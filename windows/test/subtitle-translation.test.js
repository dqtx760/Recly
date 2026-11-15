'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { makeProject } = require('../src/core/model');
const {
  MAX_TRANSLATION_CUES,
  MAX_TRANSLATION_CHARACTERS,
  availableAssistantBackends,
  getTranslationTargets,
  cuesHiddenAfterTranslation,
  validateTranslationResult,
  makeSubtitlePatch,
  translationMessage,
} = require('../src/renderer/editor/subtitle-translation');

const cues = [
  { id: 'one', start: 1, end: 2, text: 'Hello world', originalText: 'Hello world', alignment: 'valid', words: [{ start: 1, end: 2, text: 'Hello world' }] },
  { id: 'two', start: 3, end: 4, text: 'Second line', originalText: 'Second line', alignment: 'valid', words: [] },
];

function projectWith(segments = [{ id: 'whole', sourceStart: 0, sourceEnd: 10, speed: 1 }]) {
  const project = makeProject({ media: { screen: { duration: 10, width: 1280, height: 720 } }, capture: {} });
  project.timeline.segments = segments;
  project.subtitles.language = 'en';
  project.subtitles.cues = structuredClone(cues);
  return project;
}

assert.deepEqual(availableAssistantBackends([
  { id: 'codex', label: 'Codex', available: true, model: null, modelSource: 'unreported' },
  { id: 'claude', label: 'Claude', available: false, model: null, modelSource: 'unreported' },
  { id: 'api', label: 'API Key', available: true, model: 'test-model', modelSource: 'config' },
]), [
  { id: 'codex', label: 'Codex', model: null, modelSource: 'unreported' },
  { id: 'api', label: 'API Key', model: 'test-model', modelSource: 'config' },
]);
assert.throws(() => availableAssistantBackends([{ id: 'api', label: 'API Key', available: 'yes' }]), /检测结果格式/);
assert.deepEqual(getTranslationTargets(projectWith(), 'all').map((cue) => cue.id), ['one', 'two']);
assert.deepEqual(getTranslationTargets(projectWith(), 'selected', 'two').map((cue) => cue.id), ['two']);
assert.throws(() => getTranslationTargets(projectWith(), 'selected', 'missing'), /选中/);
const blankCue = projectWith();
blankCue.subtitles.cues[1].text = '   ';
assert.throws(() => getTranslationTargets(blankCue, 'all'), /为空/);

const oversized = projectWith();
oversized.subtitles.cues = Array.from({ length: MAX_TRANSLATION_CUES + 1 }, (_, index) => ({ ...cues[0], id: `cue-${index}` }));
assert.throws(() => getTranslationTargets(oversized), /最多翻译 50 条/);
const tooLong = projectWith();
tooLong.subtitles.cues = [{ ...cues[0], text: 'x'.repeat(MAX_TRANSLATION_CHARACTERS + 1) }];
assert.throws(() => getTranslationTargets(tooLong), /最多发送 5000 个原文字/);

const cutProject = projectWith([
  { id: 'before', sourceStart: 0, sourceEnd: 3, speed: 1 },
  { id: 'after', sourceStart: 4, sourceEnd: 10, speed: 1 },
]);
cutProject.subtitles.cues[0].start = 2;
cutProject.subtitles.cues[0].end = 5;
const beforeCutCheck = JSON.stringify(cutProject.subtitles);
assert.deepEqual(cuesHiddenAfterTranslation(cutProject, [cutProject.subtitles.cues[0]]), ['one']);
assert.equal(JSON.stringify(cutProject.subtitles), beforeCutCheck, '跨剪切预检只读，不得改动工程');
assert.deepEqual(cuesHiddenAfterTranslation(projectWith(), cues), [], '完整保留字幕可以翻译');

