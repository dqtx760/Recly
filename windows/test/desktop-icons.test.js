'use strict';

const assert = require('node:assert/strict');
const { createDesktopIconsController, findDesktopIconListView } = require('../src/main/win32');

function makeShellApi(initialVisibility) {
  const state = { visible: initialVisibility, calls: [] };
  const api = {
    FindWindowW(className) { return className === 'Progman' ? 1 : 0; },
    FindWindowExW(parent, childAfter, className, windowName) {
      if (parent === 1 && className === 'SHELLDLL_DefView') return 2;
      if (parent === 2 && className === 'SysListView32' && (windowName === 'FolderView' || windowName === null)) return 3;
      return 0;
    },
    IsWindow(handle) { return handle === 3; },
    IsWindowVisible(handle) { return handle === 3 && state.visible; },
    ShowWindow(handle, command) {
      state.calls.push({ handle, command });
      if (handle === 3) state.visible = command === 5;
      return true;
    },
  };
  return { api, state };
}

let passed = 0;
function test(name, body) {
  body();
  passed += 1;
  console.log(`  ok  ${name}`);
}

test('隐藏桌面图标后显式恢复为原先可见状态', () => {
  const { api, state } = makeShellApi(true);
  const controller = createDesktopIconsController(api);
  assert.equal(controller.hide(), true);
  assert.equal(state.visible, false);
  assert.deepEqual(state.calls, [{ handle: 3, command: 0 }]);
  assert.equal(controller.hide(), true, '重复隐藏不会再次切换状态');
  assert.equal(controller.restore(), true);
  assert.equal(state.visible, true);
  assert.deepEqual(state.calls, [{ handle: 3, command: 0 }, { handle: 3, command: 5 }]);
  assert.equal(controller.restore(), false);
});

test('原先已隐藏时保持隐藏，即使录制期间状态意外改变', () => {
  const { api, state } = makeShellApi(false);
  const controller = createDesktopIconsController(api);
  assert.equal(controller.hide(), true);
  assert.deepEqual(state.calls, []);
  state.visible = true;
  assert.equal(controller.restore(), true);
  assert.equal(state.visible, false);
  assert.deepEqual(state.calls, [{ handle: 3, command: 0 }]);
});

test('在 Explorer 的 WorkerW 层级查找桌面列表视图', () => {
  const api = {
    FindWindowW: () => 1,
    FindWindowExW(parent, childAfter, className, windowName) {
      if (parent === 1 && className === 'SHELLDLL_DefView') return 0;
      if (parent === 0 && className === 'WorkerW') return childAfter ? 0 : 10;
      if (parent === 10 && className === 'SHELLDLL_DefView') return 11;
      if (parent === 11 && className === 'SysListView32' && windowName === 'FolderView') return 12;
      return 0;
    },
  };
  assert.equal(findDesktopIconListView(api), 12);
});

console.log(`全部 ${passed} 项桌面图标状态测试通过。`);
