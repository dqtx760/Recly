'use strict';

const assert = require('node:assert/strict');
const {
  ScreenProjection,
  ProjectedScreenQuad,
  ProjectedScreenPointMapper,
  contains,
} = require('../src/core/projection');
const { FocusEffect, FocusEffectEvaluator } = require('../src/core/focus');

const near = (actual, expected, tolerance = 1e-6, label = '') => {
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

console.log('Running projection.test.js...');

test('Identity projection (rotation=0, perspective=0) returns original corners', () => {
  const rect = { x: 100, y: 150, width: 800, height: 600 };
  const quad = ScreenProjection.project({
    rect,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    perspective: 0,
  });

  near(quad.topLeft.x, 100);
  near(quad.topLeft.y, 150);
  near(quad.topRight.x, 900);
  near(quad.topRight.y, 150);
  near(quad.bottomRight.x, 900);
  near(quad.bottomRight.y, 750);
  near(quad.bottomLeft.x, 100);
  near(quad.bottomLeft.y, 750);

  near(quad.center.x, 500);
  near(quad.center.y, 450);
  near(quad.bounds.x, 100);
  near(quad.bounds.y, 150);
  near(quad.bounds.width, 800);
  near(quad.bounds.height, 600);
});

test('3D projection produces expected perspective trapezoid', () => {
  const rect = { x: 0, y: 0, width: 1000, height: 1000 };
  // Rotate around X axis with perspective: top tilts away or forward, bottom tilts oppositely
  const quad = ScreenProjection.project({
    rect,
    rotationX: 30,
    rotationY: 0,
    rotationZ: 0,
    perspective: 1.0,
  });

  // Top edge and bottom edge should have different horizontal widths (perspective trapezoid)
  const topWidth = quad.topRight.x - quad.topLeft.x;
  const bottomWidth = quad.bottomRight.x - quad.bottomLeft.x;
  assert.notEqual(topWidth, bottomWidth);
  assert.ok(topWidth > 0);
  assert.ok(bottomWidth > 0);

  // Symmetry around center x=500
  near(quad.center.x, 500, 1e-4);
  near(quad.topLeft.x + quad.topRight.x, 1000, 1e-4);
  near(quad.bottomLeft.x + quad.bottomRight.x, 1000, 1e-4);
});

test('Homography unproject maps projected point back to original source point with <1e-6 error', () => {
  const rect = { x: 200, y: 150, width: 640, height: 480 };
  const quad = ScreenProjection.project({
    rect,
    rotationX: 25,
    rotationY: -20,
    rotationZ: 15,
    perspective: 0.8,
  });

  const mapper = quad.projector(rect);
  assert.ok(mapper !== null);

  const testPoints = [
    { x: 200, y: 150 }, // topLeft
    { x: 840, y: 150 }, // topRight
    { x: 840, y: 630 }, // bottomRight
    { x: 200, y: 630 }, // bottomLeft
    { x: 520, y: 390 }, // center
    { x: 300, y: 250 },
    { x: 750, y: 550 },
    { x: 400, y: 600 },
  ];

  for (const pt of testPoints) {
    const projected = mapper.project(pt);
    assert.ok(projected !== null);
    const unprojected = mapper.unproject(projected);
    assert.ok(unprojected !== null);

    near(unprojected.x, pt.x, 1e-6, `Unproject X for (${pt.x}, ${pt.y})`);
    near(unprojected.y, pt.y, 1e-6, `Unproject Y for (${pt.x}, ${pt.y})`);
  }
});

test('Winding number containment works for projected quad', () => {
  const rect = { x: 100, y: 100, width: 400, height: 400 };
  const quad = ScreenProjection.project({
    rect,
    rotationX: 20,
    rotationY: 10,
    rotationZ: 5,
    perspective: 0.5,
  });

  // Center should be inside
  assert.ok(quad.contains(quad.center));
  assert.ok(contains(quad.center, quad));

  // Points far outside
  assert.ok(!quad.contains({ x: -100, y: -100 }));
  assert.ok(!quad.contains({ x: 2000, y: 2000 }));

  // Boundary corners should be considered inside
  assert.ok(quad.contains(quad.topLeft));
  assert.ok(quad.contains(quad.topRight));
  assert.ok(quad.contains(quad.bottomRight));
  assert.ok(quad.contains(quad.bottomLeft));
});

test('FocusEffect model validation and properties', () => {
  const linear = new FocusEffect({ linear: true });
  assert.equal(linear.shape, 'linear');
  assert.equal(linear.angleDegrees, 0);
  assert.equal(linear.target, 'fixed');
  assert.equal(linear.dimming, 0);
  assert.ok(linear.isValid);

  const radial = new FocusEffect({
    shape: 'radial',
    size: 0.5,
    blur: 0.4,
    softness: 0.6,
    dimming: 0.2,
  });
  assert.equal(radial.shape, 'radial');
  assert.equal(radial.target, 'animation');
  assert.ok(radial.isValid);
  near(radial.clearHalfWidth(1000), 250);
  near(radial.featherWidth(1000), 240);

  const invalid = new FocusEffect({ size: 0.05 });
  assert.ok(!invalid.isValid);
});

test('FocusEffectEvaluator scene evaluation with zoom clip', () => {
  const zoom = {
    startTime: 2,
    duration: 3,
    enterDuration: 0.5,
    exitDuration: 0.5,
    easing: 'linear',
    focusEffect: {
      shape: 'radial',
      target: 'animation',
      size: 0.4,
      blur: 0.3,
      softness: 0.5,
      dimming: 0.2,
    },
  };

  const zoomFocus = { x: 0.4, y: 0.6 };

  // Before clip: no scene
  const before = FocusEffectEvaluator.scene({
    zoom,
    zoomFocus,
    time: 1.5,
  });
  assert.equal(before, null);

  // During enter lead-in (t = 2.25, midway through 0.5s leadIn)
  const enterScene = FocusEffectEvaluator.scene({
    zoom,
    zoomFocus,
    time: 2.25,
  });
  assert.ok(enterScene !== null);
  near(enterScene.progress, 0.5, 1e-4);
  near(enterScene.center.x, 0.4);
  near(enterScene.center.y, 0.6);

  // During hold (t = 3.5)
  const holdScene = FocusEffectEvaluator.scene({
    zoom,
    zoomFocus,
    time: 3.5,
  });
  assert.ok(holdScene !== null);
  near(holdScene.progress, 1.0, 1e-4);

  // During exit (t = 5.25, midway through exit from 5.0 to 5.5)
  const exitScene = FocusEffectEvaluator.scene({
    zoom,
    zoomFocus,
    time: 5.25,
  });
  assert.ok(exitScene !== null);
  near(exitScene.progress, 0.5, 1e-4);

  // After exit (t = 6.0)
  const after = FocusEffectEvaluator.scene({
    zoom,
    zoomFocus,
    time: 6.0,
  });
  assert.equal(after, null);
});

test('FocusEffectEvaluator pointer target tracking', () => {
  const zoom = {
    startTime: 1,
    duration: 2,
    enterDuration: 0.2,
    exitDuration: 0.2,
    easing: 'linear',
    focusEffect: {
      shape: 'radial',
      target: 'pointer',
      size: 0.4,
      blur: 0.3,
      softness: 0.5,
      dimming: 0.2,
    },
  };

  const scenePointer = FocusEffectEvaluator.scene({
    zoom,
    zoomFocus: { x: 0.5, y: 0.5 },
    pointer: { x: 0.8, y: 0.2 },
    time: 1.5,
  });
  assert.ok(scenePointer !== null);
  near(scenePointer.center.x, 0.8);
  near(scenePointer.center.y, 0.2);
});

console.log(`\nAll ${passed} projection & focus tests passed!`);
