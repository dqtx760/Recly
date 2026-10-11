'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return { ipcRenderer: { invoke: async () => {} } };
  if (request === './export' && /renderer[\\/]editor[\\/]store\.js$/.test(parent?.filename || '')) {
    return { loadPointerTrack: () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { Store } = require('../src/renderer/editor/store');
Module._load = originalLoad;

const effects = {
  zoom: { id: 'zoom-1', startTime: 1, endTime: 2, scale: 1.5, focus: { x: 0.4, y: 0.6 } },
  screen: { id: 'screen-1', timing: { startTime: 1, duration: 2 }, target: { position: { x: 0.3, y: 0.7 }, scale: 1.6 } },
  camera: { id: 'camera-1', timing: { startTime: 1, duration: 2 }, target: { position: { x: 0.8, y: 0.7 }, size: 0.4 } },
  mosaic: { id: 'mosaic-1', timing: { startTime: 1, duration: 2 }, sourceRect: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 } },
  sticker: { id: 'sticker-1', timing: { startTime: 1, duration: 2 }, relativePath: 'media/sticker.png', position: { x: 0.6, y: 0.4 } },
};
const project = {
  media: { screen: { duration: 4 } },
  timeline: {
    segments: [{ id: 'segment-1', sourceStart: 0, sourceEnd: 4, speed: 1 }],
    screenMotionClips: [effects.screen],
    cameraMotionClips: [effects.camera],
    mosaicClips: [effects.mosaic],
    stickerClips: [effects.sticker],
  },
  zoomAnimations: [effects.zoom],
};

const store = new Store('unused', project);
for (const [type, clip] of Object.entries(effects)) {
  const expected = JSON.parse(JSON.stringify(clip));
  store.select({ type, id: clip.id });
  assert.equal(store.getClip(type, clip.id).id, clip.id, `${type} clip is available to the inspector`);
  store.mutate((draft) => {
    const target = type === 'zoom'
      ? draft.zoomAnimations[0]
      : draft.timeline[({ screen: 'screenMotionClips', camera: 'cameraMotionClips', mosaic: 'mosaicClips', sticker: 'stickerClips' })[type]][0];
    if (type === 'zoom') target.scale = 1.9;
    else if (target.target) target.target.position.x = 0.9;
    else if (target.position) target.position.x = 0.9;
    else target.sourceRect.x = 0.9;
  });
  store.undo();
  assert.equal(store.selection.id, clip.id, `${type} selection survives undo restore`);
  assert.deepEqual(store.getClip(type, clip.id), expected, `${type} visual attributes restore on undo`);
  store.redo();
  assert.equal(store.getClip(type, clip.id).id, clip.id, `${type} selection pool remains available after redo`);
}

clearTimeout(store.saveTimer);
console.log('Passed 5 editor effect store/undo tests.');
