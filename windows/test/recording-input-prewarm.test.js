'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/recorder.js'), 'utf8');
const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function track(kind) {
  const handlers = {};
  return { kind, readyState: 'live', stopped: 0,
    stop() { this.stopped++; this.readyState = 'ended'; },
    addEventListener(event, handler) { handlers[event] = handler; },
    end() { this.readyState = 'ended'; handlers.ended?.(); },
  };
}
class Stream {
  constructor(tracks) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(item => item.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(item => item.kind === 'video'); }
}
const microphoneRequests = [], systemRequests = [], meterStops = [], events = {};
const state = { mic: { on: true, deviceId: 'A' }, sys: { on: true }, cam: { on: false }, readiness: { ready: true } };
const context = vm.createContext({ state, Promise, Error, MediaStream: Stream,
  document: { hidden: true, addEventListener(event, callback) { events[event] = callback; } },
  window: { addEventListener(event, callback) { events[event] = callback; } },
  ipcRenderer: { on(event, callback) { events[event] = callback; } },
  navigator: { mediaDevices: {
    getUserMedia(constraints) { const gate = deferred(); microphoneRequests.push({ gate, constraints }); return gate.promise; },
    getDisplayMedia() { const gate = deferred(); systemRequests.push(gate); return gate.promise; },
  } },
  render() {}, updateDeviceNames() {},
  invalidateRecordingReadiness(reason) { state.readiness = { ready: false, reason }; },
  takeReadyInlineCameraStream: async () => null,
  stopInlineCameraPreview: async () => {},
  startMicrophoneMeter: async () => {},
  meterStops,
});
vm.runInContext(`
  let microphoneStream = null, microphoneStreamDeviceId = null, microphoneRequest = null, microphoneRequestDeviceId = null;
  let systemAudioStream = null, systemAudioRequest = null, systemAudioGeneration = 0, systemAudioRequestGeneration = -1;
  let rendererPageClosing = false;
  const device = id => id && id !== 'default' ? { deviceId: { exact: id } } : {};
  function stopMicrophoneMeter(stopStream) {
    meterStops.push(stopStream);
    if (stopStream && microphoneStream) { microphoneStream.getTracks().forEach(item => item.stop()); microphoneStream = null; microphoneStreamDeviceId = null; }
  }
  ${slice('async function acquireMicrophoneStream(', 'async function startMicrophoneMeter(')}
  ${slice('function releasePreparedSystemAudio(', 'async function prepareInputStreams(')}
  ${slice('async function openStreams()', 'function pickMimeType(')}
  ${slice("ipcRenderer.on('recorder:hidden'", "ipcRenderer.on('recorder:show-history'")}
  ${source.slice(source.lastIndexOf("document.addEventListener('visibilitychange'"))}
`, context);
const deadline = setTimeout(() => { console.error('输入预热测试未执行完成'); process.exit(1); }, 10000);
(async () => {
  const a = context.acquireMicrophoneStream();
  const aAgain = context.acquireMicrophoneStream();
  assert.equal(microphoneRequests.length, 1, '同设备并发准备只能打开一次');
  state.mic.deviceId = 'B';
  const b = context.acquireMicrophoneStream();
  const old = new Stream([track('audio')]);
  microphoneRequests[0].gate.resolve(old);
  await flush();
  assert.equal(old.getAudioTracks()[0].stopped, 1, '迟到旧设备必须释放');
  assert.equal(await a, null); assert.equal(await aAgain, null);
  assert.equal(microphoneRequests.length, 2);
  assert.equal(microphoneRequests[1].constraints.audio.deviceId.exact, 'B');
  const microphone = new Stream([track('audio')]);
  microphoneRequests[1].gate.resolve(microphone);
  assert.equal(await b, microphone, '隐藏窗口中仍接受所选设备的待机流');
  events['recorder:hidden']();
  events.visibilitychange();
  assert.equal(meterStops.at(-1), false, '隐藏只停止电平绘制，不释放输入');
  assert.equal(await context.acquireMicrophoneStream(), microphone);
  assert.equal(microphoneRequests.length, 2);

  const systemPending = context.acquireSystemAudioStream();
  const systemAgain = context.acquireSystemAudioStream();
  assert.equal(systemRequests.length, 1);
  const screen = track('video'), sound = track('audio');
  systemRequests[0].resolve(new Stream([screen, sound]));
  const system = await systemPending;
  assert.equal(await systemAgain, system);
  assert.equal(screen.stopped, 1); assert.equal(sound.stopped, 0);
  const borrowed = await context.openStreams();
  assert.equal(borrowed.streams.microphone, microphone);
  assert.equal(borrowed.streams.system, system);
  assert.equal(borrowed.problems.length, 0);
  assert.equal(systemRequests.length, 1); assert.equal(microphoneRequests.length, 2, '点击录制不得重新打开任何设备');
  context.releasePreparedSystemAudio();
  assert.equal(sound.stopped, 0, '已借出的录制轨道不再归待机清理所有');

  const latePending = context.acquireSystemAudioStream();
  state.sys.on = false; context.releasePreparedSystemAudio();
  const late = new Stream([track('video'), track('audio')]);
  systemRequests[1].resolve(late);
  assert.equal(await latePending, null);
  assert.ok(late.getTracks().every(item => item.readyState === 'ended'), '关闭后返回的系统流必须释放');
  state.sys.on = true;
  const finalPending = context.acquireSystemAudioStream();
  const finalSound = track('audio'); systemRequests[2].resolve(new Stream([track('video'), finalSound]));
  await finalPending;
  state.readiness = { ready: true }; finalSound.end();
  assert.equal(state.readiness.ready, false, '系统音轨断开必须撤销已就绪');
  state.readiness = { ready: true }; microphone.getAudioTracks()[0].end();
  assert.equal(state.readiness.ready, false, '麦克风断开必须撤销已就绪');
  events.pagehide();
  assert.equal(finalSound.stopped, 1); assert.equal(microphone.getAudioTracks()[0].stopped, 1, '页面关闭释放待机设备');
  assert.equal(await context.acquireSystemAudioStream(), null);
  assert.equal(await context.acquireMicrophoneStream(), null);

  state.cam.on = true;
  state.mic.deviceId = 'C';
  const missing = await context.openStreams();
  assert.equal(missing.problems.length, 3, '缺失热流应报告未就绪，不在点击后重新检测/打开');
  assert.equal(systemRequests.length, 3); assert.equal(microphoneRequests.length, 2);
  console.log('输入预热全部通过：同设备复用、旧请求隔离、隐藏保持、只借热流、关闭与迟到清理。');
})().then(() => clearTimeout(deadline)).catch(error => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
