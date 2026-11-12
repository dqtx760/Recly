'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_CONFIG,
  MAX_RESPONSE_BYTES,
  createApiConfigStore,
  normalizeBaseUrl,
  requestAssistantApi,
} = require('../src/main/assistant-api');
const { parseResult } = require('../src/main/assistant-service');

const secret = 'sk-test-never-return-this-key';
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`cipher:${value}`),
  decryptString: (value) => Buffer.from(value).toString('utf8').slice('cipher:'.length),
};
const responsePlan = {
  reply: '已安排剪辑',
  operationsJson: '[]',
  subtitlePatchJson: '{}',
  historyAction: 'none',
};

async function main() {
  assert.equal(normalizeBaseUrl('https://api.example/v1/'), 'https://api.example/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.5:8000/v1'), 'http://127.0.0.5:8000/v1');
  assert.equal(normalizeBaseUrl('http://[::1]:8000/v1'), 'http://[::1]:8000/v1');
  for (const value of [
    'http://api.example/v1',
    'https://user:password@api.example/v1',
    'https://api.example/v1?token=x',
    'https://api.example/v1#fragment',
    'file:///etc/passwd',
  ]) assert.throws(() => normalizeBaseUrl(value));

  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recly-assistant-api-config-')), 'api-config.json');
  const store = createApiConfigStore({ filePath: configPath, safeStorage: storage });
  assert.deepEqual(store.getConfig(), { ...DEFAULT_CONFIG, hasKey: false });
  const configured = store.saveConfig({ protocol: 'openai', baseUrl: 'https://api.example/v1/', model: 'model-a', apiKey: secret });
  assert.deepEqual(configured, { protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a', hasKey: true });
  const disk = fs.readFileSync(configPath, 'utf8');
  assert.ok(!disk.includes(secret), '密钥不得明文写入配置文件');
  assert.equal(store.getConfig().apiKey, undefined, '公开配置不得包含密钥');
  assert.equal(store.loadForRequest().apiKey, secret);
  assert.throws(() => store.saveConfig({ protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a', apiKey: {} }), /API Key 格式无效/);

  assert.throws(() => store.saveConfig({ protocol: 'openai', baseUrl: 'https://other.example/v1', model: 'model-a', apiKey: '' }), /请输入.*API Key/);
  assert.equal(store.getConfig().baseUrl, 'https://api.example/v1', '更换接口时缺少新密钥应保持旧配置');
  assert.equal(store.saveConfig({ protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'model-b', apiKey: '' }).hasKey, true,
    '相同 endpoint 且输入空密钥时保留已加密密钥');
  assert.equal(store.clearKey().hasKey, false);
  assert.throws(() => store.loadForRequest(), /配置 API Key/);

  const unavailablePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recly-assistant-api-no-storage-')), 'api-config.json');
  const unavailable = createApiConfigStore({ filePath: unavailablePath, safeStorage: { isEncryptionAvailable: () => false } });
  assert.throws(() => unavailable.saveConfig({ protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a', apiKey: secret }), /安全存储不可用/);
  assert.equal(fs.existsSync(unavailablePath), false, '安全存储不可用时不得降级保存明文密钥');

  const corruptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recly-assistant-api-corrupt-')), 'api-config.json');
  fs.writeFileSync(corruptPath, '{ broken');
  const recoverable = createApiConfigStore({ filePath: corruptPath, safeStorage: storage });
  assert.throws(() => recoverable.saveConfig({ protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a', apiKey: '' }), /输入新的 API Key/);
  assert.equal(recoverable.saveConfig({ protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a', apiKey: secret }).hasKey, true,
    '明确输入新 Key 后可覆盖损坏配置');
  assert.equal(recoverable.loadForRequest().apiKey, secret, '覆盖损坏配置后不能复用旧密钥');

  let openAiRequest;
  const openAiContent = JSON.stringify(responsePlan);
  const openAiText = await requestAssistantApi(
    { protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a' },
    secret,
    'prompt body',
    { fetchImpl: async (url, options) => {
      openAiRequest = { url, options };
      return new Response(JSON.stringify({ choices: [{ message: { content: openAiContent } }] }), { status: 200 });
    } },
  );
  assert.equal(openAiRequest.url, 'https://api.example/v1/chat/completions');
  assert.equal(openAiRequest.options.method, 'POST');
  assert.equal(openAiRequest.options.redirect, 'error');
  assert.equal(openAiRequest.options.headers.authorization, `Bearer ${secret}`);
  assert.deepEqual(JSON.parse(openAiRequest.options.body), { model: 'model-a', messages: [{ role: 'user', content: 'prompt body' }] });
  assert.deepEqual(parseResult(openAiText, 'api'), { reply: responsePlan.reply, operations: [], subtitlePatch: {}, historyAction: 'none' });
  assert.throws(() => parseResult(JSON.stringify({ ...responsePlan, unexpected: true }), 'api'), /格式无效/);

  let anthropicRequest;
  const anthropicText = await requestAssistantApi(
    { protocol: 'anthropic', baseUrl: 'https://api.example/v1', model: 'claude-test' },
    secret,
    'prompt body',
    { fetchImpl: async (url, options) => {
      anthropicRequest = { url, options };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(responsePlan) }] }), { status: 200 });
    } },
  );
  assert.equal(anthropicRequest.url, 'https://api.example/v1/messages');
  assert.equal(anthropicRequest.options.headers['x-api-key'], secret);
  assert.equal(anthropicRequest.options.headers['anthropic-version'], '2023-06-01');
  assert.equal(parseResult(anthropicText, 'api').reply, responsePlan.reply);

  await assert.rejects(requestAssistantApi(
    { protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a' }, secret, 'prompt body',
    { fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      throw new Error(`redirect included ${secret}`);
    } },
  ), (error) => !error.message.includes(secret) && !error.message.includes('redirect included'));
  await assert.rejects(requestAssistantApi(
    { protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a' }, secret, 'prompt body',
    { fetchImpl: async () => new Response(JSON.stringify({ error: { message: `echo ${secret}` } }), { status: 401 }) },
  ), (error) => error.message.includes('HTTP 401') && !error.message.includes(secret) && !error.message.includes('echo'));

  let wasAborted = false;
  await assert.rejects(requestAssistantApi(
    { protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a' }, secret, 'prompt body',
    { maxResponseBytes: 64, abort: () => { wasAborted = true; }, fetchImpl: async () => new Response('x'.repeat(65), { status: 200 }) },
  ), /超过 4MB 限制/);
  assert.equal(wasAborted, true, '响应超限时应终止请求');
  assert.equal(MAX_RESPONSE_BYTES, 4 * 1024 * 1024);
  console.log('API Key 加密配置、OpenAI/Anthropic 协议、URL 与响应安全边界测试通过');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
