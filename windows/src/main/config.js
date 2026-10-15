'use strict';
// Electron 主进程端用户配置存储与管理。
// 存储路径: %APPDATA%/DogSC/config.json

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let electron = null;
try {
  const el = require('electron');
  if (el && typeof el === 'object') {
    electron = el;
  }
} catch {
  electron = null;
}

let customConfigPath = null;

/**
 * 设置自定义配置文件路径（测试用）
 */
function setConfigPath(filePath) {
  customConfigPath = filePath ? path.resolve(filePath) : null;
}

/**
 * 重置自定义配置文件路径
 */
function resetConfigPath() {
  customConfigPath = null;
}

/**
 * 获取配置文件绝对路径（默认 %APPDATA%/DogSC/config.json）
 */
function getConfigPath() {
  if (customConfigPath) {
    return customConfigPath;
  }

  let appDataDir = null;
  if (electron && electron.app && typeof electron.app.getPath === 'function') {
    try {
      appDataDir = electron.app.getPath('appData');
    } catch {
      appDataDir = null;
    }
  }

  if (!appDataDir) {
    appDataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }

  return path.join(appDataDir, 'DogSC', 'config.json');
}

/**
 * 获取默认项目存储根目录（默认 app.getPath('videos')/DogSC）
 */
function getDefaultProjectsRoot() {
  let videosDir = null;
  if (electron && electron.app && typeof electron.app.getPath === 'function') {
    try {
      videosDir = electron.app.getPath('videos');
    } catch {
      videosDir = null;
    }
  }

  if (!videosDir) {
    videosDir = process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, 'Videos')
      : path.join(os.homedir(), 'Videos');
  }

  return path.join(videosDir, 'DogSC');
}

/**
 * 读取本地配置，如文件不存在或损坏则返回空对象
 */
function loadConfig() {
  const file = getConfigPath();
  try {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    // 忽略异常，降级回退
  }
  return {};
}

/**
 * 安全原子写入配置
 */
function saveConfig(config) {
  const file = getConfigPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${file}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmpFile, file);
}

/**
 * 获取当前配置的项目存储根目录，如未配置则返回默认路径
 */
function getProjectsRoot() {
  const config = loadConfig();
  if (config && typeof config.projectsRoot === 'string' && config.projectsRoot.trim()) {
    return path.resolve(config.projectsRoot.trim());
  }
  return getDefaultProjectsRoot();
}

/**
 * 更新并持久化项目存储根目录
 * @param {string|null} dir - 新的项目存储目录绝对/相对路径；若为 null 则清除配置回退默认
 * @returns {string} 更新后的存储路径
 */
function setProjectsRoot(dir) {
  if (dir === null || dir === undefined) {
    const config = loadConfig();
    delete config.projectsRoot;
    saveConfig(config);
    return getDefaultProjectsRoot();
  }

  if (typeof dir !== 'string' || !dir.trim()) {
    throw new Error('Invalid projects directory path');
  }

  const resolved = path.resolve(dir.trim());
  const config = loadConfig();
  config.projectsRoot = resolved;
  saveConfig(config);
  return resolved;
}

function getHideDesktopIconsDuringRecording() {
  return loadConfig().hideDesktopIconsDuringRecording === true;
}

function getExportRoot() {
  const dir = loadConfig().exportRoot;
  return typeof dir === 'string' && dir.trim() ? path.resolve(dir.trim()) : null;
}

function setExportRoot(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('请选择有效的导出文件夹');
  const config = loadConfig();
  config.exportRoot = path.resolve(dir.trim());
  saveConfig(config);
  return config.exportRoot;
}

function setHideDesktopIconsDuringRecording(enabled) {
  if (typeof enabled !== 'boolean') {
    throw new Error('Invalid desktop icon visibility setting');
  }
  const config = loadConfig();
  config.hideDesktopIconsDuringRecording = enabled;
  saveConfig(config);
  return enabled;
}

/**
 * 注册项目配置相关的 IPC 处理函数
 */
function registerConfigIpc(ipc = (electron && electron.ipcMain), dialogInstance = (electron && electron.dialog)) {
  if (!ipc || typeof ipc.handle !== 'function') {
    throw new Error('Valid ipcMain instance required for registerConfigIpc');
  }

  ipc.handle('config:get-projects-root', () => {
    return getProjectsRoot();
  });

  ipc.handle('config:set-projects-root', (event, dir) => {
    return setProjectsRoot(dir);
  });

  ipc.handle('config:get-hide-desktop-icons', () => getHideDesktopIconsDuringRecording());
  ipc.handle('config:set-hide-desktop-icons', (event, enabled) => setHideDesktopIconsDuringRecording(enabled));
  ipc.handle('config:get-export-root', () => getExportRoot());
  ipc.handle('config:choose-export-root', async () => {
    const result = await dialogInstance.showOpenDialog({
      title: '选择导出文件夹',
      defaultPath: getExportRoot() || getDefaultProjectsRoot(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled || !result.filePaths?.length ? null : setExportRoot(result.filePaths[0]);
  });

  ipc.handle('config:choose-projects-root', async (event) => {
    if (!dialogInstance || typeof dialogInstance.showOpenDialog !== 'function') {
      throw new Error('Valid dialog instance required for config:choose-projects-root');
    }
    const currentRoot = getProjectsRoot();
    const options = {
      title: '选择项目存储文件夹',
      defaultPath: currentRoot,
      properties: ['openDirectory', 'createDirectory'],
    };

    let result;
    try {
      result = await dialogInstance.showOpenDialog(options);
    } catch (err) {
      console.warn('[config] showOpenDialog error:', err.message);
      result = null;
    }

    if (result && !result.canceled && Array.isArray(result.filePaths) && result.filePaths.length > 0) {
      const chosen = result.filePaths[0];
      return setProjectsRoot(chosen);
    }

    return null;
  });
}

module.exports = {
  getExportRoot,
  setExportRoot,
  getProjectsRoot,
  setProjectsRoot,
  getHideDesktopIconsDuringRecording,
  setHideDesktopIconsDuringRecording,
  registerConfigIpc,
  getConfigPath,
  setConfigPath,
  resetConfigPath,
  getDefaultProjectsRoot,
  loadConfig,
  saveConfig,
};
