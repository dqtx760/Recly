'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssistantService, promptFor, parseResult, SCHEMA } = require('../src/main/assistant-service');

const plan = { reply: '已准备好圆形摄像头', operationsJson: '[{"type":"camera","patch":{"shape":"circle"}}]', subtitlePatchJson: '{}', historyAction: 'none' };
const event = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(plan) } });
const payload = { backend: 'codex', message: '改为圆形', project: { media: { screen: { duration: 6, file: 'private-source.mp4' } }, capture: { token: 'private-token' }, camera: { shape: 'square' }, timeline: { segments: [] } } };
const apiKey = 'sk-test-recly-secret-123';
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => Buffer.from(value).toString('utf8').slice('encrypted:'.length),
};
const prompt = promptFor(payload);
assert.ok(!prompt.includes('private-source.mp4') && !prompt.includes('private-token'));
assert.ok(prompt.includes(JSON.stringify(SCHEMA)), '发给 API 的 prompt 必须明确包含 JSON Schema');
assert.equal(parseResult(event, 'codex').operations[0].patch.shape, 'circle');
assert.equal(parseResult(JSON.stringify({ structured_output: plan }), 'claude').historyAction, 'none');
const runtimeCodex = parseResult([
  JSON.stringify({ type: 'turn.started', turn: { model: 'gpt-6.1-sol' } }),
  event,
].join('\n'), 'codex');
assert.deepEqual({ model: runtimeCodex.model, modelSource: runtimeCodex.modelSource }, { model: 'gpt-6.1-sol', modelSource: 'runtime' });
const runtimeClaude = parseResult(JSON.stringify({ model: 'claude-sonnet-4-5', structured_output: plan }), 'claude');
assert.deepEqual({ model: runtimeClaude.model, modelSource: runtimeClaude.modelSource }, { model: 'claude-sonnet-4-5', modelSource: 'runtime' });
assert.throws(() => parseResult('{"type":"turn.failed"}', 'codex'));
assert.throws(() => parseResult(JSON.stringify({ structured_output: { ...plan, operationsJson: '{}' } }), 'claude'));
const mappedPrompt = promptFor({
  message: '按字幕分镜',
  project: {
    media: { screen: { duration: 10 } },
    timeline: { segments: [{ id: 'kept-segment', sourceStart: 3, sourceEnd: 10, speed: 1 }], screenMotionClips: [], cameraMotionClips: [] },
    subtitles: { enabled: true, cues: [
      { id: 'trimmed-count', start: 0, end: 2, text: '12345' },
      { id: 'retained-line', start: 4, end: 5, text: '保留字幕' },
    ] },
  },
});
const mappedData = JSON.parse(mappedPrompt.split('本次数据：\n').at(-1));
assert.equal(mappedData.project.originalOutputDuration, 7);
assert.deepEqual(mappedData.project.outputSubtitles, [{ id: 'retained-line', start: 1, end: 2, text: '保留字幕' }],
  '场景分析应收到当前保留片段映射后的成片时间字幕');

