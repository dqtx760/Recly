'use strict';
// DogSC Windows 版全局快捷键管理模块
// 存储路径：%APPDATA%/DogSC/shortcuts.json

const fs = require('node:fs');
const path = require('node:path');

// 默认快捷键映射
const DEFAULT_SHORTCUTS = Object.freeze({
  recordToggle: 'Control+Alt+R',
  recordPause: 'Control+Alt+P',
  recordMarker: 'Control+Alt+M',
  recordDiscard: 'Control+Alt+D',
  play: 'Space',
  split: 'S',
  delete: 'Delete',
  addZoom: 'Z',
  export: 'Control+E',
});

// 修饰键标准化映射（不区分大小写）
const MODIFIER_MAP = {
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Command',
  command: 'Command',
  cmdorctrl: 'CommandOrControl',
  commandorcontrol: 'CommandOrControl',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
};

// 规范修饰键排序权重
const MODIFIER_ORDER = ['CommandOrControl', 'Control', 'Command', 'Alt', 'AltGr', 'Shift', 'Super'];

// 常用特殊键标准化映射
const SPECIAL_KEYS = {
  plus: 'Plus',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  return: 'Return',
  enter: 'Return',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Escape',
  esc: 'Escape',
  volumeup: 'VolumeUp',
  volumedown: 'VolumeDown',
  volumemute: 'VolumeMute',
  medianexttrack: 'MediaNextTrack',
  mediaprevioustrack: 'MediaPreviousTrack',
  mediastop: 'MediaStop',
  mediaplaypause: 'MediaPlayPause',
  printscreen: 'PrintScreen',
  prtsc: 'PrintScreen',
  numdec: 'numdec',
  numadd: 'numadd',
  numsub: 'numsub',
  nummult: 'nummult',
  numdiv: 'numdiv',
};
for (let i = 0; i <= 9; i++) {
  SPECIAL_KEYS[`num${i}`] = `num${i}`;
}

// 常见标点/符号键
const VALID_SYMBOLS = new Set([
  '~', '`', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')',
  '-', '_', '=', '+', '[', ']', '{', '}', '\\', '|',
  ';', ':', '\'', '"', ',', '.', '<', '>', '/', '?'
]);

let customStoragePath = null;
let shortcutsCache = null;
let registeredCallbacks = null;
let activeRegisteredAccelerators = new Set();
let injectedGlobalShortcut = null;

/**
 * 解析并验证 Electron Accelerator 格式字符串。
 * @param {string} accelerator
 * @returns {{ valid: boolean, error?: string, normalized?: string, modifiers?: string[], key?: string }}
 */
function parseAccelerator(accelerator) {
  if (typeof accelerator !== 'string') {
    return { valid: false, error: '快捷键必须是字符串' };
  }
  const trimmed = accelerator.trim();
  if (!trimmed) {
    return { valid: false, error: '快捷键不能为空' };
  }

  // 处理 '+' 作为按键的情况，例如 'Control+Alt++'
  let rawTokens = [];
  if (trimmed.endsWith('++')) {
    const prefix = trimmed.slice(0, -2);
    rawTokens = prefix.split('+').map((s) => s.trim()).filter(Boolean);
    rawTokens.push('Plus');
  } else {
    rawTokens = trimmed.split('+').map((s) => s.trim()).filter(Boolean);
  }

  if (rawTokens.length === 0) {
    return { valid: false, error: '快捷键缺少有效按键' };
  }

  const modifiers = [];
  let keyToken = null;

  for (const token of rawTokens) {
    const lower = token.toLowerCase();
    if (MODIFIER_MAP[lower]) {
      const canonicalMod = MODIFIER_MAP[lower];
      if (!modifiers.includes(canonicalMod)) {
        modifiers.push(canonicalMod);
      }
    } else {
      if (keyToken !== null) {
        return { valid: false, error: `不能指定多个主按键: "${keyToken}" 与 "${token}"` };
      }
      keyToken = token;
    }
  }

  if (keyToken === null) {
    return { valid: false, error: '快捷键缺少主按键（例如字母、数字或功能键）' };
  }

  // 验证与标准化主按键
  let canonicalKey = null;
  const lowerKey = keyToken.toLowerCase();

  if (/^[a-zA-Z]$/.test(keyToken)) {
    canonicalKey = keyToken.toUpperCase();
  } else if (/^[0-9]$/.test(keyToken)) {
    canonicalKey = keyToken;
  } else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(keyToken)) {
    canonicalKey = `F${keyToken.slice(1)}`;
  } else if (SPECIAL_KEYS[lowerKey]) {
    canonicalKey = SPECIAL_KEYS[lowerKey];
  } else if (VALID_SYMBOLS.has(keyToken)) {
    canonicalKey = keyToken === '+' ? 'Plus' : keyToken;
  } else {
    return { valid: false, error: `不支持的主按键: "${keyToken}"` };
  }

  // 修饰键按规范排序
  modifiers.sort((a, b) => {
    const idxA = MODIFIER_ORDER.indexOf(a);
    const idxB = MODIFIER_ORDER.indexOf(b);
    return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
  });

  const normalized = modifiers.length > 0 ? `${modifiers.join('+')}+${canonicalKey}` : canonicalKey;

  return {
    valid: true,
    modifiers,
    key: canonicalKey,
    normalized,
  };
}

