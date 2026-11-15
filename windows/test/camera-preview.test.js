'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../src/renderer/camera.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function createCameraPage() {
  const listeners = new Map();
  const sent = [];
  const timers = new Map();
  let nextId = 0;
  let unload;
  const preview = { src: '', onload: null, onerror: null, removeAttribute() { this.src = ''; } };
  const context = {
    require(name) {
      assert.equal(name, 'electron');
      return { ipcRenderer: {
        on(channel, handler) { listeners.set(channel, handler); },
        send(channel, payload) { sent.push({ channel, payload }); },
      } };
    },
    document: { getElementById: () => preview },
    navigator: { mediaDevices: { getUserMedia() { throw new Error('悬浮窗不得再次采集摄像头'); } } },
    window: { addEventListener(name, handler) { if (name === 'beforeunload') unload = handler; } },
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(script, context);
  return {
    preview, timers, sent,
    request: (request) => listeners.get('camera:device')({}, request),
    frame: (frame) => listeners.get('camera:frame')({}, frame),
    load() { assert.ok(preview.onload); preview.onload(); },
    timeout() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
      assert.equal(timer.delay, 8000);
    },
    unload: () => unload(),
    status: () => sent.at(-1)?.payload,
  };
}

const page = createCameraPage();
assert.equal(page.sent.length, 0, '窗口加载不能隐式启动设备');
page.request({ requestId: 1, deviceId: 'camera' });
assert.equal(page.status().status, 'checking');
page.frame({ requestId: 0, dataUrl: 'data:image/jpeg;base64,stale' });
assert.equal(page.preview.src, '', '旧请求画面不能显示');
page.frame({ requestId: 1, dataUrl: 'invalid' });
assert.equal(page.preview.src, '');
page.frame({ requestId: 1, dataUrl: 'data:image/jpeg;base64,first' });
assert.equal(page.status().status, 'checking', '必须等图片真实加载成功');
page.load();
assert.equal(page.status().status, 'ready');
page.frame({ requestId: 1, dataUrl: 'data:image/jpeg;base64,second' });
page.frame({ requestId: 1, dataUrl: 'data:image/jpeg;base64,third' });
page.frame({ requestId: 1, dataUrl: 'data:image/jpeg;base64,fourth' });
assert.equal(page.preview.src, 'data:image/jpeg;base64,second');
page.load();
assert.equal(page.preview.src, 'data:image/jpeg;base64,fourth', '积压帧只保留最新一张');
page.load();
page.timeout();
assert.equal(page.status().error, 'frame_stalled');
assert.equal(page.preview.src, '', '停止更新后必须清掉旧图');
page.frame({ requestId: 1, dataUrl: 'data:image/jpeg;base64,recovered' });
page.load();
assert.equal(page.status().status, 'ready', '新画面恢复后可以重新就绪');
page.request({ requestId: 2, deviceId: 'camera2' });
assert.equal(page.preview.src, '');
page.timeout();
assert.equal(page.status().error, 'no_frame');
page.frame({ requestId: 2, dataUrl: 'data:image/jpeg;base64,broken' });
page.preview.onerror();
assert.equal(page.status().error, 'invalid_frame');
assert.equal(page.preview.src, '');
page.request({ requestId: 3 });
page.frame({ requestId: 3, dataUrl: 'data:image/jpeg;base64,last' });
const lateLoad = page.preview.onload;
page.unload();
lateLoad();
assert.equal(page.preview.src, '');
assert.equal(page.timers.size, 0);
assert.equal(page.preview.onload, null);
console.log('悬浮摄像头消费帧测试通过：不采集设备、请求隔离、真实加载、背压、新帧超时与清理。');
