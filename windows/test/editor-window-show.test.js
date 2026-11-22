'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class MockWindow extends EventEmitter {
  constructor() {
    super();
    this.showCalls = 0;
    this.hideCalls = 0;
    this.focusCalls = 0;
    this.showInactiveCalls = 0;
    this.minimizeCalls = 0;
    this.visible = true;
    this.minimized = false;
    this.skipTaskbar = false;
    this.webContents = new EventEmitter();
    this.webContents.id = 7;
    this.webContents.isLoading = () => true;
  }
  isDestroyed() { return false; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  showInactive() { this.showInactiveCalls += 1; this.visible = true; this.emit('show'); }
  minimize() { this.minimized = true; this.minimizeCalls += 1; }
  getBounds() { return { x: 400, y: 160, width: 1400, height: 780 }; }
  show() {
    this.showCalls += 1;
    if (this.visible) return;
    this.visible = true;
    this.emit('show');
  }
  hide() { this.hideCalls += 1; this.visible = false; }
  focus() { this.focusCalls += 1; }
  setSkipTaskbar(skip) { this.skipTaskbar = skip; }
  setIgnoreMouseEvents() {}
}

const mainPath = path.join(__dirname, '../src/main/main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const taskbarStart = mainSource.indexOf('function ensureRecorderTaskbarPresence(');
const start = mainSource.indexOf('function openEditor(');
const end = mainSource.indexOf('\nfunction getEditorWindow(', start);
const showRecorderStart = mainSource.indexOf('function showRecorder(');
const showRecorderEnd = mainSource.indexOf('\nfunction showLibrary(', showRecorderStart);
assert.ok(start >= 0 && end > start, '定位真实 openEditor 函数');

const directory = path.join('D:\\fixture-root', 'fixture.dogscproject');
const editorWindows = new Map();
const win = new MockWindow();
const recorderWindow = new MockWindow();
let createWindowCall;
const context = {
  recorderWindow: null,
  editorWindows,
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 100, y: 50, width: 2000, height: 1000 } }),
    getDisplayMatching: () => ({ workArea: { x: 100, y: 50, width: 2000, height: 1000 } }),
  },
  path,
  PROJECT_EXTENSION: '.dogscproject',
  assistantService: null,
  activeExportSession: null,
  activeExport: null,
  agentService: null,
  memoWindow: null,
  updateRecorderTaskbarIcon() {},
  excludeFromCapture() {},
  createWindow(...args) {
    if (args[0] === 'recorder.html') return recorderWindow;
    createWindowCall = args;
    return win;
  },
};

vm.runInNewContext(mainSource.slice(showRecorderStart, showRecorderEnd), context, { filename: mainPath });
assert.equal(context.showRecorder(), recorderWindow);
const taskbarSource = mainSource.slice(taskbarStart, start);
vm.runInNewContext(`${taskbarSource}\nglobalThis.__ensureRecorderTaskbarPresence = ensureRecorderTaskbarPresence;`, context, { filename: mainPath });
recorderWindow.visible = false;
assert.equal(context.__ensureRecorderTaskbarPresence(), true, '托盘隐藏状态应恢复任务栏入口');
assert.equal(recorderWindow.showInactiveCalls, 1, '恢复任务栏入口不能抢焦点');
assert.equal(recorderWindow.minimizeCalls, 1, '恢复后最小化，避免整理界面弹到前台');
assert.equal(recorderWindow.focusCalls, 0, '整理阶段不能抢焦点');
assert.equal(context.__ensureRecorderTaskbarPresence(), false, '已最小化时不重复改变窗口状态');
recorderWindow.visible = true;
recorderWindow.minimized = false;

vm.runInNewContext(`${mainSource.slice(start, end)}\nglobalThis.__openEditor = openEditor;`, context, { filename: mainPath });
assert.equal(context.__openEditor(directory), win);

assert.deepEqual(createWindowCall[0], 'editor.html');
assert.deepEqual(JSON.parse(JSON.stringify(createWindowCall[1])), {
  width: 1400,
  height: 780,
  x: 400,
  y: 160,
  minWidth: 960,
  minHeight: 540,
  frame: false,
  title: 'fixture — Recly',
});
assert.deepEqual(JSON.parse(JSON.stringify(createWindowCall[2])), { project: directory });
assert.equal(editorWindows.get(directory), win);
assert.equal(recorderWindow.hideCalls, 0, '编辑器加载完成前保留录制器任务栏按钮');
assert.equal(recorderWindow.skipTaskbar, false);
assert.equal(win.showCalls, 0, '首次创建后先等待 renderer 加载');
assert.equal(win.webContents.listenerCount('did-finish-load'), 1, '首次显示绑定到 did-finish-load');
assert.equal(win.listenerCount('ready-to-show'), 0, '不再依赖 ready-to-show');

win.emit('ready-to-show');
assert.equal(win.showCalls, 0, 'ready-to-show 不能替代页面加载完成事件');
win.webContents.emit('did-finish-load');
assert.equal(win.showCalls, 1, '页面加载完成后显示窗口');
assert.equal(recorderWindow.hideCalls, 1, '编辑器显示后才隐藏录制器');
assert.equal(recorderWindow.skipTaskbar, true, '编辑器显示后应移除主控台的任务栏预览');
win.webContents.emit('did-finish-load');
assert.equal(win.showCalls, 1, '首次显示回调只执行一次');

assert.equal(context.showRecorder(), recorderWindow);
assert.equal(recorderWindow.skipTaskbar, false, '主动重新打开主控台应恢复任务栏入口');
assert.equal(context.__openEditor(directory), win);
assert.equal(recorderWindow.skipTaskbar, true, '切回已打开的编辑器也应移除主控台预览');
win.emit('closed');
assert.equal(recorderWindow.skipTaskbar, false, '关闭最后一个编辑器后应恢复主控台的任务栏入口');

console.log('Editor window show test passed: did-finish-load displays the initial window and preserves centered 70% width, 78% height bounds.');
