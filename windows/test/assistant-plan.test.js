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

const { outputDuration } = require('../src/core/timeline');
const { evaluateScreenMotion } = require('../src/core/screen-motion');
function scenesFixture() {
  const value = fixture();
  value.project.media.camera = { file: 'camera.mp4', duration: 10, width: 1280, height: 720 };
  value.project.timeline.segments = [{ id: 'second', sourceStart: 4, sourceEnd: 10, speed: 2, audio: { microphoneVolume: 1.2 } },
    { id: 'first', sourceStart: 0, sourceEnd: 4, speed: 1 }];
  return value;
}
const scenes = [{ start: 0, end: 1, mode: 'portrait' }, { start: 1, end: 3, mode: 'screen3d' }, { start: 3, end: 7, mode: 'presenter' }];
const sceneResult = { reply: '按字幕分镜', operations: [{ type: 'scene_plan', scenes }], subtitlePatch: {}, historyAction: 'none' };
const planned = scenesFixture(), originalCues = JSON.stringify(planned.project.subtitles);
assert.equal(applyAssistantResult(planned, sceneResult, 2), true);
assert.equal(planned.calls, 1);
assert.equal(outputDuration(planned.project.timeline.segments), 7);
assert.deepEqual(planned.project.timeline.segments.map((s) => [s.sourceStart, s.sourceEnd, s.camera.layout]),
  [[4, 6, 'fullscreen'], [6, 10, 'shape'], [0, 4, 'shape']]);
assert.equal(planned.project.timeline.segments[1].audio.microphoneVolume, 1.2);
assert.equal(JSON.stringify(planned.project.subtitles), originalCues);
const effect = planned.project.timeline.screenMotionClips[0];
assert.equal(effect.timing.startTime, 6);
assert.equal(effect.timing.duration + effect.timing.returnDuration, 4);
assert.ok(evaluateScreenMotion([effect], 8).rotationY < -1, '3D实际求值应出现旋转');
assert.equal(evaluateScreenMotion([effect], 10.01).rotationY, 0, '3D退场不得延伸到后续片段');
assert.equal(new Set(planned.project.timeline.segments.map((s) => s.id)).size, 3);
for (const bad of [
  [{ start: 1, end: 7, mode: 'portrait' }],
  [{ start: 0, end: 7.1, mode: 'portrait' }],
  [{ start: 0, end: 7, mode: 'unknown' }],
  [{ start: 0, end: 0.01, mode: 'portrait' }, { start: 0.01, end: 7, mode: 'presenter' }],
]) {
  const target = scenesFixture(), before = JSON.stringify(target.project);
  assert.throws(() => applyAssistantResult(target, { ...sceneResult, operations: [{ type: 'scene_plan', scenes: bad }] }, 2));
  assert.equal(JSON.stringify(target.project), before, '非法分镜不能部分执行');
}
const noCamera = fixture();
assert.throws(() => applyAssistantResult(noCamera, sceneResult, 2), /没有摄像头/);
const collision = scenesFixture();
collision.project.timeline.screenMotionClips = [effect];
assert.throws(() => applyAssistantResult(collision, sceneResult, 2), /重叠/);
const repeated = scenesFixture();
repeated.project.timeline.segments = [{ id: 'a', sourceStart: 0, sourceEnd: 4, speed: 1 }, { id: 'b', sourceStart: 0, sourceEnd: 4, speed: 1 }];
assert.throws(() => applyAssistantResult(repeated, { ...sceneResult, operations: [{ type: 'scene_plan', scenes: [{ start: 0, end: 8, mode: 'screen3d' }] }] }, 2), /重复/);
console.log('字幕分镜：变速重排、独立摄像头、3D退场、时长音轨保留与整批校验通过');
const rounded = scenesFixture();
rounded.project.timeline.segments[1].sourceEnd = 3.997;
assert.equal(applyAssistantResult(rounded, { ...sceneResult, operations: [{ type: 'scene_plan', scenes: [{ start: 0, end: 7, mode: 'presenter' }] }] }, 2), true);
assert.equal(outputDuration(rounded.project.timeline.segments), 6.997, '模型百分之一秒尾时间贴齐真实时长');
