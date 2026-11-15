'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const start = source.indexOf('function excludeFromCapture(');
const end = source.indexOf('\nfunction initTray(', start);
assert.ok(start >= 0 && end > start);
const values = [];
const win = { isDestroyed: () => false, setContentProtection(value) { values.push(value); }, setAlwaysOnTop() {} };
let busy = false;
const context = {
  recorderWindow: win, cameraWindow: win, memoWindow: win,
  completionWindows: new Map([[1, win]]), tray: null,
  hasRecordingWork: () => busy, updateRecorderTaskbarIcon() {},
};
vm.runInNewContext(source.slice(start, end), context);
context.excludeFromCapture(win);
assert.equal(values.pop(), false, '新建窗口空闲时允许系统截图');
busy = true;
context.updateTrayState();
assert.deepEqual(values.splice(0), [true, true, true, true], '准备/录制期间控件排除捕获');
busy = false;
context.updateTrayState();
assert.deepEqual(values.splice(0), [false, false, false, false], '结束或取消后重新允许截图');
context.excludeFromCapture(win, true);
assert.equal(values.pop(), false);

function startHandlerHarness() {
  let resolve;
  let reject;
  const starting = new Promise((yes, no) => { resolve = yes; reject = no; });
  const protectedStates = [];
  const session = { start: () => starting };
  let handler;
  const sandbox = {
    preparing: session, recording: null, startingRecording: null, finishingRecording: null,
    recorderWindow: { isDestroyed: () => false, setAlwaysOnTop() {},
      setContentProtection(value) { protectedStates.push(value); },
    },
    cameraWindow: null, memoWindow: null, completionWindows: new Map(), tray: null,
    updateRecorderTaskbarIcon() {}, setCompletionWindowsVisible() {}, restoreTaskbar() {},
    ipcMain: { handle(channel, callback) { assert.equal(channel, 'recorder:start'); handler = callback; } },
  };
  const busyStart = source.indexOf('function hasRecordingWork()');
  const busyEnd = source.indexOf('\nfunction getRecorderIcon(', busyStart);
  const handlerStart = source.indexOf("  ipcMain.handle('recorder:start',");
  const handlerEnd = source.indexOf("  ipcMain.handle('recorder:commit-start',", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  vm.runInNewContext(`${source.slice(busyStart, busyEnd)}\n${source.slice(start, end)}\n${source.slice(handlerStart, handlerEnd)}`, sandbox);
  return { sandbox, protectedStates, session, start: () => handler(), resolve, reject };
}

(async () => {
  const success = startHandlerHarness();
  const started = success.start();
  assert.deepEqual(success.protectedStates, [true]);
  assert.equal(success.sandbox.startingRecording, success.session);
  success.resolve({ started: true });
  await started;
  assert.equal(success.sandbox.recording, success.session);
  assert.equal(success.sandbox.startingRecording, null);
  assert.ok(success.protectedStates.every(Boolean), '启动交接必须连续保护，不能出现true,false,true');

  const failure = startHandlerHarness();
  const failed = failure.start();
  assert.deepEqual(failure.protectedStates, [true]);
  failure.reject(new Error('采集启动失败'));
  await assert.rejects(failed, /采集启动失败/);
  assert.deepEqual(failure.protectedStates, [true, false], '失败后仅解除一次保护，不可继续锁定系统截图');
  assert.equal(failure.sandbox.recording, null);
  assert.equal(failure.sandbox.startingRecording, null);
  console.log('Capture protection tests passed, including real start handler success/failure transitions.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
