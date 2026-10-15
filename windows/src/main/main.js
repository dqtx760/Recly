'use strict';
// DogSC Windows 版主进程：窗口管理、录制调度、项目库与导出混流。

const { app, BrowserWindow, ipcMain, screen, desktopCapturer, dialog, globalShortcut, session, shell, Menu, Tray, clipboard, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const media = require('./ffmpeg');
const { createAgentService } = require('./agent-service');
const { TranscriptionManager } = require('./transcription');
const { RecordingSession, listDisplays, PROJECT_EXTENSION } = require('./recording');
const { copyProjectToFolder } = require('./project-copy');
const { normalizeProject } = require('../core/model');

const { registerPresetsIpc } = require('./presets');
const { registerUpdaterIpc } = require('./updater');
const { getProjectsRoot, getHideDesktopIconsDuringRecording, registerConfigIpc } = require('./config');
const { automaticExportPath } = require('./export-path');
const { trashProjects } = require('./project-trash');
const { importAsset, readClipboardImage } = require('./asset-import');
const {
  autoHideTaskbar,
  restoreTaskbar,
  setupTaskbarSafetyHooks,
  registerTaskbarIpc,
} = require('./taskbar');
const { registerShortcuts, registerShortcutsIpc } = require('./shortcuts');
// 所有窗口只加载应用自带的本地页面，不打开任何远程内容。
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const RENDERER = path.join(__dirname, '..', 'renderer');
const SELF_TEST = process.argv.includes('--selftest');
// 开发时字体从共享 Resources 读取；Windows 图标单独保存在 windows/assets。
const resourcesDirectory = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '..', '..', '..', 'Resources');
const windowsIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'AppIconMaster.png')
  : path.join(__dirname, '..', '..', 'assets', 'AppIconMaster.png');
// 自测产生的项目放在临时目录，不进用户的项目库。
const projectsRoot = () => (SELF_TEST ? path.join(app.getPath('temp'), 'dogsc-selftest') : getProjectsRoot());

let tray = null;
let recorderWindow = null;
let libraryWindow = null;
let cameraWindow = null;
let memoWindow = null;
let windowSourcesCache = null;
let windowSourcesPending = null;
const editorWindows = new Map();
const completionWindows = new Map();
const completionThumbnailPromises = new Map();
function initShortcuts() {
  registerShortcuts({
    recordToggle: () => {
      if (recorderWindow && !recorderWindow.isDestroyed()) {
        recorderWindow.webContents.send('recorder:toggle');
      }
    },
    recordPause: () => {
      if (recorderWindow && !recorderWindow.isDestroyed()) {
        recorderWindow.webContents.send('recorder:pause');
      }
    },
    recordMarker: () => {
      if (recording && recording.addMarker()) {
        if (recorderWindow && !recorderWindow.isDestroyed()) {
          recorderWindow.webContents.send('recorder:marker-added', recording.markers.length);
        }
      }
    },
    recordDiscard: () => {
      if (recorderWindow && !recorderWindow.isDestroyed()) {
        recorderWindow.webContents.send('recorder:discard');
      } else if (recording) {
        const sessionState = recording;
        recording = null;
        restoreTaskbar();
        sessionState.discard().catch(() => {});
      }
    },
  });
}

let recording = null;
let preparing = null;
let startingRecording = null;
let finishingRecording = null;
let environment = { ok: false, reason: '正在检查 ffmpeg…' };
let activeExport = null;
let activeExportSession = null;
let agentService = null;
let transcription = null;
let drainingServices = false;

function hasRecordingWork() {
  return Boolean(recording || preparing || startingRecording || finishingRecording);
}

function createWindow(file, options = {}, query = {}) {
  const win = new BrowserWindow({
    show: false,
    backgroundColor: options.transparent ? '#00000000' : '#F4F5F3',
    icon: windowsIconPath,
    ...options,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, ...(options.webPreferences || {}) },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(RENDERER, file), { query: { resources: resourcesDirectory, ...query } });
  return win;
}

/// 录制条、备忘录、摄像头预览都不进入本软件自己的录制画面（WDA_EXCLUDEFROMCAPTURE）。
function excludeFromCapture(win, keepOnTop = false) {
  win.setContentProtection(true);
  if (keepOnTop) win.setAlwaysOnTop(true, 'screen-saver');
}