const goodResult = {
  reply: '完成', operations: [], historyAction: 'none',
  subtitlePatch: { cues: [{ id: 'one', text: '你好，世界' }, { id: 'two', text: '第二行' }] },
};
const translations = validateTranslationResult(goodResult, cues);
assert.deepEqual([...translations], [['one', '你好，世界'], ['two', '第二行']]);
assert.deepEqual(makeSubtitlePatch(cues, translations, 'bilingual').cues, [
  { id: 'one', text: 'Hello world\n你好，世界' }, { id: 'two', text: 'Second line\n第二行' },
]);
assert.deepEqual(makeSubtitlePatch(cues, translations, 'replace').cues, [
  { id: 'one', text: '你好，世界' }, { id: 'two', text: '第二行' },
]);
for (const badPatch of [
  { cues: [{ id: 'one', text: 'x' }, { id: 'one', text: 'y' }] },
  { cues: [{ id: 'one', text: 'x' }] },
  { cues: [{ id: 'missing', text: 'x' }, { id: 'two', text: 'y' }] },
  { cues: [{ id: 'one', text: ' ' }, { id: 'two', text: 'y' }] },
  { cues: [{ id: 'one', text: 'x', start: 0 }, { id: 'two', text: 'y' }] },
  { cues: [{ id: 'one', text: 'x' }, { id: 'two', text: 'y' }], enabled: true },
]) assert.throws(() => validateTranslationResult({ ...goodResult, subtitlePatch: badPatch }, cues));
assert.throws(() => validateTranslationResult({ ...goodResult, operations: [{ type: 'remove', segmentId: 'x' }] }, cues), /只返回 subtitlePatch/);
assert.match(translationMessage('ja', '日语', cues).toLowerCase(), /subtitlepatchjson/);
assert.throws(() => makeSubtitlePatch([{ ...cues[0], text: 'x'.repeat(3000) }], new Map([['one', 'y'.repeat(1500)]]), 'bilingual'), /超过 4000/);

class MockElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.scrollHeight = 48;
  }
  set className(value) { this.attributes.class = value; }
  get className() { return this.attributes.class || ''; }
  set textContent(value) { this.children = [{ nodeType: 3, textContent: String(value) }]; }
  get textContent() { return this.children.map((child) => child.textContent || '').join(''); }
  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'value') this.value = String(value);
    if (key === 'hidden') this.hidden = true;
    if (key === 'disabled') this.disabled = true;
  }
  getAttribute(key) { return this.attributes[key] ?? null; }
  append(...nodes) { for (const node of nodes.flat()) if (node != null && node !== false) this.children.push(node?.nodeType ? node : { nodeType: 3, textContent: String(node) }); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  dispatchEvent(event) {
    const payload = typeof event === 'string' ? { type: event } : event;
    payload.target ||= this;
    payload.preventDefault ||= () => {};
    for (const callback of [...(this.listeners[payload.type] || [])]) callback(payload);
  }
  click() { this.dispatchEvent({ type: 'click' }); }
  querySelectorAll(selector) {
    const matches = (node) => selector.startsWith('.')
      ? node.className.split(/\s+/).includes(selector.slice(1))
      : node.tagName === selector.toUpperCase();
    const result = [];
    const visit = (node) => { for (const child of node.children || []) if (child.nodeType === 1) { if (matches(child)) result.push(child); visit(child); } };
    visit(this);
    return result;
  }
}

const ipcCalls = [];
const sendResolvers = [];
const electron = { ipcRenderer: { invoke(channel, payload) {
  ipcCalls.push({ channel, payload });
  if (channel === 'assistant:detect') return Promise.resolve([
    { id: 'codex', label: 'Codex', available: true, model: 'gpt-test', modelSource: 'config' },
    { id: 'api', label: 'API Key', available: true, model: null, modelSource: 'unreported' },
  ]);
  if (channel === 'assistant:api-config') return Promise.resolve({ hasKey: true, baseUrl: 'https://example.invalid/v1', model: 'test-model' });
  if (channel === 'subtitle:environment') return Promise.resolve({ ready: false });
  if (channel === 'assistant:send') return new Promise((resolve) => sendResolvers.push(resolve));
  return Promise.resolve(null);
} } };

