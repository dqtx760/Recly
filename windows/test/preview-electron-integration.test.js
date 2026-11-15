'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createPreviewMediaFixture } = require('./preview-media-fixture');

const windowsRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(windowsRoot, '..');
const defaultBuildRoot = path.join(repositoryRoot, 'builds', 'recording-optimization-20261017-214702');

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function hashFiles(files) {
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await hashFile(file)])));
}

async function runElectron() {
  const { app, BrowserWindow } = require('electron');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.disableHardwareAcceleration();
  await app.whenReady();
  const fixture = JSON.parse(process.env.RECLY_PREVIEW_FIXTURE);
  const previewModule = path.join(windowsRoot, 'src', 'renderer', 'editor', 'preview.js');
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  window.webContents.setAudioMuted(true);
  const hostFile = path.resolve(process.env.RECLY_PREVIEW_HOST_FILE);
  fs.writeFileSync(hostFile, '<meta charset="utf-8"><title>Recly preview sync integration</title>', 'utf8');
  await window.loadFile(hostFile);
  const report = await window.webContents.executeJavaScript(`(async () => {
    const assert = require('node:assert/strict');
    window.requestAnimationFrame = () => 0;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    const { Preview } = require(${JSON.stringify(previewModule)});
    const fixture = ${JSON.stringify(fixture)};
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const waitFor = async (predicate, label, timeout = 8000) => {
      const deadline = performance.now() + timeout;
      while (performance.now() < deadline) {
        if (predicate()) return;
        await wait(20);
      }
      throw new Error('等待超时：' + label);
    };
    const makeNode = (tag, file, muted) => {
      const node = document.createElement(tag);
      node.src = file;
      node.preload = 'auto';
      node.muted = muted;
      document.body.appendChild(node);
      return node;
    };
    const screenNode = makeNode('video', fixture.screenUrl, true);
    const cameraNode = makeNode('video', fixture.cameraUrl, true);
    const microphoneNode = makeNode('audio', fixture.microphoneUrl, false);
    await Promise.all([screenNode, cameraNode, microphoneNode].map((node) => new Promise((resolve, reject) => {
      if (node.readyState >= 3) return resolve();
      node.addEventListener('canplay', resolve, { once: true });
      node.addEventListener('error', () => reject(node.error || new Error('媒体加载失败')), { once: true });
      node.load();
    })));

    const segment = fixture.segments?.[0] || { sourceStart: 0, sourceEnd: fixture.duration, speed: 1 };
    const preview = Object.create(Preview.prototype);
    preview.store = { project: {
      timeline: { segments: fixture.segments || [segment] },
      audio: { isMicrophoneMuted: false, microphoneVolume: 1, isSystemMuted: true, systemVolume: 0 },
      camera: { isHidden: false, timeOffset: fixture.cameraTimeOffset || 0 },
    } };
    preview.time = 0.4;
    preview.playing = true;
    preview.lastTick = performance.now();
    preview.dirty = false;
    preview.screen = { node: screenNode, offset: fixture.screenOffset || 0, duration: fixture.duration, inRange: true };
    preview.camera = { node: cameraNode, offset: fixture.cameraOffset || 0, duration: fixture.cameraDuration || fixture.duration, inRange: true };
    preview.microphone = { node: microphoneNode, offset: fixture.microphoneOffset || 0, duration: fixture.microphoneDuration || fixture.duration, inRange: true };
    preview.system = null;
    preview.timelineAudio = new Map();
    preview.backgroundVideo = null;
    preview.onTime = () => {};
    preview.onState = () => {};
    preview.invalidate = () => {};
    preview.draw = () => {};
    preview.quality = 'balanced';
    preview.originalScreenUrl = fixture.screenUrl;
    preview.activeScreenUrl = fixture.screenUrl;
    preview.proxyFile = fixture.screenProxy;
    preview.readyProxyFile = fixture.screenProxy;
    preview.screenFrame = { mediaTime: null, presentedAt: 0 };
    preview.watchScreenFrame();

    const advanceFrame = () => preview.frame(performance.now());
    const sample = async (milliseconds) => {
      const values = [];
      let waitingSamples = 0;
      let waitingSince = null;
      let maxConsecutiveWaitingMs = 0;
      const deadline = performance.now() + milliseconds;
      while (performance.now() < deadline) {
        advanceFrame();
        const cameraWanted = preview.sourceTime - preview.camera.offset - (fixture.cameraTimeOffset || 0);
        const audioWanted = preview.sourceTime - preview.microphone.offset;
        const waiting = screenNode.seeking || cameraNode.seeking || microphoneNode.seeking
          || screenNode.readyState < 2 || cameraNode.readyState < 2 || microphoneNode.readyState < 2
          || microphoneNode.paused;
        const sampledAt = performance.now();
        if (waiting) {
          if (waitingSince === null) waitingSince = sampledAt;
          waitingSamples += 1;
          await wait(25);
          continue;
        }
        if (waitingSince !== null) {
          maxConsecutiveWaitingMs = Math.max(maxConsecutiveWaitingMs, sampledAt - waitingSince);
          waitingSince = null;
        }
        values.push({
          screen: screenNode.currentTime,
          camera: cameraNode.currentTime,
          audio: microphoneNode.currentTime,
          cameraDiff: Math.abs(cameraNode.currentTime - cameraWanted),
          audioDiff: Math.abs(microphoneNode.currentTime - audioWanted),
          timelineDiff: preview.screenFrame.mediaTime === null ? 0
            : Math.abs(preview.sourceTime - (preview.screenFrame.mediaTime
              + (performance.now() - preview.screenFrame.presentedAt) / 1000 + (preview.screen.offset || 0))),
          cameraRate: cameraNode.playbackRate,
          audioRate: microphoneNode.playbackRate,
        });
        await wait(25);
      }
      if (waitingSince !== null) {
        maxConsecutiveWaitingMs = Math.max(maxConsecutiveWaitingMs, performance.now() - waitingSince);
      }
      assert.ok(values.length > 0, '量测期间没有可用的连续播放样本');
      const observationCount = values.length + waitingSamples;
      const effectiveSampleRatio = values.length / observationCount;
      assert.ok(values.length >= Math.max(8, Math.floor(milliseconds / 50)),
        '有效播放样本不足：' + values.length + '/' + observationCount);
      assert.ok(effectiveSampleRatio >= 0.6, '有效播放采样占比低于 60%：' + effectiveSampleRatio);
      assert.ok(maxConsecutiveWaitingMs <= 300, '连续等待时间超过 300ms：' + maxConsecutiveWaitingMs + 'ms');
      return {
        samples: values.length,
        waitingSamples,
        effectiveSampleRatio,
        maxConsecutiveWaitingMs,
        maxCameraDiff: Math.max(...values.map((value) => value.cameraDiff)),
        maxAudioDiff: Math.max(...values.map((value) => value.audioDiff)),
        maxTimelineDiff: Math.max(...values.map((value) => value.timelineDiff)),
        cameraRates: [...new Set(values.map((value) => value.cameraRate))],
        audioRates: [...new Set(values.map((value) => value.audioRate))],
      };
    };

    preview.syncMedia(true);
    await waitFor(() => {
      preview.syncMedia(false);
      return !screenNode.paused && !cameraNode.paused && !microphoneNode.paused;
    }, '三条媒体轨开始播放');
    const continuous = await sample(fixture.sampleDurationMs || 1200);
    assert.ok(continuous.maxCameraDiff <= 0.08, '连续播放摄像头漂移超过 80ms：' + JSON.stringify(continuous));
    assert.ok(continuous.maxAudioDiff <= 0.08, '连续播放音频漂移超过 80ms：' + JSON.stringify(continuous));
    assert.ok(continuous.maxTimelineDiff <= 0.06, '播放时间线未跟随屏幕上呈现的画帧：' + JSON.stringify(continuous));
    assert.deepEqual(continuous.cameraRates, [1], '连续播放不应反复改写摄像头速度');

    if (fixture.mode === 'real-read-only') {
      preview.playing = false;
      preview.syncMedia(true);
      return {
        fixture: '用户工程只读媒体时钟量测；未读取或输出画面与声音内容',
        thresholdSeconds: 0.08,
        sampleDurationMs: fixture.sampleDurationMs,
        minimumEffectiveSampleRatio: 0.6,
        maximumConsecutiveWaitingMs: 300,
        offsets: {
          camera: preview.camera.offset,
          cameraTimeOffset: fixture.cameraTimeOffset || 0,
          microphone: preview.microphone.offset,
        },
        continuous,
      };
    }

    cameraNode.currentTime = Math.max(screenNode.currentTime - 0.6, 0);
    await waitFor(() => !cameraNode.seeking, '人为漂移定位完成');
    advanceFrame();
    const inducedDrift = Math.abs(cameraNode.currentTime - screenNode.currentTime);
    assert.ok(inducedDrift <= 0.08, '人为制造 600ms 漂移后未立即纠正：' + inducedDrift);

    cameraNode.currentTime = Math.min(screenNode.currentTime + 1.2, fixture.duration - 0.2);
    preview.time = screenNode.currentTime;
    preview.syncMedia(false);
    const audioPausedForCamera = microphoneNode.paused;
    assert.equal(audioPausedForCamera, true, '摄像头 seek 时音频仍在先行');
    await waitFor(() => !cameraNode.seeking && cameraNode.readyState >= 2, '摄像头 seek 完成');
    await waitFor(() => {
      advanceFrame();
      return !microphoneNode.paused;
    }, '摄像头就绪后音频恢复');

    preview.seek(3.0);
    await waitFor(() => !screenNode.seeking && !cameraNode.seeking && !microphoneNode.seeking, '预览跳转完成');
    const seek = await sample(500);
    assert.ok(seek.maxCameraDiff <= 0.08, '跳转后摄像头漂移超过 80ms：' + JSON.stringify(seek));
    assert.ok(seek.maxAudioDiff <= 0.08, '跳转后音频漂移超过 80ms：' + JSON.stringify(seek));

    preview.playing = false;
    preview.syncMedia(true);
    segment.speed = 1.5;
    preview.time = 1;
    preview.playing = true;
    preview.syncMedia(true);
    await waitFor(() => {
      preview.syncMedia(false);
      return !screenNode.paused && !cameraNode.paused && !microphoneNode.paused;
    }, '变速播放开始');
    const speed = await sample(700);
    assert.ok(speed.maxCameraDiff <= 0.08, '变速后摄像头漂移超过 80ms：' + JSON.stringify(speed));
    assert.ok(speed.maxAudioDiff <= 0.08, '变速后音频漂移超过 80ms：' + JSON.stringify(speed));
    assert.deepEqual(speed.cameraRates, [1.5], '摄像头应稳定使用片段速度');
    assert.deepEqual(speed.audioRates, [1.5], '音频应稳定使用片段速度');

    segment.speed = 1;
    preview.time = Math.min(screenNode.currentTime, 4.5);
    assert.equal(preview.applyReadyProxy(), true, '应切换到代理视频');
    await waitFor(() => screenNode.readyState >= 3 && !screenNode.seeking, '代理视频加载');
    await waitFor(() => {
      advanceFrame();
      return !cameraNode.paused && !microphoneNode.paused
        && cameraNode.playbackRate === 1 && microphoneNode.playbackRate === 1;
    }, '代理切换后媒体恢复');
    const proxy = await sample(700);
    assert.ok(proxy.maxCameraDiff <= 0.08, '代理切换后摄像头漂移超过 80ms：' + JSON.stringify(proxy));
    assert.ok(proxy.maxAudioDiff <= 0.08, '代理切换后音频漂移超过 80ms：' + JSON.stringify(proxy));

    preview.playing = false;
    preview.syncMedia(true);
    return {
      fixture: '合成时间码、整秒闪白和整秒音脉冲；不含真人口型',
      thresholdSeconds: 0.08,
      minimumEffectiveSampleRatio: 0.6,
      maximumConsecutiveWaitingMs: 300,
      continuous,
      inducedDrift,
      audioPausedForCamera,
      seek,
      speed,
      proxy,
      activeScreenSource: screenNode.src,
    };
  })().catch((error) => ({ __error: error.stack || error.message || String(error) }))`, true);
  if (report.__error) throw new Error(report.__error);
  await window.close();
  return report;
}

