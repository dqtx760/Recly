'use strict';
// 预览区贴图菜单、拖入/粘贴与画布变换回归。
// 运行：node windows/test/editor-overlay-interaction.test.js

const assert = require('node:assert/strict');
const Module = require('node:module');

class FakeClassList {
  constructor(node) { this.node = node; }
  toggle(name, force) {
    const values = new Set(this.node.className.split(/\s+/).filter(Boolean));
    const enabled = force === undefined ? !values.has(name) : force;
    if (enabled) values.add(name); else values.delete(name);
    this.node.className = [...values].join(' ');
    return enabled;
  }
  add(name) { this.toggle(name, true); }
  remove(name) { this.toggle(name, false); }
  contains(name) { return this.node.className.split(/\s+/).includes(name); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.classList = new FakeClassList(this);
    this.hidden = false;
    this.tabIndex = -1;
    this.textContent = '';
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  removeEventListener(type, handler) { this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== handler); }
  dispatchEvent(input) {
    const event = {
      target: this,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      stopImmediatePropagation() { this.immediatePropagationStopped = true; },
      ...input,
    };
    for (let node = this; node; node = node.parentNode) {
      for (const handler of [...(node.listeners[event.type] || [])]) handler(event);
      if (event.propagationStopped || event.immediatePropagationStopped) break;
    }
    return event;
  }
  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }
  focus() { if (global.document) global.document.activeElement = this; }
  getBoundingClientRect() { return this.rect || { left: 0, top: 0, width: 500, height: 300 }; }
  closest(selector) {
    for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node;
    return null;
  }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const data = selector.match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/);
    if (data) {
      const key = data[1].replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      return this.dataset[key] !== undefined && (data[2] === undefined || this.dataset[key] === data[2]);
    }
    return false;
  }
  querySelectorAll(selector) {
    const results = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

let clipboardHasImage = false;
const originalLoad = Module._load;
Module._load = function loadWithElectronClipboard(request, parent, isMain) {
  if (request === 'electron') return {
    ipcRenderer: { invoke: async (channel) => channel === 'clipboard:has-image' ? clipboardHasImage : undefined },
    webUtils: { getPathForFile: (file) => file.nativePath || '' },
  };
  return originalLoad.call(this, request, parent, isMain);
};
const { initOverlayInteraction, isImageFile, nativeFilePath, normalizedDegrees } = require('../src/renderer/editor/overlay-interaction');
Module._load = originalLoad;

function createHarness() {
  const documentListeners = {};
  const windowListeners = {};
  const fakeDocument = {
    activeElement: null,
    createElement: (tag) => new FakeElement(tag),
    addEventListener(type, handler) { (documentListeners[type] ||= []).push(handler); },
    removeEventListener(type, handler) { documentListeners[type] = (documentListeners[type] || []).filter((item) => item !== handler); },
  };
  const fakeWindow = {
    addEventListener(type, handler) { (windowListeners[type] ||= []).push(handler); },
    removeEventListener(type, handler) { windowListeners[type] = (windowListeners[type] || []).filter((item) => item !== handler); },
    dispatchEvent(event) { for (const handler of [...(windowListeners[event.type] || [])]) handler(event); },
  };
  let nextFrame = 0;
  const previous = {
    document: global.document,
    window: global.window,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
  };
  global.document = fakeDocument;
  global.window = fakeWindow;
  global.requestAnimationFrame = () => ++nextFrame;
  global.cancelAnimationFrame = () => {};

  const stage = new FakeElement('section');
  const ids = {};
  const add = (tag, id, parent = stage) => {
    const node = new FakeElement(tag);
    node.id = id;
    ids[id] = node;
    parent.append(node);
    return node;
  };
  stage.querySelector = (selector) => ids[selector.slice(1)] || null;
  const canvasWrap = add('div', 'canvas-wrap');
  canvasWrap.rect = { left: 0, top: 0, width: 700, height: 400 };
  const canvas = add('canvas', 'preview', canvasWrap);
  canvas.rect = { left: 100, top: 50, width: 500, height: 300 };
  const addButton = add('button', 'preview-add-button');
  const addMenu = add('div', 'preview-add-menu');
  addMenu.hidden = true;
  const mosaicButton = add('button', 'preview-add-mosaic', addMenu);
  const importButton = add('button', 'preview-add-sticker', addMenu);
  const pasteButton = add('button', 'preview-paste-image', addMenu);
  const clip = { id: 'sticker-1', position: { x: 0.5, y: 0.5 }, width: 0.2, rotationDegrees: 0, aspectRatio: 2 };
  const project = { timeline: { stickerClips: [clip] } };
  const listeners = new Set();
  const store = {
    project,
    selection: null,
    gesture: false,
    listeners,
    subscribe(listener) { listeners.add(listener); },
    select(selection) { this.selection = selection; for (const listener of listeners) listener('selection'); },
    getClip(type, id) { return type === 'sticker' ? project.timeline.stickerClips.find((item) => item.id === id) : null; },
    beginGesture() { this.gesture = true; },
    endGesture() { this.gesture = false; this.endedGestures = (this.endedGestures || 0) + 1; },
    mutate(change) { change(project); for (const listener of listeners) listener('project'); },
  };
  const preview = {
    canvas,
    playing: false,
    time: 0,
    scene: { width: 1000, height: 600, stickers: [{ id: clip.id, centerX: 500, centerY: 300, width: 200, height: 100, rotation: 0, layerIndex: 0 }] },
    pause() { this.playing = false; this.paused = true; },
  };
  const calls = [];
  const dispose = initOverlayInteraction({
    store,
    preview,
    stage,
    canvasWrap,
    onAddMosaic: () => calls.push('mosaic'),
    onImportImage: (path) => calls.push(['image', path]),
    onPasteImage: () => calls.push('paste'),
    onPasteSelected: () => calls.push('effect-paste'),
    onShowOverlayInspector: (kind) => calls.push(['inspector', kind]),
  });
  return {
    document: fakeDocument, window: fakeWindow, previous, stage, canvasWrap, canvas,
    addButton, addMenu, mosaicButton, importButton, pasteButton, clip, store, preview, calls, dispose,
    restore() {
      dispose();
      global.document = previous.document;
      global.window = previous.window;
      global.requestAnimationFrame = previous.requestAnimationFrame;
      global.cancelAnimationFrame = previous.cancelAnimationFrame;
    },
  };
}

const test = (name, body) => {
  const result = body();
  if (result && typeof result.then === 'function') return result.then(() => console.log(`  ok  ${name}`));
  console.log(`  ok  ${name}`);
  return Promise.resolve();
};

console.log('Testing preview overlay interaction...');

test('图片格式识别与旋转角度吸附', () => {
  assert.equal(isImageFile({ name: 'screen.PNG', type: '' }), true);
  assert.equal(isImageFile({ name: 'movie.mp4', type: 'video/mp4' }), false);
  assert.equal(nativeFilePath({ name: 'screen.png', nativePath: 'D:\\screen.png' }), 'D:\\screen.png');
  assert.equal(normalizedDegrees(91), 90);
  assert.equal(normalizedDegrees(46), 46);
});

test('画布拖动、缩放、旋转共用贴图模型字段并合并手势', () => {
  const h = createHarness();
  try {
    const box = h.canvasWrap.querySelector('.overlay-transform');
    assert.ok(box);
    box.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 1, clientX: 350, clientY: 200 });
    h.window.dispatchEvent({ type: 'pointermove', pointerId: 1, clientX: 400, clientY: 230 });
    assert.equal(h.clip.position.x, 0.6);
    assert.equal(h.clip.position.y, 0.6);
    h.window.dispatchEvent({ type: 'pointerup', pointerId: 1 });

    const resize = box.querySelector('[data-overlay-action="resize-se"]');
    resize.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 2, clientX: 400, clientY: 225 });
    h.window.dispatchEvent({ type: 'pointermove', pointerId: 2, clientX: 430, clientY: 245 });
    h.window.dispatchEvent({ type: 'pointerup', pointerId: 2 });
    assert.ok(h.clip.width > 0.2);

    const rotate = box.querySelector('[data-overlay-action="rotate"]');
    rotate.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 3, clientX: 350, clientY: 155 });
    h.window.dispatchEvent({ type: 'pointermove', pointerId: 3, clientX: 395, clientY: 200 });
    h.window.dispatchEvent({ type: 'pointerup', pointerId: 3 });
    assert.equal(h.clip.rotationDegrees, 90);
    assert.equal(h.store.endedGestures, 3);
    assert.ok(h.calls.some((call) => Array.isArray(call) && call[0] === 'inspector'));
  } finally { h.restore(); }
});

