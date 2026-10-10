'use strict';
// Electron 主进程端预设存储与管理。
// 存储路径: app.getPath('userData')/presets.json
// 对齐 macOS 版 EditorStylePresetStore.swift。

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const {
  getDefaultPresets,
  normalizePreset,
} = require('../core/presets');

class PresetStore {
  constructor(storagePath) {
    this.storagePath = storagePath || path.join(app.getPath('userData'), 'presets.json');
    this._cache = null;
  }

  /**
   * 获取预设存储文件绝对路径
   */
  getPath() {
    return this.storagePath;
  }

  /**
   * 从文件读取或回退到默认预设列表
   */
  load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const list = parsed.map(normalizePreset).filter(Boolean);
          if (list.length > 0) {
            this._cache = list;
            return this._cache;
          }
        }
      }
    } catch (err) {
      console.warn('[presets] Failed to load presets.json, falling back to defaults:', err.message);
    }

    // 文件不存在或损坏时，初始化为默认预设
    const defaults = getDefaultPresets();
    this.saveAll(defaults);
    this._cache = defaults;
    return this._cache;
  }

  /**
   * 安全原子写入所有预设
   */
  saveAll(presets) {
    const list = (presets || []).map(normalizePreset).filter(Boolean);
    const dir = path.dirname(this.storagePath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpFile = `${this.storagePath}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(list, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.storagePath);
      this._cache = list;
      return true;
    } catch (err) {
      console.error('[presets] Failed to write presets.json:', err);
      throw err;
    }
  }

  /**
   * 获取所有预设
   */
  list() {
    return this.load();
  }

  /**
   * 保存或更新预设
   */
  save(presetData) {
    const preset = normalizePreset(presetData);
    if (!preset) throw new Error('Invalid preset data');

    const presets = this.list().slice();
    const index = presets.findIndex((item) => item.id === preset.id);

    if (preset.isDefault) {
      // 保证只有一个预设被标记为 isDefault
      for (const item of presets) {
        item.isDefault = false;
      }
    }

    if (index >= 0) {
      presets[index] = preset;
    } else {
      presets.push(preset);
    }

    this.saveAll(presets);
    return preset;
  }

  /**
   * 根据 ID 删除预设
   */
  delete(id) {
    if (!id) return false;
    const presets = this.list().slice();
    const index = presets.findIndex((item) => item.id === id);
    if (index === -1) return false;

    const [deleted] = presets.splice(index, 1);

    // 如果删除了默认预设，回退默认标记到第一个预设（如果还有预设）
    if (deleted.isDefault && presets.length > 0) {
      presets[0].isDefault = true;
    }

    this.saveAll(presets);
    return true;
  }

  /**
   * 设置默认预设 ID
   */
  setDefault(id) {
    const presets = this.list().slice();
    let found = false;
    for (const item of presets) {
      if (item.id === id) {
        item.isDefault = true;
        found = true;
      } else {
        item.isDefault = false;
      }
    }
    if (!found && id !== null) {
      return false;
    }
    this.saveAll(presets);
    return true;
  }

  /**
   * 获取当前默认预设（如有）
   */
  getDefault() {
    const presets = this.list();
    return presets.find((p) => p.isDefault) || presets[0] || null;
  }
}

let defaultStoreInstance = null;
function getPresetStore() {
  if (!defaultStoreInstance) {
    defaultStoreInstance = new PresetStore();
  }
  return defaultStoreInstance;
}

function registerPresetsIpc(ipc = require('electron').ipcMain, store = getPresetStore()) {
  ipc.handle('presets:list', async () => store.list());
  ipc.handle('presets:save', async (event, presetData) => store.save(presetData));
  ipc.handle('presets:delete', async (event, id) => store.delete(id));
  ipc.handle('presets:set-default', async (event, id) => store.setDefault(id));
}

module.exports = {
  PresetStore,
  getPresetStore,
  registerPresetsIpc,
};
