'use strict';
// DogSC Windows 版主进程：窗口管理、录制调度、项目库与导出混流。

const { app, BrowserWindow, ipcMain, screen, desktopCapturer, dialog, globalShortcut, session, shell, Menu, Tray } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const media = require('./ffmpeg');
const { RecordingSession, listDisplays, PROJECT_EXTENSION } = require('./recording');
const { normalizeProject } = require('../core/model');

const { registerPresetsIpc } = require('./presets');
const { registerUpdaterIpc } = require('./updater');
const { getProjectsRoot, registerConfigIpc } = require('./config');
const { trashProjects } = require('./project-trash');
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
let environment = { ok: false, reason: '正在检查 ffmpeg…' };
let activeExport = null;

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
  const isRecording = Boolean(recording);
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
  const height = 580;
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
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.on('closed', () => {
    editorWindows.delete(directory);
    if (editorWindows.size === 0 && recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.show();
    }
  });
  editorWindows.set(directory, win);
  return win;
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
    if (recording) throw new Error('已经在录制中');
    if (!environment.ok) throw new Error(environment.reason);
    if (preparing) fs.rmSync(preparing.directory, { recursive: true, force: true });
    fs.mkdirSync(projectsRoot(), { recursive: true });
    preparing = new RecordingSession({ projectsRoot: projectsRoot(), selection, frameRate });
    fs.mkdirSync(preparing.mediaDirectory, { recursive: true });
    return { mediaDirectory: preparing.mediaDirectory };
  });
  ipcMain.handle('recorder:start', async () => {
    if (!preparing) throw new Error('录制还没有准备好');
    const sessionState = preparing;
    preparing = null;
    autoHideTaskbar();
    let started;
    try {
      started = await sessionState.start();
    } catch (error) {
      restoreTaskbar();
      throw error;
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
    updateTrayState();
    restoreTaskbar();
    const result = await sessionState.finish(tracks, (stage) => event.sender.send('recorder:stage', stage));
    if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.webContents.send('library:refresh');
    result.thumbnailsReady?.then(() => {
      if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.webContents.send('library:refresh');
    });
    const { media: recorded } = result.project;
    return {
      directory: result.directory, name: result.project.name, duration: recorded.screen.duration,
      recorded: { camera: Boolean(recorded.camera), microphone: Boolean(recorded.microphone), system: Boolean(recorded.systemAudio) },
    };
  });
  ipcMain.handle('recorder:cancel', async () => {
    if (!recording) return;
    const sessionState = recording;
    recording = null;
    updateTrayState();
    restoreTaskbar();
    await sessionState.discard();
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
  ipcMain.handle('project:rebuild-index', async (event, file) => media.buildVideoIndex(file));
  ipcMain.handle('system:wallpapers', () => listWallpapers());
  ipcMain.handle('dialog:open-image', async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: '选择背景图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:save-export', async (event, { name, kind }) => {
    const extension = kind === 'audio' ? 'm4a' : 'mp4';
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '导出', defaultPath: path.join(app.getPath('videos'), `${name}.${extension}`),
      filters: [{ name: kind === 'audio' ? 'M4A 音频' : 'MP4 视频', extensions: [extension] }],
    });
    return result.canceled ? null : result.filePath;
  });

  ipcMain.handle('export:mux', async (event, job) => {
    const args = media.buildMuxArguments(job);
    try {
      await media.ffmpeg(args, {
        onSpawn: (child) => { activeExport = child; },
        onStderr: (text) => {
          const match = /time=(\d+):(\d+):(\d+\.\d+)/.exec(text);
          if (match) event.sender.send('export:mux-progress', (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) / Math.max(job.outputDuration, 0.001));
        },
      });
    } finally {
      activeExport = null;
    }
    return job.outputFile;
  });
  ipcMain.on('export:cancel', () => { if (activeExport) activeExport.kill(); });
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
    setupTaskbarSafetyHooks(app);
    initShortcuts();
    initTray();
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
    restoreTaskbar();
  });
}

module.exports = { resourcesDirectory };
