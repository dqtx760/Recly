'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function loadWithScreen(request, parent, isMain) {
  if (request === 'electron') {
    const display = { id: 1, label: '测试显示器', isPrimary: true, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 } };
    return { screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display], dipToScreenRect: (_window, rect) => rect } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let recordingModule;
let media;
const pointerModule = require('../src/main/pointer-recorder');
pointerModule.PointerRecorder = class MockPointerRecorder {
  constructor() { this.hasClickSupport = true; }
  start() {}
  stop() { return []; }
};
media = require('../src/main/ffmpeg');
recordingModule = require('../src/main/recording');
Module._load = originalLoad;

const { RecordingSession } = recordingModule;
const root = path.join(os.tmpdir(), `dogsc-recording-icons-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);

function makeIconSpy() {
  const calls = [];
  return { calls, hide: () => calls.push('hide'), restore: () => { calls.push('restore'); return true; } };
}

async function run() {
  const previousStartCapture = media.startCapture;
  const previousRmSync = fs.rmSync;
  fs.mkdirSync(root);
  fs.rmSync = (target, options) => {
    const relative = path.relative(root, path.resolve(target));
    const insideDiagnostics = relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    if (insideDiagnostics) return;
    return previousRmSync(target, options);
  };
  let passed = 0;
  const test = async (name, body) => {
    await body();
    passed += 1;
    console.log(`  ok  ${name}`);
  };

  try {
    await test('屏幕采集启动错误会恢复图标状态', async () => {
      const icons = makeIconSpy();
      const failedStartSession = new RecordingSession({
        projectsRoot: root,
        selection: { kind: 'display', displayId: 1 },
        hideDesktopIconsDuringRecording: true,
        desktopIcons: icons,
      });
      media.startCapture = async () => { throw new Error('模拟屏幕采集错误'); };

      await assert.rejects(failedStartSession.start(), /模拟屏幕采集错误/);
      assert.deepEqual(icons.calls, ['hide', 'restore']);
      assert.equal(fs.existsSync(failedStartSession.mediaDirectory), true, '测试保留启动错误诊断目录');
    });

    await test('取消录制会在整理失败时也恢复图标状态', async () => {
      const icons = makeIconSpy();
      const session = new RecordingSession({ projectsRoot: root, selection: { kind: 'display', displayId: 1 }, desktopIcons: icons });
      session.pointer = { stop: () => [] };
      session.capture = { stop: async () => { throw new Error('模拟停止错误'); } };
      await assert.rejects(session.discard(), /模拟停止错误/);
      assert.deepEqual(icons.calls, ['restore']);
    });

    await test('正常取消恢复桌面原本隐藏状态', async () => {
      const icons = makeIconSpy();
      const session = new RecordingSession({ projectsRoot: root, selection: { kind: 'display', displayId: 1 }, desktopIcons: icons });
      session.pointer = { stop: () => [] };
      session.capture = { stop: async () => {} };
      await session.discard();
      assert.deepEqual(icons.calls, ['restore']);
    });

    await test('结束采集报错时仍然恢复图标状态', async () => {
      const icons = makeIconSpy();
      const session = new RecordingSession({ projectsRoot: root, selection: { kind: 'display', displayId: 1 }, desktopIcons: icons });
      session.firstFrameTime = Date.now() / 1000;
      session.pointer = { stop: () => [] };
      session.capture = { stop: async () => { throw new Error('模拟结束错误'); }, stderr: '' };
      await assert.rejects(session.finish([]), /模拟结束错误/);
      assert.deepEqual(icons.calls, ['restore']);
    });
  } finally {
    media.startCapture = previousStartCapture;
    fs.rmSync = previousRmSync;
  }
  console.log(`诊断目录保留：${root}`);
  console.log(`全部 ${passed} 项录制生命周期恢复测试通过。`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