global.location = { search: '' };
global.document = {
  head: new MockElement('head'),
  getElementById: () => null,
  createElement: (tag) => new MockElement(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
};
global.requestAnimationFrame = (callback) => callback();
global.window = { reclyEditor: { agentBridge: { activeExportId: null } } };
const originalLoad = Module._load;
Module._load = function loadElectron(request, parent, isMain) {
  if (request === 'electron') return electron;
  return originalLoad.call(this, request, parent, isMain);
};
const { renderSubtitlesPanel } = require('../src/renderer/editor/subtitles-panel');
Module._load = originalLoad;

function makeStore() {
  const project = projectWith();
  project.revision = 4;
  return {
    project, revision: 4, directory: 'D:/synthetic-project', selection: null, gesture: null,
    mutations: 0,
    mutate(change) { change(this.project); this.revision += 1; this.project.revision = this.revision; this.mutations += 1; },
  };
}

function findButton(root, label) { return root.querySelectorAll('button').find((node) => node.textContent.trim() === label) || null; }
function findTabButtons(root) { return root.querySelectorAll('.subtitles-tabs').flatMap((node) => node.querySelectorAll('button')); }
async function flush() { await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve)); await Promise.resolve(); }

async function testPanelFlow() {
  const store = makeStore();
  const root = new MockElement('div');
  const inspector = {
    tab: 'subtitles', store, root, preview: { time: 1 },
    render() { root.replaceChildren(...renderSubtitlesPanel(this)); },
    show(tab) { this.tab = tab; this.render(); },
  };
  inspector.render();
  assert.deepEqual(findTabButtons(root).map((node) => node.textContent), ['内容', '翻译', '样式', '动画']);
  findTabButtons(root)[1].click();
  await flush();
  assert.ok(ipcCalls.some((call) => call.channel === 'assistant:detect'), '翻译页通过 assistant:detect 读取后端清单');
  assert.ok(root.querySelectorAll('select').some((node) => node.getAttribute('aria-label') === '翻译 AI 后端'));

  findButton(root, '翻译字幕').click();
  await flush();
  const firstCall = ipcCalls.filter((call) => call.channel === 'assistant:send').at(-1);
  assert.equal(firstCall.payload.backend, 'codex');
  assert.equal(firstCall.payload.directory, store.directory);
  assert.equal(firstCall.payload.history.length, 0);
  assert.match(firstCall.payload.message, /operationsJson 必须是 \[\]/);
  assert.equal(firstCall.payload.project.subtitles.cues.length, 2);
  sendResolvers.shift()({
    reply: '翻译完成', operations: [], historyAction: 'none',
    subtitlePatch: { cues: [{ id: 'one', text: '你好，世界' }, { id: 'two', text: '第二行' }] },
  });
  await flush();
  assert.equal(store.mutations, 1, '完整结果只调用一次 store.mutate');
  assert.deepEqual(store.project.subtitles.cues.map((cue) => [cue.text, cue.start, cue.end, cue.alignment]), [
    ['你好，世界', 1, 2, 'stale'], ['第二行', 3, 4, 'stale'],
  ]);
  assert.equal(store.project.subtitles.cues[0].words[0].text, 'Hello world', '旧词文本仅留作不可用对齐数据，文字编辑会标记 stale');
  assert.equal(store.project.subtitles.language, 'en', '保留原始识别语言');

  findButton(root, '翻译字幕').click();
  await flush();
  const beforeConflict = store.mutations;
  store.revision += 1;
  store.project.revision = store.revision;
  sendResolvers.shift()({
    reply: '翻译完成', operations: [], historyAction: 'none',
    subtitlePatch: { cues: [{ id: 'one', text: '新译文' }, { id: 'two', text: '第二行新译文' }] },
  });
  await flush();
  assert.equal(store.mutations, beforeConflict, 'revision 冲突拒绝整批应用');
  assert.ok(root.textContent.includes('工程已改变'));

  findButton(root, '翻译字幕').click();
  await flush();
  findButton(root, '停止等待').click();
  assert.ok(root.textContent.includes('返回结果会被丢弃'));
  sendResolvers.shift()({
    reply: '翻译完成', operations: [], historyAction: 'none',
    subtitlePatch: { cues: [{ id: 'one', text: '不应写入' }, { id: 'two', text: '不应写入' }] },
  });
  await flush();
  assert.equal(store.mutations, beforeConflict, '停止等待后返回内容不得应用');
  assert.equal(ipcCalls.some((call) => call.channel === 'assistant:cancel'), false, '停止翻译等待不取消同一窗口 owner 的其他 AI 请求');
}

testPanelFlow().then(() => console.log('字幕翻译：后端检测、响应全覆盖校验、原子提交、起止时间、冲突与停止等待检查通过'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
