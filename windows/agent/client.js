'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { METHODS } = require('./api');

function defaultEndpointFile() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Recly', 'agent-endpoint.json');
}

function readEndpoint(endpointFile = process.env.RECLY_AGENT_ENDPOINT || defaultEndpointFile()) {
  let endpoint;
  try { endpoint = JSON.parse(fs.readFileSync(path.resolve(endpointFile), 'utf8')); } catch {
    const error = new Error('找不到 Recly 本机服务 locator 文件。请先启动 Recly，或设置 RECLY_AGENT_ENDPOINT。');
    error.code = 'SERVICE_UNAVAILABLE';
    throw error;
  }
  if (!endpoint || endpoint.version !== 1 || typeof endpoint.pipeName !== 'string' || typeof endpoint.token !== 'string') {
    const error = new Error('Recly 本机服务 locator 文件格式无效。');
    error.code = 'INVALID_ENDPOINT';
    throw error;
  }
  return endpoint;
}

class AgentClient {
  constructor(options = {}) {
    this.endpointFile = options.endpointFile || process.env.RECLY_AGENT_ENDPOINT || defaultEndpointFile();
    this.timeoutMs = options.timeoutMs || 120000;
    this.socket = null;
    this.connected = null;
    this.pending = new Map();
    this.buffer = '';
    this.decoder = null;
    this.authenticated = false;
  }

  async connect() {
    if (this.authenticated && this.socket && !this.socket.destroyed) return;
    if (this.connected) return this.connected;
    const endpoint = readEndpoint(this.endpointFile);
    this.connected = new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint.pipeName);
      const decoder = new StringDecoder('utf8');
      this.socket = socket;
      this.decoder = decoder;
      this.buffer = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error('连接 Recly 本机服务超时。'), { code: 'CONNECT_TIMEOUT' }));
      }, 10000);

      socket.setNoDelay(true);
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ type: 'auth', token: endpoint.token })}\n`);
      });
      socket.on('data', (chunk) => {
        this.buffer += decoder.write(chunk);
        let newline;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { socket.destroy(); continue; }
          if (!this.authenticated) {
            if (message.type !== 'auth' || message.ok !== true) {
              clearTimeout(timer);
              reject(Object.assign(new Error('Recly 本机服务鉴权失败。'), { code: 'AUTH_FAILED' }));
              socket.destroy();
              return;
            }
            this.authenticated = true;
            clearTimeout(timer);
            resolve();
            continue;
          }
          const waiter = this.pending.get(String(message.id));
          if (!waiter) continue;
          clearTimeout(waiter.timer);
          this.pending.delete(String(message.id));
          if (message.ok) waiter.resolve(message.result);
          else waiter.reject(Object.assign(new Error(message.error?.message || 'Recly 本机命令失败。'), { code: message.error?.code || 'AGENT_ERROR' }));
        }
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        if (!this.authenticated) reject(Object.assign(new Error(`连接 Recly 失败：${error.message}`), { code: 'SERVICE_UNAVAILABLE' }));
      });
      socket.on('close', () => {
        clearTimeout(timer);
        this.authenticated = false;
        this.socket = null;
        this.connected = null;
        for (const waiter of this.pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(Object.assign(new Error('Recly 本机服务连接已断开。'), { code: 'SERVICE_DISCONNECTED' }));
        }
        this.pending.clear();
      });
    }).finally(() => {
      if (!this.authenticated) this.connected = null;
    });
    return this.connected;
  }

  async call(method, params = {}) {
    if (!METHODS.some((item) => item.name === method)) throw Object.assign(new Error(`不支持的接口：${method}`), { code: 'METHOD_NOT_FOUND' });
    await this.connect();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('Recly 本机命令等待超时。'), { code: 'REQUEST_TIMEOUT' }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(`${JSON.stringify({ type: 'request', id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    if (this.socket && !this.socket.destroyed) this.socket.end();
    this.socket = null;
    this.connected = null;
    this.authenticated = false;
  }
}

module.exports = { AgentClient, defaultEndpointFile, readEndpoint };
