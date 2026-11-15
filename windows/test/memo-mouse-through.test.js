'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const memoSource = fs.readFileSync(path.join(__dirname, '../src/renderer/memo.html'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = mainSource.indexOf(startMarker);
  const end = mainSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `main.js 必须包含 ${startMarker}`);
  return mainSource.slice(start, end);
}

const memoWindowCreation = sourceBetween('function toggleMemo()', '\nfunction closeRecordingOverlays()');
assert.match(memoWindowCreation, /setInterval\(syncMemoMouseThrough,\s*16\)/,
  '提词器应以短间隔按光标位置更新标题栏命中区域');
assert.match(mainSource, /screen\.getCursorScreenPoint\(\)/, '窗口命中区应由主进程读取真实全局鼠标位置');
assert.match(mainSource, /setIgnoreMouseEvents\(ignore,\s*\{\s*forward:\s*true\s*\}\)/,
  '正文穿透必须调用 Electron 原生窗口鼠标忽略 API');
assert.match(mainSource, /if\s*\(memoMouseEventsIgnored\s*===\s*ignore\)\s*return/, '鼠标状态不变时不得重复调用原生 API');
assert.match(memoWindowCreation, /initialMemoEditing\s*=\s*typeof savedMemo\.text !== 'string' \|\| !savedMemo\.text\.trim\(\)/,
  '空白新文稿默认编辑，已有台词默认阅读穿透');

const syncFunction = sourceBetween('function syncMemoMouseThrough()', '\nfunction closeRecordingOverlays()');
let cursor = { x: 120, y: 150 };
const nativeCalls = [];
const mouseContext = {
  memoWindow: {
    isDestroyed: () => false,
    getBounds: () => ({ x: 100, y: 100, width: 560, height: 360 }),
    setIgnoreMouseEvents(...args) { nativeCalls.push(args); },
  },
  memoEditing: false,
  memoMouseEventsIgnored: false,
  screen: { getCursorScreenPoint: () => cursor },
  MEMO_HEADER_EDGE_GUTTER: 12,
  MEMO_HEADER_TOP: 6,
  MEMO_HEADER_HEIGHT: 38,
};
vm.runInNewContext(syncFunction, mouseContext);
mouseContext.syncMemoMouseThrough();
mouseContext.syncMemoMouseThrough();
assert.deepEqual(JSON.parse(JSON.stringify(nativeCalls)), [[true, { forward: true }]],
  '正文点位应穿透整个原生窗口，重复轮询不重复切换');
cursor = { x: 140, y: 120 };
mouseContext.syncMemoMouseThrough();
assert.equal(mouseContext.memoMouseEventsIgnored, false, '标题栏区域应恢复交互');
cursor = { x: 104, y: 120 };
mouseContext.syncMemoMouseThrough();
assert.equal(mouseContext.memoMouseEventsIgnored, true, '窗口边缘应继续穿透');
cursor = { x: 120, y: 150 };
mouseContext.memoEditing = true;
mouseContext.syncMemoMouseThrough();
assert.equal(mouseContext.memoMouseEventsIgnored, false, '编辑态的正文应恢复交互');

const editingHandler = sourceBetween("ipcMain.on('memo:editing'", "\n  ipcMain.");
let handler;
const syncCalls = [];
const currentMemo = {
  webContents: { id: 10 },
  isDestroyed: () => false,
};
const handlerContext = {
  ipcMain: {
    on(channel, callback) {
      assert.equal(channel, 'memo:editing');
      handler = callback;
    },
  },
  memoWindow: currentMemo,
  memoEditing: false,
  syncMemoMouseThrough() { syncCalls.push(true); },
};
vm.runInNewContext(editingHandler, handlerContext);
assert.equal(typeof handler, 'function', '主进程应注册编辑状态 IPC');
handler({ sender: { id: 20 } }, true);
assert.equal(syncCalls.length, 0, '其他窗口不得改变提词器命中状态');
handler({ sender: currentMemo.webContents }, true);
assert.equal(syncCalls.length, 1, '编辑态变化后应立即同步命中状态');
assert.equal(handlerContext.memoEditing, true, '主进程应保存提词器当前编辑态');

assert.match(memoSource, /id=["']toggle-edit["']/, '标题栏应有进入/退出编辑态的入口');
assert.match(memoSource, /textEl\.readOnly\s*=\s*!isEditing/, '阅读态只读，编辑态可输入');
assert.match(memoSource, /ipcRenderer\.send\('memo:editing'/, '渲染层应将编辑态同步给主进程');
assert.match(memoSource, /阅读态：正文鼠标穿透，点击进入编辑/, '阅读态应明确说明正文穿透');
assert.match(memoSource, /完成编辑，正文恢复鼠标穿透/, '编辑态应明确说明完成后恢复穿透');
assert.match(memoSource, /-webkit-app-region:\s*drag/, '标题栏继续使用 Electron 原生拖动区域');
assert.match(memoSource, /memo\.text\.trim\(\)/, '空白新文稿默认可编辑，已有文稿默认阅读态');

console.log('Memo native mouse-through tests passed.');
