'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../src/renderer/recorder.js');
const htmlPath = path.join(__dirname, '../src/renderer/recorder.html');
const mainPath = path.join(__dirname, '../src/main/main.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class MockElement {
  constructor(id = '', tagName = 'DIV') {
    this.id = id;
    this.tagName = tagName;
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.title = '';
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = {
      values: new Set(),
      add: (...items) => items.forEach((item) => this.classList.values.add(item)),
      remove: (...items) => items.forEach((item) => this.classList.values.delete(item)),
      toggle: (item, force) => {
        const enabled = force === undefined ? !this.classList.values.has(item) : Boolean(force);
        if (enabled) this.classList.values.add(item);
        else this.classList.values.delete(item);
        return enabled;
      },
      contains: (item) => this.classList.values.has(item),
    };
  }

  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(handler);
  }

  click() {
    if (this.disabled) return;
    for (const handler of this.listeners.get('click') || []) {
      handler({ target: this, preventDefault() {}, stopPropagation() {} });
    }
  }

  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || ''; }
  closest() { return null; }
  querySelector(selector) {
    if (selector === 'span' || selector === '.rec-label') return this.children.find((child) => child.tagName === 'SPAN') || null;
    if (selector === 'b') return this.children.find((child) => child.tagName === 'B') || null;
    if (selector === 'small') return this.children.find((child) => child.tagName === 'SMALL') || null;
    return null;
  }
}

function makeStream({ audio = 0, video = 0 } = {}) {
  const makeTrack = (kind) => ({ kind, stopped: false, stop() { this.stopped = true; } });
  const audioTracks = Array.from({ length: audio }, () => makeTrack('audio'));
  const videoTracks = Array.from({ length: video }, () => makeTrack('video'));
  return {
    getTracks: () => [...audioTracks, ...videoTracks],
    getAudioTracks: () => audioTracks,
    getVideoTracks: () => videoTracks,
  };
}

function createHarness(options = {}) {
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
  const elements = new Map(ids.map((id) => [id, new MockElement(id)]));
  elements.get('busy').hidden = true;
  elements.get('done').hidden = true;
  elements.get('start').appendChild(new MockElement('', 'SPAN'));
  const markerSpan = new MockElement('', 'SPAN');
  elements.get('marker').appendChild(markerSpan);
  for (const id of ['hint']) {
    elements.get(id).appendChild(new MockElement('', 'B'));
    elements.get(id).appendChild(new MockElement('', 'SMALL'));
  }

  const sourceButtons = ['display', 'window', 'area'].map((kind) => {
    const button = new MockElement();
    button.dataset.source = kind;
    button.appendChild(new MockElement('', 'SPAN'));
    return button;
  });

  const ipcHandlers = new Map();
  const sends = [];
  const invokes = [];
  let now = 1000;
  const startGate = options.startGate || deferred();
  const microphoneGate = options.microphoneGate || null;
  let microphoneOpens = 0;

  const invoke = async (channel, ...args) => {
    invokes.push({ channel, args });
    if (channel === 'recorder:displays') return [{ id: 1, label: '主显示器', isPrimary: true, physical: { width: 1920, height: 1080 } }];
    if (channel === 'config:get-hide-desktop-icons') return false;
    if (channel === 'app:environment') return { ok: true, encoder: 'h264_nvenc', projectsRoot: 'D:\\Videos\\DogSC' };
    if (channel === 'config:get-projects-root') return 'D:\\Videos\\DogSC';
    if (channel === 'config:get-export-root') return '';
    if (channel === 'recorder:prepare') {
      if (options.prepareError) throw options.prepareError;
      return { mediaDirectory: 'D:\\Videos\\DogSC\\test\\media' };
    }
    if (channel === 'recorder:start') return startGate.promise;
    if (channel === 'recorder:commit-start') {
      if (options.commitError) throw options.commitError;
      return { officialStartOffset: 3 };
    }
    if (channel === 'recorder:stop') return { directory: 'D:\\Videos\\DogSC\\test.dogscproject' };
    if (channel === 'recorder:cancel') return true;
    return null;
  };

  const ipcRenderer = {
    invoke,
    send(channel, ...args) { sends.push({ channel, args }); },
    on(channel, handler) {
      if (!ipcHandlers.has(channel)) ipcHandlers.set(channel, []);
      ipcHandlers.get(channel).push(handler);
    },
  };

  class MockMediaRecorder {
    static isTypeSupported() { return true; }
    constructor(stream) {
      this.stream = stream;
      this.state = 'inactive';
      this.onstart = null;
      this.onstop = null;
      this.ondataavailable = null;
    }
    start() {
      this.state = 'recording';
      queueMicrotask(() => this.onstart?.());
    }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => this.onstop?.());
    }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
  }

  class MockMediaStream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  }

  const saved = {
    mic: options.mic ?? true,
    cam: options.cam ?? false,
    sys: options.sys ?? false,
  };
  const body = new MockElement('body');
  const context = {
    Buffer,
    Date,
    Promise,
    performance: { now: () => now },
    console,
    localStorage: {
      getItem: () => JSON.stringify(saved),
      setItem() {},
    },
    document: {
      body,
      getElementById: (id) => elements.get(id) || null,
      querySelectorAll: (selector) => selector === '.source' ? sourceButtons : [],
    },
    window: { alert() {} },
    navigator: {
      mediaDevices: {
        enumerateDevices: async () => [],
        getUserMedia: async (constraints) => {
          if (constraints.audio) {
            microphoneOpens += 1;
            if (options.microphoneError) throw options.microphoneError;
            if (microphoneGate) return microphoneGate.promise;
            return makeStream({ audio: 1 });
          }
          return makeStream({ video: 1 });
        },
        getDisplayMedia: async () => makeStream({ audio: 1, video: 1 }),
      },
    },
    MediaRecorder: MockMediaRecorder,
    MediaStream: MockMediaStream,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    queueMicrotask,
  };
  context.global = context;
  context.require = (id) => {
    if (id === 'electron') return { ipcRenderer };
    if (id === './common') return { icon: () => '', formatTime: () => '00:00' };
    if (id === './editor/shortcuts-modal') return { openShortcutsModal() {} };
    return require(id);
  };

  vm.runInNewContext(source, context, { filename: sourcePath });

  const emit = (channel, ...args) => {
    for (const handler of ipcHandlers.get(channel) || []) handler({}, ...args);
  };
  const flush = async (rounds = 8) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const visiblePanel = () => ['idle', 'busy', 'done'].find((id) => elements.get(id) && !elements.get(id).hidden);

  return {
    elements,
    sends,
    invokes,
    body,
    startGate,
    emit,
    flush,
    visiblePanel,
    microphoneOpens: () => microphoneOpens,
  };
}

