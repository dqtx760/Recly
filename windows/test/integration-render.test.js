'use strict';

const assert = require('node:assert/strict');
const model = require('../src/core/model');
const scene = require('../src/core/scene');
const { NormalizedCrop, ScreenFrameStyle } = require('../src/core/crop-frame');
const { ProjectedScreenQuad } = require('../src/core/projection');
const { MosaicClip, StickerClip, OpeningSequence } = require('../src/core/opening-overlay');
const { CameraMotionClip } = require('../src/core/camera-motion');
const { Compositor, createMockCanvas } = require('../src/renderer/editor/render');

const near = (actual, expected, tolerance = 1e-4, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected}, got ${actual}`);

let passed = 0;
const test = (name, body) => {
  body();
  passed += 1;
  console.log(`  ok  ${name}`);
};

console.log('Running integration-render.test.js...');

// ==========================================
// 1. evaluateScene with complete features
// ==========================================

test('evaluateScene: full integration with crop, windowLight chrome, converge opening, mosaics & stickers', () => {
  const project = model.makeProject({
    name: 'Integration Test Project',
    media: { screen: { duration: 10, width: 1920, height: 1080 } },
    capture: {},
  });

  // 1. 归一化裁切 (NormalizedCrop)
  project.canvas.crop = new NormalizedCrop(0.1, 0.1, 0.8, 0.8);

  // 2. 窗口装饰外框 (windowLight)
  project.canvas.screenFrame = 'windowLight';
  project.canvas.screenFrameTitle = 'DogSC Studio Pro';
  project.canvas.screenFrameScale = 1.0;
  project.canvas.screenFrameToolbarScale = 1.0;

  // 3. 3D 旋转角度
  project.canvas.rotationX = 12;
  project.canvas.rotationY = -18;
  project.canvas.rotationZ = 3;
  project.canvas.perspective = 0.6;

  // 4. 开场动画编排 (converge)
  project.openingSequence = new OpeningSequence({
    isEnabled: true,
    preset: 'converge',
    duration: 2.0,
    elementOrder: ['screen', 'camera', 'stickers'],
    includedElements: ['screen', 'camera', 'stickers'],
    staggerDuration: 0.16,
  });

  // 5. 局部马赛克 (MosaicClip)
  const mosaic = new MosaicClip({
    id: 'mos-1',
    timing: { startTime: 0, duration: 4.0 },
    sourceRect: { x: 0.2, y: 0.25, width: 0.35, height: 0.25 },
    style: 'blur',
    intensity: 0.75,
  });
  project.timeline.mosaicClips = [mosaic];

  // 6. 贴图片段 (StickerClip)
  const sticker = new StickerClip({
    id: 'stk-1',
    timing: { startTime: 0, duration: 5.0 },
    position: { x: 0.5, y: 0.4 },
    width: 0.32,
    animation: 'pop',
    cornerRadius: 16,
    borderWidth: 2,
    borderColor: '#3B82F6',
    shadowOpacity: 0.35,
  });
  project.timeline.stickerClips = [sticker];

  // 7. 摄像运镜片段 (CameraMotionClip)
  const cameraMotion = new CameraMotionClip({
    id: 'cam-1',
    timing: { startTime: 0, duration: 3.0, leadInDuration: 0.6 },
    target: {
      shape: 'circle',
      position: { x: 0.2, y: 0.3 },
      size: 0.4,
      roundness: 0.5,
    },
  });
  project.timeline.cameraMotionClips = [cameraMotion];

  // 在开场动画中间时刻（time = 0.8s）进行场景评估
  const evaluated = scene.evaluateScene(project, {
    time: 0.8,
    width: 1920,
    height: 1080,
    sourceAspect: 16 / 9,
    cameraAspect: 16 / 9,
    zoomClips: [],
    pointerTrack: null,
  });

  // 验证返回的场景结构包含全部新增字段
  assert.ok(evaluated.crop instanceof NormalizedCrop, 'evaluated.crop must be NormalizedCrop instance');
  assert.equal(evaluated.crop.width, 0.8);
  assert.equal(evaluated.crop.height, 0.8);
  assert.equal(evaluated.screen.crop, evaluated.crop);

  // 验证屏幕装饰 (FrameScreenDecoration)
  assert.ok(evaluated.decoration, 'evaluated.decoration must exist');
  assert.equal(evaluated.decoration.style, 'windowLight');
  assert.equal(evaluated.decoration.kind, 'window');
  assert.equal(evaluated.decoration.title, 'DogSC Studio Pro');
  assert.ok(evaluated.decoration.toolbarRect, 'toolbarRect must be calculated');
  assert.ok(evaluated.decoration.outerRect, 'outerRect must be calculated');
  const ctrlButtons = evaluated.decoration.controls.buttons || evaluated.decoration.controls;
  assert.equal(ctrlButtons.length, 3, 'controls must have 3 window buttons');

  // 验证 3D 透视四边形 (ProjectedScreenQuad)
  assert.ok(evaluated.projectedQuad instanceof ProjectedScreenQuad, 'projectedQuad must be ProjectedScreenQuad');
  const corners = evaluated.projectedQuad.corners;
  assert.equal(corners.length, 4);
  for (const pt of corners) {
    assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y), 'corner coordinates must be finite');
  }
  // 由于 rotationY = -18，左侧与右侧的 X 坐标与高度必然存在透视差
  const leftHeight = evaluated.projectedQuad.bottomLeft.y - evaluated.projectedQuad.topLeft.y;
  const rightHeight = evaluated.projectedQuad.bottomRight.y - evaluated.projectedQuad.topRight.y;
  assert.notEqual(leftHeight, rightHeight, '3D rotation must yield perspective distortion');
  assert.equal(evaluated.screen.projectedQuad, evaluated.projectedQuad);

  // 验证马赛克求值 (mosaics)
  assert.ok(Array.isArray(evaluated.mosaics), 'mosaics must be an array');
  assert.equal(evaluated.mosaics.length, 1);
  const m = evaluated.mosaics[0];
  assert.equal(m.style, 'blur');
  assert.equal(m.intensity, 0.75);
  assert.ok(m.transitionProgress > 0, 'mosaic transitionProgress must be active');

  // 验证贴图求值 (stickers)
  assert.ok(Array.isArray(evaluated.stickers), 'stickers must be an array');
  assert.equal(evaluated.stickers.length, 1);
  const s = evaluated.stickers[0];
  assert.equal(s.id, 'stk-1');
  assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y));
  assert.ok(s.width > 0 && s.height > 0);
  assert.ok(s.opacity > 0);
  assert.equal(s.borderColor, '#3B82F6');

  // 验证开场序列状态 (opening)
  assert.ok(evaluated.opening, 'scene.opening must exist');
  assert.ok(evaluated.opening.scale !== undefined);
  assert.ok(evaluated.opening.screen, 'opening.screen must exist');
  assert.ok(evaluated.opening.camera, 'opening.camera must exist');
  assert.ok(evaluated.opening.stickers, 'opening.stickers must exist');

  // 验证摄像头融合摄像运动与开场动画
  assert.ok(evaluated.camera, 'scene.camera must exist');
  assert.ok(evaluated.camera.rect.width > 0);
  assert.ok(evaluated.camera.rect.height > 0);
  assert.ok(evaluated.camera.opacity > 0);
});

// ==========================================
// 2. 浏览器外框与地址栏测试 (browserLight / browserDark)
// ==========================================

test('evaluateScene: browserLight creates address bar chrome', () => {
  const project = model.makeProject({
    name: 'Browser Test',
    media: { screen: { duration: 10, width: 1920, height: 1080 } },
    capture: {},
  });

  project.canvas.screenFrame = 'browserLight';
  project.canvas.screenFrameBrowserAddress = 'https://github.com/laogou717/dogsc';
  project.canvas.screenFrameTitle = 'DogSC Repository';

  const evaluated = scene.evaluateScene(project, {
    time: 0,
    width: 1920,
    height: 1080,
    sourceAspect: 16 / 9,
    cameraAspect: null,
  });

  assert.equal(evaluated.decoration.kind, 'browser');
  assert.equal(evaluated.decoration.browserAddress, 'https://github.com/laogou717/dogsc');
  assert.ok(evaluated.decoration.addressFieldRect, 'addressFieldRect must be generated');
  assert.ok(evaluated.decoration.addressFieldRect.width > 100);
  assert.ok(evaluated.decoration.addressFieldRect.height > 10);
});

// ==========================================
// 3. 手机外框测试 (devicePhone)
// ==========================================

test('evaluateScene: devicePhone creates perimeter bezel expansion', () => {
  const project = model.makeProject({
    name: 'Phone Test',
    media: { screen: { duration: 10, width: 1080, height: 1920 } },
    capture: {},
  });

  project.canvas.screenFrame = 'devicePhone';

  const evaluated = scene.evaluateScene(project, {
    time: 0,
    width: 1080,
    height: 1920,
    sourceAspect: 9 / 16,
    cameraAspect: null,
  });

  const dec = evaluated.decoration;
  assert.equal(dec.kind, 'devicePhone');
  // 手机边框外扩：outerRect 的宽和高必然大于 contentRect (screen.finalRect)
  assert.ok(dec.outerRect.width > dec.contentRect.width, 'outer width must be greater than content width');
  assert.ok(dec.outerRect.height > dec.contentRect.height, 'outer height must be greater than content height');
  assert.ok(dec.outerCornerRadius > dec.contentCornerRadius, 'outer corner radius must be larger than content corner radius');
});

// ==========================================
// 4. Compositor 渲染测试 (Node.js 运行环境与离线绘制验证)
// ==========================================

test('Compositor: draw 2D decorated screen, mosaics, stickers & camera', () => {
  const compositor = new Compositor('.');

  const project = model.makeProject({
    name: 'Render Test',
    media: { screen: { duration: 10, width: 1920, height: 1080 } },
    capture: {},
  });
  project.canvas.screenFrame = 'windowLight';
  project.canvas.screenFrameTitle = 'Render Test';

  const mosaic = new MosaicClip({
    id: 'mos-1',
    timing: { startTime: 0, duration: 4.0 },
    sourceRect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
    style: 'blur',
  });
  const sticker = new StickerClip({
    id: 'stk-1',
    timing: { startTime: 0, duration: 4.0 },
    position: { x: 0.5, y: 0.5 },
    width: 0.25,
  });
  project.timeline.mosaicClips = [mosaic];
  project.timeline.stickerClips = [sticker];

  const evaluated = scene.evaluateScene(project, {
    time: 1.0,
    width: 1920,
    height: 1080,
    sourceAspect: 16 / 9,
    cameraAspect: 16 / 9,
  });

  // 创建 Node.js 兼容模拟画布与上下文
  const canvas = createMockCanvas(1920, 1080);
  const ctx = canvas.getContext('2d');

  // 模拟视频源帧
  const mockFrame = {
    width: 1920,
    height: 1080,
    displayWidth: 1920,
    displayHeight: 1080,
  };

  // 执行合成渲染，确保无异常抛出
  assert.doesNotThrow(() => {
    compositor.draw(ctx, project, evaluated, {
      screen: mockFrame,
      camera: mockFrame,
    });
  }, 'Compositor.draw must complete cleanly without errors');
});

test('Compositor: draw 3D perspective quad screen via mesh subdivider', () => {
  const compositor = new Compositor('.');

  const project = model.makeProject({
    name: '3D Render Test',
    media: { screen: { duration: 10, width: 1920, height: 1080 } },
    capture: {},
  });
  project.canvas.screenFrame = 'windowDark';
  project.canvas.rotationX = 20;
  project.canvas.rotationY = -25;
  project.canvas.rotationZ = 5;
  project.canvas.perspective = 0.8;

  const evaluated = scene.evaluateScene(project, {
    time: 0,
    width: 1920,
    height: 1080,
    sourceAspect: 16 / 9,
    cameraAspect: null,
  });

  assert.ok(evaluated.screen.rotationX !== 0 || evaluated.screen.rotationY !== 0);
  assert.ok(evaluated.projectedQuad instanceof ProjectedScreenQuad);

  const canvas = createMockCanvas(1920, 1080);
  const ctx = canvas.getContext('2d');
  const mockFrame = { width: 1920, height: 1080 };

  // 验证 3D 透视屏幕绘制不抛出任何异常
  assert.doesNotThrow(() => {
    compositor.drawScreen(ctx, evaluated.screen, mockFrame);
  }, 'draw3DScreen via quadrilateral mesh must complete cleanly');
});

test('Compositor: safe fallbacks when decoration is absent or style is none', () => {
  const compositor = new Compositor('.');

  const project = model.makeProject({
    name: 'Fallback Test',
    media: { screen: { duration: 10, width: 1920, height: 1080 } },
    capture: {},
  });
  project.canvas.screenFrame = 'none';

  const evaluated = scene.evaluateScene(project, {
    time: 0,
    width: 1920,
    height: 1080,
    sourceAspect: 16 / 9,
    cameraAspect: null,
  });

  assert.equal(evaluated.decoration.style, 'none');

  const canvas = createMockCanvas(1920, 1080);
  const ctx = canvas.getContext('2d');
  const mockFrame = { width: 1920, height: 1080 };

  // 无装饰时走标准 2D 屏幕渲染
  assert.doesNotThrow(() => {
    compositor.drawScreen(ctx, evaluated.screen, mockFrame);
  });
});

console.log(`\nAll ${passed} integration-render tests passed!`);
