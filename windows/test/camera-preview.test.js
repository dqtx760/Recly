'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../src/renderer/camera.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeStream() {
  const listeners = new Map();
  const track = {
    kind: 'video',
    stopCount: 0,
    stop() { this.stopCount += 1; },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); },
    end() { listeners.get('ended')?.(); },
  };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}

function createCameraPage() {
  const ipcListeners = new Map();
  const sent = [];
  const pendingStreams = [];
  const getUserMediaCalls = [];
  const frameCallbacks = new Map();
  const timers = new Map();
  const windowListeners = new Map();
  let nextId = 0;
  const video = {
    srcObject: null,
    readyState: 0,
    videoWidth: 0,
    play() { return Promise.resolve(); },
    pause() {},
    requestVideoFrameCallback(callback) {
      const id = ++nextId;
      frameCallbacks.set(id, callback);
      return id;
    },
    cancelVideoFrameCallback(id) { frameCallbacks.delete(id); },
    addEventListener() {},
    removeEventListener() {},
  };
  const context = {
    require(name) {
      assert.equal(name, 'electron');
      return {
        ipcRenderer: {
          on(channel, handler) { ipcListeners.set(channel, handler); },
          send(channel, message) { sent.push({ channel, message }); },
        },
      };
    },
    document: { getElementById: (id) => id === 'video' ? video : null },
    navigator: {
      mediaDevices: {
        getUserMedia(constraints) {
          getUserMediaCalls.push(constraints);
          const pending = deferred();
          pendingStreams.push(pending);
          return pending.promise;
        },
      },
    },
    window: {
      addEventListener(name, handler) { windowListeners.set(name, handler); },
    },
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(script, context, { filename: 'camera.html inline script' });

  return {
    video,
    sent,
    getUserMediaCalls,
    pendingStreams,
    frameCallbacks,
    timers,
    request: (request) => ipcListeners.get('camera:device')({}, request),
    setReady(readyState, videoWidth) {
      video.readyState = readyState;
      video.videoWidth = videoWidth;
    },
    frame() {
      const [id, callback] = frameCallbacks.entries().next().value || [];
      assert.ok(callback, '等待中的预览应注册首帧回调');
      frameCallbacks.delete(id);
      callback(1, {});
    },
    fireTimeout() {
      const [id, timer] = timers.entries().next().value || [];
      assert.ok(timer, '等待中的预览应设置无帧超时');
      timers.delete(id);
      timer.callback();
      return timer.delay;
    },
    unload: () => windowListeners.get('beforeunload')(),
    statuses: () => sent.filter((item) => item.channel === 'camera:status').map((item) => item.message),
  };
}

async function main() {
  const page = createCameraPage();
  assert.equal(page.getUserMediaCalls.length, 0, '页面加载时不能隐式打开默认摄像头');

  const failedOpen = page.request({ requestId: 1, deviceId: 'busy-camera' });
  page.pendingStreams[0].reject({ name: 'NotReadableError' });
  await failedOpen;
  assert.deepEqual(page.statuses().slice(-2).map(({ status }) => status), ['checking', 'error']);
  assert.equal(page.statuses().at(-1).error, 'device_in_use_or_unreadable');

  const firstFrameStream = makeStream();
  const openingWithFrame = page.request({ requestId: 2, deviceId: 'camera-2' });
  page.pendingStreams[1].resolve(firstFrameStream);
  await openingWithFrame;
  assert.equal(page.statuses().at(-1).status, 'checking', '拿到流后仍要等到首帧才能报告就绪');
  page.frame();
  assert.equal(page.statuses().at(-1).status, 'ready');
  assert.equal(page.statuses().at(-1).requestId, 2);
  assert.equal(firstFrameStream.track.stopCount, 0, '就绪预览应继续持有流');

  const alreadyDecodedStream = makeStream();
  const openingAlreadyDecoded = page.request({ requestId: 21, deviceId: 'camera-decoded' });
  page.setReady(2, 640);
  page.pendingStreams[2].resolve(alreadyDecodedStream);
  await openingAlreadyDecoded;
  assert.equal(page.statuses().at(-1).status, 'ready', '首帧在注册回调前已解码时也应立即报告就绪');
  page.setReady(0, 0);

  const noFrameStream = makeStream();
  const openingWithoutFrame = page.request({ requestId: 3, deviceId: 'camera-3' });
  assert.equal(firstFrameStream.track.stopCount, 1, '切换设备时应先停止旧流');
  page.pendingStreams[3].resolve(noFrameStream);
  await openingWithoutFrame;
  assert.equal(page.fireTimeout(), 8000);
  assert.equal(page.statuses().at(-1).status, 'error');
  assert.equal(page.statuses().at(-1).error, 'no_frame');
  assert.equal(noFrameStream.track.stopCount, 1, '无帧超时后应停止流');

  const hungOpen = page.request({ requestId: 4, deviceId: 'hung-camera' });
  assert.equal(page.statuses().at(-1).status, 'checking');
  assert.equal(page.fireTimeout(), 8000);
  assert.equal(page.statuses().at(-1).error, 'no_frame', 'getUserMedia 挂起也应受总超时约束');
  const lateAfterTimeout = makeStream();
  page.pendingStreams[4].resolve(lateAfterTimeout);
  await hungOpen;
  assert.equal(lateAfterTimeout.track.stopCount, 1, '超时后迟到的流必须立即停止');
  assert.equal(page.statuses().at(-1).error, 'no_frame', '超时后的迟到流不能恢复为就绪');

  const older = page.request({ requestId: 5, deviceId: 'slow-camera' });
  const newer = page.request({ requestId: 6, deviceId: 'fast-camera' });
  const newestStream = makeStream();
  page.pendingStreams[6].resolve(newestStream);
  await newer;
  const statusCountBeforeLateStream = page.statuses().length;
  const staleStream = makeStream();
  page.pendingStreams[5].resolve(staleStream);
  await older;
  assert.equal(staleStream.track.stopCount, 1, '迟到的旧流必须立即停止');
  assert.equal(page.statuses().length, statusCountBeforeLateStream, '旧请求不能发送迟到状态');
  page.frame();
  assert.equal(page.statuses().at(-1).requestId, 6);
  assert.equal(page.statuses().at(-1).status, 'ready');
  newestStream.track.end();
  assert.equal(page.statuses().at(-1).status, 'error', 'live track ended 后应将预览改为失败');
  assert.equal(page.statuses().at(-1).error, 'device_ended');
  assert.equal(newestStream.track.stopCount, 1);

  const closingStream = makeStream();
  const openingBeforeClose = page.request({ requestId: 7, deviceId: 'camera-before-close' });
  page.pendingStreams[7].resolve(closingStream);
  await openingBeforeClose;
  page.frame();
  assert.equal(page.statuses().at(-1).status, 'ready');

  page.unload();
  assert.equal(closingStream.track.stopCount, 1, '窗口卸载时应停止当前流');
  assert.equal(page.video.srcObject, null, '窗口卸载时应清除 video.srcObject');
  assert.equal(page.frameCallbacks.size, 0);
  assert.equal(page.timers.size, 0);

  assert.equal(page.getUserMediaCalls[1].video.deviceId.exact, 'camera-2');
  console.log('camera preview inline script tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
