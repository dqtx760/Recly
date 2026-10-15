'use strict';

const readline = require('node:readline');
const { AgentClient } = require('./client');
const { METHODS } = require('./api');

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const SERVER_INFO = { name: 'recly-agent', version: '1.0.0' };

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function structuredResult(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value ?? null };
}

function toolResult(value) {
  if (value && value.mimeType === 'image/png' && typeof value.base64 === 'string') {
    const { base64, ...details } = value;
    return {
      content: [
        { type: 'image', data: base64, mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify(details) },
      ],
      structuredContent: details,
    };
  }
  if (value && /^audio\//.test(value.mimeType || '') && typeof value.base64 === 'string') {
    const { base64, ...details } = value;
    return {
      content: [
        { type: 'audio', data: base64, mimeType: value.mimeType },
        { type: 'text', text: JSON.stringify(details) },
      ],
      structuredContent: details,
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }], structuredContent: structuredResult(value) };
}

async function dispatchRequest(message, client) {
  const { id, method, params = {} } = message;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return rpcError(id, -32602, 'params 必须是 JSON 对象');
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: '通过本机 Recly 编辑器读取和编辑已打开工程。所有写操作都必须提供当前 expectedRevision 与唯一 requestId；修改前先读取工程版本。',
      },
    };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: METHODS } };
  if (method === 'tools/call') {
    const name = params.name;
    if (!METHODS.some((entry) => entry.name === name)) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `未知的 Recly 工具：${String(name)}` }], isError: true } };
    }
    try {
      return { jsonrpc: '2.0', id, result: toolResult(await client.call(name, params.arguments || {})) };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${error.code || 'AGENT_ERROR'}: ${error.message}` }], isError: true } };
    }
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return null;
  return rpcError(id, -32601, `找不到协议方法：${String(method)}`);
}

async function main(input = process.stdin, output = process.stdout) {
  const client = new AgentClient();
  const lines = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  lines.on('line', async (line) => {
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      output.write(`${JSON.stringify(rpcError(null, -32600, '请求超过允许的最大长度'))}\n`);
      return;
    }
    let message;
    try { message = JSON.parse(line); } catch {
      output.write(`${JSON.stringify(rpcError(null, -32700, 'JSON 解析失败'))}\n`);
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    const responses = await Promise.all(messages.map((item) => {
      if (!item || item.jsonrpc !== '2.0' || typeof item.method !== 'string') return rpcError(item?.id, -32600, '无效的 JSON-RPC 请求');
      return dispatchRequest(item, client).catch((error) => rpcError(item?.id, -32603, error.message || String(error)));
    }));
    for (const response of responses) if (response) output.write(`${JSON.stringify(response)}\n`);
  });
  lines.on('close', () => client.close());
  return lines;
}

if (require.main === module) void main();

module.exports = { dispatchRequest, main, structuredResult, toolResult };
