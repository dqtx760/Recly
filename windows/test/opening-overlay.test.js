'use strict';

const assert = require('node:assert/strict');
const {
  OpeningSequence,
  openingSample,
  MosaicClip,
  StickerClip,
  evaluateMosaics,
  evaluateStickers,
  evaluateStickerBackdrop,
  evaluateMotionCurve,
  smootherStep,
  overlayEffectProgress,
  automaticExit,
  stickerAnimationTransform,
} = require('../src/core/opening-overlay');

const near = (actual, expected, tolerance = 1e-4, label = '') => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} expected ${expected}, got ${actual} (diff: ${Math.abs(actual - expected)})`
  );
};

let passed = 0;
const test = (name, body) => {
  body();
  passed += 1;
  console.log(`  ok  ${name}`);
};

console.log('Running opening-overlay.test.js...');

// ============================================================================
// 1. OpeningSequence 模型与时间计算测试
// ============================================================================

test('OpeningSequence initializes with defaults and clamps values', () => {
  const seq = new OpeningSequence();
  assert.equal(seq.isEnabled, false);
  assert.equal(seq.preset, 'light3D');
  assert.equal(seq.motionCurve, 'swift');
  assert.equal(seq.duration, 2.2);
  assert.equal(seq.stagger, 0.16);
  assert.deepEqual(seq.includedElements, ['screen', 'camera', 'stickers']);
  assert.deepEqual(seq.elementOrder, ['screen', 'camera', 'stickers']);

  // Clamping duration [0.4, 8] and stagger
  const clampedLow = new OpeningSequence({ duration: 0.1, stagger: -0.5 });
  assert.equal(clampedLow.duration, 0.4);
  assert.equal(clampedLow.stagger, 0);

  const clampedHigh = new OpeningSequence({ duration: 15, stagger: 2.0 });
  assert.equal(clampedHigh.duration, 8);
  assert.equal(clampedHigh.stagger, 1.2);
});

test('OpeningSequence aliases and element normalization work', () => {
  const seq = new OpeningSequence({
    preset: '聚拢',
    includedElements: ['贴图', '屏幕'],
    elementOrder: ['摄像头'],
  });
  assert.equal(seq.preset, 'converge');
  assert.deepEqual(seq.includedElements, ['stickers', 'screen']);
  // elementOrder appends missing elements in standard order
  assert.deepEqual(seq.elementOrder, ['camera', 'screen', 'stickers']);
});

test('OpeningSequence maximumStagger calculation', () => {
  const seq = new OpeningSequence({ duration: 2.2 });
  // gapCount for 3 elements is 2: (2.2 - 0.18) / 2 = 1.01
  near(seq.maximumStagger(3), 1.01);
  // 1 or 0 elements: no gap constraint, returns 1.2
  assert.equal(seq.maximumStagger(1), 1.2);
  assert.equal(seq.maximumStagger(0), 1.2);

  // Very short duration
  const shortSeq = new OpeningSequence({ duration: 0.4 });
  // (0.4 - 0.18) / 2 = 0.11
  near(shortSeq.maximumStagger(3), 0.11);
});

// ============================================================================
// 2. openingSample 采样与预设形变测试
// ============================================================================

test('openingSample returns identity when sequence is disabled or duration expired', () => {
  const disabledSeq = new OpeningSequence({ isEnabled: false, duration: 2.0 });
  const sample1 = openingSample('screen', disabledSeq, ['screen'], 0.5, 1920, 1080);
  assert.equal(sample1.opacity, 1);
  assert.equal(sample1.scale, 1);
  assert.equal(sample1.offset.x, 0);
  assert.equal(sample1.offset.y, 0);
  assert.equal(sample1.rotationX, 0);
  assert.equal(sample1.rotationY, 0);
  assert.equal(sample1.perspective, 0);

  const enabledSeq = new OpeningSequence({ isEnabled: true, duration: 2.0 });
  // Exactly at duration
  const sampleAtEnd = openingSample('screen', enabledSeq, ['screen'], 2.0, 1920, 1080);
  assert.equal(sampleAtEnd.scale, 1);
  assert.equal(sampleAtEnd.offset.x, 0);
  assert.equal(sampleAtEnd.offset.y, 0);

  // After duration
  const samplePastEnd = openingSample('screen', enabledSeq, ['screen'], 2.5, 1920, 1080);
  assert.equal(samplePastEnd.scale, 1);
  assert.equal(samplePastEnd.offset.x, 0);
  assert.equal(samplePastEnd.offset.y, 0);

  // Element not in activeElements
  const sampleInactive = openingSample('camera', enabledSeq, ['screen'], 0.1, 1920, 1080);
  assert.equal(sampleInactive.scale, 1);
  assert.equal(sampleInactive.offset.x, 0);
});

test('openingSample produces expected initial offsets for converge preset', () => {
  const cw = 1920;
  const ch = 1080;
  const seq = new OpeningSequence({
    isEnabled: true,
    preset: 'converge',
    duration: 2.0,
    stagger: 0,
  });

  const screenSample = openingSample('screen', seq, ['screen', 'camera', 'stickers'], 0, cw, ch);
  near(screenSample.offset.x, -cw * 1.05);
  near(screenSample.offset.y, -ch * 0.62);
  near(screenSample.scale, 0.72);
  near(screenSample.opacity, 0);
  assert.equal(screenSample.rotationX, 0);
  assert.equal(screenSample.rotationY, 0);

  const cameraSample = openingSample('camera', seq, ['screen', 'camera', 'stickers'], 0, cw, ch);
  near(cameraSample.offset.x, cw * 1.12);
  near(cameraSample.offset.y, ch * 0.72);
  near(cameraSample.scale, 0.58);
  near(cameraSample.opacity, 0);

  const stickerSample = openingSample('stickers', seq, ['screen', 'camera', 'stickers'], 0, cw, ch);
  near(stickerSample.offset.x, -cw * 1.30);
  near(stickerSample.offset.y, -ch * 0.70);
  near(stickerSample.scale, 0.62);
  near(stickerSample.opacity, 0);
});

test('openingSample produces expected initial offsets for sideSlide preset', () => {
  const cw = 1920;
  const ch = 1080;
  const seq = new OpeningSequence({
    isEnabled: true,
    preset: 'sideSlide',
    duration: 2.0,
    stagger: 0,
  });

  const screenSample = openingSample('screen', seq, ['screen', 'camera', 'stickers'], 0, cw, ch);
  near(screenSample.offset.x, -cw * 1.12);
  near(screenSample.offset.y, 0);
  near(screenSample.scale, 0.94);
  near(screenSample.opacity, 0);

  const cameraSample = openingSample('camera', seq, ['screen', 'camera', 'stickers'], 0, cw, ch);
  near(cameraSample.offset.x, cw * 1.15);
  near(cameraSample.offset.y, 0);
  near(cameraSample.scale, 0.88);

  const stickerSample = openingSample('stickers', seq, ['screen', 'camera', 'stickers'], 0, cw, ch);
  near(stickerSample.offset.x, -cw * 1.35);
  near(stickerSample.offset.y, 0);
  near(stickerSample.scale, 0.90);
});

test('openingSample produces expected initial offsets and 3D tilt for light3D preset', () => {
  const cw = 1920;
  const ch = 1080;
  const seq = new OpeningSequence({
    isEnabled: true,
    preset: 'light3D',
    duration: 2.0,
    stagger: 0,
  });

  const screenSample = openingSample('screen', seq, ['screen', 'camera', 'stickers'], 0, cw, ch);
  near(screenSample.offset.x, -cw * 1.05);
  near(screenSample.offset.y, ch * 0.08);
  near(screenSample.scale, 0.80);
  near(screenSample.opacity, 0);
  near(screenSample.rotationX, 9);
  near(screenSample.rotationY, -22);
  near(screenSample.perspective, 0.72);

  const cameraSample = openingSample('camera', seq, ['screen', 'camera', 'stickers'], 0, cw, ch);
  near(cameraSample.offset.x, cw * 1.10);
  near(cameraSample.offset.y, ch * 0.16);
  near(cameraSample.scale, 0.72);

  const stickerSample = openingSample('stickers', seq, ['screen', 'camera', 'stickers'], 0, cw, ch);
  near(stickerSample.offset.x, -cw * 1.30);
  near(stickerSample.offset.y, -ch * 0.12);
  near(stickerSample.scale, 0.76);
});

test('openingSample settles cleanly to 0 offsets and unit scale as time advances', () => {
  const cw = 1000;
  const ch = 1000;
  const seq = new OpeningSequence({
    isEnabled: true,
    preset: 'light3D',
    duration: 2.0,
    stagger: 0.1,
  });

  const active = ['screen', 'camera', 'stickers'];

  // Check monotonicity of screen offset approaching 0
  let prevAbsX = Math.abs(openingSample('screen', seq, active, 0, cw, ch).offset.x);
  for (let t = 0.2; t < 1.9; t += 0.2) {
    const s = openingSample('screen', seq, active, t, cw, ch);
    const absX = Math.abs(s.offset.x);
    assert.ok(absX <= prevAbsX + 1e-4, `Offset X should decrease towards 0 at time ${t}`);
    prevAbsX = absX;
  }

  // At the end of sequence, all elements settle to offset 0 and scale near 1
  for (const elem of active) {
    const endSample = openingSample(elem, seq, active, 1.9999, cw, ch);
    near(endSample.offset.x, 0, 1.0, `${elem} end offset.x`);
    near(endSample.offset.y, 0, 1.0, `${elem} end offset.y`);
    near(endSample.scale, 1.0, 0.02, `${elem} end scale`);
    near(endSample.opacity, 1.0, 0.02, `${elem} end opacity`);
  }
});

test('openingSample element stagger delays start of later elements', () => {
  const seq = new OpeningSequence({
    isEnabled: true,
    preset: 'converge',
    duration: 2.0,
    stagger: 0.2,
  });

  const active = ['screen', 'camera', 'stickers'];

  // At t = 0.1:
  // screen (index 0) has started (t = 0.1 > start 0)
  const screenSample = openingSample('screen', seq, active, 0.1);
  assert.ok(screenSample.opacity > 0, 'Screen should start animating immediately');

  // camera (index 1) starts at t = 0.2, so at t = 0.1 it is still at its initial state
  const cameraSample = openingSample('camera', seq, active, 0.1);
  near(cameraSample.opacity, 0);
  near(cameraSample.remaining, 1);

  // stickers (index 2) starts at t = 0.4, so at t = 0.3 it is still at its initial state
  const stickerSample = openingSample('stickers', seq, active, 0.3);
  near(stickerSample.opacity, 0);
  near(stickerSample.remaining, 1);
});

// ============================================================================
// 3. MosaicClip 与 evaluateMosaics 测试
// ============================================================================

test('MosaicClip default constructor assigns defaults and creates timing', () => {
  const clip = new MosaicClip({
    startTime: 2.0,
    duration: 4.0,
    style: 'blur',
  });
  assert.equal(clip.timing.startTime, 2.0);
  assert.equal(clip.timing.duration, 4.0);
  assert.equal(clip.style, 'blur');
  assert.equal(clip.transitionStyle, 'none'); // blur defaults to none
  assert.equal(clip.intensity, 0.55);

  const spotlight = new MosaicClip({
    startTime: 1.0,
    duration: 3.0,
    style: 'spotlight',
  });
  assert.equal(spotlight.transitionStyle, 'smooth'); // spotlight defaults to smooth
});

test('evaluateMosaics filters clips to strictly [startTime, endTime)', () => {
  const clips = [
    new MosaicClip({ startTime: 1.0, duration: 2.0 }), // [1.0, 3.0)
    new MosaicClip({ startTime: 2.5, duration: 1.5 }), // [2.5, 4.0)
  ];

  assert.equal(evaluateMosaics(clips, 0.5).length, 0, 'Inactive before start');
  assert.equal(evaluateMosaics(clips, 1.0).length, 1, 'Active at startTime');
  assert.equal(evaluateMosaics(clips, 2.0).length, 1, 'Active during clip 1');
  assert.equal(evaluateMosaics(clips, 2.6).length, 2, 'Both active during overlap');
  assert.equal(evaluateMosaics(clips, 3.0).length, 1, 'Clip 1 expires exactly at 3.0, clip 2 active');
  assert.equal(evaluateMosaics(clips, 4.0).length, 0, 'Clip 2 expires at 4.0');
  assert.equal(evaluateMosaics(clips, 4.5).length, 0, 'Inactive past end');
});

test('evaluateMosaics computes correct transition progress for linear and smooth styles', () => {
  // Linear transition: in 0.5s, out 0.5s, duration 4.0s (start 10s -> end 14s)
  const linearClip = new MosaicClip({
    startTime: 10.0,
    duration: 4.0,
    transitionStyle: 'linear',
    transitionInDuration: 0.5,
    transitionOutDuration: 0.5,
  });

  // At start (10.0s): progress 0
  let res = evaluateMosaics([linearClip], 10.0);
  near(res[0].transitionProgress, 0);

  // At 10.25s (halfway in): progress 0.5
  res = evaluateMosaics([linearClip], 10.25);
  near(res[0].transitionProgress, 0.5);

  // At 10.5s (fully entered): progress 1.0
  res = evaluateMosaics([linearClip], 10.5);
  near(res[0].transitionProgress, 1.0);

  // At 12.0s (middle plateau): progress 1.0
  res = evaluateMosaics([linearClip], 12.0);
  near(res[0].transitionProgress, 1.0);

  // At 13.75s (halfway through exit): progress 0.5
  res = evaluateMosaics([linearClip], 13.75);
  near(res[0].transitionProgress, 0.5);

  // Smooth transition: verify smootherStep curve
  const smoothClip = new MosaicClip({
    startTime: 0,
    duration: 2.0,
    transitionStyle: 'smooth',
    transitionInDuration: 1.0,
    transitionOutDuration: 1.0,
  });

  // At 0.5s, linear is 0.5, smootherStep(0.5) is 0.5 * 0.5 * 0.5 * (0.5 * (3 - 15) + 10) = 0.5
  res = evaluateMosaics([smoothClip], 0.5);
  near(res[0].transitionProgress, smootherStep(0.5));
});

// ============================================================================
// 4. StickerClip 与 evaluateStickers 测试
// ============================================================================

test('StickerClip initializes with expected defaults', () => {
  const sticker = new StickerClip({
    startTime: 5.0,
    duration: 3.0,
    animation: 'pop',
  });
  assert.equal(sticker.timing.startTime, 5.0);
  assert.equal(sticker.timing.duration, 3.0);
  assert.equal(sticker.animation, 'pop');
  assert.equal(sticker.enterDuration, 0.7);
  assert.equal(sticker.exitDuration, 0.22);
  assert.equal(sticker.opacity, 1);
});

test('evaluateStickers filters by active timing [startTime, endTime)', () => {
  const stickers = [
    new StickerClip({ startTime: 1.0, duration: 2.0 }),
  ];
  assert.equal(evaluateStickers(stickers, 0.99).length, 0);
  assert.equal(evaluateStickers(stickers, 1.0).length, 1);
  assert.equal(evaluateStickers(stickers, 2.5).length, 1);
  assert.equal(evaluateStickers(stickers, 3.0).length, 0);
});

test('evaluateStickers computes correct pop animation scale and opacity', () => {
  const clip = new StickerClip({
    startTime: 0,
    duration: 2.0,
    animation: 'pop',
    animationCurve: 'swift',
    enterDuration: 0.6,
    exitDuration: 0.4,
    opacity: 0.9,
  });

  // At t = 0: entering started, scale is 0.72, opacity is 0
  let res = evaluateStickers([clip], 0, 1920, 1080);
  near(res[0].scale, 0.72);
  near(res[0].opacity, 0);

  // At t = 0.6: enter complete, scale settles to 1.0, opacity to clip.opacity (0.9)
  res = evaluateStickers([clip], 0.6, 1920, 1080);
  near(res[0].scale, 1.0);
  near(res[0].opacity, 0.9);

  // At t = 1.0 (middle): scale 1.0, opacity 0.9
  res = evaluateStickers([clip], 1.0, 1920, 1080);
  near(res[0].scale, 1.0);
  near(res[0].opacity, 0.9);

  // At t = 1.8 (halfway into 0.4s exit): exit progress is ~0.5
  // Pop exit scales back towards 0.72, opacity drops
  res = evaluateStickers([clip], 1.8, 1920, 1080);
  assert.ok(res[0].scale < 1.0, 'Scale should decrease during exit');
  assert.ok(res[0].scale >= 0.72, 'Scale should not drop below 0.72');
  assert.ok(res[0].opacity < 0.9, 'Opacity should drop during exit');
});

test('evaluateStickers computes correct fade animation opacity without scaling', () => {
  const clip = new StickerClip({
    startTime: 0,
    duration: 2.0,
    animation: 'fade',
    enterDuration: 0.5,
    exitDuration: 0.5,
    opacity: 0.8,
  });

  // At t = 0: scale is 1.0, opacity 0
  let res = evaluateStickers([clip], 0, 1920, 1080);
  near(res[0].scale, 1.0);
  near(res[0].opacity, 0);

  // At t = 0.5: enter complete, scale 1.0, opacity 0.8
  res = evaluateStickers([clip], 0.5, 1920, 1080);
  near(res[0].scale, 1.0);
  near(res[0].opacity, 0.8);

  // At t = 1.75: halfway through 0.5s exit, opacity ramps down
  res = evaluateStickers([clip], 1.75, 1920, 1080);
  near(res[0].scale, 1.0);
  assert.ok(res[0].opacity < 0.8 && res[0].opacity > 0);
});

test('evaluateStickers slide animation starts off-canvas and settles to target center', () => {
  const cw = 1920;
  const ch = 1080;
  const clip = new StickerClip({
    startTime: 0,
    duration: 3.0,
    position: { x: 0.5, y: 0.5 },
    animation: 'slideLeft',
    enterDuration: 1.0,
    exitDuration: 1.0,
  });

  // At t = 0: starts far to the left outside canvas
  let res = evaluateStickers([clip], 0, cw, ch);
  assert.ok(res[0].x < 0, `Initial slideLeft x (${res[0].x}) should be off-canvas left (< 0)`);
  near(res[0].scale, 1.0);

  // At t = 1.0: enter settles at target center (0.5 * 1920 = 960)
  res = evaluateStickers([clip], 1.0, cw, ch);
  near(res[0].x, 960);
  near(res[0].y, 540);

  // During exit (t = 2.9): automatic exit for slideLeft is slideRight,
  // so it slides out towards the right beyond canvas (x > 1920)
  res = evaluateStickers([clip], 2.9, cw, ch);
  assert.ok(res[0].x > 960, `slideRight exit x (${res[0].x}) should move to the right`);
});

test('evaluateStickers returns required transform fields and respects layerIndex order', () => {
  const clip1 = new StickerClip({
    startTime: 0,
    duration: 1.0,
    layerIndex: 2,
    rotationDegrees: 45,
  });
  const clip2 = new StickerClip({
    startTime: 0,
    duration: 1.0,
    layerIndex: 1,
  });

  const res = evaluateStickers([clip1, clip2], 0.5, 1920, 1080);
  assert.equal(res.length, 2);

  // Sorted by layerIndex ascending (1 before 2)
  assert.equal(res[0].layerIndex, 1);
  assert.equal(res[1].layerIndex, 2);

  // Verify transform object and fields
  const t = res[1].transform;
  assert.ok(t);
  assert.ok(Number.isFinite(t.x));
  assert.ok(Number.isFinite(t.y));
  assert.ok(Number.isFinite(t.width));
  assert.ok(Number.isFinite(t.height));
  assert.equal(t.rotation, 45);
  assert.ok(Number.isFinite(t.opacity));
  assert.ok(Number.isFinite(t.scale));
});

test('evaluateStickers joins adjacent cuts of the same image without dropping backdrop suppression', () => {
  const clips = [
    new StickerClip({
      id: 'outgoing', relativePath: 'media/card.png', timing: { startTime: 0, duration: 2 },
      position: { x: 0.3, y: 0.5 }, hidesScreen: true, hidesCamera: true,
    }),
    new StickerClip({
      id: 'incoming', relativePath: 'media/card.png', timing: { startTime: 2, duration: 2 },
      position: { x: 0.7, y: 0.5 }, hidesScreen: true, hidesCamera: true,
    }),
  ];
  const scenes = evaluateStickers(clips, 2, 1000, 500);
  assert.equal(scenes.length, 2, '接点两侧的贴图都应参与交接');
  assert.ok(scenes.every((sticker) => sticker.transitionProgress > 0), '交接时两侧贴图均应可见');
  const backdrop = evaluateStickerBackdrop(clips, 2, scenes);
  assert.equal(backdrop.screenSuppression, 1, '相邻片段均隐藏屏幕时，接点不能闪现屏幕');
  assert.equal(backdrop.cameraSuppression, 1, '相邻片段均隐藏摄像头时，接点不能闪现摄像头');
});

test('automaticExit maps complementary slide directions and preserves none/fade/pop', () => {
  assert.equal(automaticExit('slideLeft'), 'slideRight');
  assert.equal(automaticExit('slideRight'), 'slideLeft');
  assert.equal(automaticExit('slideUp'), 'slideDown');
  assert.equal(automaticExit('slideDown'), 'slideUp');
  assert.equal(automaticExit('slideTopLeft'), 'slideBottomRight');
  assert.equal(automaticExit('slideTopRight'), 'slideBottomLeft');
  assert.equal(automaticExit('slideBottomLeft'), 'slideTopRight');
  assert.equal(automaticExit('slideBottomRight'), 'slideTopLeft');
  assert.equal(automaticExit('pop'), 'pop');
  assert.equal(automaticExit('fade'), 'fade');
  assert.equal(automaticExit('none'), 'none');
});

console.log(`\nAll ${passed} tests passed successfully!`);
