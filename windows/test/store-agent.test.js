'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const ipcRenderer = { invoke: async () => {} };
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return { ipcRenderer };
  if (request === './export' && /renderer[\\/]editor[\\/]store\.js$/.test(parent?.filename || '')) return { loadPointerTrack: () => null };
  return originalLoad.call(this, request, parent, isMain);
};
const { Store } = require('../src/renderer/editor/store');
Module._load = originalLoad;

function makeProject() {
  return {
    media: { screen: { duration: 10 } },
    zoomAnimations: [],
    timeline: { segments: [{ id: 'one', sourceStart: 0, sourceEnd: 10, speed: 1 }] },
  };
}

async function main() {
  let releaseFirst;
  let startedFirst;
  const firstStarted = new Promise((resolve) => { startedFirst = resolve; });
  const snapshots = [];
  ipcRenderer.invoke = async (channel, { project }) => {
    assert.equal(channel, 'project:write');
    snapshots.push(project.revision);
    if (snapshots.length === 1) {
      startedFirst();
      await new Promise((resolve) => { releaseFirst = resolve; });
    }
  };

  const store = new Store('test-project', makeProject());
  assert.equal(store.revision, 0, 'legacy projects begin at revision zero');
  store.mutate((draft) => { draft.name = 'first'; });
  clearTimeout(store.saveTimer);
  const saving = store.save({ throwOnError: true, untilStable: true });
  await firstStarted;
  store.mutate((draft) => { draft.name = 'latest'; });
  clearTimeout(store.saveTimer);
  releaseFirst();
  const saved = await saving;
  assert.deepEqual(snapshots, [1, 2], 'strict save serializes the newer snapshot after the older one finishes');
  assert.equal(saved.savedRevision, 2);
  assert.equal(store.savedRevision, 2);
  assert.equal(store.saveState, 'saved', 'an older write cannot mark a newer revision as saved');

  const revisions = [store.revision];
  store.undo();
  revisions.push(store.revision);
  store.redo();
  revisions.push(store.revision);
  assert.deepEqual(revisions, [2, 3, 4], 'undo and redo always advance the revision');

  ipcRenderer.invoke = async () => { throw new Error('disk denied'); };
  store.mutate((draft) => { draft.name = 'unsaved'; });
  clearTimeout(store.saveTimer);
  await assert.rejects(store.save({ throwOnError: true, untilStable: true }), /disk denied/);
  assert.equal(store.saveState, 'failed');
  assert.equal(store.savedRevision, 2, 'failed writes do not claim the newer undo/redo revisions were saved');
  clearTimeout(store.saveTimer);
  console.log('Passed serialized save, stale-snapshot protection, monotonic undo/redo revision, and strict save failure tests.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
