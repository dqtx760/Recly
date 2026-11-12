'use strict';
// 右侧检查器的分组、样机与运镜控件回归。
// 运行：node windows/test/editor-inspector-ui.test.js

const assert = require('node:assert/strict');
const Module = require('node:module');
const model = require('../src/core/model');
const { FRAME_DEFAULTS } = require('../src/core/crop-frame');
const { StickerClip } = require('../src/core/opening-overlay');

class MockElement {
  constructor(tag, attributes = {}) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attributes = {};
    this.children = [];
    this.style = { cssText: '' };
    this.listeners = {};
    this.scrollTop = 0;
    this.value = '';
    this.open = false;
    for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value);
  }

  set className(value) { this.setAttribute('class', value); }
  get className() { return this.getAttribute('class') || ''; }
  get textContent() { return this.children.map((child) => child.textContent || '').join(''); }
  set textContent(value) { this.children = [{ nodeType: 3, textContent: String(value) }]; }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'value') this.value = String(value);
    if (key === 'open') this.open = true;
  }

  getAttribute(key) { return this.attributes[key] ?? null; }

  append(...nodes) {
    for (const node of nodes.flat()) {
      if (node === null || node === undefined || node === false) continue;
      this.children.push(node && node.nodeType ? node : { nodeType: 3, textContent: String(node) });
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }

  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== handler);
  }

  dispatchEvent(event) {
    const normalized = typeof event === 'string' ? { type: event } : event;
    const payload = {
      target: this,
      preventDefault() {},
      stopPropagation() {},
      ...normalized,
    };
    for (const handler of [...(this.listeners[payload.type] || [])]) handler(payload);
  }

  click() { this.dispatchEvent({ type: 'click' }); }
  focus() { this.focused = true; }
  setPointerCapture() {}

  getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 100 }; }

  matches(selector) {
    const attrMatch = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attrMatch) return this.getAttribute(attrMatch[1]) === (attrMatch[2] ?? '');
    const typeMatch = selector.match(/^([a-z]+)\[type="([^"]+)"\]$/i);
    if (typeMatch) return this.tagName === typeMatch[1].toUpperCase() && this.getAttribute('type') === typeMatch[2];
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector) {
    if (selector.trim().includes(' ')) {
      const [parentSelector, ...descendantSelectors] = selector.trim().split(/\s+/);
      const remainder = descendantSelectors.join(' ');
      return this.querySelectorAll(parentSelector).flatMap((parent) => parent.querySelectorAll(remainder));
    }
    const found = [];
    const visit = (node) => {
      for (const child of node.children || []) {
        if (child.nodeType !== 1) continue;
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function element(tag, attributes = {}, ...children) {
  const node = new MockElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children);
  return node;
}

function findByText(root, selector, text) {
  return root.querySelectorAll(selector).find((node) => node.textContent.includes(text)) || null;
}

function createStore() {
  const project = model.makeProject({
    name: '检查器测试',
    media: {
      screen: { duration: 20, width: 1920, height: 1080, frameRate: 30 },
      camera: null,
      thumbnails: null,
      microphone: null,
      systemAudio: null,
    },
    capture: {},
  });
  const listeners = new Set();
  return {
    project,
    directory: 'D:/test-project',
    pointerTrack: null,
    selection: null,
    gesture: null,
    subscribe(listener) { listeners.add(listener); },
    emit(reason) { for (const listener of listeners) listener(reason); },
    mutate(change) { change(this.project); this.emit('project'); },
    beginGesture() { this.gesture ||= true; },
    endGesture() { if (this.gesture) { this.gesture = null; this.emit('history'); } },
    select(selection) { this.selection = selection; this.emit('selection'); },
    getClip(type, id) {
      const pools = { sticker: this.project.timeline.stickerClips, mosaic: this.project.timeline.mosaicClips };
      return pools[type]?.find((item) => item.id === id) || null;
    },
    get selectedSticker() { return this.selection?.type === 'sticker' ? this.getClip('sticker', this.selection.id) : null; },
    get selectedMosaic() { return this.selection?.type === 'mosaic' ? this.getClip('mosaic', this.selection.id) : null; },
    get selectedZoom() {
      return this.selection?.type === 'zoom'
        ? this.project.zoomAnimations.find((item) => item.id === this.selection.id) || null
        : null;
    },
    get selectedSegment() {
      return this.selection?.type === 'segment'
        ? this.project.timeline.segments.find((item) => item.id === this.selection.id) || null
        : null;
    },
    get selectedScreenMotion() {
      return this.selection?.type === 'screen'
        ? this.project.timeline.screenMotionClips.find((item) => item.id === this.selection.id) || null
        : null;
    },
  };
}

const ipcCalls = [];
const electron = { ipcRenderer: { invoke: (channel, payload) => {
  ipcCalls.push({ channel, payload });
  if (channel === 'project:import-asset') return Promise.resolve({ file: 'media/drop.png', width: 640, height: 480 });
  return new Promise(() => {});
} } };
const originalLoad = Module._load;
Module._load = function loadForInspector(request, parent, isMain) {
  if (request === 'electron') return electron;
  const parentPath = parent?.filename.replaceAll('/', '\\');
  if (request === '../common' && (
    parentPath?.endsWith('renderer\\editor\\inspector.js')
    || parentPath?.endsWith('renderer\\editor\\subtitles-panel.js')
  )) {
    return { element, fileUrl: (file) => file };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { Inspector, TABS } = require('../src/renderer/editor/inspector');
Module._load = originalLoad;

const test = (name, body) => {
  const result = body();
  if (result && typeof result.then === 'function') {
    pendingTests.push(result.then(() => console.log(`  ok  ${name}`)));
  } else console.log(`  ok  ${name}`);
};
const pendingTests = [];

console.log('Testing editor inspector groups and controls...');

test('画面设置合并摄像头与样机并保留各分组滚动位置', () => {
  assert.deepEqual(TABS.map((tab) => tab.id), ['canvas', 'motion', 'subtitles', 'audio', 'cursor']);
  const store = createStore();
  const root = new MockElement('div');
  const inspector = new Inspector(store, { sourceTime: 0 }, root, { textContent: '' });
  inspector.show('canvas');
  assert.deepEqual(root.querySelectorAll('.frame-tabs button').map((button) => button.textContent), ['摄像头', '背景', '布局']);
  assert.equal(root.querySelector('[data-frame-tab="camera"]').getAttribute('aria-selected'), 'true');
  root.querySelector('[data-frame-tab="background"]').click();
  assert.equal(root.querySelector('[data-frame-tab="background"]').getAttribute('aria-selected'), 'true');
  assert.ok(findByText(root, '.section', '背景'));
  assert.equal(root.querySelectorAll('.mockup-option').length, 6);

  root.scrollTop = 84;
  root.querySelector('[data-frame-tab="layout"]').click();
  assert.equal(inspector.canvasTab, 'layout');
  assert.equal(root.scrollTop, 0);
  assert.ok(findByText(root, '.section', '位置与大小'));
  assert.equal(root.querySelectorAll('.mockup-option').length, 0);

  root.scrollTop = 28;
  root.querySelector('[data-frame-tab="camera"]').click();
  assert.equal(inspector.canvasTab, 'camera');
  assert.ok(root.textContent.includes('这次录制未开启摄像头'));
  root.querySelector('[data-frame-tab="background"]').click();
  assert.equal(root.scrollTop, 84);
  root.querySelector('[data-frame-tab="layout"]').click();
  assert.equal(root.scrollTop, 28);
});

test('样机卡片应用样式默认值并显示网址、框体和顶栏控件', () => {
  const store = createStore();
  store.project.canvas.screenFrameTitle = '自定义标题';
  store.project.canvas.screenFrameBrowserAddress = 'custom.example/path';
  const root = new MockElement('div');
  const inspector = new Inspector(store, { sourceTime: 0 }, root, { textContent: '' });
  inspector.show('canvas');
  root.querySelector('[data-frame-tab="background"]').click();
  const browserCard = root.querySelectorAll('.mockup-option').find((item) => item.getAttribute('aria-label') === '浅色浏览器');
  browserCard.click();

  const defaults = FRAME_DEFAULTS.browserLight;
  assert.equal(store.project.canvas.screenFrame, 'browserLight');
  assert.equal(store.project.canvas.screenFrameScale, defaults.frameScale);
  assert.equal(store.project.canvas.screenFrameToolbarScale, defaults.toolbarScale);
  assert.equal(store.project.canvas.screenFrameOuterCornerRadius, defaults.outerRadius);
  assert.equal(store.project.canvas.screenFrameContentCornerRadius, defaults.contentRadius);
  assert.equal(store.project.canvas.cornerRadius, defaults.contentRadius);
  assert.equal(store.project.canvas.shadowStrength, defaults.shadowStrength);
  assert.equal(store.project.canvas.screenFrameTitle, '自定义标题');
  assert.equal(store.project.canvas.screenFrameBrowserAddress, 'custom.example/path');

  const addressField = root.querySelectorAll('.field-stacked').find((item) => item.textContent.includes('浏览器地址'));
  assert.ok(addressField, '浏览器卡片选中后应显示自定义地址输入');
  const addressInput = addressField.querySelector('input');
  assert.equal(addressInput.getAttribute('placeholder'), 'https://example.com');
  addressInput.value = 'docs.example.org/start';
  addressInput.dispatchEvent({ type: 'change' });
  assert.equal(store.project.canvas.screenFrameBrowserAddress, 'docs.example.org/start');

  const labels = root.querySelectorAll('.field').map((field) => field.textContent);
  assert.ok(labels.some((label) => label.includes('框体比例')));
  assert.ok(labels.some((label) => label.includes('顶栏高度')));
  assert.ok(labels.some((label) => label.includes('框体外圆角')));
});

test('运镜提供独立开场分组并保留屏幕 3D 控件与分组滚动位置', () => {
  const store = createStore();
  const clip = {
    id: 'screen-motion-ui',
    target: { position: { x: 0.3, y: 0.7 }, scale: 1.4, rotationX: 4, rotationY: -8, rotationZ: 2, perspective: 0.65 },
    timing: { startTime: 1, duration: 3, leadInDuration: 0.5, returnDuration: 0.6, easing: 'cubic' },
  };
  store.project.timeline.screenMotionClips.push(clip);
  const root = new MockElement('div');
  const inspector = new Inspector(store, { sourceTime: 0 }, root, { textContent: '' });
  inspector.show('motion');
  assert.equal(inspector.motionMode, 'opening');
  assert.deepEqual(root.querySelectorAll('.motion-mode button').map((button) => button.textContent), ['开场', '缩放', '屏幕 3D']);
  assert.ok(findByText(root, '.section', '全局开场'));
  const enableOpening = root.querySelectorAll('.field').find((field) => field.textContent.includes('启用开场'));
  enableOpening.querySelector('button').click();
  assert.equal(store.project.openingSequence.isEnabled, true);
  assert.ok(root.querySelectorAll('.field').some((field) => field.textContent.includes('开场时长')));

  store.select({ type: 'screen', id: clip.id });
  assert.ok(root.querySelector('.tilt-pad'));
  assert.equal(findByText(root, '.section', '全局开场'), null);
  const anchorGroup = root.querySelector('[aria-label="构图锚点"]');
  const anchorX = anchorGroup.querySelector('input');
  anchorX.value = '41';
  anchorX.dispatchEvent({ type: 'change' });
  assert.equal(clip.target.position.x, 0.41);

  const tilt = root.querySelector('.tilt-pad');
  tilt.dispatchEvent({ type: 'pointerdown', pointerId: 1, clientX: 0, clientY: 0 });
  tilt.dispatchEvent({ type: 'pointerup', pointerId: 1 });
  assert.equal(clip.target.rotationX, 28);
  assert.equal(clip.target.rotationY, -32);

  const details = root.querySelector('.disclosure');
  assert.ok(details, 'Z 平面旋转与透视应位于折叠组中');
  assert.equal(details.open, false);
  assert.ok(findByText(root, 'summary', '平面旋转与透视'));

  const zoomMode = root.querySelectorAll('.motion-mode button').find((button) => button.textContent === '缩放');
  zoomMode.click();
  assert.equal(inspector.motionMode, 'zoom');
  assert.equal(store.selection, null);
  assert.ok(findByText(root, '.section', '自动缩放'));
  const screenMode = root.querySelectorAll('.motion-mode button').find((button) => button.textContent === '屏幕 3D');
  screenMode.click();
  assert.equal(inspector.motionMode, 'screen3D');
  assert.ok(findByText(root, '.section', '屏幕 3D'));
  root.scrollTop = 120;
  store.select({ type: 'screen', id: clip.id });
  root.querySelectorAll('.motion-mode button').find((button) => button.textContent === '开场').click();
  assert.equal(store.selection, null);
  assert.equal(inspector.motionMode, 'opening');
  assert.equal(root.scrollTop, 0);
  root.querySelectorAll('.motion-mode button').find((button) => button.textContent === '屏幕 3D').click();
  assert.equal(root.scrollTop, 120);
});

test('叠加不再占左侧分类，内部贴图面板提供录屏虚化与仅背景入口', () => {
  assert.equal(TABS.some((tab) => tab.id === 'overlays'), false);
  const store = createStore();
  const clip = new StickerClip({ id: 'sticker-ui', relativePath: 'media/sticker.png' });
  store.project.timeline.stickerClips.push(clip);
  const root = new MockElement('div');
  const inspector = new Inspector(store, { sourceTime: 0 }, root, { textContent: '' });
  inspector.show('canvas');
  store.select({ type: 'sticker', id: clip.id });
  assert.equal(inspector.tab, 'overlays');
  assert.equal(inspector.title.textContent, '画面效果');
  const labels = root.querySelectorAll('.field').map((field) => field.textContent);
  assert.ok(labels.some((label) => label.includes('录屏虚化')));
  const backgroundMode = root.querySelectorAll('.field').find((field) => field.textContent.includes('仅作背景'));
  assert.ok(backgroundMode);
  backgroundMode.querySelector('button').click();
  assert.equal(clip.hidesScreen, true);
});

test('预览拖入图片路径透传到已有素材导入 IPC', async () => {
  const store = createStore();
  const root = new MockElement('div');
  const preview = { sourceTime: 0, time: 0, compositor: { prepare: async () => {} }, invalidate() {} };
  const inspector = new Inspector(store, preview, root, { textContent: '' });
  await inspector.importSticker('image', 'D:\\assets\\drop.png');
  const importCall = ipcCalls.filter((call) => call.channel === 'project:import-asset').at(-1);
  assert.equal(importCall.payload.file, 'D:\\assets\\drop.png');
  assert.equal(store.project.timeline.stickerClips.length, 1);
  assert.equal(inspector.tab, 'overlays');
});

test('贴图导入先检查播放头剩余时长，片尾不会产生未引用素材', async () => {
  const store = createStore();
  const preview = { sourceTime: 0, time: 19.95, compositor: { prepare: async () => {} }, invalidate() {} };
  const inspector = new Inspector(store, preview, new MockElement('div'), { textContent: '' });
  let message = '';
  inspector.onToast = (value) => { message = value; };
  const before = ipcCalls.filter((call) => call.channel === 'project:import-asset').length;
  await inspector.importSticker('image', 'D:\\assets\\too-late.png');
  assert.equal(ipcCalls.filter((call) => call.channel === 'project:import-asset').length, before);
  assert.equal(store.project.timeline.stickerClips.length, 0);
  assert.match(message, /末尾太近/);
});

test('requestEffect返回创建Promise供预览添加菜单捕获错误', () => {
  const inspector = new Inspector(createStore(), { time: 2 }, new MockElement('div'), { textContent: '' });
  const expected = Promise.resolve('created');
  inspector.timelineView = { onAddEffect: () => expected };
  assert.equal(inspector.requestEffect('mosaic'), expected);
});

test('声音面板只允许麦克风放大到 400%，系统声音仍封顶 100%', () => {
  const store = createStore();
  store.project.media.microphone = { file: 'microphone.wav', duration: 20 };
  store.project.media.systemAudio = { file: 'system.wav', duration: 20 };
  store.project.audio.microphoneVolume = 1;
  const segment = store.project.timeline.segments[0];
  store.select({ type: 'segment', id: segment.id });
  const root = new MockElement('div');
  const inspector = new Inspector(store, { sourceTime: 0 }, root, { textContent: '' });
  inspector.show('audio');

  const ranges = root.querySelectorAll('input[type="range"]');
  assert.equal(ranges.length, 4, '应显示全局与片段两组麦克风、系统音量');
  assert.equal(ranges[0].getAttribute('max'), '4', '全局麦克风滑杆上限为 400%');
  assert.equal(ranges[1].getAttribute('max'), '1', '全局系统声音滑杆上限为 100%');
  assert.equal(ranges[2].getAttribute('max'), '4', '片段麦克风滑杆上限为 400%');
  assert.equal(ranges[3].getAttribute('max'), '1', '片段系统声音滑杆上限为 100%');
});

test('摄像头形状使用可视化卡片并按主片段独立覆盖或恢复全局', () => {
  const store = createStore();
  store.project.media.camera = { file: 'camera.mp4', width: 1280, height: 720, duration: 20 };
  store.project.timeline.segments = [
    { id: 'first', sourceStart: 0, sourceEnd: 5, speed: 1 },
    { id: 'middle', sourceStart: 5, sourceEnd: 12, speed: 1 },
    { id: 'last', sourceStart: 12, sourceEnd: 20, speed: 1 },
  ];
  const root = new MockElement('div');
  const inspector = new Inspector(store, { sourceTime: 0 }, root, { textContent: '' });
  inspector.show('camera');
  assert.equal(inspector.tab, 'canvas');
  assert.equal(inspector.canvasTab, 'camera');
  assert.equal(inspector.title.textContent, '画面');
  assert.equal(root.querySelectorAll('.camera-shape-option').length, 6);
  assert.deepEqual(root.querySelectorAll('.camera-shape-option').map((button) => button.getAttribute('data-shape')),
    ['fullscreen', 'circle', 'horizontal', 'vertical', 'original', 'square']);
  assert.ok(root.querySelectorAll('.camera-shape-option').every((button) => button.getAttribute('aria-pressed') !== null));
  assert.match(root.textContent, /整段默认/);

  store.select({ type: 'segment', id: 'middle' });
  assert.match(root.textContent, /仅当前片段/);
  const fullscreen = root.querySelectorAll('.camera-shape-option').find((button) => button.textContent.includes('全屏'));
  fullscreen.click();
  assert.deepEqual(store.project.timeline.segments[1].camera, { layout: 'fullscreen', shape: 'square' });
  assert.equal(store.project.timeline.segments[0].camera, undefined);
  assert.equal(store.project.camera.layout, 'shape');
  assert.ok(findByText(root, 'button', '恢复整段默认'));
  findByText(root, 'button', '恢复整段默认').click();
  assert.equal(store.project.timeline.segments[1].camera, undefined);

  store.project.timeline.segments = [store.project.timeline.segments[1]];
  store.select({ type: 'segment', id: 'middle' });
  root.querySelectorAll('.camera-shape-option').find((button) => button.textContent.includes('圆形')).click();
  assert.equal(store.project.camera.shape, 'circle', '单片段且没有旧覆盖时修改整段默认');
  assert.equal(store.project.timeline.segments[0].camera, undefined);

  store.project.timeline.segments[0].camera = { layout: 'shape', shape: 'square' };
  store.emit('project');
  assert.match(root.textContent, /仅当前片段/);
  assert.ok(findByText(root, 'button', '恢复整段默认'));
  assert.ok(root.querySelectorAll('.field').some((field) => field.textContent.includes('全局圆角')),
    '全局圆形时仍需显示供局部方形使用的全局圆角');
});

Promise.all(pendingTests).then(() => {
  console.log('All 9 editor inspector UI tests passed.');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
