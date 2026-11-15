'use strict';

const assert = require('node:assert/strict');
const { createHistorySelection } = require('../src/renderer/history-selection');

class MockElement {
  constructor(className = '') {
    this.className = className;
    this.classList = {
      values: new Set(className.split(/\s+/).filter(Boolean)),
      add: (name) => this.classList.values.add(name),
      remove: (name) => this.classList.values.delete(name),
      toggle: (name, force) => {
        if (force) this.classList.values.add(name);
        else this.classList.values.delete(name);
        return this.classList.values.has(name);
      },
      contains: (name) => this.classList.values.has(name),
    };
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.style = {};
    this.parentElement = null;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.rect = { left: 0, top: 0, right: 100, bottom: 60, width: 100, height: 60 };
  }
  append(child) { child.parentElement = this; this.children.push(child); }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  addEventListener(type, handler, capture = false) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ handler, capture });
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item.handler !== handler));
  }
  dispatch(type, event = {}) {
    const normalized = {
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...event,
    };
    for (const { handler } of this.listeners.get(type) || []) handler(normalized);
    return normalized;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] || ''; }
  closest(selector) {
    if (selector === '.history-item') {
      for (let current = this; current; current = current.parentElement) {
        if (current.classList.contains('history-item')) return current;
      }
    }
    return null;
  }
  contains(target) {
    for (let current = target; current; current = current.parentElement) if (current === this) return true;
    return false;
  }
  querySelectorAll(selector) {
    return selector === '.history-item' ? this.children.filter((child) => child.classList.contains('history-item')) : [];
  }
  getBoundingClientRect() { return this.rect; }
}

function makeHarness(count) {
  const frames = new Map();
  let nextFrame = 1;
  const document = new MockElement();
  document.body = new MockElement();
  document.createElement = (className) => new MockElement(className);
  document.defaultView = {
    getComputedStyle: () => ({ overflowY: 'auto' }),
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const list = new MockElement();
  list.ownerDocument = document;
  list.clientHeight = 60;
  list.scrollHeight = count * 20;
  list.rect = { left: 0, top: 0, right: 100, bottom: 60, width: 100, height: 60 };
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const row = new MockElement('history-item');
    row.dataset.projectDirectory = `project-${index}`;
    row.ownerDocument = document;
    row.rect = { left: 0, right: 100, width: 100 };
    row.getBoundingClientRect = () => ({
      left: 0,
      right: 100,
      width: 100,
      top: index * 20 - list.scrollTop,
      bottom: (index + 1) * 20 - list.scrollTop,
      height: 20,
    });
    list.append(row);
    rows.push(row);
  }
  document.scrollingElement = list;
  const runFrame = () => {
    const first = frames.entries().next().value;
    if (!first) return false;
    frames.delete(first[0]);
    first[1]();
    return true;
  };
  return { document, list, rows, runFrame };
}

function pointerEvent(target, clientX, clientY, extras = {}) {
  return { target, button: 0, clientX, clientY, pointerId: 1, ...extras };
}

let passed = 0;
function test(name, body) {
  body();
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log('Testing recording history selection...');

test('Shift range、Ctrl+A 和 Escape 遵循常规多选行为', () => {
  const { document, list, rows } = makeHarness(4);
  const selection = createHistorySelection(list, { document });
  list.dispatch('click', { target: rows[0] });
  list.dispatch('click', { target: rows[2], shiftKey: true });
  assert.deepEqual(selection.getSelectedDirectories(), ['project-0', 'project-1', 'project-2']);
  document.dispatch('keydown', { target: document.body, key: 'a', ctrlKey: true });
  assert.deepEqual(selection.getSelectedDirectories(), ['project-0', 'project-1', 'project-2', 'project-3']);
  document.dispatch('keydown', { target: document.body, key: 'Escape' });
  assert.deepEqual(selection.getSelectedDirectories(), []);
  selection.destroy();
});

test('拖动框选后紧接的 click 不会清掉已选工程', () => {
  const { document, list, rows } = makeHarness(3);
  const selection = createHistorySelection(list, { document });
  list.dispatch('pointerdown', pointerEvent(rows[0], 5, 5));
  document.dispatch('pointermove', pointerEvent(rows[2], 70, 55));
  document.dispatch('pointerup', pointerEvent(rows[2], 70, 55));
  assert.deepEqual(selection.getSelectedDirectories(), ['project-0', 'project-1', 'project-2']);
  const click = list.dispatch('click', { target: rows[2] });
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(selection.getSelectedDirectories(), ['project-0', 'project-1', 'project-2']);
  selection.destroy();
});

test('拖动到滚动边缘时自动滚动并纳入列表下方工程', () => {
  const { document, list, rows, runFrame } = makeHarness(5);
  const selection = createHistorySelection(list, { document });
  list.dispatch('pointerdown', pointerEvent(rows[0], 5, 5));
  document.dispatch('pointermove', pointerEvent(rows[1], 70, 59));
  assert.equal(runFrame(), true);
  assert.ok(list.scrollTop > 0);
  assert.ok(selection.getSelectedDirectories().includes('project-2'));
  document.dispatch('pointerup', pointerEvent(rows[1], 70, 59));
  selection.destroy();
});

console.log(`全部 ${passed} 项历史选择测试通过！`);
