'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

const root = path.join(os.tmpdir(), `dogsc-recording-icons-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
let activePresetStore = null;
const originalLoad = Module._load;
Module._load = function loadWithScreen(request, parent, isMain) {
  if (request === 'electron') {
    const display = {
      id: 1, label: '主显示器', isPrimary: true, scaleFactor: 1,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      workArea: { x: 0, y: 0, width: 800, height: 560 },
    };
    const secondaryDisplay = {
      id: 2, label: '高 DPI 显示器', isPrimary: false, scaleFactor: 1.5,
      bounds: { x: 800, y: -200, width: 640, height: 480 },
      workArea: { x: 800, y: -200, width: 640, height: 450 },
    };
    return {
      app: { getPath: () => path.join(root, 'user-data') },
      screen: {
        getPrimaryDisplay: () => display,
        getAllDisplays: () => [secondaryDisplay, display],
        dipToScreenRect: (_window, rect) => {
          const target = rect.x >= secondaryDisplay.bounds.x ? secondaryDisplay : display;
          const physicalOrigin = target.id === secondaryDisplay.id
            ? { x: 800, y: -300 }
            : { x: 0, y: 0 };
          return {
            x: physicalOrigin.x + (rect.x - target.bounds.x) * target.scaleFactor,
            y: physicalOrigin.y + (rect.y - target.bounds.y) * target.scaleFactor,
            width: rect.width * target.scaleFactor,
            height: rect.height * target.scaleFactor,
          };
        },
      },
    };
  }
  if (request === './presets' && parent && path.resolve(parent.filename) === path.resolve(__dirname, '../src/main/recording.js')) {
    return { getPresetStore: () => activePresetStore };
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
pointerModule.bringToFront = () => {};
pointerModule.windowRects = () => ({ frame: { x: 830, y: 350, width: 300, height: 70 } });
media = require('../src/main/ffmpeg');
recordingModule = require('../src/main/recording');
const { PresetStore } = require('../src/main/presets');
Module._load = originalLoad;

const { RecordingSession, listDisplays, resolveSource } = recordingModule;
const { getDefaultPresets } = require('../src/core/presets');

function makeIconSpy() {
  const calls = [];
  return { calls, hide: () => calls.push('hide'), restore: () => { calls.push('restore'); return true; } };
}

function makeFinishSession(name) {
  const session = new RecordingSession({
    projectsRoot: root,
    selection: { kind: 'display', displayId: 1 },
    name,
    desktopIcons: makeIconSpy(),
  });
  session.source = { description: { source: 'display', display: '测试显示器' } };
  session.firstFrameTime = 100;
  session.pointer = {
    hasClickSupport: true,
    stop: () => [{ time: 101, x: 0.5, y: 0.5, kind: 'leftClick' }],
  };
  session.capture = { stop: async () => {}, stderr: '' };
  session.frameRate = 30;
  session.markers = [{ id: 'kept', time: 1 }, { id: 'outside', time: 10 }];
  fs.mkdirSync(session.mediaDirectory, { recursive: true });
  return session;
}

async function run() {
  const previousStartCapture = media.startCapture;
  const previousRemuxToMp4 = media.remuxToMp4;
  const previousProbe = media.probe;
  const previousBuildVideoIndex = media.buildVideoIndex;
  const previousFinalizeAudio = media.finalizeAudio;
  const previousMakeThumbnails = media.makeThumbnails;
  const previousEnsurePreview = media.ensurePreview;
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
    await test('显示器列表保留工作区域，并按每台显示器的 DPI 换算物理尺寸', async () => {
      const displays = listDisplays();
      assert.deepEqual(displays.map((item) => item.id), [1, 2], '主显示器应先于其他输出');
      assert.deepEqual(displays[1].workArea, { x: 800, y: -200, width: 640, height: 450 });
      assert.deepEqual(displays[1].physical, { x: 800, y: -300, width: 960, height: 720 });
    });

    await test('整屏捕获范围按高 DPI 显示器工作区域裁掉任务栏', async () => {
      const source = resolveSource({ kind: 'display', displayId: 2 });
      assert.deepEqual(source.capture, { kind: 'area', outputIndex: 1, rect: { x: 0, y: 0, width: 960, height: 674 } });
      assert.deepEqual(source.getRect(), { x: 800, y: -300, width: 960, height: 674 });
      assert.deepEqual(source.description, {
        source: 'display', display: '高 DPI 显示器', rect: { x: 0, y: 0, width: 960, height: 674 },
      });
    });

    await test('选区与工作区域取交集，工作区域外的任务栏部分不进入录制', async () => {
      const source = resolveSource({ kind: 'area', displayId: 2, rect: { x: 100, y: 600, width: 300, height: 200 } });
      assert.deepEqual(source.capture, { kind: 'area', outputIndex: 1, rect: { x: 100, y: 600, width: 300, height: 74 } });
      assert.deepEqual(source.getRect(), { x: 900, y: 300, width: 300, height: 74 });
      assert.throws(
        () => resolveSource({ kind: 'area', displayId: 2, rect: { x: 100, y: 680, width: 200, height: 40 } }),
        /工作区域没有足够的重叠/,
      );
    });

    await test('窗口录制保留工作区域内的任务栏边缘，不按工作区域裁切', async () => {
      const source = resolveSource({ kind: 'window', hwnd: 123, title: '任务栏边缘窗口' });
      assert.deepEqual(source.capture, { kind: 'area', outputIndex: 1, rect: { x: 30, y: 650, width: 300, height: 70 } });
      assert.deepEqual(source.getRect(), { x: 830, y: 350, width: 300, height: 70 });
      assert.equal(source.description.source, 'window');
    });

    media.remuxToMp4 = async (_source, target) => fs.writeFileSync(target, 'synthetic video');
    media.probe = async () => ({ duration: 4, video: { width: 1920, height: 1080 } });
    media.buildVideoIndex = async () => ({ frames: [] });
    media.finalizeAudio = async (_source, target) => {
      fs.writeFileSync(target, 'synthetic audio');
      return { duration: 6 };
    };
    media.makeThumbnails = async () => ({ file: 'thumbnails.jpg' });
    media.ensurePreview = async (_source, target) => {
      fs.writeFileSync(target, 'synthetic proxy');
      return target;
    };

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

    await test('PresetStore 重建后新录制应用默认预设并保留媒体、音量和时间线', async () => {
      const storagePath = path.join(root, 'synthetic-presets.json');
      const firstStore = new PresetStore(storagePath);
      const selected = getDefaultPresets().find((preset) => preset.name === '极简纯色');
      assert.ok(firstStore.setDefault(selected.id));
      const afterRestart = new PresetStore(storagePath);
      assert.equal(afterRestart.getDefault().id, selected.id, '重建存储实例后应读回已选择的默认预设');

      const saved = afterRestart.getDefault();
      afterRestart.save({
        ...saved,
        isDefault: true,
        canvas: { ...saved.canvas, padding: 37 },
        camera: { ...saved.camera, shape: 'circle' },
        motion: { ...saved.motion, defaultZoomScale: 2.25 },
      });
      activePresetStore = new PresetStore(storagePath);
      assert.equal(activePresetStore.getDefault().motion.defaultZoomScale, 2.25);

      const session = makeFinishSession('preset-default-finish');
      const result = await session.finish([]);
      await result.thumbnailsReady;

      assert.equal(result.project.canvas.padding, 37);
      assert.equal(result.project.camera.shape, 'circle');
      assert.equal(result.project.motion.defaultZoomScale, 2.25);
      assert.equal(result.project.zoomAnimations.length, 1, '应基于预设运镜参数生成自动缩放');
      assert.equal(result.project.zoomAnimations[0].scale, 2.25);
      assert.deepEqual(result.project.audio, { systemVolume: 0.82, microphoneVolume: 1, isSystemMuted: false, isMicrophoneMuted: false });
      assert.equal(result.project.media.screen.file, 'media/screen.mp4');
      assert.equal(result.project.previewQuality, 'balanced');
      assert.equal(result.project.media.screen.preview, 'media/screen.preview.v3.mp4');
      assert.equal(result.project.media.pointer, 'media/pointer.json');
      const finishedProject = JSON.parse(fs.readFileSync(path.join(result.directory, 'project.json'), 'utf8'));
      assert.equal(finishedProject.media.screen.preview, 'media/screen.preview.v3.mp4', '代理路径应在打开编辑器前落盘');
      assert.equal(finishedProject.media.thumbnails.file, 'media/thumbnails.jpg', '缩略图应在打开编辑器前落盘');
      assert.equal(result.project.timeline.segments.length, 1);
      assert.equal(result.project.timeline.segments[0].sourceStart, 0, '未提交正式起点的旧调用保持从原素材0秒开始');
      assert.deepEqual(result.project.markers, [{ id: 'kept', time: 1 }]);
      assert.equal(result.project.export.frameRate, 30);
      const savedProject = finishedProject;
      assert.equal(savedProject.canvas.padding, 37, '应用后的项目外观应写入新项目文件');
    });

    await test('正式起点只提交一次并从默认成片排除准备时间，音轨偏移保持真实时钟差', async () => {
      const session = makeFinishSession('official-start-trim-finish');
      session.pointer.stop = () => [
        { time: 100.5, x: 0.5, y: 0.5, kind: 'leftClick' },
        { time: 103, x: 0.5, y: 0.5, kind: 'leftClick' },
      ];
      session.markers = [{ id: 'pre-roll', time: 1 }, { id: 'kept', time: 3 }];
      assert.equal(session.commitStart(102), 2);
      assert.equal(session.commitStart(103), 2, '重复提交不得移动正式起点');
      const microphoneRaw = path.join(session.mediaDirectory, 'microphone-raw.webm');
      fs.writeFileSync(microphoneRaw, Buffer.alloc(1024));

      const result = await session.finish([{ kind: 'microphone', file: microphoneRaw, startedAt: 99, hasAudio: true }]);
      await result.thumbnailsReady;

      assert.equal(result.project.timeline.segments[0].sourceStart, 2);
      assert.equal(result.project.timeline.segments[0].sourceEnd, 4);
      assert.equal(result.outputDuration, 2);
      assert.equal(result.project.media.microphone.offset, -1, '音轨偏移仍使用 startedAt-firstFrameTime');
      assert.deepEqual(result.project.markers, [{ id: 'kept', time: 3 }]);
      assert.equal(result.project.zoomAnimations.length, 1, '正式起点前的点击不得生成自动运镜');
    });

    await test('默认预设读取异常仍创建基础录制项目', async () => {
      activePresetStore = { getDefault: () => { throw new Error('synthetic preset storage failure'); } };
      const session = makeFinishSession('preset-default-error-finish');
      const warnings = [];
      const previousWarn = console.warn;
      let result;
      try {
        console.warn = (...args) => warnings.push(args.join(' '));
        result = await session.finish([]);
        await result.thumbnailsReady;
      } finally {
        console.warn = previousWarn;
      }

      assert.equal(result.project.canvas.padding, 100, '预设读取失败时应保留基础画布');
      assert.equal(result.project.motion.defaultZoomScale, 1.6, '预设读取失败时应保留基础运镜');
      assert.ok(fs.existsSync(path.join(result.directory, 'project.json')), '预设读取失败不应阻止项目落盘');
      assert.ok(warnings.some((warning) => warning.includes('synthetic preset storage failure')));
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
    media.remuxToMp4 = previousRemuxToMp4;
    media.probe = previousProbe;
    media.buildVideoIndex = previousBuildVideoIndex;
    media.finalizeAudio = previousFinalizeAudio;
    media.makeThumbnails = previousMakeThumbnails;
    media.ensurePreview = previousEnsurePreview;
    fs.rmSync = previousRmSync;
  }
  console.log(`诊断目录保留：${root}`);
  console.log(`全部 ${passed} 项录制生命周期恢复测试通过。`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
