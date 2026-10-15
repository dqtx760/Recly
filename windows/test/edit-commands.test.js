'use strict';

const assert = require('node:assert/strict');
const { applyOperations } = require('../src/core/edit-commands');

function makeProject() {
  return {
    media: { screen: { duration: 20, frameRate: 30, width: 1280, height: 720 } },
    canvas: { aspectRatio: 'adaptive', padding: 100, contentScale: 1, contentPosition: { x: 0.5, y: 0.5 } },
    camera: { shape: 'circle', position: { x: 0.5, y: 0.5 }, size: 0.3 },
    audio: { microphoneVolume: 1, systemVolume: 1 },
    zoomAnimations: [],
    timeline: {
      segments: [
        { id: 'first', sourceStart: 0, sourceEnd: 8, speed: 2 },
        { id: 'second', sourceStart: 10, sourceEnd: 20, speed: 1 },
      ],
      screenMotionClips: [{ id: 'fx', timing: { startTime: 5, duration: 2 }, target: { position: { x: 0.5, y: 0.5 }, scale: 1 } }],
      cameraMotionClips: [], mosaicClips: [], stickerClips: [],
    },
  };
}

function codeIs(code) {
  return (error) => error.code === code;
}

const original = makeProject();
assert.throws(() => applyOperations(original, [
  { type: 'trim', segmentId: 'first', start: 1, end: 7 },
  { type: 'remove', segmentId: 'missing' },
]), codeIs('not_found'));
assert.deepEqual(original, makeProject(), 'failed batches leave the supplied project unchanged');

assert.throws(() => applyOperations(original, [{ type: 'remove', segmentId: 'missing' }]), codeIs('not_found'));
assert.throws(() => applyOperations(original, [{ type: 'remove', segmentId: 'first' }, { type: 'remove', segmentId: 'second' }]), codeIs('invalid_operation'));
assert.deepEqual(original.timeline.segments.map((segment) => segment.id), ['first', 'second']);

const edit = applyOperations(original, [
  { type: 'trim', segmentId: 'first', start: 1, end: 7 },
  { type: 'speed', segmentId: 'second', value: 2 },
  { type: 'reorder', segmentIds: ['second', 'first'] },
]);
assert.equal(edit.results.length, 3);
assert.equal(edit.project.timeline.segments[0].id, 'second');
assert.equal(edit.project.timeline.segments[0].speed, 2);
assert.equal(edit.project.timeline.segments[1].sourceStart, 1);
assert.equal(edit.project.timeline.segments[1].sourceEnd, 7);
assert.deepEqual(original.timeline.segments.map((segment) => segment.sourceStart), [0, 10], 'valid batches also edit a clone');

const split = applyOperations(original, [{ type: 'split', segmentId: 'first', sourceTime: 4 }]);
assert.equal(split.project.timeline.segments.length, 3);
assert.equal(split.project.timeline.segments[0].sourceEnd, 4);
assert.equal(split.project.timeline.segments[1].sourceStart, 4);
assert.equal(split.project.timeline.segments[1].speed, 2);

assert.throws(() => applyOperations(original, [{
  type: 'effect', kind: 'screen', segmentId: 'fx', patch: { startTime: 18, duration: 3 },
}]), codeIs('invalid_params'));
assert.deepEqual(original.timeline.screenMotionClips[0].timing, { startTime: 5, duration: 2 }, 'invalid effect range cannot partially mutate timing');
assert.throws(() => applyOperations(original, [{ type: 'effect', kind: 'screen', segmentId: 'missing', patch: { scale: 2 } }]), codeIs('not_found'));
assert.throws(() => applyOperations(original, [{ type: 'canvas', patch: { arbitraryPath: 'project.name' } }]), codeIs('invalid_params'));

console.log('Passed atomic edit-command validation, clone isolation, undo-ready operations, and source-boundary tests.');