/**
 * 校验快捷键是否符合规范
 */
function validateShortcut(accelerator) {
  return parseAccelerator(accelerator);
}

/**
 * 设置自定义存储文件路径（主要用于单元测试隔离）
 */
function setStoragePath(customPath) {
  customStoragePath = customPath || null;
}

/**
 * 获取快捷键配置存储文件绝对路径
 */
function getStoragePath() {
  if (customStoragePath) {
    return customStoragePath;
  }
  let appDataDir = '';
  try {
    const electron = require('electron');
    if (electron && typeof electron === 'object' && electron.app && typeof electron.app.getPath === 'function') {
      appDataDir = electron.app.getPath('appData');
    }
  } catch {}

  if (!appDataDir) {
    appDataDir = process.env.APPDATA || (
      process.platform === 'win32'
        ? path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Roaming')
        : path.join(process.env.HOME || '.', '.config')
    );
  }
  return path.join(appDataDir, 'DogSC', 'shortcuts.json');
}

/**
 * 从本地磁盘读取快捷键，损坏或不存在时回退到默认
 */
function loadShortcuts() {
  const filePath = getStoragePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const merged = { ...DEFAULT_SHORTCUTS };
        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val === 'string') {
            const parsedAcc = parseAccelerator(val);
            if (parsedAcc.valid) {
              merged[key] = parsedAcc.normalized;
            }
          }
        }
        return merged;
      }
    }
  } catch {
    // 损坏或不可读时回退到默认
  }
  return { ...DEFAULT_SHORTCUTS };
}

/**
 * 安全原子写入快捷键到磁盘
 */
