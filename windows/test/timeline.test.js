'use strict';

const assert = require('node:assert/strict');
const timeline = require('../src/core/timeline');
const waveform = require('../src/renderer/editor/waveform');

let passed = 0;
const test = (name, body) => {
  body();
  passed += 1;
  console.log(`  ok  ${name}`);
};

const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: expected ${expected}, got ${actual}`);

console.log('Testing Timeline Editing...');

test('reordered source segments preserve locate and source-to-output mapping', () => {
  const segments = [
    { id: 'early', sourceStart: 0, sourceEnd: 2, speed: 1 },
    { id: 'late', sourceStart: 5, sourceEnd: 9, speed: 2 },
  ];
  const reordered = timeline.reorderSegments(segments, 0, 1);
  const hit = timeline.locate(reordered, 0.5);
  assert.equal(hit.segment.id, 'late');
  close(hit.sourceTime, 6, 'late source time');
  close(timeline.sourceToOutput(reordered, 6), 0.5, 'late output time');
  close(timeline.sourceToOutput(reordered, 1), 3, 'early output time');
});

test('source-time boundaries prefer a retained segment start and preserve the true final endpoint', () => {
  const segments = [
    { id: 'first', sourceStart: 0, sourceEnd: 2, speed: 1 },
    { id: 'last-source-middle-output', sourceStart: 4, sourceEnd: 6, speed: 1 },
    { id: 'starts-at-cut', sourceStart: 2, sourceEnd: 4, speed: 1 },
  ];
  close(timeline.sourceToOutput(segments, 2), 4, 'shared cut maps to the half-open interval start');
  assert.equal(timeline.isRetained(segments, 2), true);
  close(timeline.sourceToOutput(segments, 6), 4, 'maximum source end maps to its segment output end');
  assert.equal(timeline.isRetained(segments, 6), true);
  assert.equal(timeline.isRetained([
    { id: 'before-gap', sourceStart: 0, sourceEnd: 2, speed: 1 },
    { id: 'after-gap', sourceStart: 4, sourceEnd: 6, speed: 1 },
  ], 2), false, 'a non-final cut edge before a source gap is not retained');
});

test('Q/W ripple trim changes only the playhead segment edge and closes output duration', () => {
  const segments = [
    { id: 'first', sourceStart: 0, sourceEnd: 4, speed: 1 },
    { id: 'second', sourceStart: 5, sourceEnd: 9, speed: 2 },
  ];
  const afterQ = timeline.rippleTrimAt(segments, 5, 'start');
  assert.equal(afterQ[1].sourceStart, 7);
  close(timeline.outputDuration(afterQ), 5, 'Q output duration');
  const afterW = timeline.rippleTrimAt(segments, 1, 'end');
  assert.equal(afterW[0].sourceEnd, 1);
  close(timeline.outputDuration(afterW), 3, 'W output duration');
  assert.equal(timeline.rippleTrimAt(segments, 0.05, 'end'), null, 'rejects a sub-minimum retained segment');
});

test('missing ranges are source-sorted and restore rejects duplicate or overlapping footage', () => {
  const segments = [
    { id: 'late', sourceStart: 5, sourceEnd: 8, speed: 1 },
    { id: 'early', sourceStart: 0, sourceEnd: 2, speed: 1 },
  ];
  const gaps = timeline.missingRanges(segments, 10);
  assert.deepEqual(gaps, [
    { sourceStart: 2, sourceEnd: 5 },
    { sourceStart: 8, sourceEnd: 10 },
  ]);
  const restored = timeline.restoreRange(segments, gaps[0], 1);
  assert.deepEqual(restored.map((segment) => [segment.sourceStart, segment.sourceEnd]), [[5, 8], [2, 5], [0, 2]]);
  assert.equal(timeline.restoreRange(restored, gaps[0], 0), null, 'a restored interval cannot be restored twice');
  assert.equal(timeline.restoreRange(segments, { sourceStart: 1, sourceEnd: 5 }, 1), null, 'overlap is rejected');
});

test('splitting keeps independent copies of a segment audio override', () => {
  const segment = {
    id: 'with-audio', sourceStart: 0, sourceEnd: 4, speed: 1,
    audio: { microphoneVolume: 0.3, systemVolume: 0.7, isMicrophoneMuted: false, isSystemMuted: true },
  };
  const split = timeline.splitAt([segment], 2);
  assert.deepEqual(split[0].audio, segment.audio);
  assert.deepEqual(split[1].audio, segment.audio);
  split[0].audio.microphoneVolume = 0.8;
  assert.equal(split[1].audio.microphoneVolume, 0.3);
});

test('trim constraints follow source ranges after segment reordering', () => {
  const segments = [
    { id: 'later', sourceStart: 8, sourceEnd: 10, speed: 1 },
    { id: 'target', sourceStart: 4, sourceEnd: 6, speed: 1 },
    { id: 'earlier', sourceStart: 1, sourceEnd: 3, speed: 1 },
  ];
  const startTrimmed = timeline.trimSegment(segments, 'target', 'start', 0, 10);
  const endTrimmed = timeline.trimSegment(segments, 'target', 'end', 10, 10);
  assert.equal(startTrimmed[1].sourceStart, 3);
  assert.equal(endTrimmed[1].sourceEnd, 8);
  for (const result of [startTrimmed, endTrimmed]) {
    const target = result.find((segment) => segment.id === 'target');
    for (const other of result.filter((segment) => segment.id !== 'target')) {
      assert.ok(target.sourceEnd <= other.sourceStart || target.sourceStart >= other.sourceEnd,
        `${target.id} overlaps ${other.id}`);
    }
  }
});

test('waveform projection applies audio offset, source range, speed, and track mix', () => {
  const segment = { sourceStart: 2, sourceEnd: 6, speed: 2 };
  const micSamples = waveform.extractWaveformFromPCM(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]), 6, { noiseFloor: 0, curve: 1 });
  const systemSamples = waveform.extractWaveformFromPCM(new Float32Array([0.4, 0.1, 0.2, 0.5, 0.1, 0.1]), 6, { noiseFloor: 0, curve: 1 });
  const samples = timeline.waveformSamplesForSegment(segment, [
    { samples: micSamples, duration: 6, offset: 2 },
    { samples: systemSamples, duration: 6, offset: 0 },
  ], 2);
  close(samples[0], 0.5, 'first mixed waveform sample');
  close(samples[1], 0.4, 'second mixed waveform sample');
});

test('source-timed effects map each retained intersection after cuts and reordering', () => {
  const segments = [
    { id: 'late', sourceStart: 6, sourceEnd: 10, speed: 2 },
    { id: 'early', sourceStart: 0, sourceEnd: 4, speed: 1 },
  ];
  const pools = {
    mosaic: [{ id: 'effect', timing: { startTime: 2, duration: 7 } }],
  };
  const originalTiming = structuredClone(pools.mosaic[0].timing);
  const pieces = timeline.mapEffectClipsToOutput(segments, pools).mosaic;
  assert.deepEqual(pieces.map(({ segment, sourceStart, sourceEnd, outputStart, outputEnd }) => [
    segment.id, sourceStart, sourceEnd, outputStart, outputEnd,
  ]), [
    ['late', 6, 9, 0, 1.5],
    ['early', 2, 4, 4, 6],
  ]);
  assert.deepEqual(pools.mosaic[0].timing, originalTiming, 'mapping never rewrites the source-time clip');
});

test('zoom intervals map to each retained intersection in output order', () => {
  const segments = [
    { id: 'late', sourceStart: 6, sourceEnd: 10, speed: 2 },
    { id: 'early', sourceStart: 0, sourceEnd: 4, speed: 1 },
  ];
  const zoom = { id: 'zoom', startTime: 2, endTime: 9, exitDuration: 0.5 };
  const pieces = timeline.mapEffectClipsToOutput(segments, { zoom: [zoom] }).zoom;
  assert.deepEqual(pieces.map(({ clip, segment, sourceStart, sourceEnd, outputStart, outputEnd }) => [
    clip.id, segment.id, sourceStart, sourceEnd, outputStart, outputEnd,
  ]), [
    ['zoom', 'late', 6, 9, 0, 1.5],
    ['zoom', 'early', 2, 4, 4, 6],
  ]);
  assert.equal(zoom.startTime, 2);
  assert.equal(zoom.endTime, 9, 'mapping leaves the original zoom clip as one source-time object');
});

console.log(`Passed ${passed} timeline tests.`);
