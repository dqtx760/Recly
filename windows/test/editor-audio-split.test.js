'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const originalLoad = Module._load;
const projectWrites = [];
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return { ipcRenderer: { invoke: async (channel, payload) => {
    if (channel === 'project:write') projectWrites.push(payload);
  } } };
  if (request === './export' && /renderer[\\/]editor[\\/]store\.js$/.test(parent?.filename || '')) {
    return { loadPointerTrack: () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { Store } = require('../src/renderer/editor/store');
Module._load = originalLoad;

const originalClip = {
  id: 'audio-1', file: 'media/music.mp3', name: '背景音乐.mp3', kind: 'music',
  startTime: 10, sourceStart: 2, sourceEnd: 8, sourceDuration: 12, volume: 0.37,
};
const project = {
  media: { screen: { duration: 30, frameRate: 30 } },
  timeline: {
    segments: [{ id: 'segment-1', sourceStart: 0, sourceEnd: 30, speed: 1 }],
    audioClips: [{ ...originalClip }],
  },
  zoomAnimations: [],
};
const store = new Store('unused', project);
store.select({ type: 'audio', id: originalClip.id });

const appSource = fs.readFileSync(path.join(__dirname, '../src/renderer/editor/app.js'), 'utf8');
const shortcutsSource = fs.readFileSync(path.join(__dirname, '../src/renderer/editor/shortcuts-modal.js'), 'utf8');
assert.ok(appSource.includes("$('split').addEventListener('click', split);"), '工具栏分割按钮路由到同一分割动作');
assert.ok(appSource.includes("[!control && key === 's', split]"), 'S 键路由到同一分割动作');
assert.ok(appSource.includes("[control && key === 'b', split]"), 'Ctrl+B 兼容键路由到同一分割动作');
assert.ok(shortcutsSource.includes("split: 'S'"), '快捷键默认值为 S');
assert.ok(shortcutsSource.includes('在播放头处分割片段（含音频）'), '快捷键面板说明所选音频也可分割');

assert.equal(store.splitAudioClip(originalClip.id, 13), true, '播放头位于所选音频内时可以分割');
assert.equal(store.project.timeline.audioClips.length, 2);
const [left, right] = store.project.timeline.audioClips;
assert.equal(left.id, originalClip.id, '左侧保留原片段 ID 以维持当前选中状态');
assert.equal(left.sourceStart, 2);
assert.equal(left.sourceEnd, 5);
assert.equal(right.startTime, 13, '右侧从播放头所在的时间线位置开始');
assert.equal(right.sourceStart, 5, '右侧从对应的音源位置开始');
assert.equal(right.sourceEnd, 8);
assert.notEqual(right.id, left.id);
for (const key of ['file', 'name', 'kind', 'sourceDuration', 'volume']) {
  assert.equal(left[key], originalClip[key], `左侧保留 ${key}`);
  assert.equal(right[key], originalClip[key], `右侧保留 ${key}`);
}
assert.deepEqual(store.selection, { type: 'audio', id: originalClip.id });

assert.equal(store.undo(), true);
assert.deepEqual(store.project.timeline.audioClips, [originalClip], '撤销恢复未分割的片段');
assert.equal(store.selection.id, originalClip.id);
assert.equal(store.redo(), true);
assert.equal(store.project.timeline.audioClips.length, 2, '重做恢复两段音频');

const beforeInvalidSplit = JSON.stringify(store.project.timeline.audioClips);
assert.equal(store.splitAudioClip(originalClip.id, 10.04), false, '切点过于靠近片段开头时拒绝分割');
assert.equal(store.splitAudioClip(originalClip.id, 15.96), false, '切点过于靠近片段结尾时拒绝分割');
assert.equal(store.splitAudioClip(originalClip.id, 20), false, '播放头位于片段之外时拒绝分割');
assert.equal(JSON.stringify(store.project.timeline.audioClips), beforeInvalidSplit, '无效切点不改动工程');

store.save({ throwOnError: true, untilStable: true }).then((result) => {
  assert.equal(result.saveState, 'saved', '分割后的项目能够保存');
  assert.equal(projectWrites.length, 1);
  assert.equal(projectWrites[0].project.timeline.audioClips.length, 2, '保存内容包含分割后的两段音频');
  clearTimeout(store.saveTimer);
  console.log('Passed audio split, shortcut routing, metadata preservation, undo/redo, save, and boundary tests.');
}).catch((error) => {
  clearTimeout(store.saveTimer);
  console.error(error);
  process.exitCode = 1;
});