function saveShortcuts(shortcutsMap) {
  const filePath = getStoragePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const content = JSON.stringify(shortcutsMap, null, 2);
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

/**
 * 获取当前快捷键映射
 */
function getShortcuts() {
  if (!shortcutsCache) {
    shortcutsCache = loadShortcuts();
  }
  return { ...shortcutsCache };
}

/**
 * 更新、验证、持久化并重新注册全局快捷键
 * @param {Record<string, string>} newMap
 */
function setShortcuts(newMap) {
  if (!newMap || typeof newMap !== 'object' || Array.isArray(newMap)) {
    throw new TypeError('快捷键配置必须是非空对象');
  }

  const current = getShortcuts();
  const updated = { ...current };

  // 验证每个更新的快捷键
  for (const [action, accelerator] of Object.entries(newMap)) {
    if (typeof accelerator !== 'string') {
      throw new TypeError(`快捷键操作 "${action}" 的键位必须是字符串`);
    }
    const parsed = parseAccelerator(accelerator);
    if (!parsed.valid) {
      throw new Error(`快捷键 "${accelerator}" 格式无效 (${action}): ${parsed.error}`);
    }
    updated[action] = parsed.normalized;
  }

  // 检查按键冲突：不同操作不能绑定相同的按键
  const acceleratorToAction = new Map();
  for (const [action, acc] of Object.entries(updated)) {
    if (acceleratorToAction.has(acc)) {
      throw new Error(`快捷键冲突: "${acc}" 同时分配给了 "${acceleratorToAction.get(acc)}" 和 "${action}"`);
    }
    acceleratorToAction.set(acc, action);
  }

  // 保存并更新缓存
  saveShortcuts(updated);
  shortcutsCache = updated;

  // 重新注册全局快捷键
  reRegisterGlobalShortcuts();

  return { ...shortcutsCache };
}

function resolveGlobalShortcut(customImpl = null) {
  if (customImpl) {
    return customImpl;
  }
  if (injectedGlobalShortcut) {
    return injectedGlobalShortcut;
  }
  try {
    const electron = require('electron');
    if (electron && typeof electron === 'object' && electron.globalShortcut) {
      return electron.globalShortcut;
    }
  } catch {}
  return null;
}

/**
 * 使用 Electron globalShortcut 注册全局快捷键
 * @param {Record<string, Function>} callbacks
 * @param {object} [globalShortcutImpl] 可注入的 globalShortcut 实例（用于测试）
 */
function registerShortcuts(callbacks, globalShortcutImpl = null) {
  if (globalShortcutImpl) {
    injectedGlobalShortcut = globalShortcutImpl;
  }
  if (callbacks && typeof callbacks === 'object') {
    registeredCallbacks = { ...callbacks };
  }

  const gs = resolveGlobalShortcut();
  if (!gs || typeof gs.register !== 'function') {
    return false;
  }

  // 先注销之前已注册的全局快捷键
  if (typeof gs.unregister === 'function') {
    for (const acc of activeRegisteredAccelerators) {
      try {
        gs.unregister(acc);
      } catch {}
    }
  }
  activeRegisteredAccelerators.clear();

  const current = getShortcuts();
  if (registeredCallbacks) {
    for (const [action, accelerator] of Object.entries(current)) {
      const cb = registeredCallbacks[action];
      if (typeof cb === 'function' && accelerator) {
        try {
          const success = gs.register(accelerator, cb);
          if (success !== false) {
            activeRegisteredAccelerators.add(accelerator);
          }
        } catch (err) {
          console.warn(`[shortcuts] 注册全局快捷键失败 (${action}: ${accelerator}):`, err.message);
        }
      }
    }
  }
  return true;
}

/**
 * 注销所有通过此模块注册的全局快捷键
 */
function unregisterShortcuts(globalShortcutImpl = null) {
  const gs = resolveGlobalShortcut(globalShortcutImpl);
  if (gs && typeof gs.unregister === 'function') {
    for (const acc of activeRegisteredAccelerators) {
      try {
        gs.unregister(acc);
      } catch {}
    }
  }
  activeRegisteredAccelerators.clear();
}

/**
 * 当快捷键配置更新时，重新注册已绑定的回调
 */
function reRegisterGlobalShortcuts() {
  if (registeredCallbacks) {
    registerShortcuts(registeredCallbacks);
  }
}

function resolveIpcMain(customIpc = null) {
  if (customIpc) {
    return customIpc;
  }
  try {
    const electron = require('electron');
    if (electron && typeof electron === 'object' && electron.ipcMain) {
      return electron.ipcMain;
    }
  } catch {}
  return null;
}

/**
 * 注册 IPC 接口：shortcuts:get 与 shortcuts:set
 * @param {object} [ipc] 可注入的 ipcMain 实例（用于测试）
 */
function registerShortcutsIpc(ipc = null) {
  const ipcTarget = resolveIpcMain(ipc);
  if (!ipcTarget || typeof ipcTarget.handle !== 'function') {
    return false;
  }

  if (typeof ipcTarget.removeHandler === 'function') {
    try { ipcTarget.removeHandler('shortcuts:get'); } catch {}
    try { ipcTarget.removeHandler('shortcuts:set'); } catch {}
    try { ipcTarget.removeHandler('shortcuts:reset'); } catch {}
  }

  ipcTarget.handle('shortcuts:reset', () => {
    return setShortcuts({ ...DEFAULT_SHORTCUTS });
  });
  ipcTarget.handle('shortcuts:get', () => {
    return getShortcuts();
  });

  ipcTarget.handle('shortcuts:set', (event, payload) => {
    const newMap = (payload && typeof payload === 'object' && payload.shortcuts) ? payload.shortcuts : payload;
    return setShortcuts(newMap);
  });

  return true;
}

/**
 * 重置模块内部状态（供单元测试使用）
 */
function resetShortcuts() {
  shortcutsCache = null;
  registeredCallbacks = null;
  activeRegisteredAccelerators.clear();
  injectedGlobalShortcut = null;
  customStoragePath = null;
}

module.exports = {
  DEFAULT_SHORTCUTS,
  getShortcuts,
  setShortcuts,
  registerShortcuts,
  unregisterShortcuts,
  registerShortcutsIpc,
  parseAccelerator,
  validateShortcut,
  getStoragePath,
  setStoragePath,
  resetShortcuts,
};
