'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const sent = [];
const calls = [];
const ipcRenderer = {
  on() {},
  removeListener() {},
  send(channel, payload) { sent.push({ channel, payload }); },
  async invoke(channel, payload) {
    calls.push({ channel, payload });
    if (channel === 'project:write') {
      if (this.failWrite) throw new Error('disk denied');
      return { ok: true };
    }
    if (channel === 'subtitle:generate') { this.lastTranscript = payload; return { jobId: 'asr-1', status: 'queued' }; }
    if (channel === 'jobs:get') return { jobId: payload.jobId, status: 'completed', result: { cues: [{ id: 'asr-cue', start: 1, end: 2, text: '示例' }] } };
    if (channel === 'jobs:cancel') return { jobId: payload.jobId, status: 'cancelled' };
    if (channel === 'agent:media-frame') return { path: path.resolve(__dirname, '..', 'assets', 'AppIconMaster.png'), mimeType: 'image/png' };
    if (channel === 'agent:audio-excerpt') {
      const offset = payload.project.media[payload.track].offset;
      const sourceStart = Math.max(payload.sourceStart, offset);
      const sourceDuration = payload.sourceDuration - (sourceStart - payload.sourceStart);
      return { path: path.resolve(__dirname, '..', 'assets', 'AppIconMaster.png'), mimeType: 'audio/wav',
        timeDomain: payload.timeDomain, sourceStart, sourceDuration, duration: sourceDuration / payload.speed,
        time: payload.timeDomain === 'output' ? payload.time + (sourceStart - payload.sourceStart) / payload.speed : sourceStart };
    }
    if (channel === 'agent:validate-export-output') return { ok: true };
    if (channel === 'export:begin') return { ok: true };
    if (channel === 'export:end') return { ok: true };
    throw Object.assign(new Error(`unexpected IPC ${channel}`), { code: 'unexpected_ipc' });
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return { ipcRenderer };
  if (request === './export' && /renderer[\\/]editor[\\/]store\.js$/.test(parent?.filename || '')) return { loadPointerTrack: () => null };
  if (request === './export' && /renderer[\\/]editor[\\/]agent-bridge\.js$/.test(parent?.filename || '')) {
    return { exportProject: async () => ({ outputFile: 'agent.mp4', width: 1280, height: 720 }), ExportCancelled: class ExportCancelled extends Error {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { Store } = require('../src/renderer/editor/store');
const { AgentBridge } = require('../src/renderer/editor/agent-bridge');
Module._load = originalLoad;

const directory = path.resolve('bridge-test-project');
function makeProject() {
  return {
    name: 'bridge test',
    media: {
      screen: { file: 'screen.mp4', duration: 20, width: 1280, height: 720, frameRate: 30 },
      microphone: { file: 'microphone.wav', duration: 20, offset: 0 },
      systemAudio: { file: 'system.wav', duration: 20, offset: 0 },
    },
    camera: { isHidden: true },
    canvas: { background: { kind: 'pattern', preset: 'obsidianGrid' } },
    audio: { microphoneVolume: 1, systemVolume: 1, isMicrophoneMuted: false, isSystemMuted: false },
    subtitles: { enabled: true, sourceTrack: 'microphone', language: 'zh', style: {}, cues: [] },
    zoomAnimations: [],
    timeline: {
      segments: [
        { id: 'first', sourceStart: 0, sourceEnd: 8, speed: 2 },
        { id: 'second', sourceStart: 10, sourceEnd: 20, speed: 1 },
      ],
      screenMotionClips: [], cameraMotionClips: [], mosaicClips: [], stickerClips: [],
    },
    export: { kind: 'video', resolution: 'source', frameRate: 30 },
  };
}

function makePreview(project) {
  const node = {
    readyState: 2, duration: 20, currentTime: 0, seeking: false,
    addEventListener() {}, removeEventListener() {},
  };
  return {
    screen: { node, offset: 0, duration: 20, inRange: false },
    camera: null,
    backgroundVideo: null,
    canvas: { toDataURL: () => 'data:image/png;base64,aGVsbG8=' },
    quality: 'full', playing: false, time: 0, assetsPending: false, assetError: null,
    drawCount: 0,
    pause() { this.playing = false; },
    play() { this.playing = true; },
    setQuality(value) { this.quality = value; },
    syncMedia() { this.screen.inRange = true; },
    seek(time) {
      this.time = time;
      const hit = require('../src/core/timeline').locate(project.timeline.segments, time);
      this.screen.node.currentTime = hit.sourceTime;
      this.screen.inRange = true;
    },
    draw() { this.drawCount += 1; },
  };
}

function codeIs(code) { return (error) => error.code === code; }
function clearSave(store) { clearTimeout(store.saveTimer); }

async function main() {
  const project = makeProject();
  const store = new Store(directory, project);
  const preview = makePreview(project);
  const documentRef = { activeElement: { tagName: 'BODY' } };
  const bridge = new AgentBridge({ ipcRenderer, store, preview, directory, documentRef, exportProject: async () => ({ outputFile: 'agent.mp4' }) });
  bridge.attach();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent.shift(), { channel: 'agent:ready', payload: { directory } }, 'bridge announces readiness after the preview is ready');

  const editParams = {
    directory, expectedRevision: 0, requestId: 'edit-1',
    operations: [{ type: 'trim', segmentId: 'first', start: 1, end: 7 }],
  };
  const [first, retry] = await Promise.all([
    bridge.dispatch('edit.apply', editParams),
    bridge.dispatch('edit.apply', editParams),
  ]);
  assert.deepEqual(retry, first, 'same request id and payload return the first result');
  assert.equal(store.revision, 1, 'a repeated write changes the store only once');
  clearSave(store);
  await assert.rejects(bridge.dispatch('edit.apply', { ...editParams, operations: [{ type: 'remove', segmentId: 'first' }] }), codeIs('request_id_conflict'));
  await assert.rejects(bridge.dispatch('edit.apply', { ...editParams, requestId: 'stale', expectedRevision: 0 }), codeIs('revision_conflict'));

  const undo = await bridge.dispatch('history.undo', { directory, expectedRevision: 1, requestId: 'undo-1' });
  assert.equal(undo.revision, 2);
  assert.equal(store.project.timeline.segments[0].sourceStart, 0);
  const redo = await bridge.dispatch('history.redo', { directory, expectedRevision: 2, requestId: 'redo-1' });
  assert.equal(redo.revision, 3);
  assert.equal(store.project.timeline.segments[0].sourceStart, 1);
  clearSave(store);

  store.gesture = 'dragging';
  await assert.rejects(bridge.dispatch('edit.apply', { ...editParams, expectedRevision: 3, requestId: 'busy-gesture' }), codeIs('project_busy'));
  store.gesture = null;
  documentRef.activeElement = { tagName: 'INPUT', type: 'text' };
  await assert.rejects(bridge.dispatch('edit.apply', { ...editParams, expectedRevision: 3, requestId: 'busy-input' }), codeIs('project_busy'));
  documentRef.activeElement = { tagName: 'BODY' };

  const replacement = await bridge.dispatch('subtitles.patch', {
    directory, expectedRevision: 3, requestId: 'subtitle-replace',
    patch: { replaceCues: [{ id: 'cue-1', start: 1, end: 2, text: '我在用 coldex', words: [{ start: 1, end: 1.4, text: '我在用' }, { start: 1.4, end: 2, text: 'coldex' }] }] },
  });
  assert.equal(replacement.revision, 4);
  clearSave(store);
  const generation = await bridge.dispatch('transcript.generate', {
    directory, expectedRevision: 4, requestId: 'asr-1', track: 'microphone', scope: 'source',
  });
  assert.equal(generation.jobId, 'asr-1');
  assert.equal(ipcRenderer.lastTranscript.track, 'microphone', 'ASR IPC receives a track name, not a track object');
  assert.equal(ipcRenderer.lastTranscript.scope, 'source');

  const correction = await bridge.dispatch('subtitles.patch', {
    directory, expectedRevision: 4, requestId: 'subtitle-correct',
    patch: { cues: [{ id: 'cue-1', text: '我在用 Codex' }] },
  });
  assert.equal(correction.revision, 5);
  assert.equal(store.project.subtitles.cues[0].text, '我在用 Codex');
  assert.equal(store.project.subtitles.cues[0].alignment, 'stale', 'text edits without replacement words invalidate alignment');
  clearSave(store);
  const beforeBadPatch = JSON.stringify(store.project.subtitles);
  await assert.rejects(bridge.dispatch('subtitles.patch', {
    directory, expectedRevision: 5, requestId: 'subtitle-atomic-fail',
    patch: { cues: [{ id: 'cue-1', text: 'partially changed' }, { id: 'missing', text: 'error' }] },
  }), codeIs('not_found'));
  assert.equal(JSON.stringify(store.project.subtitles), beforeBadPatch, 'invalid subtitle batches do not partially mutate the store');
  assert.equal(store.revision, 5);
  const subtitles = await bridge.dispatch('subtitles.get', { directory });
  assert.match(subtitles.srt, /我在用 Codex/);
  const transcript = await bridge.dispatch('transcript.get', { directory, jobId: 'asr-1' });
  assert.equal(transcript.job.result.cues[0].text, '示例');

  const sourceFrame = await bridge.dispatch('media.frame', { directory, timeDomain: 'source', time: 2 });
  assert.equal(sourceFrame.timeDomain, 'source');
  assert.ok(sourceFrame.base64.length > 0);
  const beforeFrameCalls = calls.filter((call) => call.channel === 'agent:media-frame').length;
  const outputFrame = await bridge.dispatch('media.frame', { directory, timeDomain: 'output', time: 1 });
  assert.equal(outputFrame.sourceTime, 3, 'output frame time maps through the live timeline after trim and speed edits');
  assert.equal(preview.drawCount, 1, 'output screenshots use the current compositor canvas');
  assert.equal(calls.filter((call) => call.channel === 'agent:media-frame').length, beforeFrameCalls, 'output frame does not return a source-only screenshot');

  const excerpt = await bridge.dispatch('media.audio_excerpt', { directory, timeDomain: 'output', start: 2.5, duration: 0.5, track: 'microphone' });
  const audioCall = calls.filter((call) => call.channel === 'agent:audio-excerpt').at(-1);
  assert.equal(audioCall.payload.sourceStart, 6);
  assert.equal(audioCall.payload.sourceDuration, 1);
  assert.equal(audioCall.payload.speed, 2);
  assert.equal(excerpt.duration, 0.5);
  store.project.media.microphone.offset = 2;
  const clippedSource = await bridge.dispatch('media.audio_excerpt', { directory, timeDomain: 'source', start: 1, duration: 3, track: 'microphone' });
  assert.equal(clippedSource.time, 2);
  assert.equal(clippedSource.sourceStart, 2);
  assert.equal(clippedSource.sourceDuration, 2);
  assert.equal(clippedSource.duration, 2);
  const clippedOutput = await bridge.dispatch('media.audio_excerpt', { directory, timeDomain: 'output', start: 0, duration: 1, track: 'microphone' });
  assert.equal(clippedOutput.time, 0.5);
  assert.equal(clippedOutput.sourceStart, 2);
  assert.equal(clippedOutput.sourceDuration, 1);
  assert.equal(clippedOutput.duration, 0.5);
  assert.equal(clippedOutput.speed, 2);
  store.project.media.microphone.offset = 0;
  await assert.rejects(bridge.dispatch('media.audio_excerpt', { directory, timeDomain: 'output', start: 2.8, duration: 0.5, track: 'microphone' }), codeIs('invalid_params'));

  const planProject = makeProject();
  const planStore = new Store(directory, planProject);
  const planBridge = new AgentBridge({ ipcRenderer, store: planStore, preview: makePreview(planProject), directory, documentRef });
  const splitOperations = [{ type: 'split', segmentId: 'first', sourceTime: 4 }];
  const splitPlan = await planBridge.dispatch('edit.preview', { directory, operations: splitOperations });
  const splitCommit = await planBridge.dispatch('edit.apply', {
    directory, expectedRevision: 0, requestId: 'plan-split', planId: splitPlan.planId, operations: splitOperations,
  });
  assert.equal(splitPlan.results[0].createdSegmentId, splitCommit.results[0].createdSegmentId, 'apply commits the exact segment IDs returned by preview');
  assert.equal(planStore.project.timeline.segments[1].id, splitPlan.results[0].createdSegmentId);
  clearSave(planStore);
  const trimOperations = [{ type: 'trim', segmentId: 'first', start: 0.25, end: 3.75 }];
  const trimPlan = await planBridge.dispatch('edit.preview', { directory, operations: trimOperations });
  const trimCommit = await planBridge.dispatch('edit.apply', {
    directory, expectedRevision: 1, requestId: 'plan-trim', planId: trimPlan.planId,
  });
  assert.equal(trimCommit.revision, 2, 'apply can submit a planId without resending its operations');
  assert.equal(planStore.project.timeline.segments[0].sourceStart, 0.25);
  clearSave(planStore);

  const exportResult = await bridge.dispatch('export.start', {
    directory, expectedRevision: 5, requestId: 'export-1', outputFile: 'C:\\temp\\agent.mp4', kind: 'video', resolution: 'source', frameRate: 30,
  });
  for (let index = 0; index < 20 && bridge.jobs.get(exportResult.jobId).status === 'running'; index++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await bridge.dispatch('jobs.get', { directory, jobId: exportResult.jobId })).status, 'completed');
  assert.ok(calls.some((call) => call.channel === 'agent:validate-export-output'));
  assert.ok(calls.some((call) => call.channel === 'export:begin'));
  assert.ok(calls.some((call) => call.channel === 'export:end'), 'export lock releases in finally');

  ipcRenderer.failWrite = true;
  store.mutate((draft) => { draft.name = 'save failure'; });
  clearSave(store);
  await assert.rejects(bridge.dispatch('project.save', { directory, expectedRevision: store.revision, requestId: 'save-failure' }), /disk denied/);
  assert.equal(store.saveState, 'failed');
  clearSave(store);
  bridge.detach();
  console.log('Passed Agent protocol, write dedupe/conflict, busy checks, subtitles, ASR, media capture, export lock, and save failure tests.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
