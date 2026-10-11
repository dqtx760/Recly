'use strict';

const assert = require('node:assert/strict');
const {
  NormalizedCrop,
  ScreenFrameStyle,
  FRAME_DEFAULTS,
  ScreenFrameDefaults,
  decorationInsets,
  screenDecoration,
} = require('../src/core/crop-frame');
const { defaultCanvas, normalizeProject } = require('../src/core/model');

const near = (actual, expected, tolerance = 1e-5, label = '') => {
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

console.log('Running crop-frame.test.js...');

// ==========================================
// 1. NormalizedCrop Tests
// ==========================================

test('NormalizedCrop: default constructor creates full crop (0, 0, 1, 1)', () => {
  const crop = new NormalizedCrop();
  assert.equal(crop.x, 0);
  assert.equal(crop.y, 0);
  assert.equal(crop.width, 1);
  assert.equal(crop.height, 1);
  assert.equal(crop.left, 0);
  assert.equal(crop.top, 0);
  assert.equal(crop.right, 0);
  assert.equal(crop.bottom, 0);

  const full = NormalizedCrop.full;
  assert.equal(full.x, 0);
  assert.equal(full.y, 0);
  assert.equal(full.width, 1);
  assert.equal(full.height, 1);
});

test('NormalizedCrop: clamped within [0, 1] with safe minimum size', () => {
  // Normal crop within range
  const valid = NormalizedCrop.clamped({ x: 0.1, y: 0.2, width: 0.7, height: 0.6 });
  near(valid.x, 0.1);
  near(valid.y, 0.2);
  near(valid.width, 0.7);
  near(valid.height, 0.6);

  // Negative origin clamped to 0
  const negative = NormalizedCrop.clamped({ x: -0.5, y: -0.2, width: 0.5, height: 0.5 });
  near(negative.x, 0);
  near(negative.y, 0);
  near(negative.width, 0.5);
  near(negative.height, 0.5);

  // Exceeding width and height clamped to remaining room
  const overflowing = NormalizedCrop.clamped({ x: 0.8, y: 0.9, width: 0.5, height: 0.5 });
  near(overflowing.x, 0.8);
  near(overflowing.y, 0.9);
  near(overflowing.width, 0.2); // 1 - 0.8
  near(overflowing.height, 0.1); // 1 - 0.9

  // Minimum size enforcement
  const tiny = NormalizedCrop.clamped({ x: 0.5, y: 0.5, width: 0.001, height: 0.005 }, 0.05);
  near(tiny.width, 0.05);
  near(tiny.height, 0.05);

  // Instance method clamped()
  const instance = new NormalizedCrop(-0.1, 0.2, 1.5, 0.4);
  const clampedInstance = instance.clamped();
  near(clampedInstance.x, 0);
  near(clampedInstance.y, 0.2);
  near(clampedInstance.width, 1.0);
  near(clampedInstance.height, 0.4);
});

test('NormalizedCrop: fromEdges and toEdges round-trip', () => {
  const left = 0.1;
  const right = 0.15;
  const top = 0.05;
  const bottom = 0.2;

  const crop = NormalizedCrop.fromEdges(left, right, top, bottom);
  near(crop.x, 0.1);
  near(crop.y, 0.05);
  near(crop.width, 0.75); // 1 - 0.1 - 0.15
  near(crop.height, 0.75); // 1 - 0.05 - 0.2

  const edges = crop.toEdges();
  near(edges.left, 0.1);
  near(edges.right, 0.15);
  near(edges.top, 0.05);
  near(edges.bottom, 0.2);

  // Out of bound edges clamped safely
  const extreme = NormalizedCrop.fromEdges(0.8, 0.8, 0.9, 0.9, 0.02);
  assert.ok(extreme.width >= 0.02);
  assert.ok(extreme.height >= 0.02);
  assert.ok(extreme.x + extreme.width <= 1.0001);
  assert.ok(extreme.y + extreme.height <= 1.0001);
});

test('NormalizedCrop: cropSourceRect calculates pixel rect across resolutions', () => {
  const crop = { x: 0.1, y: 0.2, width: 0.8, height: 0.6 };

  // 1080p Full HD (1920x1080)
  const rect1080p = NormalizedCrop.cropSourceRect(crop, 1920, 1080);
  near(rect1080p.sx, 192);
  near(rect1080p.sy, 216);
  near(rect1080p.sw, 1536);
  near(rect1080p.sh, 648);

  // 4K UHD (3840x2160)
  const rect4k = NormalizedCrop.cropSourceRect(crop, 3840, 2160);
  near(rect4k.sx, 384);
  near(rect4k.sy, 432);
  near(rect4k.sw, 3072);
  near(rect4k.sh, 1296);

  // 720p HD (1280x720) with size object { width, height }
  const rect720p = NormalizedCrop.cropSourceRect(crop, { width: 1280, height: 720 });
  near(rect720p.sx, 128);
  near(rect720p.sy, 144);
  near(rect720p.sw, 1024);
  near(rect720p.sh, 432);

  // Vertical Phone (1080x1920)
  const rectVertical = new NormalizedCrop(0.25, 0.1, 0.5, 0.8).cropSourceRect(1080, 1920);
  near(rectVertical.sx, 270);
  near(rectVertical.sy, 192);
  near(rectVertical.sw, 540);
  near(rectVertical.sh, 1536);

  // Clamped safety for invalid inputs
  const rectClamped = NormalizedCrop.cropSourceRect({ x: -1, y: -1, width: 5, height: 5 }, 1920, 1080);
  near(rectClamped.sx, 0);
  near(rectClamped.sy, 0);
  near(rectClamped.sw, 1920);
  near(rectClamped.sh, 1080);
});

// ==========================================
// 2. ScreenFrameStyle and FRAME_DEFAULTS Tests
// ==========================================

test('ScreenFrameStyle: enumeration and helpers', () => {
  assert.equal(ScreenFrameStyle.none, 'none');
  assert.equal(ScreenFrameStyle.windowLight, 'windowLight');
  assert.equal(ScreenFrameStyle.windowDark, 'windowDark');
  assert.equal(ScreenFrameStyle.browserLight, 'browserLight');
  assert.equal(ScreenFrameStyle.browserDark, 'browserDark');
  assert.equal(ScreenFrameStyle.devicePhone, 'devicePhone');

  assert.equal(ScreenFrameStyle.NONE, 'none');
  assert.equal(ScreenFrameStyle.WINDOW_LIGHT, 'windowLight');
  assert.equal(ScreenFrameStyle.DEVICE_PHONE, 'devicePhone');

  assert.ok(ScreenFrameStyle.isDevice('devicePhone'));
  assert.ok(!ScreenFrameStyle.isDevice('windowLight'));

  assert.ok(ScreenFrameStyle.isBrowser('browserLight'));
  assert.ok(ScreenFrameStyle.isBrowser('browserDark'));
  assert.ok(!ScreenFrameStyle.isBrowser('windowDark'));

  assert.ok(ScreenFrameStyle.isWindow('windowLight'));
  assert.ok(ScreenFrameStyle.isWindow('windowDark'));
  assert.ok(!ScreenFrameStyle.isWindow('browserLight'));

  assert.ok(ScreenFrameStyle.isValid('browserDark'));
  assert.ok(!ScreenFrameStyle.isValid('unknownStyle'));
});

test('FRAME_DEFAULTS: matching design specification', () => {
  assert.deepEqual(FRAME_DEFAULTS.none, {
    frameScale: 1.0,
    toolbarScale: 1.0,
    outerRadius: 24,
    contentRadius: 24,
    shadowStrength: 0.28,
    borderWidth: 0,
    borderColor: '#ffffff',
    toolbarHeight: 0,
    bezelWidth: 0,
  });

  assert.equal(FRAME_DEFAULTS.windowLight.toolbarScale, 0.90);
  assert.equal(FRAME_DEFAULTS.windowLight.outerRadius, 18);
  assert.equal(FRAME_DEFAULTS.windowLight.contentRadius, 0);
  assert.equal(FRAME_DEFAULTS.windowLight.shadowStrength, 0.22);
  assert.equal(FRAME_DEFAULTS.windowLight.toolbarHeight, 46);

  assert.equal(FRAME_DEFAULTS.windowDark.toolbarScale, 0.90);
  assert.equal(FRAME_DEFAULTS.windowDark.outerRadius, 18);
  assert.equal(FRAME_DEFAULTS.windowDark.contentRadius, 0);
  assert.equal(FRAME_DEFAULTS.windowDark.shadowStrength, 0.30);
  assert.equal(FRAME_DEFAULTS.windowDark.toolbarHeight, 46);

  assert.equal(FRAME_DEFAULTS.browserLight.toolbarScale, 1.08);
  assert.equal(FRAME_DEFAULTS.browserLight.outerRadius, 22);
  assert.equal(FRAME_DEFAULTS.browserLight.contentRadius, 0);
  assert.equal(FRAME_DEFAULTS.browserLight.shadowStrength, 0.22);
  assert.equal(FRAME_DEFAULTS.browserLight.toolbarHeight, 46);

  assert.equal(FRAME_DEFAULTS.browserDark.toolbarScale, 1.08);
  assert.equal(FRAME_DEFAULTS.browserDark.outerRadius, 22);
  assert.equal(FRAME_DEFAULTS.browserDark.contentRadius, 0);
  assert.equal(FRAME_DEFAULTS.browserDark.shadowStrength, 0.30);
  assert.equal(FRAME_DEFAULTS.browserDark.toolbarHeight, 46);

  assert.equal(FRAME_DEFAULTS.devicePhone.frameScale, 0.90);
  assert.equal(FRAME_DEFAULTS.devicePhone.toolbarScale, 1.0);
  assert.equal(FRAME_DEFAULTS.devicePhone.outerRadius, 64);
  assert.equal(FRAME_DEFAULTS.devicePhone.contentRadius, 40);
  assert.equal(FRAME_DEFAULTS.devicePhone.shadowStrength, 0.24);
  assert.equal(FRAME_DEFAULTS.devicePhone.bezelWidth, 14);

  assert.equal(ScreenFrameDefaults, FRAME_DEFAULTS);
});

test('defaultCanvas and legacy project normalization preserve inherited frame geometry', () => {
  const defaults = defaultCanvas();
  assert.equal(defaults.screenFrameScale, 1);
  assert.equal(defaults.screenFrameToolbarScale, 1);
  assert.equal(defaults.screenFrameOuterCornerRadius, null);
  assert.equal(defaults.screenFrameContentCornerRadius, null);

  const legacy = normalizeProject({
    media: { screen: { duration: 4 } },
    canvas: { screenFrame: 'browserLight' },
    timeline: { segments: [{ id: 'segment', sourceStart: 0, sourceEnd: 4, speed: 1 }] },
  });
  assert.equal(legacy.canvas.screenFrameScale, 1);
  assert.equal(legacy.canvas.screenFrameToolbarScale, 1);
  assert.equal(legacy.canvas.screenFrameOuterCornerRadius, null);
  assert.equal(legacy.canvas.screenFrameContentCornerRadius, null);

  const savedOverrides = normalizeProject({
    media: { screen: { duration: 4 } },
    canvas: {
      screenFrame: 'browserLight',
      screenFrameScale: 0.92,
      screenFrameToolbarScale: 1.12,
      screenFrameOuterCornerRadius: 0,
      screenFrameContentCornerRadius: null,
      screenFrameBrowserAddress: 'https://example.com',
    },
    timeline: { segments: [{ id: 'segment', sourceStart: 0, sourceEnd: 4, speed: 1 }] },
  });
  assert.equal(savedOverrides.canvas.screenFrameScale, 0.92);
  assert.equal(savedOverrides.canvas.screenFrameToolbarScale, 1.12);
  assert.equal(savedOverrides.canvas.screenFrameOuterCornerRadius, 0);
  assert.equal(savedOverrides.canvas.screenFrameContentCornerRadius, null);
  assert.equal(savedOverrides.canvas.screenFrameBrowserAddress, 'https://example.com');
});

// ==========================================
// 3. decorationInsets Tests
// ==========================================

test('decorationInsets: none style returns zero insets', () => {
  const insets = decorationInsets({ style: 'none' });
  assert.deepEqual(insets, { top: 0, right: 0, bottom: 0, left: 0 });

  const emptyInsets = decorationInsets();
  assert.deepEqual(emptyInsets, { top: 0, right: 0, bottom: 0, left: 0 });
});

test('decorationInsets: windowLight and windowDark toolbar insets', () => {
  // Default toolbarScale = 0.90, base toolbarHeight = 46 => 46 * 0.90 = 41.4
  const insetsLight = decorationInsets({ style: 'windowLight' });
  near(insetsLight.top, 41.4);
  near(insetsLight.right, 0);
  near(insetsLight.bottom, 0);
  near(insetsLight.left, 0);

  // Overriding toolbarScale to 1.0 => top = 46
  const insetsFull = decorationInsets({ style: 'windowLight', toolbarScale: 1.0 });
  near(insetsFull.top, 46);

  // windowDark matches windowLight metrics
  const insetsDark = decorationInsets({ style: 'windowDark' });
  near(insetsDark.top, 41.4);

  // With styleScale = 1.5 => top = 46 * 1.5 * 0.9 = 62.1
  const insetsScaled = decorationInsets({ style: 'windowLight', styleScale: 1.5 });
  near(insetsScaled.top, 62.1);
});

test('decorationInsets: browserLight and browserDark toolbar insets', () => {
  // Default toolbarScale = 1.08, base toolbarHeight = 46 => 46 * 1.08 = 49.68
  const insetsLight = decorationInsets({ style: 'browserLight' });
  near(insetsLight.top, 49.68);
  near(insetsLight.right, 0);
  near(insetsLight.bottom, 0);
  near(insetsLight.left, 0);

  // Overriding toolbarScale to 1.0 => top = 46
  const insetsFull = decorationInsets({ style: 'browserLight', toolbarScale: 1.0 });
  near(insetsFull.top, 46);

  // browserDark matches browserLight metrics
  const insetsDark = decorationInsets({ style: 'browserDark' });
  near(insetsDark.top, 49.68);
});

test('decorationInsets: devicePhone bezel insets', () => {
  // Without fitted dimensions, decorationInsets keeps its explicit scale-1 default.
  const insetsPhone = decorationInsets({ style: 'devicePhone' });
  near(insetsPhone.top, 14);
  near(insetsPhone.right, 14);
  near(insetsPhone.bottom, 14);
  near(insetsPhone.left, 14);

  // Frame scale 1.2 => 14 * 1.2 = 16.8
  const insetsScaled = decorationInsets({ style: 'devicePhone', frameScale: 1.2 });
  near(insetsScaled.top, 16.8);
  near(insetsScaled.right, 16.8);
  near(insetsScaled.bottom, 16.8);
  near(insetsScaled.left, 16.8);

  // Dynamic shortEdge calculation with fittedWidth & fittedHeight
  const insetsDynamic = decorationInsets({
    style: 'devicePhone',
    fittedWidth: 1000,
    fittedHeight: 1000,
    frameScale: 1.0,
  });
  // 1000 * 0.026 * 1.0 = 26
  near(insetsDynamic.top, 26);
  near(insetsDynamic.right, 26);
  near(insetsDynamic.bottom, 26);
  near(insetsDynamic.left, 26);
});

// ==========================================
// 4. screenDecoration Tests
// ==========================================

test('screenDecoration: none style produces exact content rect without chrome', () => {
  const geometry = { x: 100, y: 150, width: 800, height: 600 };
  const dec = screenDecoration({
    style: 'none',
    geometry,
  });

  assert.equal(dec.style, 'none');
  assert.equal(dec.kind, 'none');
  assert.equal(dec.isDark, false);
  assert.deepEqual(dec.outerRect, geometry);
  assert.deepEqual(dec.outerDecorationRect, geometry);
  assert.equal(dec.toolbarRect.height, 0);
  assert.equal(dec.controls.buttons.length, 0);
  near(dec.outerCornerRadius, 24);
  near(dec.contentCornerRadius, 24);
});

test('screenDecoration: windowLight creates toolbar and 3 control buttons', () => {
  const geometry = { x: 50, y: 50, width: 1000, height: 700 };
  const dec = screenDecoration({
    style: 'windowLight',
    title: 'My Project - Editor',
    geometry,
  });

  assert.equal(dec.kind, 'window');
  assert.equal(dec.isDark, false);
  assert.equal(dec.title, 'My Project - Editor');

  // Outer rect expanded upwards by top inset
  const expectedTopInset = 41.4; // 46 * 0.90
  near(dec.outerRect.x, 50);
  near(dec.outerRect.y, 50 - expectedTopInset);
  near(dec.outerRect.width, 1000);
  near(dec.outerRect.height, 700 + expectedTopInset);

  // Toolbar rect
  assert.ok(dec.toolbarRect.height >= expectedTopInset);
  near(dec.toolbarRect.x, dec.outerRect.x);
  near(dec.toolbarRect.y, dec.outerRect.y);
  near(dec.toolbarRect.width, dec.outerRect.width);

  // 3 macOS-style control buttons (red, yellow, green)
  assert.equal(dec.controls.buttons.length, 3);
  assert.equal(dec.controls.buttons[0].color, '#ff5f57');
  assert.equal(dec.controls.buttons[1].color, '#febc2e');
  assert.equal(dec.controls.buttons[2].color, '#28c840');
  assert.ok(dec.controls.endX > dec.toolbarRect.x);

  // Corner radii
  near(dec.outerCornerRadius, 18);
  near(dec.contentCornerRadius, 0);

  // Colors
  assert.equal(dec.surfaceColor, '#ecedf0');
  assert.equal(dec.toolbarColor, '#f4f4f6');
});

test('screenDecoration: windowDark applies dark palette', () => {
  const dec = screenDecoration({
    style: 'windowDark',
    geometry: { x: 0, y: 0, width: 800, height: 600 },
  });

  assert.equal(dec.isDark, true);
  assert.equal(dec.surfaceColor, '#222327');
  assert.equal(dec.toolbarColor, '#313238');
  assert.equal(dec.separatorColor, '#4b4d55');
  assert.equal(dec.fieldColor, '#1b1c20');
  assert.equal(dec.glyphColor, '#a9abb3');
});

test('screenDecoration: browserLight and browserDark with address bar layout', () => {
  const dec = screenDecoration({
    style: 'browserLight',
    title: 'Google',
    browserAddress: 'https://example.com/docs',
    geometry: { x: 0, y: 0, width: 1200, height: 800 },
  });

  assert.equal(dec.kind, 'browser');
  assert.equal(dec.browserAddress, 'https://example.com/docs');
  assert.ok(dec.addressFieldRect !== null);
  assert.ok(dec.addressFieldRect.width > 50);
  assert.ok(dec.addressFieldRect.height > 10);
  assert.ok(dec.addressFieldRect.x >= dec.controls.endX);

  near(dec.outerCornerRadius, 22);
  near(dec.contentCornerRadius, 0);

  // browserDark test
  const darkDec = screenDecoration({
    style: 'browserDark',
    geometry: { x: 0, y: 0, width: 1200, height: 800 },
  });
  assert.equal(darkDec.isDark, true);
  assert.equal(darkDec.kind, 'browser');
});

test('screenDecoration: devicePhone expands outer rect on all 4 sides', () => {
  const geometry = { x: 100, y: 100, width: 400, height: 800 };
  const dec = screenDecoration({
    style: 'devicePhone',
    geometry,
  });

  assert.equal(dec.kind, 'devicePhone');
  assert.equal(dec.isDark, true);

  // Short edge is 400 => bezel = 400 * 0.026 * 0.90 = 9.36px
  const expectedBezel = 400 * 0.026 * 0.90;
  near(dec.outerRect.x, 100 - expectedBezel);
  near(dec.outerRect.y, 100 - expectedBezel);
  near(dec.outerRect.width, 400 + expectedBezel * 2);
  near(dec.outerRect.height, 800 + expectedBezel * 2);

  near(dec.outerCornerRadius, 57.6); // authored radius 64 * frameScale 0.90
  near(dec.contentCornerRadius, 36); // authored radius 40 * frameScale 0.90
  near(dec.shadowStrength, 0.24);
});

test('screenDecoration: text truncation and safe limits', () => {
  const longTitle = 'A'.repeat(200);
  const longAddress = 'B'.repeat(300);

  const dec = screenDecoration({
    style: 'browserLight',
    title: longTitle,
    browserAddress: longAddress,
  });

  assert.equal(dec.title.length, 120);
  assert.equal(dec.browserAddress.length, 240);
});

console.log(`\nAll ${passed} crop-frame tests passed!`);
