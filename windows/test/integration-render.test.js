'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const model = require('../src/core/model');
const scene = require('../src/core/scene');
const { NormalizedCrop, ScreenFrameStyle, decorationInsets } = require('../src/core/crop-frame');
const { ProjectedScreenQuad, ScreenProjection } = require('../src/core/projection');
const { MosaicClip, StickerClip, OpeningSequence } = require('../src/core/opening-overlay');
const { CameraMotionClip, resolveCameraState, evaluateCameraMotion } = require('../src/core/camera-motion');
const { makeScreenMotionClip, createScreenMotionClipAtTime, evaluateScreenMotion } = require('../src/core/screen-motion');
const { makeClip: makeZoomClip } = require('../src/core/zoom');
const { Compositor, createMockCanvas, renderPerspectiveMesh } = require('../src/renderer/editor/render');
const { audioTracks } = require('../src/renderer/editor/export');

const near = (actual, expected, tolerance = 1e-4, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected}, got ${actual}`);

let passed = 0;
const test = (name, body) => {
  body();
  passed += 1;
  console.log(`  ok  ${name}`);
};

console.log('Running integration-render.test.js...');

test('screen motion: adjacent clips inherit the previous target continuously', () => {
  const base = { position: { x: 0.5, y: 0.5 }, scale: 1, rotationX: 0, rotationY: 0, rotationZ: 0, perspective: 0 };
  const clips = [
    makeScreenMotionClip({ id: 'first', timing: { startTime: 1, duration: 1, leadInDuration: 1 }, target: { position: { x: 0.2, y: 0.3 }, scale: 1.5, rotationY: 30, perspective: 0.4 } }),
    makeScreenMotionClip({ id: 'second', timing: { startTime: 2, duration: 1, leadInDuration: 1 }, target: { position: { x: 0.8, y: 0.7 }, scale: 2, rotationY: 70, perspective: 0.9 } }),
  ];
  const atJoin = evaluateScreenMotion(clips, 2, base, model.defaultMotion());
  near(atJoin.position.x, 0.2);
  near(atJoin.scale, 1.5);
  near(atJoin.rotationY, 30);
  const afterJoin = evaluateScreenMotion(clips, 2.05, base, model.defaultMotion());
  assert.ok(afterJoin.position.x > atJoin.position.x, '后一段应从前一目标继续移动');
  const movingProject = model.makeProject({ name: 'Projected Screen Motion', media: { screen: { duration: 10, width: 1920, height: 1080 } }, capture: {} });
  movingProject.timeline.screenMotionClips = clips;
  const projected = scene.evaluateScene(movingProject, { time: 1.5, sourceAspect: 16 / 9 });
  assert.ok(projected.screen.rotationY > 0 && projected.screen.projectedQuad, '场景应把源时间运动采样投影到屏幕卡片');

  const project = model.makeProject({ name: 'Opening Clock Test', media: { screen: { duration: 10, width: 1920, height: 1080 } }, capture: {} });
  project.timeline.segments = [{ id: 'trimmed', sourceStart: 5, sourceEnd: 10, speed: 1 }];
  project.openingSequence = new OpeningSequence({ isEnabled: true, preset: 'sideSlide', duration: 2, includedElements: ['screen'], elementOrder: ['screen'] });
  const opening = scene.evaluateScene(project, { time: 5, outputTime: 0, sourceAspect: 16 / 9 });
  const afterOpening = scene.evaluateScene(project, { time: 5, sourceAspect: 16 / 9 });
  assert.ok(opening.opening.scale < 1, '裁掉源素材开头后，开场仍应从成片输出时间 0 开始');
  assert.equal(afterOpening.opening.scale, 1, '未提供 outputTime 时继续默认使用素材时间');
});

test('screen motion: scale interpolates in rect space and preserves the authored 3D pivot', () => {
  const project = model.makeProject({ name: 'Screen Motion Framing', media: { screen: { duration: 10, width: 1920, height: 1080 } }, capture: {} });
  const clip = makeScreenMotionClip({
    id: 'focus-target',
    timing: { startTime: 1, duration: 1, leadInDuration: 1, easing: 'linear' },
    target: {
      position: { x: 0.46, y: 0.5 },
      scale: 2,
      rotationX: 26.8,
      rotationY: 18.8,
      rotationZ: 0,
      perspective: 0.65,
    },
  });
  project.timeline.screenMotionClips = [clip];

  const midpoint = scene.evaluateScene(project, { time: 1.5, sourceAspect: 16 / 9, width: 1920, height: 1080 });
  const fittedWidth = midpoint.screen.fittedRect.width;
  const fromLeft = 0.5 * (1920 - fittedWidth);
  const toLeft = 0.46 * (1920 - fittedWidth * 2);
  const interpolatedLeft = fromLeft + (toLeft - fromLeft) * 0.5;
  const interpolatedWidth = fittedWidth * 1.5;
  const expectedPosition = interpolatedLeft / (1920 - interpolatedWidth);
  near(midpoint.screen.screenMotion.position.x, expectedPosition, 1e-6, '中间态 position 应由 rect 线性路径还原');
  assert.ok(Math.abs(midpoint.screen.screenMotion.position.x - 0.48) > 0.02, '不能把 position 与 scale 独立插值');
  near(midpoint.screen.projectionAnchor.x, 0.46, 1e-6, '初次倾斜时从首帧锁定目标投影锚点');

  const hold = scene.evaluateScene(project, { time: 2, sourceAspect: 16 / 9, width: 1920, height: 1080 });
  const recenter = ((2 - 1) / 2) * 0.62;
  const targetX = 0.46 * 1920 + (1920 / 2 - 0.46 * 1920) * recenter;
  near(hold.screen.baseRect.x, targetX - 0.46 * hold.screen.baseRect.width, 1e-5, '高倍率目标点按作者的安全构图回中');
  near(hold.screen.rotationX, 26.8);
  near(hold.screen.rotationY, 18.8);
  near(hold.screen.perspective, 0.65);
  near(midpoint.screen.manualOffset.x, hold.screen.manualOffset.x * 0.5, 1e-5, '卡片像素偏移沿整段直线过渡');

  const pivot = {
    x: hold.screen.finalRect.x + hold.screen.finalRect.width * hold.screen.projectionAnchor.x,
    y: hold.screen.finalRect.y + hold.screen.finalRect.height * hold.screen.projectionAnchor.y,
  };
  const projectedPivot = hold.projectedQuad.project(pivot, hold.screen.finalRect);
  assert.ok(projectedPivot, '投影四边形应能映射目标锚点');
  near(projectedPivot.x, pivot.x, 1e-5, '旋转不应让锚点平移');
  near(projectedPivot.y, pivot.y, 1e-5, '旋转不应让锚点平移');
});

test('screen motion: chained target moves its projection anchor without a join jump', () => {
  const project = model.makeProject({ name: 'Screen Motion Pivot Handoff', media: { screen: { duration: 10, width: 1920, height: 1080 } }, capture: {} });
  project.timeline.screenMotionClips = [
    makeScreenMotionClip({ id: 'first-pivot', timing: { startTime: 1, duration: 1, leadInDuration: 1, easing: 'linear' }, target: { position: { x: 0.2, y: 0.3 }, scale: 1.5, rotationX: 12 } }),
    makeScreenMotionClip({ id: 'next-pivot', timing: { startTime: 2, duration: 1, leadInDuration: 1, easing: 'linear' }, target: { position: { x: 0.8, y: 0.7 }, scale: 2, rotationX: 25 } }),
  ];
  const join = scene.evaluateScene(project, { time: 2, sourceAspect: 16 / 9, width: 1920, height: 1080 });
  const halfway = scene.evaluateScene(project, { time: 2.5, sourceAspect: 16 / 9, width: 1920, height: 1080 });
  near(join.screen.projectionAnchor.x, 0.2, 1e-6);
  near(halfway.screen.projectionAnchor.x, 0.5, 1e-6);
  near(join.screen.rotationX, 12, 1e-6, '相接边界须保持前一姿态');
  near(halfway.screen.rotationX, 18.5, 1e-6);
});

test('screen motion: return timing interpolates back to base framing', () => {
  const project = model.makeProject({ name: 'Screen Motion Return', media: { screen: { duration: 10, width: 1920, height: 1080 } }, capture: {} });
  project.timeline.screenMotionClips = [
    makeScreenMotionClip({
      id: 'returning-target',
      timing: { startTime: 1, duration: 1, leadInDuration: 1, returnDuration: 1, easing: 'linear' },
      target: { position: { x: 0.2, y: 0.7 }, scale: 2, rotationX: 20, perspective: 0.65 },
    }),
  ];
  const target = scene.evaluateScene(project, { time: 2, sourceAspect: 16 / 9, width: 1920, height: 1080 });
  const halfway = scene.evaluateScene(project, { time: 2.5, sourceAspect: 16 / 9, width: 1920, height: 1080 });
  const base = scene.evaluateScene(project, { time: 3.1, sourceAspect: 16 / 9, width: 1920, height: 1080 });
  near(target.screen.screenMotion.rotationX, 20);
  near(halfway.screen.screenMotion.rotationX, 10);
  near(halfway.screen.screenMotion.scale, 1.5);
  near(halfway.screen.projectionAnchor.x, 0.2, 1e-6, '回落期间保留目标投影锚点');
  near(halfway.screen.manualOffset.x, target.screen.manualOffset.x * 0.5, 1e-5);
  near(base.screen.screenMotion.rotationX, 0);
  near(base.screen.screenMotion.scale, 1);
  near(base.screen.projectionAnchor.x, 0.5, 1e-6, '回落完成后恢复基础锚点');
});

test('screen motion: Mac-authored easing values keep their intended curve', () => {
  const clip = makeScreenMotionClip({
    id: 'linear-mac-curve',
    timing: { startTime: 1, duration: 1, leadInDuration: 1, easing: '线性' },
    target: { scale: 2 },
  });
  const quarter = evaluateScreenMotion([clip], 1.25, {
    position: { x: 0.5, y: 0.5 }, scale: 1, rotationX: 0, rotationY: 0, rotationZ: 0, perspective: 0.65,
  });
  near(quarter.scale, 1.25, 1e-6, 'Mac 项目中的线性曲线应按原值求值');
});

test('screen motion creation: defaults transition in and out from the sampled state', () => {
  const base = {
    position: { x: 0.46, y: 0.5 }, scale: 1.15,
    rotationX: 0, rotationY: 0, rotationZ: 0, perspective: 0.65,
  };
  const first = createScreenMotionClipAtTime({
    time: 3,
    clips: [],
    timelineDuration: 10,
    base,
    motionStyle: model.defaultMotion(),
    easing: 'spring',
    transitionDuration: 0.7,
  });
  assert.equal(first.timing.startTime, 3);
  near(first.timing.duration, 1.2, 1e-12);
  assert.equal(first.timing.leadInDuration, 0.7);
  assert.equal(first.timing.returnDuration, 0.7);
  assert.equal(first.timing.easing, 'spring');
  assert.deepEqual(first.target, base);

  const previous = makeScreenMotionClip({
    id: 'held-screen-target',
    timing: { startTime: 1, duration: 1, leadInDuration: 1 },
    target: { position: { x: 0.24, y: 0.31 }, scale: 1.7, rotationY: 18.8 },
  });
  const afterPrevious = createScreenMotionClipAtTime({
    time: 2.2,
    clips: [previous],
    timelineDuration: 10,
    base,
    motionStyle: model.defaultMotion(),
    transitionDuration: 0.7,
  });
  assert.equal(afterPrevious.timing.startTime, 2, '默认回落窗口内应贴到上一段结尾并连续衔接');
  assert.deepEqual(afterPrevious.target, previous.target, '新目标从播放头采样到的前一目标继承');
  assert.equal(afterPrevious.timing.returnDuration, 0.7);

  const nearEnd = createScreenMotionClipAtTime({
    time: 9.5,
    clips: [],
    timelineDuration: 10,
    base,
    transitionDuration: 0.7,
  });
  assert.equal(nearEnd.timing.startTime, 8.8, '素材末尾空间不足时将效果左移以保留标准时长');
  assert.equal(nearEnd.timing.returnDuration, 0);

  const beforeNext = createScreenMotionClipAtTime({
    time: 0,
    clips: [makeScreenMotionClip({ timing: { startTime: 1, duration: 1 } })],
    timelineDuration: 10,
    base,
    transitionDuration: 0.7,
  });
  assert.equal(beforeNext.timing.duration, 1, '下一片段的起点限制当前效果长度');
  assert.equal(beforeNext.timing.returnDuration, 0, '相邻创建时取消多余回落以保持状态连续');
});

test('screen zoom: asymmetric screen chrome grows around the decorated card center', () => {
  const project = model.makeProject({ name: 'Screen Zoom With Chrome', media: { screen: { duration: 10, width: 1920, height: 1080 } }, capture: {} });
  project.canvas.screenFrame = 'windowLight';
  project.canvas.screenFrameToolbarScale = 1;
  project.zoomAnimations = [makeZoomClip({
    startTime: 0,
    endTime: 1,
    scale: 1.6,
    focus: { x: 0.5, y: 0.5 },
    easing: 'linear',
    enterDuration: 0.7,
    exitDuration: 0,
  })];
  const evaluated = scene.evaluateScene(project, {
    time: 0.8,
    sourceAspect: 16 / 9,
    width: 1920,
    height: 1080,
    zoomClips: project.zoomAnimations,
  });
  const insets = decorationInsets({
    style: 'windowLight',
    frameScale: project.canvas.screenFrameScale,
    toolbarScale: project.canvas.screenFrameToolbarScale,
    fittedWidth: evaluated.screen.fittedRect.width,
    fittedHeight: evaluated.screen.fittedRect.height,
    styleScale: 1,
  });
  const centeredZoomY = evaluated.screen.baseRect.y + evaluated.screen.baseRect.height / 2
    - evaluated.screen.baseRect.height * evaluated.screen.viewport.scale / 2
    + evaluated.screen.viewport.translation.y * evaluated.screen.baseRect.height;
  const decorationGrowth = evaluated.screen.screenMotion.scale * (evaluated.screen.viewport.scale - 1) / 2;
  near(evaluated.screen.finalRect.y, centeredZoomY + insets.top * decorationGrowth, 1e-5);
});

test('screen zoom: full-canvas edge clamping is disabled while screen 3D motion is active', () => {
  const project = model.makeProject({ name: 'Screen 3D Zoom Coverage', media: { screen: { duration: 10, width: 1920, height: 1080 } }, capture: {} });
  project.canvas.padding = 0;
  const zoomClips = [makeZoomClip({
    startTime: 0, endTime: 4, scale: 2, focus: { x: 0, y: 0.5 }, easing: 'linear', enterDuration: 0.7, exitDuration: 0,
  })];
  const flat = scene.evaluateScene(project, { time: 1.5, sourceAspect: 16 / 9, zoomClips });
  near(flat.screen.viewport.translation.x, 0.5, 1e-6, '平面铺满画布时缩放不能露出背景边缘');

  project.timeline.screenMotionClips = [makeScreenMotionClip({
    id: 'tilted-card',
    timing: { startTime: 1, duration: 2, leadInDuration: 0.7, returnDuration: 0.7 },
    target: { position: { x: 0.5, y: 0.5 }, scale: 2, rotationX: 15 },
  })];
  const tilted = scene.evaluateScene(project, { time: 1.5, sourceAspect: 16 / 9, zoomClips });
  near(tilted.screen.viewport.translation.x, 0.8, 1e-6, '屏幕 3D 运镜活动期间按原版保留焦点路径');
  const returned = scene.evaluateScene(project, { time: 4, sourceAspect: 16 / 9, zoomClips });
  near(returned.screen.viewport.translation.x, 0.5, 1e-6, '回落结束后恢复铺满画布的边缘约束');
});

test('camera motion: adjacent transitions join without a boundary reset', () => {
  const clips = [
    new CameraMotionClip({ id: 'cam-first', timing: { startTime: 1, duration: 1, leadInDuration: 1 }, target: { shape: 'vertical', position: { x: 0.2, y: 0.3 }, size: 0.4 } }),
    new CameraMotionClip({ id: 'cam-second', timing: { startTime: 2, duration: 1, leadInDuration: 1 }, target: { shape: 'circle', position: { x: 0.8, y: 0.7 }, size: 0.6 } }),
  ];
  const base = model.defaultCamera();
  const atJoin = evaluateCameraMotion(clips, base, 2, model.defaultMotion(), 16 / 9, 16 / 9);
  near(atJoin.position.x, 0.2);
  near(atJoin.size, 0.4);
  const afterJoin = evaluateCameraMotion(clips, base, 2.05, model.defaultMotion(), 16 / 9, 16 / 9);
  assert.ok(afterJoin.position.x > atJoin.position.x);
  near(resolveCameraState({ layout: { kind: 'shape', shape: 'vertical' } }).aspectRatio, 0.72);
});

test('crop mapping: mosaic redraw uses the original crop and cursor follows that crop', () => {
  const compositor = new Compositor('.');
  const canvas = createMockCanvas(400, 200);
  const ctx = canvas.getContext('2d');
  const calls = [];
  ctx.drawImage = (...args) => calls.push(args);
  const mosaicBounds = [];
  ctx.roundRect = (x, y, width, height) => mosaicBounds.push({ x, y, width, height });
  const frame = { width: 1000, height: 500 };
  const crop = new NormalizedCrop(0.25, 0.2, 0.5, 0.6);
  compositor.drawMosaics(ctx, [{ sourceRect: { x: 0.35, y: 0.3, width: 0.2, height: 0.2 }, style: 'blur', intensity: 0.5 }],
    { x: 10, y: 20, width: 200, height: 100 }, frame, crop, { scale: 1, translation: { x: 0, y: 0 } });
  assert.deepEqual(calls[0].slice(1, 5), [250, 100, 500, 300], '柔化回画必须继续使用屏幕源裁切区域');
  near(mosaicBounds[0].x, 50);
  near(mosaicBounds[0].y, 20 + (1 / 6) * 100);
  near(mosaicBounds[0].width, 80);
  near(mosaicBounds[0].height, (1 / 3) * 100);

  const project = model.makeProject({ name: 'Crop Cursor Test', media: { screen: { duration: 10, width: 1920, height: 1080 } }, capture: {} });
  project.canvas.crop = crop;
  project.zoomAnimations = [{ startTime: 0, endTime: 3, scale: 2, focus: { x: 0.6, y: 0.5 }, origin: 'manual', easing: 'linear', enterDuration: 0.1, exitDuration: 0 }];
  const pointer = (x, y) => ({ evaluation: () => ({ cursor: { location: { x, y }, recordedCursor: 'arrow', clickPhase: null } }) });
  const inside = scene.evaluateScene(project, { time: 1, sourceAspect: 16 / 9, pointerTrack: pointer(0.35, 0.5) });
  near(inside.cursor.x, inside.screen.finalRect.x + inside.screen.finalRect.width * 0.2);
  near(inside.cursor.y, inside.screen.finalRect.y + inside.screen.finalRect.height * 0.5);
  const outside = scene.evaluateScene(project, { time: 1, sourceAspect: 16 / 9, pointerTrack: pointer(0.1, 0.5) });
  assert.equal(outside.cursor, null, '裁切掉的源画面区域不能显示光标');
});

test('perspective mesh: adjacent triangle clips overlap while the outer projection clip stays exact', () => {
  const ctx = createMockCanvas(8, 8).getContext('2d');
  const clipPaths = [];
  let currentPath = [];
  ctx.beginPath = () => { currentPath = []; };
  ctx.moveTo = (x, y) => { currentPath.push({ x, y }); };
  ctx.lineTo = (x, y) => { currentPath.push({ x, y }); };
  ctx.closePath = () => {};
  ctx.clip = () => { clipPaths.push(currentPath.map((point) => ({ ...point }))); };

  const quad = {
    topLeft: { x: 0, y: 0 }, topRight: { x: 8, y: 0 },
    bottomRight: { x: 8, y: 8 }, bottomLeft: { x: 0, y: 8 },
    projector: () => ({ valid: true, project: (point) => ({ ...point }) }),
  };
  renderPerspectiveMesh(ctx, { width: 8, height: 8 }, { x: 0, y: 0, width: 8, height: 8 }, quad, 2);

  assert.equal(clipPaths.length, 9, '应有一个外轮廓裁切和八个网格三角形裁切');
  assert.deepEqual(clipPaths[0], [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft], '总体裁切边界保持投影四边形原值');
  const containsPoint = (polygon, point) => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i];
      const b = polygon[j];
      if (((a.y > point.y) !== (b.y > point.y))
        && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  const firstTriangle = clipPaths[1];
  const neighborTriangle = clipPaths[2];
  for (const point of [{ x: 1.85, y: 1.85 }, { x: 2.15, y: 2.15 }]) {
    assert.ok(containsPoint(firstTriangle, point) && containsPoint(neighborTriangle, point), '相邻三角形裁切在共享斜边两侧应有半像素级重叠');
  }
});

test('perspective mesh: acute projected corners cap clip expansion at two output pixels', () => {
  const ctx = createMockCanvas(960, 540).getContext('2d');
  const clipPaths = [];
  let currentPath = [];
  ctx.beginPath = () => { currentPath = []; };
  ctx.moveTo = (x, y) => { currentPath.push({ x, y }); };
  ctx.lineTo = (x, y) => { currentPath.push({ x, y }); };
  ctx.closePath = () => {};
  ctx.clip = () => { clipPaths.push(currentPath.map((point) => ({ ...point }))); };

  const sourceRect = { x: 0, y: 0, width: 960, height: 540 };
  const quad = ScreenProjection.project({
    rect: sourceRect, rotationX: 80, rotationY: -80, perspective: 1,
  });
  const mapper = quad.projector(sourceRect);
  const subdivisions = 8;
  renderPerspectiveMesh(ctx, { width: 960, height: 540 }, sourceRect, quad, subdivisions);

  let clipIndex = 1;
  let minimumAngle = 180;
  let maximumOffset = 0;
  const angleAt = (a, b, c) => {
    const ab = { x: a.x - b.x, y: a.y - b.y };
    const cb = { x: c.x - b.x, y: c.y - b.y };
    const cosine = (ab.x * cb.x + ab.y * cb.y) / (Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y));
    return Math.acos(Math.min(Math.max(cosine, -1), 1)) * 180 / Math.PI;
  };
  for (let i = 0; i < subdivisions; i++) {
    for (let j = 0; j < subdivisions; j++) {
      const sx0 = i / subdivisions * sourceRect.width;
      const sx1 = (i + 1) / subdivisions * sourceRect.width;
      const sy0 = j / subdivisions * sourceRect.height;
      const sy1 = (j + 1) / subdivisions * sourceRect.height;
      const p00 = mapper.project({ x: sx0, y: sy0 });
      const p10 = mapper.project({ x: sx1, y: sy0 });
      const p01 = mapper.project({ x: sx0, y: sy1 });
      const p11 = mapper.project({ x: sx1, y: sy1 });
      for (const triangle of [[p00, p10, p01], [p10, p11, p01]]) {
        const clip = clipPaths[clipIndex++];
        for (let vertex = 0; vertex < 3; vertex++) {
          minimumAngle = Math.min(minimumAngle, angleAt(triangle[(vertex + 2) % 3], triangle[vertex], triangle[(vertex + 1) % 3]));
          maximumOffset = Math.max(maximumOffset, Math.hypot(
            clip[vertex].x - triangle[vertex].x,
            clip[vertex].y - triangle[vertex].y,
          ));
        }
      }
    }
  }
  assert.ok(minimumAngle > 1.8 && minimumAngle < 1.9, `fixture should include the 1.82-degree mesh angle, got ${minimumAngle}`);
  assert.ok(maximumOffset >= 1.99 && maximumOffset <= 2.000001, `miter expansion should clamp to two pixels, got ${maximumOffset}`);
});

test('camera content framing: zoom and position change the crop inside its mask', () => {
  const compositor = new Compositor('.');
  const ctx = createMockCanvas(300, 300).getContext('2d');
  let draw;
  ctx.drawImage = (...args) => { draw = args; };
  compositor.drawCamera(ctx, {
    rect: { x: 20, y: 30, width: 100, height: 100 }, cornerRadius: 0, borderWidth: 0,
    contentScale: 2, contentPosition: { x: 0, y: 1 }, opacity: 1,
  }, { width: 200, height: 100 });
  assert.deepEqual(draw.slice(1), [20, -70, 400, 200], '摄像头内部取景按 contentScale/contentPosition 绘制');
  compositor.drawCamera(ctx, {
    rect: { x: 20, y: 30, width: 100, height: 100 }, cornerRadius: 0, borderWidth: 0,
    contentScale: 2, contentPosition: { x: 0, y: 1 }, isMirrored: true, opacity: 1,
  }, { width: 200, height: 100 });
  assert.deepEqual(draw.slice(1), [-280, -70, 400, 200], '镜像摄像头的水平取景位置按最终视觉方向反转');
});

test('sticker backdrop flags suppress the screen and camera layers during composition', () => {
  const project = model.makeProject({
    name: 'Sticker Backdrop Test',
    media: { screen: { duration: 10, width: 1920, height: 1080 }, camera: { duration: 10, width: 1280, height: 720 } },
    capture: {},
  });
  project.timeline.stickerClips = [new StickerClip({
    id: 'backdrop', relativePath: 'media/backdrop.png', timing: { startTime: 0, duration: 4 },
    animation: 'none', hidesScreen: true, hidesCamera: true,
  })];
  const evaluated = scene.evaluateScene(project, { time: 1, sourceAspect: 16 / 9, cameraAspect: 16 / 9 });
  const compositor = new Compositor('.');
  const ctx = createMockCanvas(400, 225).getContext('2d');
  const frame = { width: 1920, height: 1080 };
  let screens = 0;
  let cameras = 0;
  let stickers = 0;
  compositor.drawScreen = () => { screens += 1; };
  compositor.drawCamera = () => { cameras += 1; };
  compositor.drawStickers = () => { stickers += 1; };
  compositor.draw(ctx, project, evaluated, { screen: frame, camera: frame });
  assert.equal(screens, 0);
  assert.equal(cameras, 0);
  assert.equal(stickers, 1);
});

test('dynamic backgrounds use output time and are not cached as a still frame', () => {
  const compositor = new Compositor('.');
  const canvas = {
    background: { kind: 'pattern', preset: 'obsidianGrid' },
    backgroundBlur: 0,
    patternScale: 1,
    patternOpacity: 1,
    patternMotion: 3,
  };
  const atStart = [];
  const atOneSecond = [];
  const firstContext = createMockCanvas(200, 100).getContext('2d');
  const secondContext = createMockCanvas(200, 100).getContext('2d');
  firstContext.moveTo = (x) => atStart.push(x);
  secondContext.moveTo = (x) => atOneSecond.push(x);
  compositor.drawPattern(firstContext, model.PATTERN_PRESETS.obsidianGrid, canvas, 200, 100, 0);
  compositor.drawPattern(secondContext, model.PATTERN_PRESETS.obsidianGrid, canvas, 200, 100, 1);
  assert.notDeepEqual(atStart, atOneSecond, '动态图案应按输出时间移动');
  const firstLayer = compositor.backgroundLayer(canvas, 200, 100, 1, 0);
  const secondLayer = compositor.backgroundLayer(canvas, 200, 100, 1, 1);
  assert.notEqual(firstLayer, secondLayer, '动态背景帧不能被复用为静态缓存');
});

test('video background draws the supplied frame into the shared composition', () => {
  const compositor = new Compositor('.');
  const project = model.makeProject({ name: 'Video Background Render', media: { screen: { duration: 10, width: 1920, height: 1080 } }, capture: {} });
  project.canvas.background = { kind: 'video', file: 'media/background.mp4', isLooping: true, duration: 4, width: 1280, height: 720, index: 'background.index.json' };
  const evaluated = scene.evaluateScene(project, { time: 3, outputTime: 5.5, sourceAspect: 16 / 9 });
  const ctx = createMockCanvas(400, 225).getContext('2d');
  let drawnFrame = null;
  ctx.drawImage = (frame) => { drawnFrame = frame; };
  compositor.drawScreen = () => {};
  compositor.draw(ctx, project, evaluated, { screen: { width: 1920, height: 1080 }, background: { width: 1280, height: 720 } });
  assert.deepEqual(evaluated.outputTime, 5.5);
  assert.equal(drawnFrame.width, 1280, '视频背景应进入与普通背景相同的 Compositor 合成层');
});

test('audioTracks: 保留全局静音但被片段解除静音的音轨', () => {
  const project = model.makeProject({
    name: 'Segment Audio Test',
    media: {
      screen: { duration: 10, width: 1920, height: 1080 },
      microphone: { file: 'media/microphone.m4a', offset: 0 },
      systemAudio: { file: 'media/system.m4a', offset: 0.2 },
    },
    capture: {},
  });
  project.audio.isMicrophoneMuted = true;
  project.audio.isSystemMuted = true;
  project.timeline.segments = [{
    ...project.timeline.segments[0],
    audio: { microphoneVolume: 0.6, isMicrophoneMuted: false, systemVolume: 0.4, isSystemMuted: false },
  }];

  const tracks = audioTracks('project-dir', project);
  assert.deepEqual(tracks.map((track) => track.kind), ['microphone', 'system']);
  assert.equal(tracks[0].baseMuted, true, '音轨保留项目级静音值供混音器计算片段继承');
  assert.equal(tracks[0].baseVolume, project.audio.microphoneVolume);
  assert.equal(tracks[1].baseMuted, true);

  project.timeline.segments[0].audio = { isMicrophoneMuted: false, microphoneVolume: 0.6 };
  assert.deepEqual(audioTracks('project-dir', project).map((track) => track.kind), ['microphone'], '全静音且未被覆盖的系统音轨应省略');
});

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
      stickers: { 'stk-1': mockFrame },
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

async function testRealStickerAssetLoading() {
  const originalImage = global.Image;
  const windowsDirectory = path.resolve(__dirname, '..');
  const assetPath = path.join(windowsDirectory, 'docs/images/editor.png');
  global.Image = class TestImage {
    set src(value) {
      const file = fileURLToPath(value);
      queueMicrotask(() => {
        if (fs.existsSync(file)) this.onload();
        else this.onerror(new Error('missing image'));
      });
    }
  };
  try {
    const compositor = new Compositor(windowsDirectory);
    const project = model.makeProject({ name: 'Sticker Asset Test', media: { screen: { duration: 2, width: 1920, height: 1080 } }, capture: {} });
    project.timeline.stickerClips = [new StickerClip({
      id: 'real-sticker', relativePath: 'docs/images/editor.png', timing: { startTime: 0, duration: 2 }, animation: 'none',
    })];
    await compositor.prepare(project);
    assert.ok(compositor.images.has(assetPath), '应按项目相对路径预载真实图片素材');

    const ctx = createMockCanvas(400, 225).getContext('2d');
    let drawnImage = null;
    ctx.drawImage = (image) => { drawnImage = image; };
    const stickerScene = scene.evaluateScene(project, { time: 1, sourceAspect: 16 / 9 }).stickers;
    compositor.drawStickers(ctx, stickerScene, {});
    assert.equal(drawnImage, compositor.images.get(assetPath), '贴图绘制应使用已解码的素材缓存');

    const missing = model.makeProject({ name: 'Missing Sticker Test', media: { screen: { duration: 2, width: 1920, height: 1080 } }, capture: {} });
    missing.timeline.stickerClips = [new StickerClip({ id: 'missing', relativePath: 'media/does-not-exist.png', timing: { startTime: 0, duration: 2 } })];
    await assert.rejects(compositor.prepare(missing), /无法加载图片素材/);
  } finally {
    global.Image = originalImage;
  }
}

testRealStickerAssetLoading().then(() => {
  passed += 1;
  console.log('  ok  real sticker assets: project-relative images preload and missing sources fail clearly');
  console.log(`\nAll ${passed} integration-render tests passed!`);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
