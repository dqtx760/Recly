'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeModel,
  readClaudeConfiguredModel,
  runtimeModelFromCodexEvent,
  runtimeModelFromCodexEvents,
  runtimeModelFromClaudeEnvelope,
  readCodexConfiguredModel,
} = require('../src/main/assistant-model');

async function main() {
  assert.equal(normalizeModel('gpt-6-luna'), 'gpt-6-luna');
  assert.equal(normalizeModel('provider/model-v2'), 'provider/model-v2');
  assert.equal(normalizeModel('sk-ant-test-secret-key'), null, '密钥样式字符串不能作为模型名返回');
  assert.equal(normalizeModel('AIzaSyDUMMYKEYTHATSHOULDNOTBELEAKED123456'), null);
  assert.equal(normalizeModel('not a model'), null);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'recly-claude-model-home-'));
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'recly-claude-model-work-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(workDirectory, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-sonnet-4-5', apiKey: 'private-value-not-read' }));
  assert.equal(readClaudeConfiguredModel({ env: {}, home, workDirectory }), 'claude-sonnet-4-5');
  fs.writeFileSync(path.join(workDirectory, '.claude', 'settings.local.json'), JSON.stringify({ model: 'claude-opus-4-1' }));
  assert.equal(readClaudeConfiguredModel({ env: {}, home, workDirectory }), null, '冲突设置不能猜测有效模型');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'sk-ant-test-secret-key' }));
  fs.rmSync(path.join(workDirectory, '.claude', 'settings.local.json'));
  assert.equal(readClaudeConfiguredModel({ env: {}, home, workDirectory }), null);

  const codexOutput = [
    JSON.stringify({ type: 'thread.started', thread_id: 'local-id' }),
    JSON.stringify({ type: 'turn.started', turn: { model: 'gpt-6.1-sol' } }),
  ].join('\n');
  assert.equal(runtimeModelFromCodexEvents(codexOutput), 'gpt-6.1-sol');
  assert.equal(runtimeModelFromCodexEvent({ type: 'item.completed', model: 'not-runtime-metadata' }), null);
  assert.equal(runtimeModelFromClaudeEnvelope({ model: 'claude-sonnet-4-5' }), 'claude-sonnet-4-5');
  assert.equal(runtimeModelFromClaudeEnvelope({ modelUsage: { 'claude-opus-4-1': { inputTokens: 4 } } }), 'claude-opus-4-1');
  assert.equal(runtimeModelFromClaudeEnvelope({ modelUsage: { 'claude-opus-4-1': {}, 'claude-haiku-4-5': {} } }), null,
    '多个模型计量项不能猜测当前响应模型');

  let child;
  let requests = [];
  const configuredModel = await readCodexConfiguredModel({
    executable: 'codex.exe', cwd: 'C:\\assistant-work', env: { CODEX_HOME: 'C:\\codex-profile' }, timeoutMs: 1000,
    spawnProcess: (executable, args, options) => {
      assert.equal(executable, 'codex.exe');
      assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
      assert.equal(options.shell, false);
      assert.equal(options.cwd, 'C:\\assistant-work');
      child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new EventEmitter();
      child.kill = () => { child.killed = true; return true; };
      child.stdin.write = (line) => {
        const request = JSON.parse(line);
        requests.push(request);
        if (request.id === 1) setImmediate(() => child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`));
        if (request.id === 2) setImmediate(() => child.stdout.write(`${JSON.stringify({ id: 2, result: { config: { model: 'gpt-6-luna' } } })}\n`));
      };
      return child;
    },
  });
  assert.equal(configuredModel, 'gpt-6-luna');
  assert.ok(requests.some((request) => request.method === 'config/read' && request.params.includeLayers === false));
  assert.equal(child.killed, true, '读取配置后关闭临时 app-server');

  let timeoutChild;
  assert.equal(await readCodexConfiguredModel({
    executable: 'codex.exe', timeoutMs: 5,
    spawnProcess: () => {
      timeoutChild = new EventEmitter();
      timeoutChild.stdout = new PassThrough(); timeoutChild.stderr = new PassThrough(); timeoutChild.stdin = new EventEmitter();
      timeoutChild.stdin.write = () => {};
      timeoutChild.kill = () => { timeoutChild.killed = true; return true; };
      return timeoutChild;
    },
  }), null, '配置探测超时时回退未报告');
  assert.equal(timeoutChild.killed, true);

  console.log('Codex app-server、Claude 配置与运行模型来源测试通过');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
