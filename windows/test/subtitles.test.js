'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { makeProject, normalizeProject } = require('../src/core/model');
const { normalizeSubtitleLanguage, normalizeSubtitles, mapCuesToOutput, activeCues, toSrt } = require('../src/core/subtitles');
const { createMockCanvas, drawSubtitleText } = require('../src/renderer/editor/render');
let semanticWords;
let alignedWordTexts;
const originalModuleLoad = Module._load;
const originalLocation = global.location;
global.location = { search: '' };
Module._load = function loadWithoutElectron(request, parent, isMain) {
  if (request === 'electron') return { ipcRenderer: {} };
  return originalModuleLoad.call(this, request, parent, isMain);
};
try {
  ({ semanticWords, alignedWordTexts } = require('../src/renderer/editor/subtitles-panel'));
} finally {
  Module._load = originalModuleLoad;
  global.location = originalLocation;
}

const legacy = makeProject({
  name: '字幕测试',
  media: { screen: { duration: 10, width: 1920, height: 1080 } },
  capture: {},
});
assert.deepEqual(legacy.subtitles, {
  enabled: true,
  sourceTrack: 'microphone',
  language: 'zh',
  style: { fontSize: 48, color: '#FFFFFF', backgroundColor: '#000000', backgroundOpacity: 1, baselineY: 0.86 },
  cues: [],
});

const oldProject = normalizeProject({
  media: { screen: { duration: 8, width: 1920, height: 1080 } },
  timeline: { segments: [{ id: 'old', sourceStart: 0, sourceEnd: 8, speed: 1 }] },
});
assert.equal(oldProject.subtitles.enabled, true, '旧工程获得可用的空字幕轨');
assert.equal(oldProject.subtitles.cues.length, 0);

const normalized = normalizeSubtitles({
  enabled: true,
  sourceTrack: 'systemAudio',
  style: { fontSize: 1000, color: 'red', backgroundOpacity: -2, baselineY: 5 },
  cues: [
    { id: 'keep', start: 0, end: 2, text: '保留', words: [{ start: 0, end: 1, text: '保留' }] },
    { id: 'bad', start: 2, end: 1, text: '时间倒置' },
  ],
});
assert.equal(normalized.style.fontSize, 160);
assert.equal(normalized.style.color, '#FFFFFF');
assert.equal(normalized.style.backgroundOpacity, 0);
assert.equal(normalized.style.baselineY, 0.9);
assert.deepEqual(normalized.cues.map((cue) => cue.id), ['keep']);
assert.equal(normalizeSubtitleLanguage('zh--CN'), 'zh');
assert.equal(normalizeSubtitles({ language: '  ' }).language, 'zh');
assert.equal(normalizeSubtitles({ language: 'zh-hans-cn' }).language, 'zh-Hans-CN');
assert.doesNotThrow(() => semanticWords('你好 Recly', 'zh--CN'));
assert.deepEqual(semanticWords(null, 'zh--CN'), []);
assert.deepEqual(alignedWordTexts({ invalid: true }, ''), []);

const project = makeProject({
  name: '映射',
  media: { screen: { duration: 8, width: 1920, height: 1080 } },
  capture: {},
});
project.timeline.segments = [
  { id: 'first', sourceStart: 0, sourceEnd: 2, speed: 1 },
  { id: 'fast', sourceStart: 4, sourceEnd: 6, speed: 2 },
  { id: 'repeat', sourceStart: 0, sourceEnd: 2, speed: 1 },
];
project.subtitles.cues = [{
  id: 'sentence',
  start: 1,
  end: 5,
  text: '你好再见你好世界',
  originalText: '你好再见你好世界',
  alignment: 'valid',
  words: [
    { start: 1, end: 2, text: '你好' },
    { start: 2, end: 3, text: '再见' },
    { start: 3, end: 4, text: '你好' },
    { start: 4, end: 5, text: '世界' },
  ],
}];

