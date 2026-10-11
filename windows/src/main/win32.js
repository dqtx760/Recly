'use strict';

const SW_HIDE = 0;
const SW_SHOW = 5;
let nativeApi;

function loadNativeApi() {
  if (nativeApi !== undefined) return nativeApi;
  nativeApi = null;
  if (process.platform !== 'win32') return nativeApi;

  try {
    const user32 = require('koffi').load('user32.dll');
    nativeApi = {
      FindWindowW: user32.func('uintptr_t __stdcall FindWindowW(const char16_t *className, const char16_t *windowName)'),
      FindWindowExW: user32.func('uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t childAfter, const char16_t *className, const char16_t *windowName)'),
      IsWindow: user32.func('bool __stdcall IsWindow(uintptr_t window)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(uintptr_t window)'),
      ShowWindow: user32.func('bool __stdcall ShowWindow(uintptr_t window, int command)'),
    };
  } catch {
    nativeApi = null;
  }
  return nativeApi;
}

function findDesktopIconListView(api) {
  if (!api) return 0;
  const listViewIn = (parent) => {
    if (!parent) return 0;
    const shellView = api.FindWindowExW(parent, 0, 'SHELLDLL_DefView', null);
    if (!shellView) return 0;
    return api.FindWindowExW(shellView, 0, 'SysListView32', 'FolderView')
      || api.FindWindowExW(shellView, 0, 'SysListView32', null);
  };

  const progman = api.FindWindowW('Progman', null);
  const fromProgman = listViewIn(progman);
  if (fromProgman) return fromProgman;

  let worker = 0;
  while ((worker = api.FindWindowExW(0, worker, 'WorkerW', null))) {
    const listView = listViewIn(worker);
    if (listView) return listView;
  }
  return 0;
}

function createDesktopIconsController(api = loadNativeApi()) {
  let originalState = null;

  return {
    hide() {
      if (originalState || !api) return Boolean(originalState);
      const window = findDesktopIconListView(api);
      if (!window) return false;
      originalState = { window, visible: Boolean(api.IsWindowVisible(window)) };
      if (originalState.visible) api.ShowWindow(window, SW_HIDE);
      return true;
    },
    restore() {
      if (!originalState || !api) return false;
      const saved = originalState;
      const window = findDesktopIconListView(api)
        || (api.IsWindow(saved.window) ? saved.window : 0);
      if (!window) return false;
      api.ShowWindow(window, saved.visible ? SW_SHOW : SW_HIDE);
      originalState = null;
      return true;
    },
  };
}

module.exports = { createDesktopIconsController, findDesktopIconListView };
