'use strict';
// 任务栏自动隐藏模块单元测试：状态机、恢复逻辑、IPC 注册、安全退出钩子与非 Windows / 降级安全处理。
// 运行：node test/taskbar.test.js

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const taskbar = require('../src/main/taskbar');

const {
  ABM_GETSTATE,
  ABM_SETSTATE,
  ABS_AUTOHIDE,
  ABS_ALWAYSONTOP,
  SW_HIDE,
  SW_SHOW,
  autoHideTaskbar,
  restoreTaskbar,
  setupTaskbarSafetyHooks,
  registerTaskbarIpc,
  getSavedTaskbarState,
  isTaskbarAutoHideActive,
  _setNativeBridge,
  _resetState,
} = taskbar;
let passed = 0;
const test = (name, body) => {
  return Promise.resolve(body()).then(() => {
    passed += 1;
    console.log(`  ok  ${name}`);
  });
};

function createMockBridge(initialState = 0) {
  let currentState = initialState;
  const calls = [];
  const showWindowCalls = [];

  return {
    cbSize: 48,
    findTrayHwnd: () => 12345,
    findSecondaryTrayHwnd: () => 67890,
    showWindow: (hwnd, nCmdShow) => {
      showWindowCalls.push({ hwnd, nCmdShow });
      return true;
    },
    getShowWindowCalls: () => showWindowCalls,
    getState: () => currentState,
    getCalls: () => calls,
    shAppBarMessage: (msg, data) => {
      calls.push({ msg, data: { ...data } });
      if (msg === ABM_GETSTATE) {
        return currentState;
      }
      if (msg === ABM_SETSTATE) {
        currentState = data.lParam;
        return 1;
      }
      return 0;
    },
  };
}