async function runHarness() {
  const buildRoot = path.resolve(process.env.RECLY_PREVIEW_TEST_ROOT || defaultBuildRoot);
  fs.mkdirSync(buildRoot, { recursive: true });
  const realProject = process.env.RECLY_PREVIEW_REAL_PROJECT ? path.resolve(process.env.RECLY_PREVIEW_REAL_PROJECT) : null;
  const reportFile = path.join(buildRoot, realProject ? 'preview-sync-real-project-report.json' : 'preview-sync-electron-report.json');
  const hostFile = path.join(buildRoot, 'preview-sync-host.html');
  let fixture;
  let sourceFiles = [];
  if (realProject) {
    const projectFile = path.join(realProject, 'project.json');
    const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    fixture = {
      mode: 'real-read-only',
      screen: path.join(realProject, project.media.screen.file),
      screenProxy: null,
      camera: path.join(realProject, project.media.camera.file),
      microphone: path.join(realProject, project.media.microphone.file),
      duration: project.media.screen.duration,
      cameraDuration: project.media.camera.duration,
      microphoneDuration: project.media.microphone.duration,
      screenOffset: project.media.screen.offset || 0,
      cameraOffset: project.media.camera.offset || 0,
      microphoneOffset: project.media.microphone.offset || 0,
      cameraTimeOffset: project.camera?.timeOffset || 0,
      segments: project.timeline.segments,
      sampleDurationMs: 30000,
    };
    sourceFiles = [projectFile, fixture.screen, fixture.camera, fixture.microphone];
  } else {
    const fixtureDirectory = path.join(buildRoot, 'preview-sync-media');
    fixture = createPreviewMediaFixture(fixtureDirectory);
  }
  const hashesBefore = realProject ? await hashFiles(sourceFiles) : null;
  const electronBinary = require('electron');
  const environment = {
    ...process.env,
    RECLY_PREVIEW_HOST_FILE: hostFile,
    RECLY_PREVIEW_FIXTURE: JSON.stringify({
      ...fixture,
      screenUrl: pathToFileURL(fixture.screen).href,
      cameraUrl: pathToFileURL(fixture.camera).href,
      microphoneUrl: pathToFileURL(fixture.microphone).href,
    }),
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [__filename, '--electron-preview-sync'], {
    cwd: windowsRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  const hashesAfter = realProject ? await hashFiles(sourceFiles) : null;
  if (realProject) {
    assert.deepEqual(hashesAfter, hashesBefore, '真实工程只读验收不得改写 project.json 或媒体文件');
  }
  assert.equal(exitCode, 0, `Electron 预览同步验收失败：\n${output}`);
  const marker = 'RECLY_PREVIEW_SYNC_REPORT=';
  const reportLine = output.split(/\r?\n/).find((line) => line.startsWith(marker));
  assert.ok(reportLine, `Electron 未返回预览同步报告：\n${output}`);
  const report = JSON.parse(reportLine.slice(marker.length));
  if (realProject) {
    report.readOnlyHashVerified = true;
  }
  fs.mkdirSync(buildRoot, { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`preview Electron integration passed\nreport: ${reportFile}\n`);
}

if (process.versions.electron && process.argv.includes('--electron-preview-sync')) {
  runElectron().then((report) => {
    process.stdout.write(`RECLY_PREVIEW_SYNC_REPORT=${JSON.stringify(report)}\n`);
    require('electron').app.quit();
  }).catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || JSON.stringify(error)}\n`);
    require('electron').app.exit(1);
  });
} else {
  runHarness().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
