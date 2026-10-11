'use strict';

const assert = require('node:assert/strict');
const { ClipClipboard } = require('../src/renderer/editor/clipboard');

const kinds = ['zoom', 'screen', 'camera', 'mosaic', 'sticker'];

function makeProject() {
  return {
    media: { screen: { duration: 10 } },
    zoomAnimations: [],
    timeline: {
      segments: [],
      screenMotionClips: [],
      cameraMotionClips: [],
      mosaicClips: [],
      stickerClips: [],
    },
  };
}

function makeClip(kind) {
  return kind === 'zoom'
    ? { id: `${kind}-source`, startTime: 1, endTime: 3, scale: 1.5 }
    : { id: `${kind}-source`, timing: { startTime: 1, duration: 2 }, target: { position: { x: 0.5, y: 0.5 } } };
}

function pool(project, kind) {
  return kind === 'zoom' ? project.zoomAnimations : project.timeline[{
    screen: 'screenMotionClips',
    camera: 'cameraMotionClips',
    mosaic: 'mosaicClips',
    sticker: 'stickerClips',
  }[kind]];
}

for (const kind of kinds) {
  const clipboard = new ClipClipboard();
  const project = makeProject();
  clipboard.copy(makeClip(kind), kind);

  const pasted = clipboard.paste(project, 9.5);
  assert.ok(pasted, `${kind} should paste when 0.5 seconds remain`);
  const start = kind === 'zoom' ? pasted.startTime : pasted.timing.startTime;
  const duration = kind === 'zoom' ? pasted.endTime - pasted.startTime : pasted.timing.duration;
  assert.equal(start, 9.5, `${kind} starts at the requested time`);
  assert.equal(duration, 0.5, `${kind} is shortened to the remaining media duration`);

  const minimumPasted = clipboard.paste(project, 9.95);
  assert.ok(minimumPasted, `${kind} allows exactly 0.05 seconds of remaining media`);
  const minimumDuration = kind === 'zoom'
    ? minimumPasted.endTime - minimumPasted.startTime
    : minimumPasted.timing.duration;
  assert.ok(Math.abs(minimumDuration - 0.05) < 1e-9, `${kind} keeps the allowed 0.05-second tail`);

  const countBeforeReject = pool(project, kind).length;
  assert.equal(clipboard.paste(project, 9.951), null, `${kind} rejects when less than 0.05 seconds remain`);
  assert.equal(clipboard.paste(project, 10), null, `${kind} rejects at the media end`);
  assert.equal(pool(project, kind).length, countBeforeReject, `${kind} rejection does not add an invisible clip`);
}

console.log('Passed clipboard media-end boundary tests for all five clip types.');
