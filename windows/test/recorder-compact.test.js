'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
let handler;
let bounds = { x: 20, y: 30, width: 800, height: 680 };
const sender = {};
const win = {
  webContents: sender, isDestroyed: () => false,
  getBounds: () => ({ ...bounds }),
  setMinimumSize() {}, setResizable() {},
  setSize(width, height) { bounds = { ...bounds, width, height }; },
  setBounds(value) { bounds = value; },
};
const context = {
  recorderWindow: win, recorderExpandedBounds: null,
  ipcMain: { handle(channel, callback) { handler = callback; } },
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 900 } }) },
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf("  ipcMain.handle('recorder:set-collapsed'"), source.indexOf("  ipcMain.on('recorder:show'")), context);
handler({ sender }, { collapsed: true, height: 204 });
assert.equal(bounds.height, 204);
handler({ sender }, { collapsed: true, height: 240 });
bounds = { ...bounds, x: 100, y: 400 };
handler({ sender }, { collapsed: false });
assert.equal(bounds.height, 680, '紧凑窗口的错误提示高度不能覆盖原始展开高度');
assert.equal(bounds.x, 100, '展开时保留用户移动后的横向位置');
assert.equal(bounds.y, 220, '展开后不能越出显示器底部');
assert.equal(context.recorderExpandedBounds, null);
assert.throws(() => handler({ sender: {} }, { collapsed: true, height: 200 }), /录制窗口不可用/);
console.log('紧凑窗口测试通过：收起、重复调整高度、移动后恢复与窗口权限。');
