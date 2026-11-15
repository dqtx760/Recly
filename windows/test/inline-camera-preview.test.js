'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function makeHarness({ showCameraPreview = false, cameraQuality = '1080p' } = {}) {
  const controller = fs.readFileSync(path.join(__dirname, '../src/renderer/recorder.js'), 'utf8');
  const start = controller.indexOf('let microphoneStream = null;');
  const end = controller.indexOf('const persist =', start);
  assert.ok(start >= 0 && end > start, '必须能定位内嵌摄像头预览控制器');
  const requests = [];
  const frameCallbacks = new Map();
  const timers = new Map();
  const sent = [];
  const ipcListeners = new Map();
  let nextId = 0;
  let now = 0;
  let canvas;
  const video = {
    srcObject: null, videoWidth: 640, videoHeight: 480, async play() {},
    currentTime: 0, readyState: 2,
    requestVideoFrameCallback(callback) { const id = ++nextId; frameCallbacks.set(id, callback); return id; },
    cancelVideoFrameCallback(id) { frameCallbacks.delete(id); },
    removeEventListener() {},
  };
  const previewClasses = new Set();
  const camTopRow = { classList: {
    add(name) { previewClasses.add(name); },
    remove(name) { previewClasses.delete(name); },
  } };
  const state = { cam: { on: true, deviceId: 'A', requestId: 1, previewMessage: '', captureFailed: false,
    previewStatus: 'off', previewError: null }, mic: { on: false }, sys: { on: false }, cameraQuality,
    readiness: { ready: true }, showCameraPreview, starting: false, session: null, finishing: false };
  const cameraLabel = { textContent: '' };
  const cameraButton = { querySelector: () => cameraLabel };
  const canvasStub = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,frame' };
  const sandbox = {
    state,
    navigator: { mediaDevices: { getUserMedia(constraints) {
      const request = deferred();
      requests.push({ constraints, ...request });
      return request.promise;
    } } },
    $(id) { return id === 'camera-inline-preview' ? video : id === 'cam-top-row' ? camTopRow : id === 'cam-global' ? cameraButton : null; },
    console,
    module: { exports: {} },
    document: { createElement: () => (canvas = canvasStub) },
    performance: { now: () => now },
    ipcRenderer: { send: (channel, payload) => sent.push({ channel, payload }), on: (channel, handler) => ipcListeners.set(channel, handler) },
    updateDeviceNames() {}, render() {},
    acquireRecordingCamera(constraints) { return sandbox.navigator.mediaDevices.getUserMedia(constraints); },
    setTimeout: (callback, delay = 0) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/camera-preview-health.js'), 'utf8'), sandbox);
  sandbox.watchCameraPreview = sandbox.module.exports.watchCameraPreview;
  const handoffStart = controller.indexOf('async function takeReadyInlineCameraStream()');
  const handoffEnd = controller.indexOf('async function openStreams()', handoffStart);
  const openStreamsStart = handoffEnd;
  const openStreamsEnd = controller.indexOf('function pickMimeType(', openStreamsStart);
  const exposed = `\nglobalThis.previewApi = {
    updateInlineCameraPreview,
    stopInlineCameraPreview,
    openInlineCameraPreview,
    takeReadyInlineCameraStream,
    openStreams,
    isReady: () => inlineCameraStreamIsReady({ enabled: true, deviceId: state.cam.deviceId, quality: state.cameraQuality, stream: null }),
    getStream: () => inlineCameraStream,
    getRequest: () => inlineCameraRequest,
    getDevice: () => inlineCameraDevice,
    getQuality: () => inlineCameraQuality,
  };`;
  vm.runInNewContext(`
    ${controller.slice(start, end)}
    ${controller.slice(handoffStart, handoffEnd)}
    ${controller.slice(openStreamsStart, openStreamsEnd)}
    ${exposed}
  `, sandbox);
  const statusStart = controller.indexOf("ipcRenderer.on('camera:status',");
  vm.runInNewContext(controller.slice(statusStart, controller.indexOf("ipcRenderer.on('recorder:hidden',", statusStart)), sandbox);
  const makeStream = (name, quality = '1080p') => {
    const dimensions = quality === '4k' ? [3840, 2160] : quality === '720p' ? [1280, 720] : [1920, 1080];
    const listeners = new Map();
    const track = { readyState: 'live', stopped: false, stop() { this.stopped = true; },
      getSettings() { return { width: dimensions[0], height: dimensions[1] }; },
      addEventListener(name, handler) { listeners.set(name, handler); },
      removeEventListener(name) { listeners.delete(name); },
      end() { this.readyState = 'ended'; listeners.get('ended')?.(); },
    };
    return { name, track, getTracks: () => [track], getVideoTracks: () => [track] };
  };
  return { api: sandbox.previewApi, state, requests, video, previewClasses, makeStream, sent, cameraLabel,
    getCanvas: () => canvas,
    status: (status) => ipcListeners.get('camera:status')({}, { requestId: state.cam.requestId, ...status }),
    frame(time) {
      now = time;
      const [id, callback] = frameCallbacks.entries().next().value;
      assert.ok(callback, '测试要先拿到流并挂接帧观察器');
      frameCallbacks.delete(id);
      video.currentTime += 1;
      callback();
    },
    timeout(delay = 8000) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `找不到 ${delay}ms 定时器`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
    pollFrameWait() {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === 50);
      if (entry) { timers.delete(entry[0]); entry[1].callback(); }
    },
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function deliverPreviewFrame(harness, requestIndex, stream, time = 0) {
  harness.requests[requestIndex].resolve(stream);
  await flushMicrotasks();
  if (harness.video.srcObject === stream) {
    harness.frame(time);
    harness.pollFrameWait();
    await flushMicrotasks();
  }
}

let passed = 0;
const testWatchdog = setTimeout(() => {
  console.error('内嵌摄像头预览测试超时：未走到全部断言完成');
  process.exit(1);
}, 20000);
async function test(name, body) {
  await body();
  passed += 1;
  console.log(`  ok  ${name}`);
}

(async () => {
  console.log('Testing inline camera preview races...');

  await test('设备A请求返回前切到B时会停止迟到A并继续请求B', async () => {
    const harness = makeHarness();
    const updateA = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].constraints.video.deviceId.exact, 'A');
    harness.state.cam.deviceId = 'B';
    const updateB = harness.api.updateInlineCameraPreview();
    assert.equal(updateB, updateA, '并发更新等待同一条 reconcile 流程');
    const streamA = harness.makeStream('A');
    harness.requests[0].resolve(streamA);
    await flushMicrotasks();
    assert.equal(streamA.track.stopped, true);
    assert.equal(harness.video.srcObject, null);
    assert.equal(harness.requests.length, 2);
    assert.equal(harness.requests[1].constraints.video.deviceId.exact, 'B');
    const streamB = harness.makeStream('B');
    await deliverPreviewFrame(harness, 1, streamB);
    await updateA;
    assert.equal(harness.video.srcObject, streamB);
    assert.equal(streamB.track.stopped, false);
  });

  await test('请求等待中关闭摄像头会停止迟到流且不再显示画面', async () => {
    const harness = makeHarness();
    const update = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    harness.state.cam.on = false;
    harness.api.updateInlineCameraPreview();
    const stream = harness.makeStream('A');
    harness.requests[0].resolve(stream);
    await flushMicrotasks();
    await update;
    assert.equal(stream.track.stopped, true);
    assert.equal(harness.video.srcObject, null);
    assert.equal(harness.requests.length, 1);
  });

  await test('录制启动中的 stop 等待迟到流清理完成', async () => {
    const harness = makeHarness();
    const update = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    harness.state.starting = true;
    let stopFinished = false;
    const stop = harness.api.stopInlineCameraPreview().then(() => { stopFinished = true; });
    await flushMicrotasks();
    assert.equal(stopFinished, false);
    const stream = harness.makeStream('A');
    harness.requests[0].resolve(stream);
    await flushMicrotasks();
    await Promise.all([update, stop]);
    assert.equal(stopFinished, true);
    assert.equal(stream.track.stopped, true);
    assert.equal(harness.video.srcObject, null);
    assert.equal(harness.requests.length, 1);
  });

  await test('同一设备的并发更新只申请一次预览流', async () => {
    const harness = makeHarness();
    const first = harness.api.updateInlineCameraPreview();
    const second = harness.api.updateInlineCameraPreview();
    assert.equal(second, first);
    await flushMicrotasks();
    assert.equal(harness.requests.length, 1);
    const stream = harness.makeStream('A');
    await deliverPreviewFrame(harness, 0, stream);
    await Promise.all([first, second]);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.video.srcObject, stream);
  });

  await test('首帧前不显示旧画面，只转发新帧且最多每秒十帧', async () => {
    const harness = makeHarness({ showCameraPreview: true });
    const opening = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    const stream = harness.makeStream('A');
    harness.requests[0].resolve(stream);
    await flushMicrotasks();
    assert.equal(harness.previewClasses.has('preview-ready'), false);
    assert.equal(harness.sent.length, 0);
    assert.equal(harness.api.isReady(), false, 'getUserMedia完成仍未证明已有真实帧');
    harness.frame(0);
    harness.pollFrameWait();
    await opening;
    harness.frame(50);
    harness.frame(100);
    assert.equal(harness.previewClasses.has('preview-ready'), true);
    assert.equal(harness.sent.length, 2);
    assert.equal(harness.sent[0].channel, 'camera:preview-frame');
    assert.equal(harness.sent[0].payload.requestId, 1);
    assert.equal(harness.getCanvas().width, 360, '4:3设备缩略图应保留宽高比');
    assert.equal(harness.getCanvas().height, 270);
    harness.state.showCameraPreview = false;
    harness.frame(200);
    assert.equal(harness.sent.length, 2, '关闭悬浮预览后仍保留主界面视频，但不再发送缩略图');
  });

  await test('轨道断开会清理静止画面和就绪状态', async () => {
    const harness = makeHarness();
    const opening = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    const stream = harness.makeStream('A');
    await deliverPreviewFrame(harness, 0, stream);
    await opening;
    stream.track.end();
    assert.equal(harness.video.srcObject, null);
    assert.equal(harness.previewClasses.has('preview-ready'), false);
    assert.equal(harness.state.cam.previewError, 'device_ended');
    assert.equal(harness.state.readiness.ready, false, '摄像头轨道结束必须撤销录制就绪状态');
    harness.status({ status: 'ready' });
    assert.equal(harness.state.cam.previewError, 'device_ended');
    harness.status({ status: 'error', error: 'no_frame', message: '浮窗超时' });
    assert.equal(harness.state.cam.previewError, 'device_ended');
    assert.equal(harness.requests.length, 1, '错误不能自动反复打开设备');
  });

  await test('首帧后停止更新会清理旧画面', async () => {
    const harness = makeHarness();
    const opening = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    const stream = harness.makeStream('A');
    await deliverPreviewFrame(harness, 0, stream);
    await opening;
    harness.timeout();
    assert.equal(harness.state.cam.previewError, 'frame_stalled');
    assert.equal(harness.state.readiness.ready, false, '画面停帧必须撤销录制就绪状态');
    assert.equal(stream.track.stopped, true);
    assert.equal(harness.video.srcObject, null);
  });

  await test('打开设备挂起八秒后结束等待，迟到流立即释放且可以重试', async () => {
    const harness = makeHarness();
    const opening = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    harness.timeout();
    await opening;
    assert.equal(harness.state.cam.previewError, 'TimeoutError');
    assert.match(harness.state.cam.previewMessage, /超时/);
    const late = harness.makeStream('late');
    harness.requests[0].resolve(late);
    await flushMicrotasks();
    assert.equal(late.track.stopped, true);
    assert.equal(harness.video.srcObject, null);
    const retry = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    const recovered = harness.makeStream('A');
    await deliverPreviewFrame(harness, 1, recovered);
    await retry;
    assert.equal(harness.video.srcObject, recovered);
    assert.equal(harness.previewClasses.has('preview-ready'), true);
    assert.equal(harness.state.cam.previewError, null, '真正恢复新帧后清除旧错误');
  });

  await test('设备拒绝应保留明确错误并释放请求', async () => {
    const harness = makeHarness();
    const opening = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    harness.requests[0].reject({ name: 'NotAllowedError' });
    await opening;
    assert.equal(harness.state.cam.previewError, 'NotAllowedError');
    assert.equal(harness.state.cam.previewMessage, '摄像头权限被拒绝');
    assert.equal(harness.api.getRequest(), null);
    assert.equal(harness.api.getStream(), null);
    assert.equal(harness.requests.length, 1);
    harness.status({ status: 'checking' });
    harness.status({ status: 'ready' });
    harness.status({ status: 'error', error: 'no_frame' });
    assert.equal(harness.state.cam.previewError, 'NotAllowedError');
    const retry = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    await deliverPreviewFrame(harness, 1, harness.makeStream('A'));
    await retry;
    harness.frame(0);
    harness.status({ status: 'ready' });
    assert.equal(harness.state.cam.previewStatus, 'ready', '采集新帧恢复之后允许浮窗再次报告就绪');
    assert.equal(harness.state.cam.previewError, null);
  });

  await test('录制启动等待挂起设备也有八秒上限', async () => {
    const harness = makeHarness();
    const opening = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    harness.state.starting = true;
    const closing = harness.api.stopInlineCameraPreview();
    harness.timeout();
    await Promise.all([opening, closing]);
    assert.equal(harness.video.srcObject, null);
    const late = harness.makeStream('late');
    harness.requests[0].resolve(late);
    await flushMicrotasks();
    assert.equal(late.track.stopped, true);
  });

  await test('拿到流但始终没有真实首帧也会清理', async () => {
    const harness = makeHarness();
    const opening = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    const stream = harness.makeStream('A');
    harness.requests[0].resolve(stream);
    await flushMicrotasks();
    harness.timeout();
    harness.pollFrameWait();
    await opening;
    assert.equal(harness.state.cam.previewError, 'no_frame');
    assert.equal(stream.track.stopped, true);
    assert.equal(harness.previewClasses.has('preview-ready'), false);
  });

  await test('每次启动默认关闭；本次手动开关可控制预览且不会被下次启动恢复', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/recorder.js'), 'utf8');
    const stateSource = source.slice(source.indexOf('const state = {'), source.indexOf('let lastCompactHeight'));
    const persistSource = source.slice(source.indexOf('const persist ='), source.indexOf('function requestCameraPreview('));
    for (const saved of [{}, { showCameraPreview: true }, { showCameraPreview: false },
      { cameraPreviewDefaultVersion: 1, showCameraPreview: true },
      { cameraPreviewDefaultVersion: 1, showCameraPreview: false },
      { cameraPreviewDefaultVersion: 2, showCameraPreview: true },
      { cameraPreviewDefaultVersion: 2, showCameraPreview: false }]) {
      const legacy = { saved };
      vm.runInNewContext(`${stateSource}\nglobalThis.visible = state.showCameraPreview;`, legacy);
      assert.equal(legacy.visible, false);
    }
    for (const visible of [true, false]) {
      const context = { saved: {}, settingsKey: 'test', localStorage: {
        setItem(key, value) { context.persisted = JSON.parse(value); },
      } };
      vm.runInNewContext(`${stateSource}\n${persistSource}\nstate.showCameraPreview = ${visible}; persist();`, context);
      assert.equal(context.persisted.showCameraPreview, visible, '本次手动选择写入本地设置');
      assert.equal(context.persisted.cameraPreviewDefaultVersion, 2);
      const restored = { saved: context.persisted };
      vm.runInNewContext(`${stateSource}\nglobalThis.visible = state.showCameraPreview;`, restored);
      assert.equal(restored.visible, false, '无论历史保存开关为何值，下次启动都默认关闭');
    }
  });

  await test('录制时借用现有摄像头流，不重复打开设备且关闭预览不停止录制轨道', async () => {
    const harness = makeHarness({ showCameraPreview: true });
    const recording = harness.makeStream('recording');
    harness.state.session = { tracks: [{ kind: 'camera', stream: recording }] };
    const opening = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.video.srcObject, recording);
    harness.frame(0);
    harness.pollFrameWait();
    await opening;
    assert.equal(harness.sent.length, 1);
    await harness.api.stopInlineCameraPreview();
    assert.equal(harness.video.srcObject, null);
    assert.equal(recording.track.stopped, false);
  });

  await test('录制流预览停帧只清预览，保留MediaRecorder所用轨道', async () => {
    const harness = makeHarness();
    const recording = harness.makeStream('recording');
    harness.state.session = { tracks: [{ kind: 'camera', stream: recording }] };
    const opening = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    harness.frame(0);
    harness.pollFrameWait();
    await opening;
    harness.timeout();
    assert.equal(harness.state.cam.previewError, 'frame_stalled');
    assert.equal(harness.video.srcObject, null);
    assert.equal(recording.track.stopped, false);
  });

  await test('按正式质量预览；handoff只detach，不停止轨道或等待第二次video首帧', async () => {
    const harness = makeHarness({ cameraQuality: '720p' });
    const opening = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    assert.equal(harness.requests[0].constraints.video.width.exact, 1280);
    assert.equal(harness.requests[0].constraints.video.height.exact, 720);
    const stream = harness.makeStream('720p', '720p');
    await deliverPreviewFrame(harness, 0, stream);
    await opening;
    assert.equal(harness.api.isReady(), true);
    assert.equal(harness.api.getQuality(), '720p');
    const recordingInputs = await harness.api.openStreams();
    assert.equal(recordingInputs.streams.camera, stream);
    assert.equal(recordingInputs.problems.length, 0);
    assert.equal(harness.requests.length, 1, 'start/openStreams不得重新申请摄像头');
    assert.equal(stream.track.stopped, false);
    assert.equal(harness.video.srcObject, null, '借出时只解除预览元素引用');
    assert.equal(harness.api.getStream(), null, '借出后预览不再拥有录制流');
  });

  await test('摄像头质量改变时废弃旧规格并请求新规格', async () => {
    const harness = makeHarness({ cameraQuality: '720p' });
    const opening = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    const oldStream = harness.makeStream('720p', '720p');
    await deliverPreviewFrame(harness, 0, oldStream);
    await opening;
    harness.state.cameraQuality = '4k';
    const changed = harness.api.updateInlineCameraPreview();
    await flushMicrotasks();
    assert.equal(oldStream.track.stopped, true);
    assert.equal(harness.requests[1].constraints.video.width.exact, 3840);
    assert.equal(harness.requests[1].constraints.video.height.exact, 2160);
    const newStream = harness.makeStream('4k', '4k');
    await deliverPreviewFrame(harness, 1, newStream);
    await changed;
    assert.equal(harness.api.getQuality(), '4k');
    assert.equal(harness.api.getStream(), newStream);
  });

  console.log(`全部 ${passed} 项内嵌摄像头预览竞态测试通过！`);
  clearTimeout(testWatchdog);
})().catch((error) => {
  clearTimeout(testWatchdog);
  console.error('测试失败:', error);
  process.exit(1);
});
