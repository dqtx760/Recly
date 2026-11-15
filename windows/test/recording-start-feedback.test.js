'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const childProcess = require('node:child_process');

const rendererSource = fs.readFileSync(path.join(__dirname, '../src/renderer/recorder.js'), 'utf8');

async function test(name, body) {
  await body();
  console.log(`  ok  ${name}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createStartHarness({ openStreams, startGate = deferred(), prepareError, commitError } = {}) {
  const startOffset = rendererSource.indexOf('function beginStartFeedback()');
  const endOffset = rendererSource.indexOf('async function stop()', startOffset);
  const startSource = rendererSource.slice(startOffset, endOffset);
  const state = {
    starting: false,
    session: null,
    environment: { ok: true, encoder: 'test' },
    selection: { kind: 'display', displayId: 1 },
    cam: { on: false, deviceId: null },
    mic: { on: false },
    sys: { on: false },
    startError: '',
    finishing: false,
  };
  const startButton = { disabled: false, label: '' };
  const errorMessage = { hidden: true, textContent: '' };
  const busy = { hidden: true };
  const invokes = [];
  let streamOpens = 0;
  let recordingStarts = 0;
  let renders = 0;
  const elements = new Map([['busy', busy], ['start', startButton]]);
  const context = {
    state,
    Date,
    Promise,
    performance: { now: () => 1000 },
    $: (id) => id === 'recording-error' ? errorMessage : elements.get(id) || null,
    show() {},
    formatTime() {},
    render() {
      renders += 1;
      errorMessage.hidden = !state.startError;
      errorMessage.textContent = state.startError;
      startButton.label = state.session ? '结束录制' : state.starting ? '正在准备…' : 'REC';
    },
    openStreams: async () => {
      streamOpens += 1;
      return openStreams ? openStreams() : { streams: {}, problems: [] };
    },
    stopTracks: async () => [],
    stopInlineCameraPreview: async () => {},
    requestCameraPreview() {},
    startTrack() { throw new Error('此测试不应启动附加媒体轨'); },
    setTimeout: () => 1,
    clearTimeout() {},
    ipcRenderer: {
      invoke: async (channel, ...args) => {
        invokes.push({ channel, args });
        if (channel === 'recorder:prepare') {
          if (prepareError) throw prepareError;
          return { mediaDirectory: 'test-media' };
        }
        if (channel === 'recorder:start') {
          recordingStarts += 1;
          return startGate.promise;
        }
        if (channel === 'recorder:commit-start') {
          if (commitError) throw commitError;
          return { officialStartOffset: 0 };
        }
        if (channel === 'recorder:cancel') return true;
        return null;
      },
    },
  };
  vm.runInNewContext(startSource, context, { filename: 'recorder-start-flow.js' });
  return {
    state,
    startButton,
    errorMessage,
    invokes,
    startGate,
    start: context.start,
    get streamOpens() { return streamOpens; },
    get recordingStarts() { return recordingStarts; },
    get renders() { return renders; },
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = {
    write() { setImmediate(() => child.emit('close', 0)); return true; },
  };
  child.kill = () => setImmediate(() => child.emit('close', 0));
  return child;
}

async function testCapturePrewarm() {
  const originalSpawn = childProcess.spawn;
  const ffmpegPath = require.resolve('../src/main/ffmpeg');
  delete require.cache[ffmpegPath];
  const spawned = [];

  childProcess.spawn = (binary, args) => {
    const child = fakeChild();
    const captureGraph = args[args.indexOf('-filter_complex') + 1] || '';
    const isGpuProbe = args.includes('-frames:v') && captureGraph.includes('scale_d3d11=format=nv12');
    const isCapture = captureGraph.includes('setpts=');
    spawned.push({ binary, args, isGpuProbe, isCapture });
    if (isCapture) setTimeout(() => child.stderr.emit('data', Buffer.from('[Eval @ 0x1] 123.456\n')), 20);
    else setImmediate(() => child.emit('close', 0));
    return child;
  };

  try {
    const media = require('../src/main/ffmpeg');
    media.resolveBinaries('missing-test-resources');
    await media.detectEncoder();

    const source = { kind: 'area', outputIndex: 0, rect: { x: 0, y: 0, width: 640, height: 360 } };
    const captureOptions = { source, fps: 60, width: 640, height: 360 };
    const prepared = await media.prepareCapture(captureOptions);
    assert.deepEqual(prepared, { encoder: 'NVIDIA NVENC', gpuConversion: true });
    assert.equal(spawned.filter((item) => item.isGpuProbe).length, 1, '预热应完成两帧 GPU 转换探测');
    assert.equal(spawned.filter((item) => item.isCapture).length, 0, '预热不得启动持续采集进程');

    const capture = await media.startCapture({ ...captureOptions, file: 'screen.mkv' });
    let firstFrameReady = false;
    capture.firstFrame.then(() => { firstFrameReady = true; });
    await Promise.resolve();
    assert.equal(firstFrameReady, false, '命中预热缓存也不能虚报首帧就绪');
    assert.equal(spawned.filter((item) => item.isGpuProbe).length, 1, '首次 startCapture 应复用预热结果');
    await capture.firstFrame;
    assert.equal(firstFrameReady, true);
    await capture.stop();
    assert.equal(spawned.filter((item) => item.isCapture).length, 1, '预热后仍须启动真实屏幕采集进程');

    const otherSource = { ...source, outputIndex: 1 };
    await media.prepareCapture({ ...captureOptions, source: otherSource });
    assert.equal(spawned.filter((item) => item.isGpuProbe).length, 2, '不同显示器输出需要独立探测');
    const otherCapture = await media.startCapture({ ...captureOptions, source: otherSource, file: 'screen-2.mkv' });
    await otherCapture.firstFrame;
    await otherCapture.stop();
    assert.equal(spawned.filter((item) => item.isGpuProbe).length, 2, '不同条件的预热结果也应由 startCapture 复用');
    assert.equal(spawned.filter((item) => item.isCapture).length, 2);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[ffmpegPath];
  }
}

(async () => {
  await test('保留单一录制按钮，不再出现倒计时或重复控制面板', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer/recorder.html'), 'utf8');
    assert.doesNotMatch(html, /id=["']countdown["']/);
    assert.doesNotMatch(html, /id=["'](?:preparing|live|stop)["']/);
    assert.doesNotMatch(rendererSource, /runCountdown|recorder:countdown-show/);
  });

  await test('等待设备与屏幕首帧时处于准备中，重复开始不重入', async () => {
    const streamsGate = deferred();
    const startGate = deferred();
    const harness = createStartHarness({ openStreams: () => streamsGate.promise, startGate });
    const pending = harness.start();
    assert.equal(harness.state.starting, true);
    assert.equal(harness.state.session, null);
    assert.equal(harness.startButton.label, '正在准备…');

    await harness.start();
    assert.equal(harness.streamOpens, 1, '准备中重复触发不得再次打开设备');

    streamsGate.resolve({ streams: {}, problems: [] });
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.recordingStarts, 1);
    assert.equal(harness.state.starting, true);
    assert.equal(harness.state.session, null, 'recorder:start 未返回屏幕首帧前不能进入录制状态');

    await harness.start();
    assert.equal(harness.recordingStarts, 1, '等待屏幕首帧时重复触发不得重入');

    startGate.resolve(true);
    await pending;
    assert.equal(harness.state.starting, false);
    assert.ok(harness.state.session);
    assert.equal(harness.startButton.label, '结束录制');
  });

  await test('启动失败后结束准备状态并把错误显示在提示区', async () => {
    const harness = createStartHarness({ openStreams: async () => { throw new Error('模拟设备打开失败'); } });
    await harness.start();
    assert.equal(harness.state.starting, false);
    assert.equal(harness.state.session, null);
    assert.match(harness.state.startError, /模拟设备打开失败/);
    assert.equal(harness.errorMessage.hidden, false);
    assert.equal(harness.errorMessage.textContent, harness.state.startError);
    assert.ok(harness.renders >= 2);
  });

  await test('渲染层按真实启动状态显示准备文字和失败提示', async () => {
    const renderStart = rendererSource.indexOf('function render()');
    const renderEnd = rendererSource.indexOf('// ------------------------------------------------------------------ 目标源', renderStart);
    const renderFlow = rendererSource.slice(renderStart, renderEnd);
    assert.match(renderFlow, /state\.starting\s*\?\s*'正在准备…'/);
    assert.match(renderFlow, /recording-error[\s\S]*?hidden\s*=\s*!state\.startError/);
    assert.match(renderFlow, /recording-error[\s\S]*?textContent\s*=\s*state\.startError/);
  });

  await test('附加轨和屏幕首帧就绪并提交正式起点后才进入录制状态', async () => {
    const startFlow = rendererSource.slice(rendererSource.indexOf('async function start()'), rendererSource.indexOf('async function stop()'));
    assert.match(startFlow, /beginStartFeedback\(\);[\s\S]*?await openStreams\(\)/);
    assert.match(startFlow, /await Promise\.all\(tracks\.map\(\(track\) => track\.started\)\)/);
    assert.match(startFlow, /await ipcRenderer\.invoke\('recorder:start'\);[\s\S]*?await ipcRenderer\.invoke\('recorder:commit-start'\);[\s\S]*?state\.session =/);
    assert.ok(startFlow.indexOf('state.session = {') > startFlow.indexOf("ipcRenderer.invoke('recorder:commit-start')"), '正式录制状态只能在提交真实屏幕首帧起点后进入');
  });

  await test('正式起点提交失败按 recording 阶段清理且不进入录制状态', async () => {
    const harness = createStartHarness({ commitError: new Error('模拟正式起点提交失败') });
    const pending = harness.start();
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.recordingStarts, 1);
    harness.startGate.resolve(true);
    await pending;
    const cancellation = harness.invokes.find((call) => call.channel === 'recorder:cancel');
    assert.equal(cancellation?.args[0], 'recording');
    assert.equal(harness.state.starting, false);
    assert.equal(harness.state.session, null);
    assert.equal(harness.errorMessage.hidden, false);
    assert.match(harness.errorMessage.textContent, /模拟正式起点提交失败/);
  });

  await test('预热当前参数后首次采集复用探测、另有条件重探且仍等待真实首帧', testCapturePrewarm);

  console.log('录制启动反馈与探测缓存测试全部通过。');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