const mapped = mapCuesToOutput(project);
assert.deepEqual(mapped.map((cue) => [cue.segmentId, cue.start, cue.end, cue.text]), [
  ['first', 1, 2, '你好'],
  ['fast', 2, 2.5, '世界'],
  ['repeat', 4, 5, '你好'],
], '剪切只留下保留词，变速和重复片段都使用各自的成片位置');
assert.equal(mapped.warnings.length, 0);

assert.equal(activeCues(project, 1.5, 1.5)[0].segmentId, 'first');
assert.equal(activeCues(project, 1.5, 4.5)[0].segmentId, 'repeat', '按成片时间选择重复源片段的当前字幕');
assert.equal(activeCues(project, 4.5, 2.25)[0].segmentId, 'fast');
const cacheCue = { id: 'cache', start: 0.25, end: 0.75, text: '片段', words: [{ start: 0.25, end: 0.75, text: '片段' }] };
const unrevisionedProject = {
  subtitles: { cues: [cacheCue] },
  timeline: { segments: [{ id: 'cache', sourceStart: 0, sourceEnd: 1, speed: 1 }] },
};
assert.equal(activeCues(unrevisionedProject, 0.5, 0.5).length, 1);
unrevisionedProject.timeline.segments[0].speed = 2;
assert.equal(activeCues(unrevisionedProject, 0.5, 0.25).length, 1, 'projects without revisions must not use stale mappings');
const revisionedProject = {
  revision: 4,
  subtitles: { cues: [cacheCue] },
  timeline: { segments: [{ id: 'cache', sourceStart: 0, sourceEnd: 1, speed: 1 }] },
};
assert.equal(activeCues(revisionedProject, 0.5, 0.5).length, 1);
revisionedProject.timeline.segments[0].speed = 2;
revisionedProject.revision += 1;
assert.equal(activeCues(revisionedProject, 0.5, 0.25).length, 1, 'mapping refreshes when project revision changes');
assert.match(toSrt(project), /00:00:02,000 --> 00:00:02,500\r\n世界/);
const canvas = createMockCanvas(1920, 1080);
const drawContext = canvas.getContext('2d');
const drawnText = [];
drawContext.fillText = (text) => drawnText.push(text);
drawSubtitleText(drawContext, project, { width: 1920, height: 1080, styleScale: 1, outputTime: 4.5 }, 1.5);
assert.deepEqual(drawnText, ['你好'], '共享绘制器按当前重复片段的成片位置画字幕');

project.subtitles.cues = [{
  id: 'stale', start: 1, end: 5, text: '纠正后的完整文本', originalText: '旧文本', alignment: 'stale', words: [],
}];
const staleMapped = mapCuesToOutput(project);
assert.equal(staleMapped.length, 0, '无法对齐的纠错文本跨剪切时不会冒充词级对齐');
assert.equal(staleMapped.warnings.length, 3, '每个有交集的保留片段都会提示被隐藏的字幕');
assert.equal(activeCues(project, 1.5, 1.5).length, 0);

project.timeline.segments = [{ id: 'whole', sourceStart: 0, sourceEnd: 8, speed: 1 }];
assert.equal(mapCuesToOutput(project)[0].text, '纠正后的完整文本', '完整保留时显示当前纠正文字');
assert.match(toSrt(project), /纠正后的完整文本/);
drawnText.length = 0;
drawSubtitleText(drawContext, project, { width: 1920, height: 1080, styleScale: 1, outputTime: 1.5 }, 1.5);
assert.deepEqual(drawnText, ['纠正后的完整文本'], '预览与导出绘制当前文本修订');

project.subtitles.cues[0].alignment = 'valid';
project.subtitles.cues[0].words = [{ start: 1, end: 2, text: '旧' }];
project.subtitles.cues[0].text = '新字';
project.timeline.segments = [{ id: 'cut', sourceStart: 1.5, sourceEnd: 8, speed: 1 }];
assert.equal(mapCuesToOutput(project).length, 0, '当前文字与词时间数量不符时，跨切片内容不显示');
assert.equal(mapCuesToOutput(project).warnings.length, 1);

console.log('字幕轨测试通过');
