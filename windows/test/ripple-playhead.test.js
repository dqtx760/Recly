'use strict';

const assert = require('node:assert/strict');
const timeline = require('../src/core/timeline');
const { rippleTrimSeekTime } = require('../src/renderer/editor/ripple-playhead');

const segments = [
  { id: 'A', sourceStart: 9, sourceEnd: 10, speed: 1 },
  { id: 'B', sourceStart: 6, sourceEnd: 9, speed: 1 },
  { id: 'C', sourceStart: 0, sourceEnd: 5, speed: 1 },
];
const outputTime = 2.5;
const hit = timeline.locate(segments, outputTime);

assert.equal(hit.segment.id, 'B');
assert.equal(hit.sourceTime, 7.5);

const trimmedEnd = timeline.rippleTrimAt(segments, outputTime, 'end');
assert.equal(timeline.sourceToOutput(trimmedEnd, hit.sourceTime), 0, 'source mapping demonstrates the reordered-segment boundary bug');
assert.equal(rippleTrimSeekTime(hit, outputTime, 'end'), 2.5, 'W keeps the output boundary after the trimmed segment');
assert.equal(timeline.locate(trimmedEnd, rippleTrimSeekTime(hit, outputTime, 'end')).segment.id, 'C');

const trimmedStart = timeline.rippleTrimAt(segments, outputTime, 'start');
assert.equal(rippleTrimSeekTime(hit, outputTime, 'start'), 1, 'Q seeks to the trimmed segment start on the output timeline');
assert.equal(timeline.locate(trimmedStart, rippleTrimSeekTime(hit, outputTime, 'start')).segment.id, 'B');

console.log('Passed ripple trim playhead boundary tests.');