const clipboardTest = test('添加菜单、拖入文件与原生图片 CtrlV 走独立入口', async () => {
  const h = createHarness();
  try {
    h.addButton.dispatchEvent({ type: 'click' });
    assert.equal(h.addMenu.hidden, false);
    h.mosaicButton.dispatchEvent({ type: 'click' });
    assert.equal(h.calls[0], 'mosaic');
    assert.equal(h.addMenu.hidden, true);

    h.canvasWrap.dispatchEvent({
      type: 'drop',
      dataTransfer: { files: [{ name: 'capture.png', type: 'image/png', path: 'D:\\capture.png' }] },
    });
    assert.deepEqual(h.calls.find((call) => Array.isArray(call) && call[0] === 'image'), ['image', 'D:\\capture.png']);

    h.canvas.focus();
    clipboardHasImage = false;
    let event = { type: 'keydown', key: 'v', ctrlKey: true, target: h.canvas, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
    h.window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    await Promise.resolve();
    assert.equal(h.calls.at(-1), 'effect-paste');
    clipboardHasImage = true;
    const input = new FakeElement('input');
    event = { type: 'keydown', key: 'v', ctrlKey: true, target: input, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
    h.window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, undefined);
    assert.notEqual(h.calls.at(-1), 'paste');
    event = { type: 'keydown', key: 'v', ctrlKey: true, target: h.canvas, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
    h.window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    await Promise.resolve();
    assert.equal(h.calls.at(-1), 'paste');
  } finally {
    clipboardHasImage = false;
    h.restore();
  }
});

clipboardTest.then(() => console.log('All 3 preview overlay interaction tests passed.')).catch((error) => { console.error(error); process.exitCode = 1; });
