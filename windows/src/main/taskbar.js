'use strict';
// Windows 任务栏自动隐藏与恢复管理。
// 使用 shell32.dll 中的 SHAppBarMessage 在录制期间自动隐藏任务栏，
// 录制结束或应用异常退出时恢复原状，避免任务栏遮挡或影响全屏录制。

const ABM_GETSTATE = 4;
const ABM_SETSTATE = 10;
const ABS_AUTOHIDE = 1;
const ABS_ALWAYSONTOP = 2;

const SW_HIDE = 0;
const SW_SHOW = 5;
let nativeBridge = null;
let nativeInitialized = false;

// 记忆录制前的任务栏状态，以便录制结束时无损还原
let savedTaskbarState = null;
let isAutoHideApplied = false;
let safetyHooksRegistered = false;

/**
 * 初始化或获取 native 桥接对象（koffi + shell32 / user32）
 * 在非 Windows 平台或无法加载 koffi 时返回 null 并优雅降级。
 */
function getNativeBridge() {
  if (nativeBridge !== null) {
    return nativeBridge;
  }
  if (nativeInitialized) {
    return null;
  }
  nativeInitialized = true;

  if (process.platform !== 'win32') {
    return null;
  }

  try {
    const koffi = require('koffi');

    let rectType = null;
    try {
      rectType = koffi.type('RECT');
    } catch {}
    if (!rectType) {
      rectType = koffi.struct('RECT', {
        left: 'long',
        top: 'long',
        right: 'long',
        bottom: 'long',
      });
    }

    let appbarDataType = null;
    try {
      appbarDataType = koffi.type('APPBARDATA');
    } catch {}
    if (!appbarDataType) {
      appbarDataType = koffi.struct('APPBARDATA', {
        cbSize: 'uint32_t',
        hWnd: 'uintptr_t',
        uCallbackMessage: 'uint32_t',
        uEdge: 'uint32_t',
        rc: rectType,
        lParam: 'intptr_t',
      });
    }

    const cbSize = koffi.sizeof(appbarDataType);
    const shell32 = koffi.load('shell32.dll');
    const shAppBarMessage = shell32.func('uintptr_t __stdcall SHAppBarMessage(uint32_t dwMessage, APPBARDATA *pData)');

    let findWindow = null;
    let showWindow = null;
    try {
      const user32 = koffi.load('user32.dll');
      findWindow = user32.func('uintptr_t __stdcall FindWindowA(const char *lpClassName, const char *lpWindowName)');
      showWindow = user32.func('bool __stdcall ShowWindow(uintptr_t hWnd, int nCmdShow)');
    } catch {
      findWindow = null;
      showWindow = null;
    }

    nativeBridge = {
      appbarDataType,
      cbSize,
      findTrayHwnd: () => {
        if (!findWindow) return 0;
        try {
          return findWindow('Shell_TrayWnd', null) || 0;
        } catch {
          return 0;
        }
      },
      findSecondaryTrayHwnd: () => {
        if (!findWindow) return 0;
        try {
          return findWindow('Shell_SecondaryTrayWnd', null) || 0;
        } catch {
          return 0;
        }
      },
      showWindow: (hwnd, nCmdShow) => {
        if (!showWindow || !hwnd) return false;
        try {
          return Boolean(showWindow(hwnd, nCmdShow));
        } catch {
          return false;
        }
      },
      shAppBarMessage: (msg, data) => shAppBarMessage(msg, data),
    };
    return nativeBridge;
  } catch (err) {
    // koffi 或 shell32 加载失败时降级
    return null;
  }
}

/**
 * 录制开始时调用：查询当前任务栏状态并保存，然后设置任务栏为自动隐藏 (ABS_AUTOHIDE)
 * @returns {boolean} 操作是否成功
 */
function autoHideTaskbar() {
  const bridge = getNativeBridge();
  if (!bridge) {
    return false;
  }

  try {
    const trayHwnd = typeof bridge.findTrayHwnd === 'function' ? bridge.findTrayHwnd() : 0;
    const secondaryTrayHwnd = typeof bridge.findSecondaryTrayHwnd === 'function' ? bridge.findSecondaryTrayHwnd() : 0;

    const data = {
      cbSize: bridge.cbSize,
      hWnd: trayHwnd,
      uCallbackMessage: 0,
      uEdge: 0,
      rc: { left: 0, top: 0, right: 0, bottom: 0 },
      lParam: 0,
    };

    // 查询当前任务栏状态并保存
    const currentState = Number(bridge.shAppBarMessage(ABM_GETSTATE, data));

    // 仅在尚未保存原状态时记录，防止多次连续调用导致覆盖原设置
    if (savedTaskbarState === null) {
      savedTaskbarState = currentState;
    }

    // 设置 ABS_AUTOHIDE
    data.lParam = ABS_AUTOHIDE;
    bridge.shAppBarMessage(ABM_SETSTATE, data);

    // 物理隐藏主屏幕任务栏与副屏幕任务栏 (ShowWindow SW_HIDE)
    if (typeof bridge.showWindow === 'function') {
      if (trayHwnd) {
        bridge.showWindow(trayHwnd, SW_HIDE);
      }
      if (secondaryTrayHwnd) {
        bridge.showWindow(secondaryTrayHwnd, SW_HIDE);
      }
    }

    isAutoHideApplied = true;
    return true;
  } catch (err) {
    console.warn('[taskbar] autoHideTaskbar failed:', err.message);
    return false;
  }
}

