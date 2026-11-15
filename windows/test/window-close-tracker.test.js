'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindowCloseTracker } = require('../src/main/window-close-tracker');

class MockWindow extends EventEmitter {
  constructor(name, closeActions = []) {
    super();
    this.name = name;
    this.closeCalls = 0;
    this.destroyed = false;
    this.closeActions = closeActions;
    this.webContents = { isLoading: () => true };
  }
  isDestroyed() { return this.destroyed; }
  close() {
    this.closeCalls += 1;
    const action = this.closeActions.shift();
    if (action instanceof Error) throw action;
    if (typeof action === 'function') action();
  }
  finishClose() { this.destroyed = true; this.emit('closed'); }
}

let passed = 0;
async function test(name, body) {
  await body();
  passed += 1;
  console.log(`  ok  ${name}`);
}

(async () => {
  console.log('Testing camera preview close tracking...');

  await test('先收到隐藏消息再收到 release 时仍等待原窗口 closed', async () => {
    const tracker = createWindowCloseTracker();
    const camera = new MockWindow('camera A');
    let cameraWindow = camera;
    let released = false;
    const toggleCameraPreview = (visible) => {
      if (visible) return;
      const closing = cameraWindow;
      const closingPromise = tracker.close(closing);
      cameraWindow = null;
      return closingPromise;
    };
    toggleCameraPreview(false);
    const release = (async () => {
      await toggleCameraPreview(false);
      await tracker.waitForPending();
      released = true;
    })();
    await Promise.resolve();
    assert.equal(cameraWindow, null);
    assert.equal(released, false);
    camera.finishClose();
    await release;
    assert.equal(released, true);
    assert.equal(camera.closeCalls, 1);
  });

  await test('重复关闭复用同一个 Promise，旧窗口和新窗口都被等待', async () => {
    const tracker = createWindowCloseTracker();
    const oldWindow = new MockWindow('camera A');
    const newWindow = new MockWindow('camera B');
    const oldClose = tracker.close(oldWindow);
    assert.equal(tracker.close(oldWindow), oldClose);
    assert.equal(oldWindow.closeCalls, 1);
    tracker.close(newWindow);
    let released = false;
    const release = tracker.waitForPending().then(() => { released = true; });
    oldWindow.finishClose();
    await Promise.resolve();
    assert.equal(released, false);
    newWindow.finishClose();
    await release;
    assert.equal(released, true);
    assert.equal(newWindow.closeCalls, 1);
  });

  await test('关闭抛错会清除失败跟踪并允许同一窗口重试', async () => {
    const tracker = createWindowCloseTracker();
    const closeError = new Error('close failed');
    const camera = new MockWindow('camera A', [closeError]);

    assert.throws(() => tracker.close(camera), closeError);
    assert.equal(camera.listenerCount('closed'), 0);
    await tracker.waitForPending();

    const retry = tracker.close(camera);
    assert.equal(camera.closeCalls, 2);
    camera.finishClose();
    await retry;
    await tracker.waitForPending();
  });

  await test('真实 main 隐藏消息捕获关闭异常，release 失败后能重试并等待 closed', async () => {
    const tracker = createWindowCloseTracker();
    const camera = new MockWindow('camera A', [
      new Error('hidden close failed'),
      new Error('release close failed'),
    ]);
    const listeners = new Map();
    const handlers = new Map();
    const warnings = [];
    let createdWindows = 0;
    const mainPath = path.join(__dirname, '../src/main/main.js');
    const mainSource = fs.readFileSync(mainPath, 'utf8');
    const toggleStart = mainSource.indexOf('function toggleCameraPreview(');
    const toggleEnd = mainSource.indexOf('\nfunction toggleMemo()', toggleStart);
    const ipcStart = mainSource.indexOf("  ipcMain.on('recorder:camera-preview'");
    const ipcEnd = mainSource.indexOf("  ipcMain.on('camera:status'", ipcStart);
    assert.ok(toggleStart >= 0 && toggleEnd > toggleStart, '定位真实 toggleCameraPreview');
    assert.ok(ipcStart >= 0 && ipcEnd > ipcStart, '定位真实隐藏消息和 release IPC');

    const context = {
      cameraPreviewRequest: { visible: true, deviceId: 'device-1', requestId: 1 },
      cameraWindow: camera,
      cameraWindowCloseTracker: tracker,
      createWindow() { createdWindows += 1; return new MockWindow('unexpected camera'); },
      ipcMain: {
        on(channel, listener) { listeners.set(channel, listener); },
        handle(channel, handler) { handlers.set(channel, handler); },
      },
      console: { warn(...args) { warnings.push(args); } },
    };
    vm.runInNewContext(
      `${mainSource.slice(toggleStart, toggleEnd)}\n${mainSource.slice(ipcStart, ipcEnd)}`,
      context,
      { filename: mainPath },
    );

    listeners.get('recorder:camera-preview')({}, { visible: false, deviceId: 'device-1', requestId: 1 });
    assert.equal(context.cameraWindow, camera, '隐藏关闭失败时保留原窗口引用');
    assert.equal(camera.closeCalls, 1);
    assert.equal(warnings.length, 1, '事件式 IPC 已处理关闭异常');
    listeners.get('recorder:camera-preview')({}, { visible: true, deviceId: 'device-1', requestId: 2 });
    assert.equal(context.cameraWindow, camera, '恢复预览时继续使用尚未关闭的窗口');
    assert.equal(createdWindows, 0, '失败关闭的窗口仍占用引用时不创建第二个窗口');

    await assert.rejects(handlers.get('recorder:release-camera-preview')(), /release close failed/);
    assert.equal(context.cameraWindow, camera, 'release 失败后保留窗口引用');
    assert.equal(camera.closeCalls, 2);

    const releaseRetry = handlers.get('recorder:release-camera-preview')();
    await Promise.resolve();
    assert.equal(context.cameraWindow, null, '重试成功发起关闭后才清空当前引用');
    let released = false;
    releaseRetry.then(() => { released = true; });
    await Promise.resolve();
    assert.equal(released, false, 'release 仍等待窗口真实 closed');
    camera.finishClose();
    await releaseRetry;
    assert.equal(released, true);
    assert.equal(camera.closeCalls, 3);
  });

  console.log(`全部 ${passed} 项摄像头窗口关闭测试通过！`);
})().catch((error) => {
  console.error('测试失败:', error);
  process.exit(1);
});
