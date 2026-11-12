'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssistantService, promptFor, parseResult } = require('../src/main/assistant-service');

const plan = { reply: '已准备好圆形摄像头', operationsJson: '[{"type":"camera","patch":{"shape":"circle"}}]', subtitlePatchJson: '{}', historyAction: 'none' };
const event = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(plan) } });
const payload = { backend: 'codex', message: '改为圆形', project: { media: { screen: { duration: 6, file: 'private-source.mp4' } }, capture: { token: 'private-token' }, camera: { shape: 'square' }, timeline: { segments: [] } } };
const prompt = promptFor(payload);
assert.ok(!prompt.includes('private-source.mp4') && !prompt.includes('private-token'));
assert.equal(parseResult(event, 'codex').operations[0].patch.shape, 'circle');
assert.equal(parseResult(JSON.stringify({ structured_output: plan }), 'claude').historyAction, 'none');
assert.throws(() => parseResult('{"type":"turn.failed"}', 'codex'));
assert.throws(() => parseResult(JSON.stringify({ structured_output: { ...plan, operationsJson: '{}' } }), 'claude'));

async function main() {
  const children = [];
  const service = createAssistantService({
    workDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'recly-assistant-test-')),
    detectBackends: () => [{ id: 'codex', label: 'Codex', executable: 'codex.exe' }],
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
  assert.deepEqual(service.detect(), [{ id: 'codex', label: 'Codex', available: true }]);
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
  console.log('本机AI后端解析、上下文脱敏、取消、超时和进程边界测试通过');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