async function test(name, body) {
  await body();
  console.log(`  ok  ${name}`);
}

(async () => {
  await test('主控台共用录制按钮并移除独立启动和录制面板', async () => {
    assert.doesNotMatch(html, /id=["']countdown["']/);
    assert.doesNotMatch(html, /id=["'](?:preparing|live|stop)["']/);
    assert.doesNotMatch(source, /runCountdown|recorder:countdown-show/);
  });

  await test('摄像头录制流打开后才关闭悬浮预览请求', async () => {
    const harness = createHarness({ cam: true, mic: false });
    await harness.flush();
    harness.emit('recorder:start');
    await harness.flush();
    const feedbackIndex = harness.sends.findIndex((call) => call.channel === 'recorder:startup-feedback');
    const closePreviewIndex = harness.sends.findIndex((call) => call.channel === 'recorder:camera-preview' && call.args[0]?.visible === false);
    assert.ok(feedbackIndex >= 0 && closePreviewIndex > feedbackIndex, '应先隐藏窗口，再在录制摄像头流已取得后关闭预览流');
  });

  await test('触发后立即隐藏控制台，采集就绪后马上提交起点且重复快捷键不重入', async () => {
    const microphoneGate = deferred();
    const harness = createHarness({ microphoneGate });
    await harness.flush();

    harness.emit('recorder:start');
    await harness.flush();
    assert.equal(harness.visiblePanel(), 'idle');
    assert.match(harness.elements.get('start').querySelector('.rec-label').textContent, /正在准备录制/);
    assert.equal(harness.sends[0]?.channel, 'recorder:startup-feedback', '启动事件循环内应先请求隐藏控制台和摄像头预览');
    assert.equal(harness.sends.some((call) => call.channel === 'recorder:countdown-show'), false);
    assert.equal(harness.microphoneOpens(), 1);

    harness.emit('recorder:start');
    harness.emit('recorder:toggle');
    await harness.flush();
    assert.equal(harness.microphoneOpens(), 1, '准备中重复快捷键不得再次打开麦克风');

    microphoneGate.resolve(makeStream({ audio: 1 }));
    await harness.flush();
    assert.equal(harness.elements.get('start').disabled, true);
    assert.equal(harness.invokes.filter((call) => call.channel === 'recorder:start').length, 1);

    harness.startGate.resolve(true);
    await harness.flush();
    assert.equal(harness.visiblePanel(), 'idle');
    assert.equal(harness.invokes.filter((call) => call.channel === 'recorder:commit-start').length, 1);
    assert.equal(harness.sends.some((call) => call.channel === 'recorder:countdown-show'), false);
    const end = harness.sends.find((call) => call.channel === 'recorder:startup-feedback-end');
    assert.equal(end?.args[0]?.success, true);
    assert.equal(harness.elements.get('start').querySelector('.rec-label').textContent, '结束录制');
    harness.elements.get('start').click();
    await harness.flush();
    assert.equal(harness.invokes.filter((call) => call.channel === 'recorder:stop').length, 1);
    assert.equal(harness.elements.get('start').querySelector('.rec-label').textContent, '开始录制');
  });

  await test('启动失败回到待机并结束置顶反馈', async () => {
    const harness = createHarness({ prepareError: new Error('模拟准备失败') });
    await harness.flush();
    harness.emit('recorder:start');
    await harness.flush();

    assert.equal(harness.visiblePanel(), 'idle');
    const end = harness.sends.find((call) => call.channel === 'recorder:startup-feedback-end');
    assert.equal(end?.args[0]?.success, false);
  });

  await test('设备打开也处于统一失败清理范围，异常不会把界面锁在准备中', async () => {
    const startFlow = source.slice(source.indexOf('async function start()'), source.indexOf('async function stop(discard)'));
    assert.match(startFlow, /try\s*\{\s*\(\{ streams, problems \} = await openStreams\(\)\)/, 'openStreams 必须位于启动流程的 try 内');
    assert.match(startFlow, /catch \(error\)\s*\{\s*await fail\(error\)/, '设备打开异常必须进入统一失败清理');
  });

  await test('正式起点提交失败会按 recording 阶段清理并恢复界面', async () => {
    const harness = createHarness({ commitError: new Error('模拟提交失败') });
    await harness.flush();
    harness.emit('recorder:start');
    await harness.flush();
    harness.startGate.resolve(true);
    await harness.flush();
    assert.equal(harness.visiblePanel(), 'idle');
    const cancel = harness.invokes.find((call) => call.channel === 'recorder:cancel');
    assert.equal(cancel?.args[0], 'recording');
    const end = harness.sends.find((call) => call.channel === 'recorder:startup-feedback-end');
    assert.equal(end?.args[0]?.success, false);
  });

  await test('未开启麦克风时明确说明状态，不声称检测到人声', async () => {
    const harness = createHarness({ mic: false });
    await harness.flush();
    harness.emit('recorder:start');
    await harness.flush();
    harness.startGate.resolve(true);
    await harness.flush();
    assert.equal(harness.elements.get('mic-status').textContent, '关闭');
  });

  await test('麦克风打开失败时录屏可降级继续，但不提示可以讲话', async () => {
    const harness = createHarness({ microphoneError: new Error('模拟麦克风被占用') });
    await harness.flush();
    harness.emit('recorder:start');
    await harness.flush();
    harness.startGate.resolve(true);
    await harness.flush();
    assert.equal(harness.visiblePanel(), 'idle');
    assert.equal(harness.elements.get('mic-status').textContent, '未能打开');
  });

  await test('主进程立即最小化控制台并隐藏摄像头，提交起点校验发送者', async () => {
    const main = fs.readFileSync(mainPath, 'utf8');
    const handlers = main.slice(main.indexOf("ipcMain.on('recorder:startup-feedback'"), main.indexOf("ipcMain.on('window:close'"));
    assert.match(handlers, /event\.sender\s*!==\s*recorderWindow\.webContents/);
    assert.match(handlers, /recorderWindow\.minimize\(\)/);
    assert.match(handlers, /cameraWindow[\s\S]*?cameraWindow\.hide\(\)/);
    assert.match(main, /recordingStartupFeedbackActive[\s\S]*?ready-to-show[\s\S]*?!recordingStartupFeedbackActive[\s\S]*?showInactive\(\)/, '摄像头窗口晚到的 ready-to-show 也不能在准备阶段重新闪现');
    assert.match(handlers, /setIgnoreMouseEvents\(true\)/);
    assert.match(handlers, /setAlwaysOnTop\(false\)/);
    assert.match(handlers, /setIgnoreMouseEvents\(false\)/);
    assert.match(handlers, /success[\s\S]*?minimize\(\)/);
    const commit = main.slice(main.indexOf("ipcMain.handle('recorder:commit-start'"), main.indexOf("ipcMain.handle('recorder:marker'"));
    assert.match(commit, /event\.sender\s*!==\s*recorderWindow\.webContents/);
    assert.match(commit, /recording\.commitStart\(\)/);
    const hideHandler = main.slice(main.indexOf("ipcMain.on('recorder:hide'"), main.indexOf("ipcMain.on('window:close'"));
    assert.match(hideHandler, /setAlwaysOnTop\(false\)[\s\S]*?hide\(\)/);
    assert.match(main, /excludeFromCapture\(recorderWindow\)/);
  });

  console.log('录制启动反馈测试全部通过。');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