function updateTrayState() {
  if (!tray || tray.isDestroyed()) return;
  const isRecording = Boolean(recording || startingRecording || finishingRecording);
  const hasUnfinishedRecording = hasRecordingWork();
  const tooltip = isRecording ? 'Recly: 录制中 (Ctrl+Alt+R 停止)' : 'Recly 屏幕录制';
  tray.setToolTip(tooltip);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开主界面',
      click: () => {
        showRecorder();
      },
    },
    {
      label: isRecording ? '停止录制' : '开始录制',
      click: () => {
        if (recorderWindow && !recorderWindow.isDestroyed()) {
          recorderWindow.webContents.send('recorder:toggle');
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      enabled: !hasUnfinishedRecording,
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

function initTray() {
  if (tray && !tray.isDestroyed()) return tray;
  try {
    tray = new Tray(windowsIconPath);
    tray.on('click', () => {
      if (recorderWindow && !recorderWindow.isDestroyed()) {
        if (recorderWindow.isVisible()) {
          recorderWindow.hide();
        } else {
          recorderWindow.show();
          recorderWindow.focus();
        }
      } else {
        showRecorder();
      }
    });
    updateTrayState();
  } catch (err) {
    console.warn('[tray] Failed to initialize tray:', err.message);
  }
  return tray;
}

function showRecorder() {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.show();
    recorderWindow.focus();
    return recorderWindow;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = 480;
  const height = 624;
  recorderWindow = createWindow('recorder.html', {
    width, height,
    useContentSize: true,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    center: true,
    frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: false, hasShadow: false,
    title: 'Recly',
  });
  recorderWindow.setIgnoreMouseEvents(false);
  excludeFromCapture(recorderWindow);
  recorderWindow.once('ready-to-show', () => recorderWindow.show());
  recorderWindow.on('close', (event) => {
    if (hasRecordingWork()) {
      event.preventDefault();
      recorderWindow.hide();
    }
  });
  recorderWindow.on('closed', () => {
    recorderWindow = null;
    for (const win of [cameraWindow, memoWindow]) if (win && !win.isDestroyed()) win.close();
    if (!editorWindows.size && !(libraryWindow && !libraryWindow.isDestroyed())) app.quit();
  });
  return recorderWindow;
}
function showLibrary() {
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    libraryWindow.show();
    libraryWindow.focus();
    libraryWindow.webContents.send('library:refresh');
    return;
  }
  libraryWindow = createWindow('library.html', { width: 980, height: 680, minWidth: 720, minHeight: 480, title: 'Recly 项目库' });
  libraryWindow.once('ready-to-show', () => libraryWindow.show());
  libraryWindow.on('closed', () => { libraryWindow = null; });
}

function openEditor(directory) {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.hide();
  }
  const existing = editorWindows.get(directory);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  const win = createWindow('editor.html', { width: 1480, height: 940, minWidth: 1100, minHeight: 700, frame: false, title: `${path.basename(directory, PROJECT_EXTENSION)} — Recly` }, { project: directory });
  const editorSender = win.webContents;
  editorSender.once('destroyed', () => {
    if (activeExportSession?.sender !== editorSender) return;
    activeExportSession = null;
    // Keep the encoder lock until its process has actually stopped.
    if (activeExport) activeExport.kill();
  });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.on('closed', () => {
    editorWindows.delete(directory);
    if (agentService) agentService.rendererClosed(directory);
    if (editorWindows.size === 0 && recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.show();
    }
  });
  editorWindows.set(directory, win);
  return win;
}

function getEditorWindow(directory) {
  const expected = path.resolve(directory).toLowerCase();
  for (const [projectDirectory, win] of editorWindows) {
    if (path.resolve(projectDirectory).toLowerCase() === expected && !win.isDestroyed()) return win;
  }
  return null;
}

function editorDirectoryForSender(sender) {
  for (const [directory, win] of editorWindows) {
    if (!win.isDestroyed() && win.webContents === sender) return directory;
  }
  return null;
}

function requireEditorRequest(event, directory) {
  const openedDirectory = editorDirectoryForSender(event.sender);
  if (!openedDirectory || !directory || path.resolve(openedDirectory).toLowerCase() !== path.resolve(directory).toLowerCase()) {
    throw Object.assign(new Error('请求必须来自指定工程的编辑器窗口'), { code: 'WRONG_PROJECT' });
  }
  return openedDirectory;
}

function projectAssetFile(directory, project, trackName) {
  const mediaInfo = project && project.media && project.media[trackName];
  if (!mediaInfo || typeof mediaInfo.file !== 'string' || !mediaInfo.file) {
    throw Object.assign(new Error(`工程缺少 ${trackName} 素材`), { code: 'MEDIA_NOT_FOUND' });
  }
  const root = fs.realpathSync(directory);
  const candidate = path.resolve(root, mediaInfo.file);
  const actual = fs.realpathSync(candidate);
  const relative = path.relative(root, actual);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(actual).isFile()) {
    throw Object.assign(new Error('素材路径必须位于当前工程目录内'), { code: 'INVALID_MEDIA_PATH' });
  }
  return actual;
}

