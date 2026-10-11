'use strict';

const assert = require('node:assert/strict');
const { splitEffectClip } = require('../src/renderer/editor/effect-editing');

const test = (name, body) => {
  body();
  console.log(`  ok  ${name}`);
};

console.log('Testing editor effect splitting...');

test('screen and camera motion split at source time with independent target objects', () => {
  for (const kind of ['screen', 'camera']) {
    const clip = {
      id: `${kind}-source`,
      timing: { startTime: 1, duration: 4, leadInDuration: 0.8, enterDuration: 0.8, returnDuration: 0.6, exitDuration: 0.6 },
      target: { position: { x: 0.25, y: 0.75 }, scale: 1.6 },
    };
    const [left, right] = splitEffectClip(clip, kind, 3);
    assert.equal(left.id, clip.id);
    assert.notEqual(right.id, clip.id);
    assert.equal(left.timing.startTime, 1);
    assert.equal(left.timing.duration, 2);
    assert.equal(right.timing.startTime, 3);
    assert.equal(right.timing.duration, 2);
    assert.notStrictEqual(left.target, right.target);
    assert.notStrictEqual(left.target.position, right.target.position);
    assert.deepEqual(left.target, right.target);
    if (kind === 'screen') {
      assert.equal(left.timing.returnDuration, 0);
      assert.equal(right.timing.leadInDuration, 0);
    } else {
      assert.equal(left.timing.exitDuration, 0);
      assert.equal(right.timing.enterDuration, 0);
    }
  }
});

test('mosaic split preserves its independent source rectangles without a fade gap', () => {
  const clip = {
    id: 'mosaic-source', timing: { startTime: 0, duration: 5 },
    sourceRect: { x: 0.2, y: 0.3, width: 0.4, height: 0.25 },
    transitionInDuration: 0.4, transitionOutDuration: 0.5,
  };
  const [left, right] = splitEffectClip(clip, 'mosaic', 2.25);
  assert.equal(left.timing.duration, 2.25);
  assert.equal(right.timing.startTime, 2.25);
  assert.equal(right.timing.duration, 2.75);
  assert.equal(left.transitionOutDuration, 0);
  assert.equal(right.transitionInDuration, 0);
  assert.notStrictEqual(left.sourceRect, right.sourceRect);
  assert.deepEqual(left.sourceRect, right.sourceRect);
});

test('sticker split keeps joins for later per-half position edits', () => {
  const clip = {
    id: 'sticker-source', timing: { startTime: 1, duration: 3 },
    relativePath: 'media/sticker.png', position: { x: 0.6, y: 0.3 },
    enterDuration: 0.5, exitDuration: 0.25,
  };
  const [left, right] = splitEffectClip(clip, 'sticker', 2.5);
  assert.equal(left.timing.duration, 1.5);
  assert.equal(right.timing.startTime, 2.5);
  assert.equal(right.timing.duration, 1.5);
  assert.equal(left.exitDuration, 0.25);
  assert.equal(right.enterDuration, 0.5);
  assert.notStrictEqual(left.position, right.position);
  right.position.x = 0.8;
  assert.equal(left.position.x, 0.6);
});

test('zoom split keeps the same framing and rejects cuts too close to either edge', () => {
  const clip = { id: 'zoom-source', startTime: 2, endTime: 6, scale: 2, focus: { x: 0.4, y: 0.6 }, enterDuration: 0.7, exitDuration: 0.8 };
  assert.equal(splitEffectClip(clip, 'zoom', 2.04), null);
  assert.equal(splitEffectClip(clip, 'zoom', 5.96), null);
  const [left, right] = splitEffectClip(clip, 'zoom', 4);
  assert.equal(left.endTime, 4);
  assert.equal(right.startTime, 4);
  assert.equal(left.exitDuration, 0);
  assert.equal(right.enterDuration, 0.002);
  assert.deepEqual(left.focus, right.focus);
  assert.notStrictEqual(left.focus, right.focus);
});

console.log('Passed 4 editor effect splitting tests.');
