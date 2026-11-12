'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { makeProject } = require('../src/core/model');
const originalLoad = Module._load;
function node() {
  return { children: [], style: {}, classes: new Set(), classList: { toggle(name, on) { this[name] = on; } }, replaceChildren(...children) { this.children = children; } };
}
Module._load = function load(request, parent, isMain) {
  if (parent?.filename.endsWith('timeline-view.js') && request === '../common') return {
    element: (tag, attrs, text) => ({ ...node(), attrs, text }), icon: () => '', formatTime: String, fileUrl: String,
  };
  if (parent?.filename.endsWith('timeline-view.js') && request === './waveform') return {};
  return originalLoad.call(this, request, parent, isMain);
};
let TimelineView;
try { ({ TimelineView } = require('../src/renderer/editor/timeline-view')); }
finally { Module._load = originalLoad; }
const project = makeProject({ media: { screen: { duration: 6, width: 640, height: 360 } }, capture: {} });
project.timeline.segments = [{ id: 'fast', sourceStart: 2, sourceEnd: 6, speed: 2 }, { id: 'repeat', sourceStart: 0, sourceEnd: 2, speed: 1 }];
project.subtitles.cues = [
  { id: 'one', start: 2, end: 3, text: '字幕一', words: [] },
  { id: 'overlap', start: 2.25, end: 2.75, text: '重叠字幕', words: [] },
  { id: 'last', start: 0.5, end: 1.5, text: '重排字幕', words: [] },
];
const lane = node(), label = node();
let selected, sought, paused = false, notified;
const view = { store: { project, select(value) { selected = value; } }, nodes: { subtitles: lane, subtitleLabel: label },
  preview: { pause() { paused = true; }, seek(time) { sought = time; } }, pps: 100, x: (time) => time * 100,
  onSelectSubtitle(cue) { notified = cue.id; } };
TimelineView.prototype.renderSubtitleClips.call(view);
assert.equal(lane.children.length, 3);
assert.deepEqual(view.subtitlePieces.map(p => [p.cue.id, p.cue.start, p.cue.end]), [['one', 0, .5], ['overlap', .125, .375], ['last', 2.5, 3.5]]);
assert.notEqual(view.subtitlePieces[0].row, view.subtitlePieces[1].row);
assert.equal(lane.style.height, label.style.height);
lane.children[2].attrs.onpointerdown({ button: 0, preventDefault() {}, stopPropagation() {} });
assert.deepEqual(selected, { type: 'subtitle', id: 'last' });
assert.equal(sought, 2.5); assert.equal(paused, true); assert.equal(notified, 'last');
project.subtitles.enabled = false;
TimelineView.prototype.renderSubtitleClips.call(view);
assert.equal(lane.classList.muted, true);
assert.equal(lane.children.length, 3, '隐藏字幕后仍能在轨道中编辑');
console.log('字幕轨道变速/重排映射、重叠分行、定位和隐藏编辑检查通过');
