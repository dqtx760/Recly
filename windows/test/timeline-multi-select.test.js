'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return { ipcRenderer: { invoke: async () => {} } };
  if (request === './export' && /renderer[\\/]editor[\\/]store\.js$/.test(parent?.filename || '')) return { loadPointerTrack: () => null };
  return originalLoad.call(this, request, parent, isMain);
};
const { Store } = require('../src/renderer/editor/store');
Module._load = originalLoad;
const { normalizeProject } = require('../src/core/model');

const project = {
  revision: 0,
  media: { screen: { duration: 12, frameRate: 30 } },
  timeline: {
    segments: [{ id: 'segment-1', sourceStart: 0, sourceEnd: 12, speed: 1 }],
    audioClips: [{ id: 'audio-1', startTime: 0, sourceStart: 0, sourceEnd: 4 }],
    screenMotionClips: [{ id: 'screen-1' }], cameraMotionClips: [],
    mosaicClips: [{ id: 'mosaic-1' }], stickerClips: [],
  },
  subtitles: { enabled: true, cues: [{ id: 'subtitle-1', start: 0, end: 2, text: '字幕' }] },
  zoomAnimations: [{ id: 'zoom-1', startTime: 1, endTime: 2 }], markers: [],
};
const store = new Store('unused', project);
store.select([{ type: 'segment', id: 'segment-1' }, { type: 'audio', id: 'audio-1' }, { type: 'mosaic', id: 'mosaic-1' }]);
assert.equal(store.selections.length, 3, '混合轨道可以同时选中');
assert.equal(store.isSelected('audio', 'audio-1'), true);
assert.deepEqual(store.selection, { type: 'segment', id: 'segment-1' }, '保留主选中项兼容既有检查器');
assert.equal(store.removeSelections(), true);
assert.equal(store.project.timeline.segments.length, 0, '允许删除最后一个录屏片段');
assert.equal(store.project.timeline.audioClips.length, 0);
assert.equal(store.project.timeline.mosaicClips.length, 0);
assert.equal(store.undoStack.length, 1, '批量删除只产生一个撤销点');
assert.equal(store.undo(), true);
assert.equal(store.project.timeline.segments.length, 1, '撤销恢复录屏片段');
assert.equal(store.project.timeline.audioClips.length, 1, '撤销恢复跨轨素材');

store.selectAll();
assert.equal(store.selections.length, 6, 'Ctrl+A 数据入口应选中所有轨道素材');
assert.equal(store.removeSelections(), true);
assert.equal(store.project.timeline.segments.length, 0);
assert.equal(store.project.timeline.audioClips.length, 0);
assert.equal(store.project.zoomAnimations.length, 0);
assert.equal(store.project.subtitles.cues.length, 0);
assert.equal(store.project.timeline.screenMotionClips.length, 0);
assert.equal(store.project.timeline.mosaicClips.length, 0);
const saved = normalizeProject(JSON.parse(JSON.stringify(store.project)));
assert.deepEqual(saved.timeline.segments, [], '保存重读空时间线时不能复活录屏片段');

const app = fs.readFileSync(path.join(__dirname, '../src/renderer/editor/app.js'), 'utf8');
const view = fs.readFileSync(path.join(__dirname, '../src/renderer/editor/timeline-view.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../src/renderer/editor.html'), 'utf8');
assert.match(app, /control && key === 'a'[\s\S]*store\.selectAll\(\)/, 'Ctrl+A 应接到全选入口');
assert.match(app, /const remove = \(\) => \{[\s\S]*store\.removeSelections\(\)/, 'Delete 和工具栏共用批量删除入口');
assert.doesNotMatch(app, /至少要保留一个片段/, '删除最后一个录屏片段不再受旧限制');
assert.match(view, /beginMarquee\(event\)/, '轨道空白处应启动框选');
assert.match(view, /querySelectorAll\('\[data-selection-type\]\[data-selection-id\]'\)/, '框选应跨轨命中素材节点');
assert.doesNotMatch(view, /beginMarquee[\s\S]{0,1800}preview\.seek/, '框选过程不得移动播放头');
assert.doesNotMatch(html, /id="quality"|id="preview-add-button"/, '移除预览质量按钮和左侧加号');

clearTimeout(store.saveTimer);
console.log('时间线多选、批量删除、撤销与空工程持久化测试通过。');
