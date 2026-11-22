'use strict';
// DogSC Windows 版主进程：窗口管理、录制调度、项目库与导出混流。

const { app, BrowserWindow, ipcMain, screen, desktopCapturer, dialog, globalShortcut, session, shell, Menu, Tray, clipboard, nativeImage, safeStorage } = require('electron');
// 当前 Windows 运行环境下硬解视频预览会停帧；关闭视频解码加速，GPU 画布仍保持启用。
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-accelerated-video-decode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const media = require('./ffmpeg');
const { createAgentService } = require('./agent-service');
const { createAssistantService } = require('./assistant-service');
const { TranscriptionManager } = require('./transcription');
const { RecordingSession, listDisplays, resolveSource, PROJECT_EXTENSION } = require('./recording');
const { copyProjectToFolder } = require('./project-copy');
const { normalizeProject } = require('../core/model');
const { outputDuration } = require('../core/timeline');

const { registerPresetsIpc } = require('./presets');
const { registerUpdaterIpc } = require('./updater');
const { getProjectsRoot, getExportRoot, getHideDesktopIconsDuringRecording, registerConfigIpc } = require('./config');
const { automaticExportPath } = require('./export-path');
const { trashProjects, trashSelectedProjects, trashEditorProject } = require('./project-trash');
const { createWindowCloseTracker } = require('./window-close-tracker');
const { importAsset, importAudio, readClipboardImage } = require('./asset-import');
const { listBuiltInMusic, importBuiltInMusic } = require('./music-library');
const { registerMaterialsIpc } = require('./materials');
const {
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
let defaultRecorderIcon = null;
let recordingRecorderIcon = null;
let recordingOverlayIcon = null;
const MEMO_MIN_WIDTH = 420;
const MEMO_MIN_HEIGHT = 160;
const MEMO_HEADER_TOP = 6;
const MEMO_HEADER_HEIGHT = 38;
const MEMO_HEADER_EDGE_GUTTER = 12;
// 自测产生的项目放在临时目录，不进用户的项目库。
const projectsRoot = () => (SELF_TEST ? path.join(app.getPath('temp'), 'dogsc-selftest') : getProjectsRoot());

let tray = null;
let recorderWindow = null;
let recorderExpandedBounds = null;
let libraryWindow = null;
let cameraWindow = null;
const cameraWindowCloseTracker = createWindowCloseTracker();
let cameraPreviewRequest = { visible: false, deviceId: null, requestId: 0 };
let memoWindow = null;
let memoResizeState = null;
let memoEditing = false;
let memoMouseEventsIgnored = false;
let memoMouseThroughTimer = null;
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
let assistantService = null;

function getAssistantService() {
  if (!assistantService) assistantService = createAssistantService({ workDirectory: path.join(app.getPath('userData'), 'assistant-work'), safeStorage });
  return assistantService;
}
let transcription = null;
let drainingServices = false;

function hasRecordingWork() {
  return Boolean(recording || preparing || startingRecording || finishingRecording);
}

function getRecorderIcon(recordingActive) {
  if (!defaultRecorderIcon) defaultRecorderIcon = nativeImage.createFromPath(windowsIconPath);
  if (!recordingActive || process.platform !== 'win32' || defaultRecorderIcon.isEmpty()) return defaultRecorderIcon;
  if (recordingRecorderIcon) return recordingRecorderIcon;

  const size = 64;
  const bitmap = Buffer.from(defaultRecorderIcon.resize({ width: size, height: size, quality: 'best' }).toBitmap());
  const overlay = Buffer.alloc(size * size * 4);
  const centerX = 52;
  const centerY = 12;
  const innerRadius = 7.8;
  const outerRadius = 10.5;
  const samplesPerAxis = 4;
  const sampleCount = samplesPerAxis * samplesPerAxis;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let redSamples = 0;
      let whiteSamples = 0;
      for (let sampleY = 0; sampleY < samplesPerAxis; sampleY += 1) {
        for (let sampleX = 0; sampleX < samplesPerAxis; sampleX += 1) {
          const dx = x + (sampleX + 0.5) / samplesPerAxis - centerX;
          const dy = y + (sampleY + 0.5) / samplesPerAxis - centerY;
          const distance = Math.hypot(dx, dy);
          if (distance <= innerRadius) redSamples += 1;
          else if (distance <= outerRadius) whiteSamples += 1;
        }
      }
      const coverage = (redSamples + whiteSamples) / sampleCount;
      if (!coverage) continue;

      // Windows NativeImage bitmap buffers use BGRA channel order.
      const index = (y * size + x) * 4;
      const coveredSamples = redSamples + whiteSamples;
      overlay[index] = Math.round((48 * redSamples + 255 * whiteSamples) / coveredSamples);
      overlay[index + 1] = Math.round((55 * redSamples + 255 * whiteSamples) / coveredSamples);
      overlay[index + 2] = 255;
      overlay[index + 3] = Math.round(255 * coverage);
      const remaining = 1 - coverage;
      bitmap[index] = Math.round((48 * redSamples + 255 * whiteSamples) / sampleCount + bitmap[index] * remaining);
      bitmap[index + 1] = Math.round((55 * redSamples + 255 * whiteSamples) / sampleCount + bitmap[index + 1] * remaining);
      bitmap[index + 2] = Math.round((255 * (redSamples + whiteSamples)) / sampleCount + bitmap[index + 2] * remaining);
      bitmap[index + 3] = Math.round(255 * coverage + bitmap[index + 3] * remaining);
    }
  }

  recordingRecorderIcon = nativeImage.createFromBitmap(bitmap, { width: size, height: size, scaleFactor: 1 });
  recordingOverlayIcon = nativeImage.createFromBitmap(overlay, { width: size, height: size, scaleFactor: 1 })
    .crop({ x: 40, y: 0, width: 24, height: 24 }).resize({ width: 16, height: 16, quality: 'best' });
  return recordingRecorderIcon.isEmpty() ? defaultRecorderIcon : recordingRecorderIcon;
}

