'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const DEFAULT_CONFIG = Object.freeze({
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
});
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function safeError(message) {
  const error = new Error(message);
  error.safeAssistantMessage = true;
  return error;
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host === '::1') return true;
  if (net.isIP(host) === 4) return Number(host.split('.')[0]) === 127;
  return false;
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('请输入有效的 API 地址');
  const source = value.trim();
  if (/[\s\\?#]/.test(source)) throw new Error('API 地址不能包含空白、查询参数或片段');
  let url;
  try { url = new URL(source); } catch { throw new Error('请输入有效的 API 地址'); }
  if (url.username || url.password) throw new Error('API 地址不能包含用户名或密码');
  if (url.search || url.hash || !url.hostname) throw new Error('API 地址不能包含查询参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('API 地址必须使用 HTTPS，或使用本机回环 HTTP 地址');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href.replace(/\/$/, '');
}

function normalizeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('API 配置无效');
  const protocol = value.protocol;
  if (!['openai', 'anthropic'].includes(protocol)) throw new Error('API 协议仅支持 OpenAI 兼容和 Anthropic');
  const baseUrl = normalizeBaseUrl(value.baseUrl);
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200 || /[\u0000-\u001f\u007f]/.test(value.model)) {
    throw new Error('请输入有效的模型名称');
  }
  return { protocol, baseUrl, model: value.model.trim() };
}

function createApiConfigStore({ filePath, safeStorage } = {}) {
  if (!filePath) throw new Error('API 配置存储路径无效');

  function readStored() {
    let value;
    try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { ...DEFAULT_CONFIG, encryptedKey: '' };
      throw new Error('API 配置文件无法读取，请重新保存配置');
    }
    try {
      const settings = normalizeSettings(value);
      return { ...settings, encryptedKey: typeof value.encryptedKey === 'string' ? value.encryptedKey : '' };
    } catch {
      throw new Error('API 配置文件无效，请重新保存配置');
    }
  }

  function writeStored(value) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    } catch {
      throw new Error('API 配置无法保存');
    }
  }

  function getConfig() {
    const { protocol, baseUrl, model, encryptedKey } = readStored();
    return { protocol, baseUrl, model, hasKey: Boolean(encryptedKey) };
  }

  function saveConfig(payload = {}) {
    const settings = normalizeSettings(payload);
    if (payload.apiKey !== undefined && typeof payload.apiKey !== 'string') throw new Error('API Key 格式无效');
    const rawApiKey = payload.apiKey || '';
    if (rawApiKey.length > 8192 || /[\u0000-\u001f\u007f]/.test(rawApiKey)) throw new Error('API Key 格式无效');
    const apiKey = rawApiKey.trim();

    let current;
    try { current = readStored(); }
    catch {
      if (!apiKey) throw new Error('API 配置损坏，请输入新的 API Key 后重新保存');
      current = null;
    }
    const sameEndpoint = Boolean(current && current.protocol === settings.protocol && current.baseUrl === settings.baseUrl);

    let encryptedKey = current?.encryptedKey || '';
    if (apiKey) {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法安全保存 API Key');
      try { encryptedKey = Buffer.from(safeStorage.encryptString(apiKey)).toString('base64'); }
      catch { throw new Error('API Key 加密失败，未保存配置'); }
    } else if (!sameEndpoint) {
      throw new Error('API 地址或协议已更改，请输入该接口对应的 API Key');
    }

    const next = { ...settings, encryptedKey };
    writeStored(next);
    return { protocol: next.protocol, baseUrl: next.baseUrl, model: next.model, hasKey: Boolean(next.encryptedKey) };
  }

  function clearKey() {
    let current;
    try { current = readStored(); }
    catch { current = { ...DEFAULT_CONFIG, encryptedKey: '' }; }
    const next = { ...current, encryptedKey: '' };
    writeStored(next);
    return { protocol: next.protocol, baseUrl: next.baseUrl, model: next.model, hasKey: false };
  }

  function loadForRequest() {
    const current = readStored();
    if (!current.encryptedKey) throw new Error('请先配置 API Key');
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取 API Key');
    let apiKey;
    try { apiKey = safeStorage.decryptString(Buffer.from(current.encryptedKey, 'base64')); }
    catch { throw new Error('API Key 无法解密，请重新输入并保存'); }
    if (typeof apiKey !== 'string' || !apiKey) throw new Error('API Key 无法解密，请重新输入并保存');
    return { protocol: current.protocol, baseUrl: current.baseUrl, model: current.model, apiKey };
  }

  return { getConfig, saveConfig, clearKey, loadForRequest };
}

function endpointUrl(config) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  return new URL(config.protocol === 'anthropic' ? 'messages' : 'chat/completions', `${baseUrl}/`).href;
}

async function readLimitedBody(response, { abort, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    abort?.();
    throw safeError('API 响应超过 4MB 限制');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    let text;
    try { text = await response.text(); } catch { throw safeError('无法读取 API 响应'); }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      abort?.();
      throw safeError('API 响应超过 4MB 限制');
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        abort?.();
        try { await reader.cancel(); } catch {}
        throw safeError('API 响应超过 4MB 限制');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error?.safeAssistantMessage) throw error;
    throw safeError('无法读取 API 响应');
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

function extractApiText(protocol, responseText) {
  let envelope;
  try { envelope = JSON.parse(responseText); } catch { throw safeError('API 响应不是有效 JSON'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw safeError('API 响应格式无效');
  if (Object.hasOwn(envelope, 'reply') || Object.hasOwn(envelope, 'operationsJson') || Object.hasOwn(envelope, 'subtitlePatchJson')) {
    return JSON.stringify(envelope);
  }
  let content;
  if (protocol === 'anthropic') {
    content = Array.isArray(envelope.content)
      ? envelope.content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n')
      : '';
  } else {
    const message = envelope.choices?.[0]?.message?.content;
    content = typeof message === 'string' ? message : '';
  }
  if (!content) throw safeError('API 未返回助手文本');
  return content;
}

async function requestAssistantApi(config, apiKey, prompt, { fetchImpl = globalThis.fetch, signal, abort, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  if (typeof fetchImpl !== 'function') throw safeError('当前运行环境不支持网络请求');
  const endpoint = endpointUrl(config);
  const headers = { 'content-type': 'application/json' };
  let body;
  if (config.protocol === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = JSON.stringify({ model: config.model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] });
  } else {
    headers.authorization = `Bearer ${apiKey}`;
    body = JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }] });
  }

  let response;
  try {
    response = await fetchImpl(endpoint, { method: 'POST', headers, body, redirect: 'error', signal });
  } catch {
    throw safeError('API 请求连接失败，请检查接口地址和网络');
  }
  const responseText = await readLimitedBody(response, { abort, maxBytes: maxResponseBytes });
  if (!response.ok) throw safeError(`API 服务返回错误（HTTP ${Number(response.status) || 0}）`);
  return extractApiText(config.protocol, responseText);
}

module.exports = {
  DEFAULT_CONFIG,
  MAX_RESPONSE_BYTES,
  createApiConfigStore,
  normalizeBaseUrl,
  normalizeSettings,
  endpointUrl,
  extractApiText,
  requestAssistantApi,
};