(async () => {
  console.log('Testing Taskbar Auto-Hide & Restore...');

  await test('模块导出符合规范', () => {
    assert.equal(typeof autoHideTaskbar, 'function');
    assert.equal(typeof restoreTaskbar, 'function');
    assert.equal(typeof setupTaskbarSafetyHooks, 'function');
    assert.equal(typeof registerTaskbarIpc, 'function');
    assert.equal(ABM_GETSTATE, 4);
    assert.equal(ABM_SETSTATE, 10);
    assert.equal(ABS_AUTOHIDE, 1);
    assert.equal(ABS_ALWAYSONTOP, 2);
    assert.equal(SW_HIDE, 0);
    assert.equal(SW_SHOW, 5);
  });

  await test('状态机：首次 autoHideTaskbar 记录原状态并应用 ABS_AUTOHIDE', () => {
    _resetState();
    const mock = createMockBridge(0); // 初始状态为 0（非自动隐藏）
    _setNativeBridge(mock);

    assert.equal(getSavedTaskbarState(), null);
    assert.equal(isTaskbarAutoHideActive(), false);

    const success = autoHideTaskbar();
    assert.equal(success, true);
    assert.equal(getSavedTaskbarState(), 0);
    assert.equal(isTaskbarAutoHideActive(), true);
    assert.equal(mock.getState(), ABS_AUTOHIDE);

    const calls = mock.getCalls();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].msg, ABM_GETSTATE);
    assert.equal(calls[1].msg, ABM_SETSTATE);
    assert.equal(calls[1].data.lParam, ABS_AUTOHIDE);
  });

  await test('状态机：多次连续调用 autoHideTaskbar 不会覆盖最初保存的状态', () => {
    _resetState();
    const mock = createMockBridge(ABS_ALWAYSONTOP);
    _setNativeBridge(mock);

    assert.equal(autoHideTaskbar(), true);
    assert.equal(getSavedTaskbarState(), ABS_ALWAYSONTOP);
    assert.equal(mock.getState(), ABS_AUTOHIDE);

    // 再次调用，此时系统返回状态已经是 ABS_AUTOHIDE
    assert.equal(autoHideTaskbar(), true);
    // 保存的原状态依然是 ABS_ALWAYSONTOP，而不是被覆盖为 ABS_AUTOHIDE
    assert.equal(getSavedTaskbarState(), ABS_ALWAYSONTOP);
  });

  await test('恢复逻辑：restoreTaskbar 正确还原先前保存的状态', () => {
    _resetState();
    const mock = createMockBridge(0);
    _setNativeBridge(mock);

    autoHideTaskbar();
    assert.equal(mock.getState(), ABS_AUTOHIDE);

    const success = restoreTaskbar();
    assert.equal(success, true);
    assert.equal(mock.getState(), 0);
    assert.equal(getSavedTaskbarState(), null);
    assert.equal(isTaskbarAutoHideActive(), false);

    const calls = mock.getCalls();
    const lastCall = calls[calls.length - 1];
    assert.equal(lastCall.msg, ABM_SETSTATE);
    assert.equal(lastCall.data.lParam, 0);
  });
  await test('物理任务栏隐藏与恢复：调用 ShowWindow SW_HIDE 与 SW_SHOW', () => {
    _resetState();
    const mock = createMockBridge(0);
    _setNativeBridge(mock);

    autoHideTaskbar();
    const hideCalls = mock.getShowWindowCalls();
    assert.equal(hideCalls.length, 2);
    assert.deepEqual(hideCalls[0], { hwnd: 12345, nCmdShow: SW_HIDE });
    assert.deepEqual(hideCalls[1], { hwnd: 67890, nCmdShow: SW_HIDE });

    restoreTaskbar();
    const allCalls = mock.getShowWindowCalls();
    assert.equal(allCalls.length, 4);
    assert.deepEqual(allCalls[2], { hwnd: 12345, nCmdShow: SW_SHOW });
    assert.deepEqual(allCalls[3], { hwnd: 67890, nCmdShow: SW_SHOW });
  });


  await test('恢复逻辑：若无保存状态，restoreTaskbar 兜底还原为 ABS_ALWAYSONTOP', () => {
    _resetState();
    const mock = createMockBridge(ABS_AUTOHIDE);
    _setNativeBridge(mock);

    assert.equal(getSavedTaskbarState(), null);
    const success = restoreTaskbar();
    assert.equal(success, true);
    // 兜底还原为 ABS_ALWAYSONTOP
    assert.equal(mock.getState(), ABS_ALWAYSONTOP);
    assert.equal(getSavedTaskbarState(), null);
    assert.equal(isTaskbarAutoHideActive(), false);
  });

  await test('用户原设恢复：若录制前用户本身已开启自动隐藏，录制后原样保留', () => {
    _resetState();
    const mock = createMockBridge(ABS_AUTOHIDE);
    _setNativeBridge(mock);

    autoHideTaskbar();
    assert.equal(getSavedTaskbarState(), ABS_AUTOHIDE);

    restoreTaskbar();
    assert.equal(mock.getState(), ABS_AUTOHIDE);
  });

  await test('优雅降级：Native Bridge 不可用时安全返回 false，不抛出异常', () => {
    _resetState();
    _setNativeBridge(null);

    assert.equal(autoHideTaskbar(), false);
    assert.equal(restoreTaskbar(), false);
    assert.equal(getSavedTaskbarState(), null);
    assert.equal(isTaskbarAutoHideActive(), false);
  });

  await test('异常安全：底层 SHAppBarMessage 抛出错误时捕获并降级', () => {
    _resetState();
    const throwingBridge = {
      cbSize: 48,
      findTrayHwnd: () => 0,
      shAppBarMessage: () => {
        throw new Error('RPC failure or invalid window handle');
      },
    };
    _setNativeBridge(throwingBridge);

    assert.equal(autoHideTaskbar(), false);
    assert.equal(restoreTaskbar(), false);
  });

  await test('IPC 注册：注册 taskbar:auto-hide 与 taskbar:restore 句柄', async () => {
    _resetState();
    const mock = createMockBridge(0);
    _setNativeBridge(mock);

    const handlers = {};
    const mockIpc = {
      handle: (channel, handler) => {
        handlers[channel] = handler;
      },
    };

    registerTaskbarIpc(mockIpc);
    assert.equal(typeof handlers['taskbar:auto-hide'], 'function');
    assert.equal(typeof handlers['taskbar:restore'], 'function');

    const hideResult = await handlers['taskbar:auto-hide']();
    assert.equal(hideResult, true);
    assert.equal(mock.getState(), ABS_AUTOHIDE);

    const restoreResult = await handlers['taskbar:restore']();
    assert.equal(restoreResult, true);
    assert.equal(mock.getState(), 0);
  });

  await test('安全钩子：app.on 及 process 信号正确注册并在退出时恢复任务栏', () => {
    _resetState();
    const mock = createMockBridge(0);
    _setNativeBridge(mock);
    autoHideTaskbar();
    assert.equal(mock.getState(), ABS_AUTOHIDE);

    const mockApp = new EventEmitter();
    const mockProcess = new EventEmitter();
    mockProcess.exit = () => {};
    mockProcess.listenerCount = () => 1;

    setupTaskbarSafetyHooks(mockApp, mockProcess);

    // 触发 app before-quit
    mockApp.emit('before-quit');
    assert.equal(mock.getState(), 0);

    // 重新隐藏
    autoHideTaskbar();
    assert.equal(mock.getState(), ABS_AUTOHIDE);

    // 触发 process SIGINT
    mockProcess.emit('SIGINT');
    assert.equal(mock.getState(), 0);

    // 重新隐藏
    autoHideTaskbar();
    assert.equal(mock.getState(), ABS_AUTOHIDE);

    // 触发 uncaughtException
    mockProcess.emit('uncaughtException', new Error('Simulated crash'));
    assert.equal(mock.getState(), 0);
  });

  // 如果是在 Windows 环境下，测试实际 Native 调用的可执行性（不残留修改）
  if (process.platform === 'win32') {
    await test('Windows 原生环境：SHAppBarMessage 原生调用及状态恢复自洽', () => {
      _resetState();
      _setNativeBridge(null); // 清除 mock，让它懒加载真实 koffi + shell32

      const originalSaved = getSavedTaskbarState();
      assert.equal(originalSaved, null);

      const hideSuccess = autoHideTaskbar();
      if (hideSuccess) {
        // 成功调用了原生 API，验证能够成功恢复
        const saved = getSavedTaskbarState();
        assert.ok(saved !== null);

        const restoreSuccess = restoreTaskbar();
        assert.equal(restoreSuccess, true);
        assert.equal(getSavedTaskbarState(), null);
      }
    });
  }

  console.log(`\nAll ${passed} taskbar tests passed!`);
})();