/**
 * 录制结束或放弃时调用：恢复先前保存的任务栏状态（若无保存记录则默认恢复 ABS_ALWAYSONTOP）
 * @returns {boolean} 操作是否成功
 */
function restoreTaskbar() {
  const bridge = getNativeBridge();
  if (!bridge) {
    savedTaskbarState = null;
    isAutoHideApplied = false;
    return false;
  }

  try {
    const trayHwnd = typeof bridge.findTrayHwnd === 'function' ? bridge.findTrayHwnd() : 0;
    const secondaryTrayHwnd = typeof bridge.findSecondaryTrayHwnd === 'function' ? bridge.findSecondaryTrayHwnd() : 0;

    // 物理恢复主屏幕任务栏与副屏幕任务栏 (ShowWindow SW_SHOW)
    if (typeof bridge.showWindow === 'function') {
      if (trayHwnd) {
        bridge.showWindow(trayHwnd, SW_SHOW);
      }
      if (secondaryTrayHwnd) {
        bridge.showWindow(secondaryTrayHwnd, SW_SHOW);
      }
    }

    const targetState = savedTaskbarState !== null ? savedTaskbarState : ABS_ALWAYSONTOP;

    const data = {
      cbSize: bridge.cbSize,
      hWnd: trayHwnd,
      uCallbackMessage: 0,
      uEdge: 0,
      rc: { left: 0, top: 0, right: 0, bottom: 0 },
      lParam: targetState,
    };

    bridge.shAppBarMessage(ABM_SETSTATE, data);

    savedTaskbarState = null;
    isAutoHideApplied = false;
    return true;
  } catch (err) {
    console.warn('[taskbar] restoreTaskbar failed:', err.message);
    savedTaskbarState = null;
    isAutoHideApplied = false;
    return false;
  }
}

/**
 * 注册退出与异常安全钩子，确保无论正常退出还是异常崩溃，任务栏都能被妥善恢复
 * @param {object} [electronApp] 可选注入 electron.app
 * @param {object} [targetProcess] 可选注入 process 对象（供测试用）
 */
function setupTaskbarSafetyHooks(electronApp, targetProcess = process) {
  if (safetyHooksRegistered) return;
  safetyHooksRegistered = true;

  let app = electronApp;
  if (!app) {
    try {
      const electron = require('electron');
      app = electron && electron.app ? electron.app : null;
    } catch {
      app = null;
    }
  }

  if (app && typeof app.on === 'function') {
    app.on('before-quit', () => {
      restoreTaskbar();
    });
    app.on('will-quit', () => {
      restoreTaskbar();
    });
  }

  if (targetProcess && typeof targetProcess.on === 'function') {
    targetProcess.on('uncaughtException', (err) => {
      try {
        restoreTaskbar();
      } catch {}
      console.error('[taskbar] Restored taskbar on uncaughtException:', err);
      if (typeof targetProcess.listenerCount === 'function' && targetProcess.listenerCount('uncaughtException') <= 1) {
        if (typeof targetProcess.exit === 'function') {
          targetProcess.exit(1);
        }
      }
    });

    targetProcess.on('SIGINT', () => {
      try {
        restoreTaskbar();
      } catch {}
      if (typeof targetProcess.exit === 'function') {
        targetProcess.exit(130);
      }
    });

    targetProcess.on('SIGTERM', () => {
      try {
        restoreTaskbar();
      } catch {}
      if (typeof targetProcess.exit === 'function') {
        targetProcess.exit(143);
      }
    });
  }
}

/**
 * 注册任务栏控制相关的 IPC 接口
 * @param {object} [ipc] electron.ipcMain 或 mock 对象
 */
function registerTaskbarIpc(ipc) {
  let targetIpc = ipc;
  if (!targetIpc) {
    try {
      const electron = require('electron');
      targetIpc = electron && electron.ipcMain ? electron.ipcMain : null;
    } catch {
      targetIpc = null;
    }
  }

  if (!targetIpc || typeof targetIpc.handle !== 'function') {
    return;
  }

  targetIpc.handle('taskbar:auto-hide', async () => autoHideTaskbar());
  targetIpc.handle('taskbar:restore', async () => restoreTaskbar());
}

// 辅助方法（用于状态查看与单元测试）
function getSavedTaskbarState() {
  return savedTaskbarState;
}

function isTaskbarAutoHideActive() {
  return isAutoHideApplied;
}

function _setNativeBridge(mockBridge) {
  nativeBridge = mockBridge;
  nativeInitialized = true;
}

function _resetState() {
  savedTaskbarState = null;
  isAutoHideApplied = false;
  safetyHooksRegistered = false;
}

module.exports = {
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
};
