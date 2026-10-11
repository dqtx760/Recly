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
  if (request === '../common' && parentPath?.endsWith('renderer\\editor\\inspector.js')) {
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

test('画面设置切换背景、布局、样机页签并保留各自滚动位置', () => {
  const store = createStore();
  const root = new MockElement('div');
  const inspector = new Inspector(store, { sourceTime: 0 }, root, { textContent: '' });
  inspector.show('canvas');
  assert.equal(root.querySelector('[data-frame-tab="background"]').getAttribute('aria-selected'), 'true');
  assert.ok(findByText(root, '.section', '背景'));
  assert.equal(root.querySelectorAll('.mockup-option').length, 0);

  root.scrollTop = 84;
  root.querySelector('[data-frame-tab="layout"]').click();
  assert.equal(inspector.canvasTab, 'layout');
  assert.equal(root.scrollTop, 0);
  assert.ok(findByText(root, '.section', '位置与大小'));
  assert.equal(root.querySelectorAll('.mockup-option').length, 0);

  root.scrollTop = 28;
  root.querySelector('[data-frame-tab="mockup"]').click();
  assert.equal(root.querySelectorAll('.mockup-option').length, 6);
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
  root.querySelector('[data-frame-tab="mockup"]').click();
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

test('屏幕 3D 面板支持锚点坐标、目标大小、2D 倾斜与模式切换', () => {
  const store = createStore();
  const clip = {
    id: 'screen-motion-ui',
    target: { position: { x: 0.3, y: 0.7 }, scale: 1.4, rotationX: 4, rotationY: -8, rotationZ: 2, perspective: 0.65 },
    timing: { startTime: 1, duration: 3, leadInDuration: 0.5, returnDuration: 0.6, easing: 'cubic' },
  };
  store.project.timeline.screenMotionClips.push(clip);
  store.select({ type: 'screen', id: clip.id });
  const root = new MockElement('div');
  const inspector = new Inspector(store, { sourceTime: 0 }, root, { textContent: '' });
  inspector.show('motion');

  assert.ok(root.querySelector('.tilt-pad'));
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

Promise.all(pendingTests).then(() => {
  console.log('All 7 editor inspector UI tests passed.');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
