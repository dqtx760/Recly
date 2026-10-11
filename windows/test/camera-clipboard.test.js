'use strict';
// 摄像运动与剪贴板单元测试
const assert = require('node:assert/strict');
const { CameraMotionClip, evaluateCameraMotion, resolveCameraState } = require('../src/core/camera-motion');
const { ClipClipboard } = require('../src/renderer/editor/clipboard');
const { defaultMotion } = require('../src/core/model');

const near = (actual, expected, tolerance = 1e-4, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected}, got ${actual}`);

let passed = 0;
const test = (name, body) => {
  body();
  passed += 1;
  console.log(`  ok  ${name}`);
};

console.log('Testing Camera Motion & Clipboard...');

// --- Camera Motion Tests ---

test('Base camera returned when outside clip range', () => {
  const baseCamera = {
    layout: 'shape',
    shape: 'square',
    position: { x: 0.9, y: 0.8 },
    size: 0.3,
    roundness: 0.5,
    opacity: 1,
  };

  const clip = new CameraMotionClip({
    id: 'clip-1',
    timing: {
      startTime: 2.0,
      duration: 3.0,
      leadInDuration: 0.5,
      returnDuration: 0.5,
    },
    target: {
      layout: 'shape',
      shape: 'circle',
      position: { x: 0.2, y: 0.3 },
      size: 0.5,
      roundness: 0.5,
      opacity: 0.8,
    },
  });

  const motion = defaultMotion();

  // 时间在片段之前 (time = 1.0)
  const sampleBefore = evaluateCameraMotion([clip], baseCamera, 1.0, motion);
  near(sampleBefore.position.x, 0.9, 1e-4, 'before: pos x');
  near(sampleBefore.position.y, 0.8, 1e-4, 'before: pos y');
  near(sampleBefore.size, 0.3, 1e-4, 'before: size');
  near(sampleBefore.opacity, 1.0, 1e-4, 'before: opacity');
  near(sampleBefore.fullscreenProgress, 0, 1e-4, 'before: fullscreenProgress');

  // 时间在片段回落之后 (clip 结束 2 + 3 = 5.0，returnDuration = 0.5，5.6 > 5.5)
  const sampleAfter = evaluateCameraMotion([clip], baseCamera, 6.0, motion);
  near(sampleAfter.position.x, 0.9, 1e-4, 'after: pos x');
  near(sampleAfter.position.y, 0.8, 1e-4, 'after: pos y');
  near(sampleAfter.size, 0.3, 1e-4, 'after: size');
  near(sampleAfter.opacity, 1.0, 1e-4, 'after: opacity');
  near(sampleAfter.fullscreenProgress, 0, 1e-4, 'after: fullscreenProgress');
});

test('Fullscreen camera progress smoothly transitions from 0 to 1', () => {
  const baseCamera = {
    layout: 'shape',
    shape: 'square',
    position: { x: 0.8, y: 0.8 },
    size: 0.25,
    roundness: 0.2,
    opacity: 1,
  };

  const clip = new CameraMotionClip({
    id: 'fullscreen-clip',
    timing: {
      startTime: 1.0,
      duration: 2.0,
      leadInDuration: 1.0,
      returnDuration: 1.0,
      easing: 'linear',
    },
    target: {
      layout: 'fullscreen',
      position: { x: 0.5, y: 0.5 },
      size: 1.0,
      roundness: 0,
      opacity: 1,
    },
  });

  const motion = defaultMotion();

  // 起点：time = 1.0，fullscreenProgress 应该是 0
  const start = evaluateCameraMotion([clip], baseCamera, 1.0, motion);
  near(start.fullscreenProgress, 0, 1e-3, 'start fullscreen');
  near(start.position.x, 0.8, 1e-3, 'start x');

  // 中间：time = 1.5 (leadIn 0.5)，fullscreenProgress 在 0 和 1 之间 (0.5 左右)
  const mid = evaluateCameraMotion([clip], baseCamera, 1.5, motion);
  assert.ok(mid.fullscreenProgress > 0.4 && mid.fullscreenProgress < 0.6, `mid fullscreen was ${mid.fullscreenProgress}`);
  assert.ok(mid.position.x < 0.8 && mid.position.x > 0.5, `mid position.x interpolated ${mid.position.x}`);

  // 过渡结束并在保持期：time = 2.0 到 3.0，fullscreenProgress 应该是 1
  const fullyIn = evaluateCameraMotion([clip], baseCamera, 2.5, motion);
  near(fullyIn.fullscreenProgress, 1.0, 1e-3, 'fully in fullscreen');
  near(fullyIn.position.x, 0.5, 1e-3, 'fully in position x');

  // 回落期：time = 3.5 (returnDuration 1.0，走了一半)，fullscreenProgress 回到 0.5 左右
  const returnMid = evaluateCameraMotion([clip], baseCamera, 3.5, motion);
  assert.ok(returnMid.fullscreenProgress > 0.4 && returnMid.fullscreenProgress < 0.6, `return fullscreen was ${returnMid.fullscreenProgress}`);

  // 回落完全结束：time = 4.1
  const returnEnd = evaluateCameraMotion([clip], baseCamera, 4.1, motion);
  near(returnEnd.fullscreenProgress, 0, 1e-3, 'return end fullscreen');
});

test('Shape transitions (square -> circle) interpolate cornerFraction and roundness', () => {
  const baseCamera = {
    layout: 'shape',
    shape: 'square',
    position: { x: 0.5, y: 0.5 },
    size: 0.3,
    roundness: 0.2, // cornerFraction = 0.5 * 0.2 = 0.1
    opacity: 1,
  };

  const clip = new CameraMotionClip({
    id: 'circle-clip',
    timing: {
      startTime: 0,
      duration: 1.0,
      leadInDuration: 1.0,
      easing: 'linear',
    },
    target: {
      layout: 'shape',
      shape: 'circle', // circle cornerFraction = 0.5
      position: { x: 0.5, y: 0.5 },
      size: 0.3,
      roundness: 1.0,
      opacity: 1,
    },
  });

  const motion = defaultMotion();
  const mid = evaluateCameraMotion([clip], baseCamera, 0.5, motion);
  // cornerFraction 应该在 0.1 到 0.5 之间，即 0.3
  near(mid.cornerFraction, 0.3, 1e-3, 'mid cornerFraction');
});

// --- Clipboard Tests ---

test('ClipClipboard: copy and paste clip creates duplicate at playheadTime', () => {
  const clipboard = new ClipClipboard();
  assert.equal(clipboard.hasClip(), false);

  const originalClip = {
    id: 'zoom-orig',
    startTime: 1.0,
    endTime: 3.5,
    scale: 1.8,
    focus: { x: 0.4, y: 0.6 },
    easing: 'spring',
  };

  clipboard.copy(originalClip, 'zoom');
  assert.equal(clipboard.hasClip(), true);

  const mockProject = {
    media: { screen: { duration: 10 } },
    zoomAnimations: [originalClip],
    timeline: { cameraMotionClips: [] },
  };

  const playhead = 5.0;
  const pastedClip = clipboard.paste(mockProject, playhead);

  assert.ok(pastedClip);
  assert.notEqual(pastedClip.id, originalClip.id);
  near(pastedClip.startTime, 5.0, 1e-4);
  near(pastedClip.endTime, 7.5, 1e-4); // duration is 2.5
  near(pastedClip.scale, 1.8, 1e-4);
  assert.equal(pastedClip.easing, 'spring');
  assert.equal(mockProject.zoomAnimations.length, 2);
});

test('ClipClipboard: copy and paste attributes transfers visual parameters while preserving timing', () => {
  const clipboard = new ClipClipboard();

  // 1. Zoom clip 属性转移测试
  const sourceZoom = {
    id: 'source-zoom-id',
    startTime: 10.0,
    endTime: 15.0,
    scale: 2.5,
    focus: { x: 0.12, y: 0.34 },
    easing: 'quintic',
    enterDuration: 1.2,
    exitDuration: 0.8,
  };

  const targetZoom = {
    id: 'target-zoom-id',
    startTime: 1.0,
    endTime: 4.0,
    scale: 1.4,
    focus: { x: 0.5, y: 0.5 },
    easing: 'linear',
    enterDuration: 0.5,
    exitDuration: 0.5,
  };

  clipboard.copy(sourceZoom, 'zoom');
  clipboard.pasteAttributes(targetZoom);

  // ID 和起止时间保持不变
  assert.equal(targetZoom.id, 'target-zoom-id');
  near(targetZoom.startTime, 1.0, 1e-4);
  near(targetZoom.endTime, 4.0, 1e-4);

  // 视觉参数转移
  near(targetZoom.scale, 2.5, 1e-4);
  near(targetZoom.focus.x, 0.12, 1e-4);
  near(targetZoom.focus.y, 0.34, 1e-4);
  assert.equal(targetZoom.easing, 'quintic');
  near(targetZoom.enterDuration, 1.2, 1e-4);
  near(targetZoom.exitDuration, 0.8, 1e-4);

  // 2. CameraMotionClip 属性转移测试
  const sourceCameraClip = new CameraMotionClip({
    id: 'cam-src',
    timing: {
      startTime: 20.0,
      duration: 10.0,
      easing: 'spring',
    },
    target: {
      layout: 'shape',
      shape: 'circle',
      position: { x: 0.1, y: 0.2 },
      size: 0.6,
      roundness: 0.9,
      opacity: 0.7,
    },
  });

  const targetCameraClip = new CameraMotionClip({
    id: 'cam-dst',
    timing: {
      startTime: 2.0,
      duration: 3.0,
      easing: 'linear',
    },
    target: {
      layout: 'shape',
      shape: 'square',
      position: { x: 0.8, y: 0.8 },
      size: 0.2,
      roundness: 0.1,
      opacity: 1.0,
    },
  });

  clipboard.copy(sourceCameraClip, 'camera');
  clipboard.pasteAttributes(targetCameraClip);

  // 校验目标 timing 和 id 未变
  assert.equal(targetCameraClip.id, 'cam-dst');
  near(targetCameraClip.timing.startTime, 2.0, 1e-4);
  near(targetCameraClip.timing.duration, 3.0, 1e-4);

  // 校验缓动与 target 视觉参数成功转移
  assert.equal(targetCameraClip.timing.easing, 'spring');
  assert.equal(targetCameraClip.target.shape, 'circle');
  near(targetCameraClip.target.position.x, 0.1, 1e-4);
  near(targetCameraClip.target.position.y, 0.2, 1e-4);
  near(targetCameraClip.target.size, 0.6, 1e-4);
  near(targetCameraClip.target.roundness, 0.9, 1e-4);
  near(targetCameraClip.target.opacity, 0.7, 1e-4);
});

test('ClipClipboard: mosaic and sticker attributes copy as their own types and preserve timing', () => {
  const clipboard = new ClipClipboard();
  const sourceMosaic = {
    id: 'mosaic-source', timing: { startTime: 8, duration: 2 }, sourceRect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    style: 'spotlight', intensity: 0.82, spotlightDimming: 0.55, transitionStyle: 'smooth',
  };
  const targetMosaic = {
    id: 'mosaic-target', timing: { startTime: 1, duration: 4 }, sourceRect: { x: 0, y: 0, width: 1, height: 1 }, style: 'blur', intensity: 0.2,
  };
  clipboard.copy(sourceMosaic, 'mosaic');
  clipboard.pasteAttributes(targetMosaic, clipboard.clipboardData, 'mosaic');
  assert.equal(targetMosaic.id, 'mosaic-target');
  assert.deepEqual(targetMosaic.timing, { startTime: 1, duration: 4 });
  assert.deepEqual(targetMosaic.sourceRect, sourceMosaic.sourceRect);
  assert.equal(targetMosaic.style, 'spotlight');
  assert.equal(targetMosaic.intensity, 0.82);
  assert.notEqual(targetMosaic.sourceRect, sourceMosaic.sourceRect, 'nested visual values are copied');

  const sourceSticker = {
    id: 'sticker-source', timing: { startTime: 3, duration: 2 }, relativePath: 'media/one.png',
    position: { x: 0.25, y: 0.75 }, width: 0.45, height: 0.3, rotationDegrees: 24, opacity: 0.65, hidesScreen: true,
  };
  const targetSticker = { id: 'sticker-target', timing: { startTime: 5, duration: 7 }, relativePath: 'media/two.png', position: { x: 0.5, y: 0.5 } };
  clipboard.copy(sourceSticker, 'sticker');
  clipboard.pasteAttributes(targetSticker, clipboard.clipboardData, 'sticker');
  assert.equal(targetSticker.id, 'sticker-target');
  assert.deepEqual(targetSticker.timing, { startTime: 5, duration: 7 });
  assert.equal(targetSticker.relativePath, 'media/one.png');
  assert.deepEqual(targetSticker.position, { x: 0.25, y: 0.75 });
  assert.equal(targetSticker.opacity, 0.65);
  assert.equal(targetSticker.hidesScreen, true);

  const beforeMismatch = structuredClone(targetSticker);
  clipboard.pasteAttributes(targetSticker, clipboard.clipboardData, 'mosaic');
  assert.deepEqual(targetSticker, beforeMismatch, 'different effect kinds are left untouched');
});

console.log(`\nAll ${passed} tests passed successfully.`);