function updateRecorderTaskbarIcon() {
  if (!recorderWindow || recorderWindow.isDestroyed()) return;
  const active = Boolean(recording);
  const icon = getRecorderIcon(active);
  if (!icon.isEmpty()) recorderWindow.setIcon(icon);
  if (process.platform === 'win32') recorderWindow.setOverlayIcon(active ? recordingOverlayIcon : null, active ? '正在录制' : '');
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

// 空闲时允许截图，录制期间排除控制窗口，避免它们进入成片。
function excludeFromCapture(win, keepOnTop = false) {
  win.setContentProtection(hasRecordingWork());
  if (keepOnTop) win.setAlwaysOnTop(true, 'screen-saver');
}

function updateTrayState() {
  updateRecorderTaskbarIcon();
  for (const win of [recorderWindow, cameraWindow, memoWindow, ...completionWindows.values()]) {
    if (win && !win.isDestroyed()) win.setContentProtection(hasRecordingWork());
  }
  if (!tray || tray.isDestroyed()) return;
  tray.setImage(getRecorderIcon(Boolean(recording)));
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
        if (recorderWindow.isVisible() && !recorderWindow.isMinimized()) {
          recorderWindow.hide();
        } else {
          if (recorderWindow.isMinimized()) recorderWindow.restore();
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
    if (recorderWindow.isMinimized()) recorderWindow.restore();
    recorderWindow.show();
    recorderWindow.focus();
    return recorderWindow;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = 800;
  const height = 600;
  recorderWindow = createWindow('recorder.html', {
    width, height,
    useContentSize: true,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    center: true,
    frame: false, transparent: true, resizable: true, minWidth: 720, minHeight: 540, maximizable: false, fullscreenable: false, skipTaskbar: false, hasShadow: false,
    title: 'Recly',
  });
  recorderExpandedBounds = null;
  updateRecorderTaskbarIcon();
  recorderWindow.setIgnoreMouseEvents(false);
  excludeFromCapture(recorderWindow);
  recorderWindow.once('ready-to-show', () => recorderWindow.show());
  recorderWindow.on('show', () => {
    recorderWindow.setSkipTaskbar(false);
    updateRecorderTaskbarIcon();
    if (!recorderWindow.webContents.isLoading()) {
      recorderWindow.webContents.send('recorder:shown');
      recorderWindow.webContents.send('recorder:memo-state', Boolean(memoWindow && !memoWindow.isDestroyed()));
    }
  });
  recorderWindow.on('restore', updateRecorderTaskbarIcon);
  recorderWindow.on('hide', () => {
    if (!recorderWindow.webContents.isLoading()) recorderWindow.webContents.send('recorder:hidden');
  });
  recorderWindow.on('close', (event) => {
    if (hasRecordingWork()) {
      event.preventDefault();
      recorderWindow.minimize();
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

function showRecorderHistory() {
  const win = showRecorder();
  const sendHistoryRequest = () => {
    if (recorderWindow === win && !win.isDestroyed()) win.webContents.send('recorder:show-history');
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', sendHistoryRequest);
  else sendHistoryRequest();
}

function ensureRecorderTaskbarPresence() {
  if (!recorderWindow || recorderWindow.isDestroyed()
    || recorderWindow.isVisible() || recorderWindow.isMinimized()) return false;
  recorderWindow.showInactive();
  recorderWindow.minimize();
  return true;
}

function hideRecorderForEditor() {
  if (!recorderWindow || recorderWindow.isDestroyed()) return;
  recorderWindow.setSkipTaskbar(true);
  recorderWindow.hide();
}

function openEditor(directory) {
  const existing = editorWindows.get(directory);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    hideRecorderForEditor();
    return existing;
  }
  const area = recorderWindow && !recorderWindow.isDestroyed()
    ? screen.getDisplayMatching(recorderWindow.getBounds()).workArea
    : screen.getPrimaryDisplay().workArea;
  const width = Math.min(area.width, Math.max(960, Math.round(area.width * 0.7)));
  const height = Math.min(area.height, Math.max(540, Math.round(area.height * 0.78)));
  const win = createWindow('editor.html', { width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), minWidth: Math.min(960, area.width), minHeight: Math.min(540, area.height), frame: false, title: `${path.basename(directory, PROJECT_EXTENSION)} — Recly` }, { project: directory });
  const editorSender = win.webContents;
  const editorSenderId = editorSender.id;
  editorSender.once('destroyed', () => {
    if (assistantService) assistantService.cancel(editorSenderId);
    if (activeExportSession?.sender !== editorSender) return;
    activeExportSession = null;
    // Keep the encoder lock until its process has actually stopped.
    if (activeExport) activeExport.kill();
  });
  win.webContents.once('did-finish-load', () => {
    win.show();
    hideRecorderForEditor();
  });
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

function sendCameraDeviceRequest(win) {
  const request = cameraPreviewRequest;
  if (!request.visible || !request.requestId || cameraWindow !== win || win.isDestroyed()) return;
  win.webContents.send('camera:device', { deviceId: request.deviceId, requestId: request.requestId });
}

function toggleCameraPreview(visible, deviceId, requestId) {
  cameraPreviewRequest = { visible, deviceId, requestId };
  if (!visible) {
    const closingWindow = cameraWindow;
    const closePromise = cameraWindowCloseTracker.close(closingWindow);
    cameraWindow = null;
    return closePromise;
  }
  if (cameraWindow && !cameraWindow.isDestroyed()) {
    if (!cameraWindow.webContents.isLoading()) sendCameraDeviceRequest(cameraWindow);
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const newCameraWindow = createWindow('camera.html', {
    width: 240, height: 240, x: area.x + area.width - 240 - 36, y: area.y + 36,
    frame: false, transparent: true, resizable: false, skipTaskbar: true, hasShadow: false, focusable: false,
  });
  cameraWindow = newCameraWindow;
  excludeFromCapture(newCameraWindow, true);
  newCameraWindow.once('ready-to-show', () => {
    newCameraWindow.showInactive();
  });
  newCameraWindow.webContents.once('did-finish-load', () => sendCameraDeviceRequest(newCameraWindow));
  newCameraWindow.on('closed', () => {
    if (cameraWindow === newCameraWindow) cameraWindow = null;
  });
}

function toggleMemo() {
  if (memoWindow && !memoWindow.isDestroyed()) {
    memoWindow.close();
    if (recorderWindow && !recorderWindow.isDestroyed()) recorderWindow.webContents.send('recorder:memo-state', false);
    return;
  }
  const area = recorderWindow && !recorderWindow.isDestroyed()
    ? screen.getDisplayMatching(recorderWindow.getBounds()).workArea
    : screen.getPrimaryDisplay().workArea;
  const width = 560;
  const height = 360;
  const store = path.join(app.getPath('userData'), 'memo.json');
  let initialMemoEditing = true;
  try {
    const savedMemo = JSON.parse(fs.readFileSync(store, 'utf8'));
    initialMemoEditing = typeof savedMemo.text !== 'string' || !savedMemo.text.trim();
  } catch {
    // 首次使用时默认可编辑。
  }
  const newMemoWindow = createWindow('memo.html', {
    width, height, minWidth: MEMO_MIN_WIDTH, minHeight: MEMO_MIN_HEIGHT, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
    frame: false, transparent: true, resizable: true, skipTaskbar: true, hasShadow: false,
  }, { store });
  memoWindow = newMemoWindow;
  memoEditing = initialMemoEditing;
  memoMouseEventsIgnored = false;
  if (memoMouseThroughTimer) clearInterval(memoMouseThroughTimer);
  memoMouseThroughTimer = setInterval(syncMemoMouseThrough, 16);
  syncMemoMouseThrough();
  excludeFromCapture(newMemoWindow, true);
  newMemoWindow.once('ready-to-show', () => {
    if (memoWindow !== newMemoWindow) return;
    newMemoWindow.show();
    if (recorderWindow && !recorderWindow.isDestroyed()) recorderWindow.webContents.send('recorder:memo-state', true);
  });
  newMemoWindow.on('closed', () => {
    if (memoWindow === newMemoWindow) {
      memoWindow = null;
      if (memoMouseThroughTimer) clearInterval(memoMouseThroughTimer);
      memoMouseThroughTimer = null;
      memoEditing = false;
      memoMouseEventsIgnored = false;
    }
    memoResizeState = null;
    if (recorderWindow && !recorderWindow.isDestroyed()) recorderWindow.webContents.send('recorder:memo-state', false);
  });
}

function syncMemoMouseThrough() {
  const win = memoWindow;
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const cursor = screen.getCursorScreenPoint();
  const inHeader = cursor.x >= bounds.x + MEMO_HEADER_EDGE_GUTTER
    && cursor.x < bounds.x + bounds.width - MEMO_HEADER_EDGE_GUTTER
    && cursor.y >= bounds.y + MEMO_HEADER_TOP
    && cursor.y < bounds.y + MEMO_HEADER_TOP + MEMO_HEADER_HEIGHT;
  const ignore = !memoEditing && !inHeader;
  if (memoMouseEventsIgnored === ignore) return;
  memoMouseEventsIgnored = ignore;
  win.setIgnoreMouseEvents(ignore, { forward: true });
}

function closeRecordingOverlays() {
  try {
    toggleCameraPreview(false, cameraPreviewRequest.deviceId, cameraPreviewRequest.requestId);
  } catch (error) {
    console.warn('[DogSC] 摄像头预览窗口关闭失败：', error.message || error);
  }
  const closingMemo = memoWindow;
  memoWindow = null;
  memoResizeState = null;
  if (memoMouseThroughTimer) clearInterval(memoMouseThroughTimer);
  memoMouseThroughTimer = null;
  memoEditing = false;
  memoMouseEventsIgnored = false;
  if (closingMemo && !closingMemo.isDestroyed()) closingMemo.close();
}

function beginMemoResize(event, payload = {}) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const edge = String(payload.edge || '');
  if (!win || win !== memoWindow || !/^(n|s|e|w|ne|nw|se|sw)$/.test(edge)) return;
  memoResizeState = {
    win,
    edge,
    startX: Number(payload.screenX) || 0,
    startY: Number(payload.screenY) || 0,
    bounds: win.getBounds(),
  };
}

function updateMemoResize(event, payload = {}) {
  const state = memoResizeState;
  if (!state || state.win.isDestroyed() || event.sender !== state.win.webContents) return;
  const deltaX = (Number(payload.screenX) || 0) - state.startX;
  const deltaY = (Number(payload.screenY) || 0) - state.startY;
  const next = { ...state.bounds };
  const minWidth = MEMO_MIN_WIDTH;
  const minHeight = MEMO_MIN_HEIGHT;

  if (state.edge.includes('e')) next.width = Math.max(minWidth, state.bounds.width + deltaX);
  if (state.edge.includes('s')) next.height = Math.max(minHeight, state.bounds.height + deltaY);
  if (state.edge.includes('w')) {
    next.width = Math.max(minWidth, state.bounds.width - deltaX);
    next.x = state.bounds.x + state.bounds.width - next.width;
  }
  if (state.edge.includes('n')) {
    next.height = Math.max(minHeight, state.bounds.height - deltaY);
    next.y = state.bounds.y + state.bounds.height - next.height;
  }
  state.win.setBounds(next, false);
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
      const project = normalizeProject(JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8')));
      const recordingFile = path.join(directory, project.media.screen.file);
      const recordingSize = fs.existsSync(recordingFile) ? fs.statSync(recordingFile).size : 0;
      projects.push({
        directory,
        name: project.name || path.basename(directory, PROJECT_EXTENSION),
        createdAt: project.createdAt,
        duration: outputDuration(project.timeline.segments),
        width: project.media.screen.width,
        height: project.media.screen.height,
        recordingFile,
        sizeText: formatFileSize(recordingSize),
        thumbnails: project.media.thumbnails ? { ...project.media.thumbnails, file: path.join(directory, project.media.thumbnails.file) } : null,
      });
    } catch { /* 录制未完成或已损坏的目录不列出 */ }
  }
  return projects.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function formatFileSize(size) {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

async function trashProject(directory) {
  const editor = getEditorWindow(directory);
  await trashEditorProject(editor, directory, (projectDirectory) => shell.trashItem(projectDirectory));
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
  ipcMain.handle('assistant:api-config', (event) => {
    if (!editorDirectoryForSender(event.sender)) throw new Error('请从编辑器打开 AI 助手');
    return getAssistantService().getApiConfig();
  });
  ipcMain.handle('assistant:api-save', (event, payload = {}) => {
    if (!editorDirectoryForSender(event.sender)) throw new Error('请从编辑器打开 AI 助手');
    return getAssistantService().saveApiConfig(payload);
  });
  ipcMain.handle('assistant:api-clear', (event) => {
    if (!editorDirectoryForSender(event.sender)) throw new Error('请从编辑器打开 AI 助手');
    return getAssistantService().clearApiConfig();
  });
  ipcMain.handle('assistant:detect', (event) => {
    if (!editorDirectoryForSender(event.sender)) throw new Error('请从编辑器打开 AI 助手');
    return getAssistantService().detect();
  });
  ipcMain.handle('assistant:send', (event, payload = {}) => {
    requireEditorRequest(event, payload.directory);
    return getAssistantService().send(payload, event.sender.id);
  });
  ipcMain.handle('assistant:cancel', (event) => {
    if (!editorDirectoryForSender(event.sender)) throw new Error('无效的编辑器窗口');
    if (assistantService) assistantService.cancel(event.sender.id);
    return true;
  });
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

  ipcMain.handle('recorder:warmup', async (event, { selection, frameRate }) => {
    if (!recorderWindow || recorderWindow.isDestroyed() || event.sender !== recorderWindow.webContents) throw new Error('无权准备录制');
    if (!environment.ok) throw new Error(environment.reason);
    if (hasRecordingWork()) throw new Error('当前录制尚未结束');
    const source = resolveSource(selection, false);
    return media.prepareCapture({ source: source.capture, fps: frameRate, width: source.width, height: source.height });
  });

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
    let started;
    try {
      started = await sessionState.start();
      recording = sessionState;
    } catch (error) {
      restoreTaskbar();
      setCompletionWindowsVisible(true);
      throw error;
    } finally {
      startingRecording = null;
      updateTrayState();
    }
    updateTrayState();
    return started;
  });
  ipcMain.handle('recorder:commit-start', (event) => {
    if (!recorderWindow || recorderWindow.isDestroyed() || event.sender !== recorderWindow.webContents) {
      throw new Error('无权提交录制起点');
    }
    if (!recording) throw new Error('当前没有正在录制的会话');
    return { officialStartOffset: recording.commitStart() };
  });
  ipcMain.handle('recorder:stop', async (event, tracks) => {
    if (!recording) throw new Error('当前没有在录制');
    const sessionState = recording;
    recording = null;
    finishingRecording = sessionState;
    closeRecordingOverlays();
    let result;
    let finishInvoked = false;
    try {
      updateTrayState();
      restoreTaskbar();
      // 用户可能在录制期间把主控台收进托盘。整理素材时恢复一个最小化的
      // 任务栏入口，但不抢焦点；编辑器真正显示后再由 openEditor 隐藏它。
      ensureRecorderTaskbarPresence();
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
      showRecorder();
      throw error;
    } finally {
      finishingRecording = null;
      updateTrayState();
    }
    if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.webContents.send('library:refresh');
    result.thumbnailsReady?.then(() => {
      if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.webContents.send('library:refresh');
    });
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
    const { media: recorded } = result.project;
    openEditor(result.directory);
    return {
      directory: result.directory, name: result.project.name, duration: result.outputDuration,
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
    closeRecordingOverlays();
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
      showRecorder();
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
  ipcMain.on('recorder:camera-preview', (event, { visible, deviceId, requestId }) => {
    try {
      toggleCameraPreview(visible, deviceId, requestId);
    } catch (error) {
      console.warn('[DogSC] 摄像头预览窗口关闭失败：', error.message || error);
    }
  });
  ipcMain.handle('recorder:release-camera-preview', async () => {
    await toggleCameraPreview(false, cameraPreviewRequest.deviceId, cameraPreviewRequest.requestId);
    await cameraWindowCloseTracker.waitForPending();
  });
  ipcMain.on('camera:preview-frame', (event, frame) => {
    if (!recorderWindow || recorderWindow.isDestroyed() || event.sender !== recorderWindow.webContents) return;
    if (!cameraWindow || cameraWindow.isDestroyed() || !cameraPreviewRequest.visible) return;
    if (!frame || frame.requestId !== cameraPreviewRequest.requestId || typeof frame.dataUrl !== 'string') return;
    if (frame.dataUrl.length > 256 * 1024 || !frame.dataUrl.startsWith('data:image/jpeg;base64,')) return;
    if (!cameraWindow.webContents.isLoading()) cameraWindow.webContents.send('camera:frame', frame);
  });
  ipcMain.on('camera:status', (event, status) => {
    if (!status || !cameraWindow || cameraWindow.isDestroyed()) return;
    if (event.sender !== cameraWindow.webContents || status.requestId !== cameraPreviewRequest.requestId || !cameraPreviewRequest.visible) return;
    if (recorderWindow && !recorderWindow.isDestroyed()) recorderWindow.webContents.send('camera:status', status);
  });
  ipcMain.on('recorder:memo', () => toggleMemo());
  ipcMain.on('recorder:close-overlays', closeRecordingOverlays);
  ipcMain.on('memo:resize-start', beginMemoResize);
  ipcMain.on('memo:resize-move', updateMemoResize);
  ipcMain.on('memo:resize-end', (event) => {
    if (memoResizeState && event.sender === memoResizeState.win.webContents) memoResizeState = null;
  });
  ipcMain.on('memo:editing', (event, editing) => {
    const win = memoWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents || typeof editing !== 'boolean') return;
    memoEditing = editing;
    syncMemoMouseThrough();
  });
  ipcMain.on('recorder:library', () => showRecorderHistory());
  ipcMain.handle('recorder:set-collapsed', (event, { collapsed, height }) => {
    const win = recorderWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) throw new Error('录制窗口不可用');
    if (collapsed) {
      if (!recorderExpandedBounds) recorderExpandedBounds = win.getBounds();
      const compactHeight = Math.max(160, Math.min(350, Math.ceil(Number(height) || 200)));
      win.setResizable(true);
      win.setMinimumSize(720, compactHeight);
      win.setSize(win.getBounds().width, compactHeight);
    } else if (recorderExpandedBounds) {
      const current = win.getBounds();
      const area = screen.getDisplayMatching(current).workArea;
      const expandedHeight = Math.min(recorderExpandedBounds.height, area.height);
      win.setResizable(true);
      win.setMinimumSize(720, 540);
      win.setBounds({ ...current, y: Math.max(area.y, Math.min(current.y, area.y + area.height - expandedHeight)), height: expandedHeight });
      recorderExpandedBounds = null;
    }
    return win.getBounds();
  });
  ipcMain.on('recorder:show', () => showRecorder());
  ipcMain.on('recorder:hide', () => {
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.setAlwaysOnTop(false);
      recorderWindow.setIgnoreMouseEvents(false);
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
  ipcMain.handle('recording:exports-list', () => {
    const directory = getExportRoot();
    if (!directory || !fs.existsSync(directory)) return { directory, items: [] };
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return { directory, items: [] }; }
    const items = entries.filter((entry) => entry.isFile() && /\.(mp4|mkv|mov|webm)$/i.test(entry.name)).map((entry) => {
      const file = path.join(directory, entry.name);
      try {
        const stat = fs.statSync(file);
        return { file, name: entry.name, modifiedAt: stat.mtimeMs, sizeText: formatFileSize(stat.size) };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { directory, items: items.slice(0, 30) };
  });
  ipcMain.handle('recording:export-trash', async (event, file) => {
    const directory = getExportRoot();
    if (!directory || typeof file !== 'string') return false;
    const root = path.resolve(directory);
    const target = path.resolve(file);
    if (path.dirname(target).toLowerCase() !== root.toLowerCase() || !/\.(mp4|mkv|mov|webm)$/i.test(target) || !fs.existsSync(target) || !fs.lstatSync(target).isFile()) return false;
    const win = BrowserWindow.fromWebContents(event.sender);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['移到回收站', '取消'], defaultId: 1, cancelId: 1,
      message: `把「${path.basename(target)}」移到回收站？`, detail: '需要时可以从回收站还原。',
    });
    if (response !== 0) return false;
    await shell.trashItem(target);
    return true;
  });
  ipcMain.handle('project:open', (event, directory) => { openEditor(directory); });
  ipcMain.handle('project:read', (event, directory) => normalizeProject(JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8'))));
  ipcMain.handle('project:preview', async (event, directory) => {
    const project = normalizeProject(JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8')));
    const source = project.media.screen;
    const sourceFile = path.join(directory, source.file);
    if (source.width <= 1280 && source.frameRate <= 20) return sourceFile;
    return media.ensurePreview(sourceFile, path.join(directory, source.preview || 'media/screen.preview.v3.mp4'));
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
  ipcMain.handle('project:trash-selected', async (event, directories) => {
    return trashSelectedProjects({
      requestedDirectories: directories,
      availableDirectories: listProjects().map((project) => project.directory),
      confirm: async (total) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        const { response } = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['移到回收站', '取消'],
          defaultId: 1,
          cancelId: 1,
          message: `把选中的 ${total} 个项目移到回收站？`,
          detail: '项目和其中的录制素材会一起移到回收站，需要时可以从回收站还原。',
        });
        return response === 0;
      },
      trashProject,
    });
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
  const musicRoot = app.isPackaged ? path.join(process.resourcesPath, 'music') : path.join(__dirname, '..', '..', 'assets', 'music');
  ipcMain.handle('music:list', (event, { directory }) => {
    requireEditorRequest(event, directory);
    return listBuiltInMusic(musicRoot);
  });
  ipcMain.handle('music:add', (event, { directory, id }) => {
    const projectDirectory = requireEditorRequest(event, directory);
    return importBuiltInMusic({ root: musicRoot, directory: projectDirectory, id }, media);
  });
  ipcMain.handle('project:import-audio', async (event, { directory }) => {
    const projectDirectory = requireEditorRequest(event, directory);
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '添加音乐或音频', properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'webm', 'flac', 'mp4'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return importAudio({ directory: projectDirectory, file: result.filePaths[0] }, media);
  });
  ipcMain.handle('project:save-audio-recording', async (event, { directory, data }) => {
    const projectDirectory = requireEditorRequest(event, directory);
    const validData = data instanceof Uint8Array || data instanceof ArrayBuffer;
    if (!validData) throw Object.assign(new Error('配音数据无效'), { code: 'INVALID_PARAMS' });
    const buffer = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    if (!buffer.length || buffer.length > 256 * 1024 * 1024) throw Object.assign(new Error('配音文件为空或超过 256 MB'), { code: 'INVALID_PARAMS' });
    return importAudio({ directory: projectDirectory, buffer, name: '配音' }, media);
  });
  ipcMain.handle('system:wallpapers', () => listWallpapers());
  registerMaterialsIpc({ ipcMain, app, safeStorage, dialog, BrowserWindow, nativeImage, media, editorDirectoryForSender });
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
  ipcMain.handle('shell:open-url', async (_event, target) => {
    try {
      const url = new URL(String(target));
      if (url.protocol !== 'https:') return false;
      await shell.openExternal(url.href);
      return true;
    } catch {
      return false;
    }
  });
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
      if (drainingServices || (!agentService && !transcription && !assistantService)) return;
      event.preventDefault();
      drainingServices = true;
      void Promise.allSettled([agentService && agentService.close(), transcription && transcription.close(), assistantService && assistantService.close()])
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