function createAgentMediaFile(extension) {
  const directory = path.join(app.getPath('userData'), 'agent-media');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${crypto.randomUUID()}.${extension}`);
}

function expireAgentMediaFile(file) {
  const timer = setTimeout(() => {
    try { fs.unlinkSync(file); } catch { /* Keep a media excerpt that is still being read. */ }
    try { fs.rmdirSync(path.dirname(file)); } catch { /* The directory may contain another active excerpt. */ }
  }, 10 * 60 * 1000);
  timer.unref();
}

async function extractAgentAudio({ directory, project, trackName, sourceStart, sourceDuration, speed = 1, timeDomain = 'source', time = sourceStart }) {
  if (!['microphone', 'systemAudio'].includes(trackName) || !Number.isFinite(sourceStart) || sourceStart < 0 ||
      !Number.isFinite(sourceDuration) || sourceDuration <= 0 || sourceDuration > 120 ||
      !Number.isFinite(speed) || speed < 0.25 || speed > 8) {
    throw Object.assign(new Error('音频区间或速度无效'), { code: 'INVALID_PARAMS' });
  }
  const track = project.media[trackName];
  const sourceFile = projectAssetFile(directory, project, trackName);
  const trackDuration = Number(track.duration) > 0 ? Number(track.duration) : (await media.probe(sourceFile)).duration;
  const offset = Number(track.offset) || 0;
  const audioStart = Math.max(0, sourceStart - offset);
  const audioEnd = Math.min(trackDuration, sourceStart - offset + sourceDuration);
  const actualSourceStart = audioStart + offset;
  const actualSourceDuration = audioEnd - audioStart;
  if (actualSourceDuration <= 0.05) throw Object.assign(new Error('所选录屏时间没有对应的音轨内容'), { code: 'INVALID_PARAMS' });
  const outputFile = createAgentMediaFile('wav');
  const atempo = [];
  let factor = speed;
  while (factor > 2) { atempo.push('atempo=2'); factor /= 2; }
  while (factor < 0.5) { atempo.push('atempo=0.5'); factor /= 0.5; }
  atempo.push(`atempo=${factor.toFixed(6)}`);
  const args = [
    '-loglevel', 'error', '-ss', audioStart.toFixed(3), '-t', actualSourceDuration.toFixed(3), '-i', sourceFile,
    '-vn', '-af', atempo.join(','), '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-f', 'wav', outputFile,
  ];
  try {
    await media.ffmpeg(args);
    expireAgentMediaFile(outputFile);
    const adjustedTime = timeDomain === 'output' ? time + (actualSourceStart - sourceStart) / speed : actualSourceStart;
    return { path: outputFile, mimeType: 'audio/wav', timeDomain, time: adjustedTime, sourceStart: actualSourceStart, sourceDuration: actualSourceDuration, duration: actualSourceDuration / speed };
  } catch (error) {
    try { fs.unlinkSync(outputFile); } catch { /* No output was created. */ }
    throw error;
  }
}

function toggleCameraPreview(visible, deviceId) {
  if (!visible) {
    if (cameraWindow && !cameraWindow.isDestroyed()) cameraWindow.close();
    cameraWindow = null;
    return;
  }
  if (cameraWindow && !cameraWindow.isDestroyed()) {
    cameraWindow.webContents.send('camera:device', deviceId);
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  cameraWindow = createWindow('camera.html', {
    width: 240, height: 240, x: area.x + 36, y: area.y + area.height - 240 - 36,
    frame: false, transparent: true, resizable: false, skipTaskbar: true, hasShadow: false, focusable: false,
  }, { device: deviceId || '' });
  excludeFromCapture(cameraWindow, true);
  cameraWindow.once('ready-to-show', () => cameraWindow.showInactive());
  cameraWindow.on('closed', () => { cameraWindow = null; });
}

function toggleMemo() {
  if (memoWindow && !memoWindow.isDestroyed()) {
    memoWindow.close();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  memoWindow = createWindow('memo.html', {
    width: 480, height: 300, minWidth: 420, minHeight: 160, x: area.x + area.width - 480 - 36, y: area.y + 80,
    frame: false, transparent: true, resizable: false, skipTaskbar: true, hasShadow: false,
  }, { store: path.join(app.getPath('userData'), 'memo.json') });
  excludeFromCapture(memoWindow, true);
  memoWindow.once('ready-to-show', () => memoWindow.show());
  memoWindow.on('closed', () => { memoWindow = null; });
}

/// 全屏半透明遮罩上拖出录制区域，返回所在显示器与物理像素矩形。
function pickArea() {
  return new Promise((resolve) => {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const overlay = createWindow('area.html', {
      ...display.bounds, frame: false, transparent: true, resizable: false, movable: false, skipTaskbar: true, hasShadow: false, fullscreenable: false,
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.once('ready-to-show', () => { overlay.show(); overlay.focus(); });
    let settled = false;
    const finish = (rect) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('area:done', onDone);
      if (!overlay.isDestroyed()) overlay.close();
      if (!rect) return resolve(null);
      const scale = display.scaleFactor;
      resolve({
        displayId: display.id,
        rect: { x: Math.round(rect.x * scale), y: Math.round(rect.y * scale), width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) },
      });
    };
    const onDone = (event, rect) => { if (event.sender === overlay.webContents) finish(rect); };
    ipcMain.on('area:done', onDone);
    overlay.on('closed', () => finish(null));
  });
}

async function listWindows() {
  if (windowSourcesCache) return windowSourcesCache;
  if (!windowSourcesPending) {
    const own = new Set(BrowserWindow.getAllWindows().map((win) => win.getMediaSourceId()));
    windowSourcesPending = desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 360, height: 220 } })
      .then((sources) => sources
        .filter((source) => !own.has(source.id) && source.name)
        .map((source) => ({ hwnd: Number(source.id.split(':')[1]), title: source.name, thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL() }))
        .filter((source) => Number.isFinite(source.hwnd) && source.hwnd > 0))
      .then((windows) => {
        windowSourcesCache = windows;
        return windows;
      })
      .finally(() => { windowSourcesPending = null; });
  }
  return windowSourcesPending;
}

function arrangeCompletionWindows() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = 356;
  const height = 336;
  const margin = 16;
  const gap = 12;
  const maxCards = Math.max(1, Math.min(3, Math.floor((area.height - margin * 2 + gap) / (height + gap))));
  const active = [...completionWindows.entries()].filter(([, win]) => !win.isDestroyed());
  while (active.length > maxCards) {
    const [oldestDirectory, oldest] = active.shift();
    if (completionWindows.get(oldestDirectory) === oldest) completionWindows.delete(oldestDirectory);
    if (!oldest.isDestroyed()) oldest.close();
  }
  const x = Math.max(area.x + margin, area.x + area.width - width - margin);
  active.slice().reverse().forEach(([, win], index) => {
    const y = Math.round(area.y + area.height - height - margin - index * (height + gap));
    win.setPosition(x, y);
  });
}

function setCompletionWindowsVisible(visible) {
  for (const win of completionWindows.values()) {
    if (win.isDestroyed()) continue;
    if (visible) win.showInactive();
    else win.hide();
  }
}

function showRecordingComplete(result) {
  const existing = completionWindows.get(result.directory);
  if (existing && !existing.isDestroyed()) existing.close();

  const win = createWindow('recording-complete.html', {
    width: 353, height: 336, useContentSize: true,
    frame: false, transparent: true, resizable: false, maximizable: false,
    skipTaskbar: true, hasShadow: false, title: '录制完成',
  });
  completionWindows.set(result.directory, win);
  excludeFromCapture(win, true);
  win.on('closed', () => {
    if (completionWindows.get(result.directory) === win) completionWindows.delete(result.directory);
    arrangeCompletionWindows();
  });
  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('recording-complete:data', {
        directory: result.directory,
        name: result.name,
        duration: result.duration,
        thumbnailUrl: result.thumbnailUrl || '',
      });
    }
  });
  win.once('ready-to-show', () => {
    arrangeCompletionWindows();
    win.showInactive();
  });
  arrangeCompletionWindows();
  return win;
}

async function refreshWindows() {
  if (windowSourcesPending) await windowSourcesPending.catch(() => {});
  windowSourcesCache = null;
  return listWindows();
}

function listProjects() {
  const root = projectsRoot();
  if (!fs.existsSync(root)) return [];
  const projects = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(PROJECT_EXTENSION)) continue;
    const directory = path.join(root, entry.name);
    try {
      const project = JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8'));
      projects.push({
        directory,
        name: project.name || path.basename(directory, PROJECT_EXTENSION),
        createdAt: project.createdAt,
        duration: project.media.screen.duration,
        width: project.media.screen.width,
        height: project.media.screen.height,
        thumbnails: project.media.thumbnails ? { ...project.media.thumbnails, file: path.join(directory, project.media.thumbnails.file) } : null,
      });
    } catch { /* 录制未完成或已损坏的目录不列出 */ }
  }
  return projects.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function trashProject(directory) {
  const editor = editorWindows.get(directory);
  if (editor && !editor.isDestroyed()) editor.close();
  await shell.trashItem(directory);
}

/// Windows 自带壁纸，对应 macOS 版的"系统壁纸"背景来源。
function listWallpapers() {
  const roots = [path.join(process.env.SystemRoot || 'C:\\Windows', 'Web', 'Wallpaper'), path.join(process.env.SystemRoot || 'C:\\Windows', 'Web', '4K', 'Wallpaper')];
  const files = [];
  const walk = (directory, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (/\.(jpe?g|png)$/i.test(entry.name)) files.push(full);
    }
  };
  roots.forEach((root) => walk(root, 0));
  const current = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
  return { current: fs.existsSync(current) ? current : null, files: files.slice(0, 48) };
}

function registerIpc() {
  ipcMain.handle('app:environment', () => ({ ...environment, projectsRoot: projectsRoot(), version: app.getVersion() }));
  ipcMain.on('agent:ready', (event, payload) => { if (agentService) agentService.rendererReady(event.sender, payload); });
  ipcMain.on('agent:response', (event, payload) => { if (agentService) agentService.rendererResponse(event.sender, payload); });
  ipcMain.handle('subtitle:environment', (event) => {
    if (!editorDirectoryForSender(event.sender) || !transcription) return { ready: false, executable: null, model: null };
    const value = transcription.environment();
    return { ready: value.ready, executable: value.executable, model: value.model };
  });
  ipcMain.handle('subtitle:generate', async (event, payload = {}) => {
    const directory = requireEditorRequest(event, payload.directory);
    if (!transcription || !payload.project) throw Object.assign(new Error('语音识别服务尚未就绪'), { code: 'ASR_UNAVAILABLE' });
    const result = await transcription.generate({
      directory,
      project: payload.project,
      track: payload.track,
      scope: payload.scope,
    });
    return { jobId: result.jobId };
  });
  ipcMain.handle('jobs:get', (event, payload = {}) => {
    const directory = editorDirectoryForSender(event.sender);
    if (!directory || !transcription) throw Object.assign(new Error('请求必须来自 Recly 编辑器'), { code: 'WRONG_PROJECT' });
    return transcription.get(payload.jobId, directory);
  });
  ipcMain.handle('jobs:cancel', (event, payload = {}) => {
    const directory = editorDirectoryForSender(event.sender);
    if (!directory || !transcription) throw Object.assign(new Error('请求必须来自 Recly 编辑器'), { code: 'WRONG_PROJECT' });
    return transcription.cancel(payload.jobId, directory);
  });
  ipcMain.handle('subtitle:save-srt', async (event, payload = {}) => {
    if (!editorDirectoryForSender(event.sender)) throw Object.assign(new Error('请求必须来自 Recly 编辑器'), { code: 'WRONG_PROJECT' });
    if (typeof payload.content !== 'string' || payload.content.includes('\0') || Buffer.byteLength(payload.content, 'utf8') > 10 * 1024 * 1024) {
      throw Object.assign(new Error('SRT 内容无效或超过 10 MB'), { code: 'INVALID_PARAMS' });
    }
    const name = String(payload.name || 'subtitles').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'subtitles';
    const defaultName = name.toLowerCase().endsWith('.srt') ? name : `${name}.srt`;
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '保存字幕文件', defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'SubRip 字幕', extensions: ['srt'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const file = path.extname(result.filePath).toLowerCase() === '.srt' ? result.filePath : `${result.filePath}.srt`;
    await fs.promises.writeFile(file, payload.content, 'utf8');
    return file;
  });
  ipcMain.handle('agent:media-frame', async (event, payload = {}) => {
    const directory = requireEditorRequest(event, payload.directory);
    const project = payload.project;
    const sourceTime = Number(payload.sourceTime);
    if (!Number.isFinite(sourceTime) || sourceTime < 0 || sourceTime >= Number(project?.media?.screen?.duration)) {
      throw Object.assign(new Error('sourceTime 超出录屏范围'), { code: 'INVALID_PARAMS' });
    }
    const sourceFile = projectAssetFile(directory, project, 'screen');
    const outputFile = createAgentMediaFile('png');
    try {
      await media.ffmpeg(['-loglevel', 'error', '-ss', sourceTime.toFixed(3), '-i', sourceFile, '-frames:v', '1', '-f', 'image2', outputFile]);
      expireAgentMediaFile(outputFile);
      return { path: outputFile, mimeType: 'image/png', sourceTime };
    } catch (error) {
      try { fs.unlinkSync(outputFile); } catch { /* No frame was produced. */ }
      throw error;
    }
  });
  ipcMain.handle('agent:audio-excerpt', async (event, payload = {}) => {
    const directory = requireEditorRequest(event, payload.directory);
    const project = payload.project;
    let trackName = payload.track;
    if (trackName && typeof trackName === 'object') {
      trackName = ['microphone', 'systemAudio'].find((name) => project?.media?.[name]?.file === trackName.file);
    }
    const sourceStart = Number(payload.sourceStart);
    const sourceDuration = Number(payload.sourceDuration || payload.duration);
    const speed = Number(payload.speed) || 1;
    const timeDomain = payload.timeDomain === 'output' ? 'output' : 'source';
    if (timeDomain === 'output') {
      const sourceEnd = sourceStart + sourceDuration;
      const isRetained = (project?.timeline?.segments || []).some((segment) => sourceStart >= segment.sourceStart - 1e-6 && sourceEnd <= segment.sourceEnd + 1e-6);
      if (!isRetained) throw Object.assign(new Error('成片音频区间不能跨剪辑点'), { code: 'INVALID_PARAMS' });
    }
    return extractAgentAudio({
      directory, project, trackName, sourceStart, sourceDuration, speed,
      timeDomain, time: Number(payload.time),
    });
  });
  ipcMain.handle('agent:validate-export-output', (event, payload = {}) => {
    const directory = requireEditorRequest(event, payload.directory);
    const outputFile = path.resolve(payload.outputFile || '');
    const expectedExtension = payload.kind === 'audio' ? '.m4a' : '.mp4';
    if (!['audio', 'video'].includes(payload.kind) || path.extname(outputFile).toLowerCase() !== expectedExtension) {
      throw Object.assign(new Error('导出格式与输出扩展名不匹配'), { code: 'INVALID_PARAMS' });
    }
    if (fs.existsSync(outputFile)) throw Object.assign(new Error('导出目标已存在，不能覆盖'), { code: 'OUTPUT_EXISTS' });
    let parent;
    try { parent = fs.realpathSync(path.dirname(outputFile)); } catch { throw Object.assign(new Error('导出目录不存在'), { code: 'INVALID_PARAMS' }); }
    const resolvedOutput = path.resolve(parent, path.basename(outputFile)).toLowerCase();
    const projectFile = path.join(directory, 'project.json');
    const referenced = new Set([path.resolve(projectFile).toLowerCase()]);
    const collect = (value) => {
      if (Array.isArray(value)) return value.forEach(collect);
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'file' && typeof child === 'string') referenced.add(path.resolve(path.isAbsolute(child) ? child : path.join(directory, child)).toLowerCase());
        else collect(child);
      }
    };
    collect(payload.project);
    if (referenced.has(resolvedOutput)) throw Object.assign(new Error('不能覆盖工程文件或源素材'), { code: 'INVALID_PARAMS' });
    return { valid: true, outputFile };
  });
  ipcMain.handle('export:begin', (event, payload = {}) => {
    const directory = requireEditorRequest(event, payload.directory);
    if (activeExport || activeExportSession) return { ok: false, message: '已有导出任务正在运行' };
    activeExportSession = { directory: path.resolve(directory), sender: event.sender };
    return { ok: true };
  });
  ipcMain.handle('export:end', (event, payload = {}) => {
    const directory = editorDirectoryForSender(event.sender);
    if (!activeExportSession || !directory || activeExportSession.sender !== event.sender || path.resolve(directory).toLowerCase() !== path.resolve(payload.directory || '').toLowerCase()) {
      return { ok: false };
    }
    activeExportSession = null;
    return { ok: true };
  });
  ipcMain.handle('recorder:displays', () => listDisplays());
  ipcMain.handle('recorder:windows', (event, refresh = false) => refresh ? refreshWindows() : listWindows());
  ipcMain.handle('recorder:pick-area', () => pickArea());
  ipcMain.handle('recorder:pick-window', () => new Promise((resolve) => {
    const parent = recorderWindow && !recorderWindow.isDestroyed() ? recorderWindow : null;
    const parentBounds = parent ? parent.getBounds() : null;
    const workArea = (parentBounds ? screen.getDisplayMatching(parentBounds) : screen.getPrimaryDisplay()).workArea;
    const sourceBounds = parentBounds || workArea;
    const width = Math.min(960, workArea.width);
    const height = Math.min(760, workArea.height);
    const x = Math.round(Math.max(workArea.x, Math.min(sourceBounds.x + (sourceBounds.width - width) / 2, workArea.x + workArea.width - width)));
    const y = Math.round(Math.max(workArea.y, Math.min(sourceBounds.y + (sourceBounds.height - height) / 2, workArea.y + workArea.height - height)));
    const picker = createWindow('picker.html', { width, height, x, y, parent: parent || undefined, title: '选择要录制的窗口' });
    picker.once('ready-to-show', () => picker.show());
    const onDone = (event, choice) => {
      if (event.sender !== picker.webContents) return;
      ipcMain.removeListener('picker:done', onDone);
      resolve(choice);
      picker.close();
    };
    ipcMain.on('picker:done', onDone);
    picker.on('closed', () => { ipcMain.removeListener('picker:done', onDone); resolve(null); });
  }));

  /// 设备菜单用原生菜单弹出，录制条窗口就不需要为下拉面板预留透明区域。
  ipcMain.handle('recorder:menu', (event, items) => new Promise((resolve) => {
    let chosen = null;
    const menu = Menu.buildFromTemplate(items.map((item) => (item.separator
      ? { type: 'separator' }
      : { label: item.label, type: item.checked === undefined ? 'normal' : 'checkbox', checked: Boolean(item.checked), enabled: item.enabled !== false, click: () => { chosen = item.id; } })));
    menu.popup({ window: BrowserWindow.fromWebContents(event.sender), callback: () => resolve(chosen) });
  }));

  // 录制分两步启动：先建好项目目录，让录制条把摄像头、麦克风、系统声音先录起来，
  // 再开始屏幕采集。这样附加轨一定早于屏幕首帧，成片从第一帧起就有画中画和声音。
  ipcMain.handle('recorder:prepare', (event, { selection, frameRate }) => {
    if (hasRecordingWork()) throw new Error('当前录制尚未结束，不能开始另一段录制');
    if (!environment.ok) throw new Error(environment.reason);
    fs.mkdirSync(projectsRoot(), { recursive: true });
    preparing = new RecordingSession({
      projectsRoot: projectsRoot(), selection, frameRate,
      hideDesktopIconsDuringRecording: getHideDesktopIconsDuringRecording(),
    });
    fs.mkdirSync(preparing.mediaDirectory, { recursive: true });
    updateTrayState();
    return { mediaDirectory: preparing.mediaDirectory };
  });
  ipcMain.handle('recorder:start', async () => {
    if (!preparing) throw new Error('录制还没有准备好');
    const sessionState = preparing;
    preparing = null;
    startingRecording = sessionState;
    updateTrayState();
    setCompletionWindowsVisible(false);
    let sessionStartInvoked = false;
    let started;
    try {
      autoHideTaskbar();
      sessionStartInvoked = true;
      started = await sessionState.start();
    } catch (error) {
      if (!sessionStartInvoked) {
        try { await sessionState.discard(); } catch (cleanupError) {
          console.warn('[DogSC] 录制启动前清理失败：', cleanupError.message || cleanupError);
        }
      }
      restoreTaskbar();
      setCompletionWindowsVisible(true);
      throw error;
    } finally {
      startingRecording = null;
      updateTrayState();
    }
    recording = sessionState;
    updateTrayState();
    return started;
  });
  ipcMain.handle('recorder:marker', () => (recording && recording.addMarker() ? recording.markers.length : 0));
  ipcMain.handle('recorder:stop', async (event, tracks) => {
    if (!recording) throw new Error('当前没有在录制');
    const sessionState = recording;
    recording = null;
    finishingRecording = sessionState;
    let result;
    let finishInvoked = false;
    try {
      updateTrayState();
      restoreTaskbar();
      finishInvoked = true;
      result = await sessionState.finish(tracks, (stage) => event.sender.send('recorder:stage', stage));
    } catch (error) {
      if (!finishInvoked) {
        try { await sessionState.discard(); } catch (cleanupError) {
          console.warn('[DogSC] 结束录制失败后的清理未完成：', cleanupError.message || cleanupError);
        }
      }
      sessionState.restoreDesktopIcons();
      restoreTaskbar();
      setCompletionWindowsVisible(true);
      throw error;
    } finally {
      finishingRecording = null;
      updateTrayState();
    }
    if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.webContents.send('library:refresh');
    result.thumbnailsReady?.then(() => {
      if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.webContents.send('library:refresh');
    });
    const { media: recorded } = result.project;
    const completion = {
      directory: result.directory,
      name: result.project.name,
      duration: recorded.screen.duration,
      thumbnailUrl: fs.existsSync(path.join(result.directory, 'media', 'thumbnails.jpg'))
        ? pathToFileURL(path.join(result.directory, 'media', 'thumbnails.jpg')).href
        : '',
    };
    showRecordingComplete(completion);
    setCompletionWindowsVisible(true);
    if (result.thumbnailsReady) {
      const thumbnailPromise = result.thumbnailsReady.then((ready) => {
        if (!ready) return;
        const thumbnailUrl = pathToFileURL(path.join(result.directory, 'media', 'thumbnails.jpg')).href;
        const win = completionWindows.get(result.directory);
        if (win && !win.isDestroyed()) win.webContents.send('recording-complete:thumbnail', thumbnailUrl);
      });
      completionThumbnailPromises.set(result.directory, thumbnailPromise);
      thumbnailPromise.then(
        () => completionThumbnailPromises.delete(result.directory),
        () => completionThumbnailPromises.delete(result.directory),
      );
    }
    return {
      directory: result.directory, name: result.project.name, duration: recorded.screen.duration,
      recorded: { camera: Boolean(recorded.camera), microphone: Boolean(recorded.microphone), system: Boolean(recorded.systemAudio) },
    };
  });
  ipcMain.handle('recorder:cancel', async (event, phase = 'preparing') => {
    if (startingRecording || finishingRecording) throw new Error('录制正在启动或整理，请完成当前步骤后再取消');
    const sessionState = phase === 'recording' ? recording : preparing;
    if (!sessionState) return;
    if (recording === sessionState) recording = null;
    if (preparing === sessionState) preparing = null;
    finishingRecording = sessionState;
    try {
      try { updateTrayState(); } catch (error) {
        console.warn('[DogSC] 更新录制托盘状态失败：', error.message || error);
      }
      try { restoreTaskbar(); } catch (error) {
        console.warn('[DogSC] 恢复任务栏状态失败：', error.message || error);
      }
      await sessionState.discard();
    } finally {
      sessionState.restoreDesktopIcons();
      finishingRecording = null;
      setCompletionWindowsVisible(true);
      updateTrayState();
    }
  });

  ipcMain.handle('recording-complete:save-copy', async (event, sourceDirectory) => {
    const source = path.resolve(String(sourceDirectory || ''));
    const dialogResult = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '选择项目副本的保存位置',
      defaultPath: path.dirname(source),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!dialogResult || dialogResult.canceled || !dialogResult.filePaths || !dialogResult.filePaths[0]) return null;
    await completionThumbnailPromises.get(source);
    return copyProjectToFolder(source, dialogResult.filePaths[0]);
  });
  ipcMain.on('recorder:camera-preview', (event, { visible, deviceId }) => toggleCameraPreview(visible, deviceId));
  ipcMain.on('recorder:memo', () => toggleMemo());
  ipcMain.on('recorder:library', () => showLibrary());
  ipcMain.on('recorder:show', () => showRecorder());
  ipcMain.on('recorder:hide', () => {
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.hide();
    }
  });
  ipcMain.on('window:close', (event) => { const win = BrowserWindow.fromWebContents(event.sender); if (win) win.close(); });
  ipcMain.on('window:minimize', (event) => { const win = BrowserWindow.fromWebContents(event.sender); if (win) win.minimize(); });
  ipcMain.on('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });

  ipcMain.handle('project:list', () => listProjects());
  ipcMain.handle('project:open', (event, directory) => { openEditor(directory); });
  ipcMain.handle('project:read', (event, directory) => normalizeProject(JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8'))));
  ipcMain.handle('project:preview', async (event, directory) => {
    const project = normalizeProject(JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8')));
    const source = project.media.screen;
    const sourceFile = path.join(directory, source.file);
    if (source.width <= 1280 && source.frameRate <= 20) return sourceFile;
    return media.ensurePreview(sourceFile, path.join(directory, 'media', 'screen.preview.mp4'));
  });
  ipcMain.handle('project:write', (event, { directory, project }) => {
    // 缩略图在录制完成后后台生成；编辑器先保存时不能把已生成的封面覆盖掉。
    let nextProject = project;
    try {
      const current = JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8'));
      if (current.media && current.media.thumbnails && project.media && !project.media.thumbnails) {
        nextProject = { ...project, media: { ...project.media, thumbnails: current.media.thumbnails } };
      }
    } catch {
      // 原有保存流程继续负责报告真正的写入错误。
    }
    // 先写临时文件再改名，写到一半断电也不会留下半个 project.json。
    const target = path.join(directory, 'project.json');
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(nextProject, null, 2));
    fs.renameSync(`${target}.tmp`, target);
  });
  ipcMain.handle('project:trash', async (event, directory) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['移到回收站', '取消'], defaultId: 1, cancelId: 1,
      message: `把「${path.basename(directory, PROJECT_EXTENSION)}」移到回收站？`, detail: '项目和它的录制素材会一起进回收站，需要时可以从回收站还原。',
    });
    if (response !== 0) return false;
    await trashProject(directory);
    return true;
  });
  ipcMain.handle('project:trash-all', async (event) => {
    const projects = listProjects();
    const total = projects.length;
    if (!total) return { total: 0, moved: 0, failed: [], cancelled: false };

    const win = BrowserWindow.fromWebContents(event.sender);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['全部移到回收站', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: `把全部 ${total} 个项目移到回收站？`,
      detail: '项目和其中的录制素材会一起移到回收站，需要时可以从回收站还原。',
    });
    if (response !== 0) return { total, moved: 0, failed: [], cancelled: true };

    const result = await trashProjects(projects.map((project) => project.directory), trashProject);
    if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.webContents.send('library:refresh');
    return { ...result, cancelled: false };
  });
  ipcMain.on('project:reveal', (event, target) => shell.showItemInFolder(target));
  ipcMain.handle('clipboard:has-image', async () => {
    const items = await clipboard.read();
    return items.some((item) => (item.types || []).some((type) => /^image\//i.test(type)));
  });
  ipcMain.handle('project:rebuild-index', async (event, file) => media.buildVideoIndex(file));
  ipcMain.handle('project:import-asset', async (event, { directory, kind, file }) => {
    if (!['image', 'video', 'clipboard'].includes(kind)) throw new Error('不支持的素材类型');
    if (kind === 'clipboard') return importAsset({ directory, kind, image: await readClipboardImage(clipboard, nativeImage) }, media, nativeImage);
    if (!file) {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: kind === 'video' ? '选择动态背景视频' : '选择图片', properties: ['openFile'],
        filters: [{ name: kind === 'video' ? '视频' : '图片', extensions: kind === 'video' ? ['mp4', 'mov', 'mkv', 'webm'] : ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
      });
      if (result.canceled) return null;
      file = result.filePaths[0];
    }
    return importAsset({ directory, kind, file }, media, nativeImage);
  });
  ipcMain.handle('system:wallpapers', () => listWallpapers());
  ipcMain.handle('dialog:open-image', async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: '选择背景图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:save-export', async (event, { name, kind }) => {
    const automaticPath = automaticExportPath(name, kind);
    if (automaticPath) return automaticPath;
    const extension = kind === 'audio' ? 'm4a' : 'mp4';
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '导出', defaultPath: path.join(app.getPath('videos'), `${name}.${extension}`),
      filters: [{ name: kind === 'audio' ? 'M4A 音频' : 'MP4 视频', extensions: [extension] }],
    });
    return result.canceled ? null : result.filePath;
  });

  ipcMain.handle('export:mux', async (event, job) => {
    const directory = editorDirectoryForSender(event.sender);
    if (!directory || path.resolve(directory).toLowerCase() !== path.resolve(job.directory || '').toLowerCase()) {
      throw Object.assign(new Error('导出请求必须来自对应工程的编辑器窗口'), { code: 'WRONG_PROJECT' });
    }
    if (activeExport) throw Object.assign(new Error('已有导出编码任务正在运行'), { code: 'PROJECT_BUSY' });
    if (activeExportSession && activeExportSession.sender !== event.sender) {
      throw Object.assign(new Error('另一个编辑器正在导出'), { code: 'PROJECT_BUSY' });
    }
    if (activeExportSession && path.resolve(activeExportSession.directory).toLowerCase() !== path.resolve(job.directory || '').toLowerCase()) {
      throw Object.assign(new Error('导出工程与当前锁定工程不一致'), { code: 'WRONG_PROJECT' });
    }
    const acquiredHere = !activeExportSession;
    if (acquiredHere) activeExportSession = { directory: path.resolve(job.directory || ''), sender: event.sender };
    const exportSession = activeExportSession;
    let exportChild = null;
    try {
      const args = media.buildMuxArguments(job);
      await media.ffmpeg(args, {
        onSpawn: (child) => { exportChild = child; activeExport = child; },
        onStderr: (text) => {
          const match = /time=(\d+):(\d+):(\d+\.\d+)/.exec(text);
          if (match && !event.sender.isDestroyed()) event.sender.send('export:mux-progress', (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) / Math.max(job.outputDuration, 0.001));
        },
      });
    } finally {
      if (activeExport === exportChild) activeExport = null;
      if (acquiredHere && activeExportSession === exportSession) activeExportSession = null;
    }
    return job.outputFile;
  });
  ipcMain.on('export:cancel', (event) => { if (activeExport && activeExportSession?.sender === event.sender) activeExport.kill(); });
  ipcMain.on('shell:open', (event, target) => shell.openPath(target));
  registerPresetsIpc(ipcMain);
  registerUpdaterIpc(ipcMain, shell);
  registerConfigIpc(ipcMain, dialog);
  registerTaskbarIpc(ipcMain);
  registerShortcutsIpc(ipcMain);
}

// 同一时间只运行一个实例：再次启动时把录制条叫到前台。
if (!SELF_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showRecorder());
  app.whenReady().then(async () => {
    media.resolveBinaries(app.isPackaged ? process.resourcesPath : null);
    // 摄像头、麦克风与系统声音回环都由本应用自己的窗口请求。
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(true));
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      callback({ video: sources[0], audio: 'loopback' });
    });
    registerIpc();
    if (!SELF_TEST) {
      const userDataPath = app.getPath('userData');
      transcription = new TranscriptionManager({
        media,
        resourcesPath: app.isPackaged ? process.resourcesPath : null,
        userDataPath,
        tempDirectory: path.join(userDataPath, 'whisper-jobs'),
      });
      const endpointFile = path.resolve(process.env.RECLY_AGENT_ENDPOINT || path.join(userDataPath, 'agent-endpoint.json'));
      agentService = createAgentService({
        endpointFile,
        projectsRoot,
        listProjects,
        openEditor,
        getEditorWindow,
        isEditorSender: (sender, directory) => {
          const editor = getEditorWindow(directory);
          return Boolean(editor && editor.webContents === sender);
        },
      });
      try { await agentService.start(); } catch (error) {
        agentService = null;
        console.warn('[Agent] 本机服务启动失败：', error.message || error);
      }
    }
    setupTaskbarSafetyHooks(app);
    initShortcuts();
    initTray();
    app.on('before-quit', (event) => {
      if (hasRecordingWork()) {
        event.preventDefault();
        const win = showRecorder();
        void dialog.showMessageBox(win, {
          type: 'warning', buttons: ['继续录制'], defaultId: 0, cancelId: 0,
          message: '当前录制尚未结束', detail: '请先结束或放弃录制，再退出 Recly。',
        }).catch((error) => console.warn('[DogSC] 显示录制退出提示失败：', error.message || error));
        return;
      }
      if (drainingServices || (!agentService && !transcription)) return;
      event.preventDefault();
      drainingServices = true;
      void Promise.allSettled([agentService && agentService.close(), transcription && transcription.close()])
        .finally(() => app.quit());
    });
    if (SELF_TEST) {
      require('./selftest').run({ media, projectsRoot, createWindow, openEditor, showRecorder, showLibrary, toggleMemo, setEnvironment: (value) => { environment = value; } });
      return;
    }
    showRecorder();
    void listWindows().catch((error) => console.warn('[picker] Failed to preload window list:', error.message));
    environment = await media.checkAvailable();
    if (environment.ok) {
      try {
        environment.encoder = (await media.detectEncoder()).label;
      } catch (error) {
        environment = { ok: false, reason: error.message };
      }
    }
    if (recorderWindow) recorderWindow.webContents.send('app:environment', { ...environment, projectsRoot: projectsRoot(), version: app.getVersion() });
  });
  app.on('window-all-closed', () => { if (!SELF_TEST) app.quit(); });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    for (const sessionState of new Set([recording, preparing, startingRecording, finishingRecording].filter(Boolean))) {
      sessionState.restoreDesktopIcons();
    }
    restoreTaskbar();
  });
}

module.exports = { resourcesDirectory };
