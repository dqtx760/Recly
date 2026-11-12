'use strict';

const assert = require('node:assert/strict');
const { makeProject } = require('../src/core/model');
const { applyAssistantResult } = require('../src/renderer/editor/assistant-plan');

function fixture() {
  const project = makeProject({ media: { screen: { duration: 10, width: 1280, height: 720 } }, capture: {} });
  project.timeline.segments = [{ id: 'first', sourceStart: 0, sourceEnd: 4, speed: 1 }, { id: 'second', sourceStart: 4, sourceEnd: 10, speed: 1 }];
  project.subtitles.cues = [{ id: 'cue', start: 1, end: 2, text: '旧字幕', words: [], alignment: 'valid' }];
  return { project, revision: 2, calls: 0, mutate(change) { change(this.project); this.revision++; this.calls++; }, undo() { return true; } };
}
const result = { reply: '完成', operations: [{ type: 'camera', segmentId: 'second', patch: { layout: 'fullscreen' } }], subtitlePatch: { cues: [{ id: 'cue', text: '新字幕' }] }, historyAction: 'none' };
const store = fixture();
assert.equal(applyAssistantResult(store, result, 2), true);
assert.equal(store.calls, 1, '跨画面与字幕修改应为一次事务');
assert.equal(store.project.timeline.segments[0].camera, undefined);
assert.equal(store.project.timeline.segments[1].camera.layout, 'fullscreen');
assert.equal(store.project.subtitles.cues[0].text, '新字幕');
assert.equal(store.project.subtitles.cues[0].alignment, 'stale');
const stale = fixture();
assert.throws(() => applyAssistantResult(stale, result, 1), /工程已改变/);
assert.equal(stale.calls, 0);
assert.throws(() => applyAssistantResult(stale, result, 2, true), /导出/);
const original = JSON.stringify(stale.project);
assert.throws(() => applyAssistantResult(stale, { ...result, subtitlePatch: { cues: [{ id: 'missing', text: 'x' }] } }, 2), /找不到字幕/);
assert.equal(JSON.stringify(stale.project), original, '字幕校验失败时不能部分执行摄像头修改');
assert.throws(() => applyAssistantResult(stale, { ...result, historyAction: 'undo' }, 2), /混用/);
assert.throws(() => applyAssistantResult(stale, { ...result, operations: [{ type: 'camera', segmentId: 'second', patch: { size: 0.5 } }] }, 2), /不支持字段/);
assert.equal(applyAssistantResult(stale, { reply: '你好', operations: [], subtitlePatch: {}, historyAction: 'none' }, 0), false);
assert.equal(applyAssistantResult(stale, { reply: '撤销', operations: [], subtitlePatch: {}, historyAction: 'undo' }, 2), true);
console.log('AI 编辑原子事务、版本冲突、字幕与片段摄像头检查通过');
