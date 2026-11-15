'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/recorder.js'), 'utf8');
const startSource = source.slice(source.indexOf('async function start()'), source.indexOf('async function stop()'));
let stage = '启动交接用例';
const timeout = setTimeout(() => {
  console.error(`摄像头交接测试超时，未完成阶段：${stage}`);
  process.exit(1);
}, 15000);

function harness({ camera = true, failure = false } = {}) {
  const calls = [];
  const callbacks = [];
  const cameraTrack = { readyState: 'live', getSettings: () => ({ width: 1920, height: 1080 }), stop() {} };
  const stream = { getVideoTracks: () => [cameraTrack], getTracks: () => [cameraTrack] };
  const state = { cam: { on: camera, deviceId: 'virtual' }, mic: { on: false }, sys: { on: false },
    environment: { ok: true }, readiness: { ready: true, pending: false }, selection: { kind: 'display' } };
  const context = {
    state, timer: null, console, Promise, performance,
    $: (id) => id === 'busy' ? { hidden: true } : {},
    beginStartFeedback() { state.starting = true; state.startError = ''; state.readiness.ready = false; },
    async stopInlineCameraPreview() { calls.push('inline-close'); },
    requestCameraPreview(visible) { calls.push(visible ? 'restore' : 'close'); },
    ipcRenderer: { async invoke(channel) {
      calls.push(channel);
      if (channel === 'recorder:prepare') return { mediaDirectory: 'fixture' };
    } },
    async openStreams() {
      calls.push('open');
      return failure ? { streams: {}, problems: ['设备无法读取'] } : { streams: camera ? { camera: stream } : {}, problems: [] };
    },
    MediaStream: class {},
    startTrack: () => ({ started: Promise.resolve(), stream }),
    stopTracks: async () => {},
    show() {}, render() {}, formatTime() {},
    prepareRecordingReadiness() { calls.push('reprepare'); },
    setTimeout(callback) { callbacks.push(callback); }, setInterval: () => 1,
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
  };
  vm.createContext(context);
  vm.runInContext(startSource, context);
  return { context, state, calls, callbacks };
}

(async () => {
  const success = harness();
  const notReady = harness();
  notReady.state.readiness.ready = false;
  await notReady.context.start();
  assert.deepEqual(notReady.calls, [], '未就绪状态不能绕过禁用门槛启动');
  assert.equal(notReady.state.starting, undefined);

  const pending = success.context.start();
  await new Promise((resolve) => setImmediate(resolve));
  await pending;
  assert.ok(success.state.session, '释放预览后必须进入录制状态');
  assert.ok(success.calls.indexOf('open') >= 0, '录制应直接复用就绪输入');
  assert.ok(!success.calls.includes('inline-close'), '开始时不得先释放热摄像头预览');
  assert.ok(!success.calls.includes('recorder:release-camera-preview'), '开始时不得关闭可交接的预览流');
  assert.ok(success.calls.includes('recorder:commit-start'));
  assert.equal(success.state.readiness.ready, false, '进入启动阶段后撤销待机 ready 标记');

  const failure = harness({ failure: true });
  await failure.context.start();
  assert.equal(failure.state.session, undefined);
  assert.ok(failure.calls.includes('restore'), '失败后恢复待机预览');
  assert.match(failure.state.startError, /设备无法读取/);
  failure.callbacks.forEach((callback) => callback());
  assert.match(failure.state.startError, /设备无法读取/, '重试恢复后错误信息仍可见');
  assert.ok(failure.calls.includes('reprepare'), '失败恢复到空闲后应重新预热');

  const noCamera = harness({ camera: false });
  await noCamera.context.start();
  assert.ok(noCamera.state.session);
  assert.ok(!noCamera.calls.includes('recorder:release-camera-preview'));
  const previewState = { cam: {}, showCameraPreview: false };
  const sent = [];
  const previewContext = { state: previewState, cameraRequestSequence: 0, updateInlineCameraPreview() {}, ipcRenderer: { send: (channel, payload) => sent.push(payload) } };
  vm.createContext(previewContext);
  vm.runInContext(source.slice(source.indexOf('function requestCameraPreview('), source.indexOf('function restoreCameraPreviewIfEnabled()')), previewContext);
  previewContext.requestCameraPreview(true, 'virtual');
  assert.equal(sent.at(-1).visible, false, '隐藏预览时不能在选设备或失败恢复时重新打开悬浮画面');
  previewState.showCameraPreview = true;
  previewContext.requestCameraPreview(true, 'virtual');
  assert.equal(sent.at(-1).visible, true);
  stage = '采集重试末段断言';
  let attempts = 0;
  const constraints = { video: { width: { exact: 3840 } } };
  const acquired = {};
  const retryContext = { navigator: { mediaDevices: { async getUserMedia(value) {
    assert.equal(value, constraints, '重试不得改变所选采集规格');
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('设备正在切换'), { name: 'OverconstrainedError' });
    return acquired;
  } } }, setTimeout: (callback) => callback() };
  vm.createContext(retryContext);
  vm.runInContext(source.slice(source.indexOf('async function acquireRecordingCamera('), source.indexOf('function releasePreparedSystemAudio(')), retryContext);
  assert.equal(await retryContext.acquireRecordingCamera(constraints), acquired);
  assert.equal(attempts, 3);
  attempts = 0;
  retryContext.navigator.mediaDevices.getUserMedia = async () => { attempts += 1; throw Object.assign(new Error('权限被拒绝'), { name: 'NotAllowedError' }); };
  await assert.rejects(retryContext.acquireRecordingCamera(constraints), /权限被拒绝/);
  assert.equal(attempts, 1, '权限错误不得反复请求');
  stage = '全部断言完成';
  console.log('摄像头交接回归通过：预览释放、录制启动与恢复、首帧等待、采集重试和权限错误。');
})().then(() => {
  clearTimeout(timeout);
}).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  process.exit(1);
});