async function main() {
  const children = [];
  const service = createAssistantService({
    workDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'recly-assistant-test-')),
    detectBackends: () => [{ id: 'codex', label: 'Codex', executable: 'codex.exe' }],
    readCodexModel: async () => null,
    spawnProcess: (exe, args, options) => {
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.ok(args.includes('shell_tool') && args.includes('read-only'));
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { child.killed = true; };
      children.push(child);
      return child;
    },
  });
  assert.deepEqual(await service.detect(), [
    { id: 'codex', label: 'Codex', available: true, model: null, modelSource: 'unreported' },
    { id: 'api', label: 'API Key', available: true, model: null, modelSource: 'unreported' },
  ]);
  const first = service.send(payload, 1);
  await assert.rejects(service.send(payload, 1), /仍在处理/);
  const bytes = Buffer.from(event);
  for (let i = 0; i < bytes.length; i += 7) children[0].stdout.write(bytes.subarray(i, i + 7));
  children[0].emit('close', 0);
  assert.equal((await first).reply, plan.reply, 'UTF8跨chunk不能损坏中文');
  const cancelled = service.send(payload, 1);
  service.cancel(1);
  await assert.rejects(cancelled, /停止/);
  assert.equal(children[1].killed, true);
  const failed = service.send(payload, 1);
  children[2].emit('close', 1);
  await assert.rejects(failed, /执行失败/);
  const invalid = service.send(payload, 1);
  children[3].stdout.write('garbage'); children[3].emit('close', 0);
  await assert.rejects(invalid, /有效方案/);
  const closed = service.send(payload, 1);
  service.close();
  await assert.rejects(closed, /停止/);

  let timeoutChild;
  const short = createAssistantService({
    workDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'recly-assistant-timeout-')), timeoutMs: 5,
    detectBackends: () => [{ id: 'codex', executable: 'codex.exe' }],
    spawnProcess: () => {
      timeoutChild = new EventEmitter();
      timeoutChild.stdin = new PassThrough(); timeoutChild.stdout = new PassThrough(); timeoutChild.stderr = new PassThrough();
      timeoutChild.kill = () => { timeoutChild.killed = true; };
      return timeoutChild;
    },
  });
  await assert.rejects(short.send(payload), /超时/);
  assert.equal(timeoutChild.killed, true);

  const apiPayload = { ...payload, backend: 'api' };
  const apiDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'recly-assistant-api-'));
  let apiRequest;
  const apiService = createAssistantService({
    workDirectory: apiDirectory,
    safeStorage,
    detectBackends: () => [],
    fetchImpl: async (url, options) => {
      apiRequest = { url, options };
      return new Response(JSON.stringify({ model: 'gpt-6.1-mini', choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200 });
    },
  });
  apiService.saveApiConfig({ protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'test-model', apiKey });
  assert.equal(apiService.getApiConfig().apiKey, undefined, '配置 IPC 不返回密钥');
  const apiResult = await apiService.send(apiPayload, 17);
  assert.equal(apiResult.reply, plan.reply);
  assert.equal(apiResult.model, 'gpt-6.1-mini');
  assert.equal(apiResult.modelSource, 'runtime');
  assert.deepEqual((await apiService.detect()).find((item) => item.id === 'api'), {
    id: 'api', label: 'API Key', available: true, model: 'test-model', modelSource: 'config',
  });
  assert.equal(apiRequest.url, 'https://api.example/v1/chat/completions');
  assert.equal(apiRequest.options.redirect, 'error');
  assert.equal(apiRequest.options.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(apiService.getApiConfig().hasKey, true);

  const apiConfigFile = path.join(apiDirectory, 'api-config.json');
  const persistedApiConfig = fs.readFileSync(apiConfigFile, 'utf8');
  assert.ok(!persistedApiConfig.includes(apiKey), 'API Key 不能以明文保存');

  const echoService = createAssistantService({
    workDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'recly-assistant-api-echo-')),
    safeStorage,
    detectBackends: () => [],
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ ...plan, reply: apiKey }) } }],
    }), { status: 200 }),
  });
  echoService.saveApiConfig({ protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'test-model', apiKey });
  await assert.rejects(echoService.send(apiPayload, 21), (error) => error.message.includes('已隐藏') && !error.message.includes(apiKey));

  for (const modelKey of ['private-key-123', 'abc']) {
    const modelEcho = createAssistantService({
      workDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'recly-assistant-model-echo-')), safeStorage, detectBackends: () => [],
      fetchImpl: async () => new Response(JSON.stringify({ model: modelKey, choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200 }),
    });
    modelEcho.saveApiConfig({ protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'test-model', apiKey: modelKey });
    await assert.rejects(modelEcho.send(apiPayload, 21), error => error.message.includes('已隐藏') && !error.message.includes(modelKey), '模型元数据也不能回显密钥');
    modelEcho.close();
  }

  let cancelSignal;
  const pendingService = createAssistantService({
    workDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'recly-assistant-api-cancel-')),
    safeStorage,
    detectBackends: () => [],
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      cancelSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(new Error(`upstream echoed ${apiKey}`)), { once: true });
    }),
  });
  pendingService.saveApiConfig({ protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'test-model', apiKey });
  const pendingApi = pendingService.send(apiPayload, 18);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(pendingService.send(apiPayload, 18), /仍在处理/);
  const cliWhileApiPending = pendingService.send(payload, 18);
  await assert.rejects(cliWhileApiPending, /仍在处理/);
  pendingService.cancel(18);
  await assert.rejects(pendingApi, (error) => error.message.includes('停止') && !error.message.includes(apiKey));
  assert.equal(cancelSignal.aborted, true, '取消 API 请求时应中止 fetch');

  let timeoutSignal;
  const timedApi = createAssistantService({
    workDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'recly-assistant-api-timeout-')),
    timeoutMs: 5,
    safeStorage,
    detectBackends: () => [],
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      timeoutSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(new Error(`upstream echoed ${apiKey}`)), { once: true });
    }),
  });
  timedApi.saveApiConfig({ protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'test-model', apiKey });
  await assert.rejects(timedApi.send(apiPayload, 19), (error) => error.message.includes('超时') && !error.message.includes(apiKey));
  assert.equal(timeoutSignal.aborted, true, '超时 API 请求时应中止 fetch');

  const corruptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'recly-assistant-api-corrupt-'));
  const corruptConfig = path.join(corruptDirectory, 'api-config.json');
  fs.writeFileSync(corruptConfig, '{ invalid config');
  const recoverable = createAssistantService({ workDirectory: corruptDirectory, safeStorage, detectBackends: () => [] });
  await assert.rejects(Promise.resolve().then(() => recoverable.saveApiConfig({ protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'new-model', apiKey: '' })), /输入新的 API Key/);
  assert.equal(recoverable.saveApiConfig({ protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'new-model', apiKey }).hasKey, true,
    '提供新密钥时应能覆盖损坏的配置文件');
  assert.equal(recoverable.getApiConfig().model, 'new-model');
  fs.writeFileSync(corruptConfig, '{ invalid config again');
  assert.equal(recoverable.clearApiConfig().hasKey, false, '清除密钥应能重置损坏的配置');
  assert.equal(recoverable.getApiConfig().baseUrl, 'https://api.openai.com/v1');

  const keyLess = createAssistantService({ workDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'recly-assistant-api-no-key-')), safeStorage, detectBackends: () => [] });
  await assert.rejects(keyLess.send(apiPayload, 20), /配置 API Key/);
  console.log('本机 CLI 与 API 助手解析、上下文脱敏、取消、超时和密钥存储边界测试通过');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
