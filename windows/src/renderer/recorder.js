'use strict';
// DogSC Bandicam-style 录屏主控制台
// 屏幕画面由主进程 ffmpeg 采集；摄像头、麦克风、系统声音用 MediaRecorder 写成文件并按时钟对齐。

const fs = require('node:fs');
const path = require('node:path');
const { ipcRenderer } = require('electron');
const { icon } = require('./common');
const { createHistorySelection } = require('./history-selection');
const { watchCameraPreview } = require('./camera-preview-health');

let openShortcutsModal = null;
try {
  openShortcutsModal = require('./editor/shortcuts-modal').openShortcutsModal;
} catch {
  // 快捷键面板将在模块准备就绪后动态引入
}

const $ = (id) => document.getElementById(id);
document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-external-url]');
  if (link) {
    event.preventDefault();
    void ipcRenderer.invoke('shell:open-url', link.href);
  }
});
const settingsKey = 'dogsc.recorder';
const saved = JSON.parse(localStorage.getItem(settingsKey) || '{}');
let cameraRequestSequence = 0;
let microphoneDeviceTipTimer = null;

const state = {
  environment: { ok: false, reason: '正在检查 ffmpeg…' },
  displays: [],
  selection: { kind: 'display', displayId: null },
  selectionLabel: '',
  mic: { on: saved.mic ?? true, deviceId: saved.micId || null, permissionError: null },
  cam: { on: Boolean(saved.cam), deviceId: saved.camId || null, requestId: 0, previewStatus: 'off', previewError: null, previewMessage: '', captureFailed: false },
  cameraQuality: ['4k', '1080p', '720p'].includes(saved.cameraQuality) ? saved.cameraQuality : '1080p',
  showCameraPreview: false,
  sys: { on: saved.sys ?? true },
  memoOpen: false,
  hideDesktopIcons: false,
  savingDesktopIconSetting: false,
  starting: false,
  startError: '',
  finishing: false,
  readiness: { ready: false, pending: true, reason: '正在准备录制环境…' },
  session: null,
  result: null,
  page: 'home',
  collapsed: false,
};
let lastCompactHeight = 0;
let readinessSequence = 0;

async function prepareRecordingReadiness() {
  if (!state.environment.ok || !state.displays.length || state.starting || state.session || state.finishing || state.configuring) return false;
  const request = ++readinessSequence;
  state.readiness = { ready: false, pending: true, reason: '正在准备录制设备…' };
  if (state.startError.startsWith('录制准备失败：')) state.startError = '';
  render();
  try {
    const [, inputs] = await Promise.all([
      ipcRenderer.invoke('recorder:warmup', { selection: state.selection, frameRate: 60 }),
      prepareInputStreams(),
    ]);
    if (inputs.problems.length) throw new Error(inputs.problems.join('、'));
    if (request !== readinessSequence || state.starting || state.session || state.finishing) return false;
    for (const [kind, enabled, label] of [['camera', state.cam?.on, '摄像头'], ['microphone', state.mic?.on, '麦克风'], ['system', state.sys?.on, '系统声音']]) {
      if (enabled && !inputs.streams[kind]?.getTracks().some((track) => track.readyState === 'live')) throw new Error(`${label}尚未就绪`);
    }
    state.readiness = { ready: true, pending: false, reason: '录制已就绪' };
    return true;
  } catch (error) {
    if (request !== readinessSequence) return false;
    state.readiness = { ready: false, pending: false, reason: error.message || String(error) };
    state.startError = `录制准备失败：${state.readiness.reason}。请检查或重新选择设备。`;
    return false;
  } finally {
    if (request === readinessSequence) render();
  }
}

function compactWindowHeight() {
  const error = $('recording-error');
  return Math.ceil(document.querySelector('.capture-controls').getBoundingClientRect().bottom + (error && !error.hidden ? error.getBoundingClientRect().height + 16 : 0) + 1);
}
if ($('camera-quality')) $('camera-quality').value = state.cameraQuality;

let microphoneStream = null;
let microphoneStreamDeviceId = null;
let microphoneMeterContext = null;
let microphoneMeterAnalyser = null;
let microphoneMeterFrame = 0;
let microphoneRequest = null;
let microphoneRequestDeviceId = null;
let inlineCameraStream = null;
let inlineCameraRequest = null;
let inlineCameraDevice = null;
let inlineCameraQuality = null;
let inlineCameraLastFrameAt = 0;
let inlineCameraHasFrame = false;
let inlineCameraGeneration = 0;
let inlineCameraUpdate = null;
let inlineCameraUpdateAgain = false;
let stopInlineCameraWatch = null;
let inlineCameraOwnsStream = false;
let systemAudioStream = null;
let systemAudioRequest = null;
let systemAudioGeneration = 0;
let systemAudioRequestGeneration = -1;
let rendererPageClosing = false;

const cameraModeFor = (quality) => ({
  '4k': { quality: '4k', width: 3840, height: 2160, label: '4K' },
  '1080p': { quality: '1080p', width: 1920, height: 1080, label: '1080p' },
  '720p': { quality: '720p', width: 1280, height: 720, label: '720p' },
}[quality] || { quality: '1080p', width: 1920, height: 1080, label: '1080p' });

function cameraInputConstraints(deviceId, quality) {
  const mode = cameraModeFor(quality);
  return { video: {
    ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
    width: { exact: mode.width }, height: { exact: mode.height }, frameRate: { ideal: 30, max: 30 },
  } };
}

function cameraStreamMatchesQuality(stream, quality) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track || (track.readyState && track.readyState !== 'live')) return false;
  const settings = track.getSettings?.();
  const mode = cameraModeFor(quality);
  return !settings || (settings.width === mode.width && settings.height === mode.height);
}

function invalidateRecordingReadiness(reason) {
  if (!state.readiness?.ready || state.starting || state.session || state.finishing) return;
  state.readiness = { ready: false, pending: false, reason };
  render();
}

async function stopInlineCameraPreview({ preserveStream = false } = {}) {
  inlineCameraGeneration += 1;
  if (stopInlineCameraWatch) stopInlineCameraWatch();
  stopInlineCameraWatch = null;
  if (!preserveStream) {
    if (inlineCameraStream && inlineCameraOwnsStream) inlineCameraStream.getTracks().forEach((track) => track.stop());
    inlineCameraStream = null;
    inlineCameraOwnsStream = false;
    inlineCameraDevice = null;
    inlineCameraQuality = null;
    inlineCameraLastFrameAt = 0;
    inlineCameraHasFrame = false;
  }
  const video = $('camera-inline-preview');
  if (video) video.srcObject = null;
  $('cam-top-row')?.classList.remove('preview-ready');
  const cameraLabel = $('cam-global')?.querySelector('.camera-preview-label');
  if (cameraLabel) cameraLabel.textContent = state.cam.on ? (state.cam.previewMessage || '等待摄像头画面') : '点击开启摄像头';
  const pending = inlineCameraRequest;
  if (pending) await pending;
  if (inlineCameraRequest === pending) inlineCameraRequest = null;
}

function cameraPreviewTarget() {
  const stream = state.session?.tracks.find((track) => track.kind === 'camera')?.stream || null;
  return {
    enabled: Boolean(state.cam.on && !state.starting && !state.finishing && (!state.session || stream)),
    deviceId: state.cam.deviceId,
    quality: cameraModeFor(state.cameraQuality).quality,
    stream,
  };
}

function inlineCameraStreamIsReady(target) {
  const video = $('camera-inline-preview');
  return Boolean(target.enabled && inlineCameraStream && inlineCameraOwnsStream
    && inlineCameraDevice === target.deviceId && inlineCameraQuality === target.quality
    && video?.srcObject === inlineCameraStream && stopInlineCameraWatch
    && inlineCameraHasFrame && performance.now() - inlineCameraLastFrameAt <= 1000
    && cameraStreamMatchesQuality(inlineCameraStream, target.quality));
}

function waitForInlineCameraFrame(stream, target, generation) {
  const deadline = performance.now() + 8000;
  return new Promise((resolve) => {
    const check = () => {
      if (inlineCameraStream !== stream || generation !== inlineCameraGeneration
        || target.deviceId !== cameraPreviewTarget().deviceId
        || target.quality !== cameraPreviewTarget().quality
        || target.stream !== cameraPreviewTarget().stream) {
        resolve(false);
      } else if (inlineCameraHasFrame && performance.now() - inlineCameraLastFrameAt <= 1000) {
        resolve(true);
      } else if (performance.now() >= deadline) {
        resolve(false);
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

function reportInlineCameraPreviewError(error, target, generation) {
  const current = cameraPreviewTarget();
  if (generation !== inlineCameraGeneration || current.enabled !== target.enabled
    || current.deviceId !== target.deviceId || current.quality !== target.quality || current.stream !== target.stream) return;
  void stopInlineCameraPreview();
  const reason = typeof error === 'string' ? error : error?.name || 'unavailable';
  const messages = {
    no_frame: '摄像头尚未提供有效画面',
    frame_stalled: '摄像头画面已停止更新',
    device_ended: '摄像头已断开',
    NotAllowedError: '摄像头权限被拒绝',
    NotFoundError: '没有找到可用摄像头',
    NotReadableError: '摄像头被占用或无法读取',
    TrackStartError: '摄像头被占用或无法读取',
    TimeoutError: '摄像头连接超时',
  };
  state.cam.captureFailed = true;
  state.cam.previewStatus = 'error';
  state.cam.previewError = reason;
  state.cam.previewMessage = messages[reason] || error?.message || '无法读取所选摄像头';
  invalidateRecordingReadiness(state.cam.previewMessage);
  render();
}

async function attachInlineCameraPreview(stream, target, ownsStream, generation, video) {
  inlineCameraStream = stream;
  inlineCameraOwnsStream = ownsStream;
  inlineCameraDevice = target.deviceId;
  inlineCameraQuality = target.quality;
  inlineCameraLastFrameAt = 0;
  inlineCameraHasFrame = false;
  video.srcObject = stream;
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 270;
  const context = canvas.getContext('2d');
  let lastSent = -Infinity;
  const targetIsCurrent = () => {
    const current = cameraPreviewTarget();
    return current.enabled === target.enabled && current.deviceId === target.deviceId
      && current.quality === target.quality && current.stream === target.stream;
  };
  stopInlineCameraWatch = watchCameraPreview(video, stream, {
    onReady: () => {
      if (generation !== inlineCameraGeneration || !targetIsCurrent()) return;
      inlineCameraHasFrame = true;
      inlineCameraLastFrameAt = performance.now();
      $('cam-top-row')?.classList.add('preview-ready');
      if (state.cam.captureFailed || state.cam.previewStatus === 'error') {
        state.cam.captureFailed = false;
        state.cam.previewStatus = state.showCameraPreview ? 'checking' : 'off';
        state.cam.previewError = null;
        state.cam.previewMessage = '';
        render();
      }
    },
    onFrame: () => {
      if (generation !== inlineCameraGeneration || !targetIsCurrent()) return;
      inlineCameraHasFrame = true;
      inlineCameraLastFrameAt = performance.now();
      if (!state.showCameraPreview || !state.cam.requestId || !context) return;
      const now = performance.now();
      if (now - lastSent < 100) return;
      if (!video.videoWidth || !video.videoHeight) return;
      lastSent = now;
      const scale = Math.min(480 / video.videoWidth, 270 / video.videoHeight, 1);
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      ipcRenderer.send('camera:preview-frame', { requestId: state.cam.requestId, dataUrl: canvas.toDataURL('image/jpeg', 0.75) });
    },
    onError: (error) => {
      reportInlineCameraPreviewError(error, target, generation);
    },
  });
  await video.play().catch(() => {});
  const ready = await waitForInlineCameraFrame(stream, target, generation);
  if (!ready && generation === inlineCameraGeneration && targetIsCurrent()) {
    throw new Error('等待摄像头真实画面超时');
  }
  return ready;
}

function updateInlineCameraPreview() {
  inlineCameraUpdateAgain = true;
  if (!inlineCameraUpdate) {
    inlineCameraUpdate = (async () => {
      let ready = false;
      while (inlineCameraUpdateAgain) {
        inlineCameraUpdateAgain = false;
        const target = cameraPreviewTarget();
        ready = await openInlineCameraPreview(target);
        const current = cameraPreviewTarget();
        if (target.enabled !== current.enabled || target.deviceId !== current.deviceId
          || target.quality !== current.quality || target.stream !== current.stream) inlineCameraUpdateAgain = true;
      }
      return ready;
    })().finally(() => {
      inlineCameraUpdate = null;
      if (inlineCameraUpdateAgain) void updateInlineCameraPreview();
    });
  }
  return inlineCameraUpdate;
}

async function openInlineCameraPreview(target) {
  const video = $('camera-inline-preview');
  if (!video) return false;
  const targetIsCurrent = () => {
    const current = cameraPreviewTarget();
    return current.enabled === target.enabled && current.deviceId === target.deviceId
      && current.quality === target.quality && current.stream === target.stream;
  };
  if (!target.enabled) {
    await stopInlineCameraPreview({ preserveStream: state.starting && state.cam.on });
    return false;
  }
  if (!targetIsCurrent()) return false;
  if (inlineCameraStream && inlineCameraDevice === target.deviceId && inlineCameraQuality === target.quality
    && (target.stream ? inlineCameraStream === target.stream : inlineCameraOwnsStream)
    && cameraStreamMatchesQuality(inlineCameraStream, target.quality)) {
    if (video.srcObject === inlineCameraStream && stopInlineCameraWatch) {
      const ready = await waitForInlineCameraFrame(inlineCameraStream, target, inlineCameraGeneration);
      if (ready) return true;
      if (!targetIsCurrent()) return false;
    } else {
      const generation = inlineCameraGeneration;
      try {
        return await attachInlineCameraPreview(inlineCameraStream, target, inlineCameraOwnsStream, generation, video);
      } catch (error) {
        reportInlineCameraPreviewError(error, target, generation);
        return false;
      }
    }
  }
  if (inlineCameraRequest && inlineCameraDevice === target.deviceId && inlineCameraQuality === target.quality) return inlineCameraRequest;
  await stopInlineCameraPreview();
  if (!targetIsCurrent()) return false;
  const ownGeneration = ++inlineCameraGeneration;
  const ownsStream = !target.stream;
  const pendingRequest = (async () => {
    let acquisitionTimer;
    let timedOut = false;
    let acquired = null;
    try {
      const acquisition = (target.stream ? Promise.resolve(target.stream) : acquireRecordingCamera(cameraInputConstraints(target.deviceId, target.quality))).then((stream) => {
        acquired = stream;
        if (timedOut && ownsStream) acquired.getTracks().forEach((track) => track.stop());
        return acquired;
      });
      const deadline = new Promise((resolve, reject) => {
        acquisitionTimer = setTimeout(() => {
          timedOut = true;
          reject(Object.assign(new Error('摄像头连接超时'), { name: 'TimeoutError' }));
        }, 8000);
      });
      acquired = await Promise.race([acquisition, deadline]);
      clearTimeout(acquisitionTimer);
      if (ownGeneration !== inlineCameraGeneration || !targetIsCurrent()) {
        if (ownsStream) acquired.getTracks().forEach((track) => track.stop());
        return false;
      }
      if (!cameraStreamMatchesQuality(acquired, target.quality)) {
        if (ownsStream) acquired.getTracks().forEach((track) => track.stop());
        acquired = null;
        throw new Error(`所选 ${cameraModeFor(target.quality).label} 规格未能匹配`);
      }
      return await attachInlineCameraPreview(acquired, target, ownsStream, ownGeneration, video);
    } catch (cause) {
      reportInlineCameraPreviewError(cause, target, ownGeneration);
      return false;
    } finally {
      if (timedOut && acquired && ownsStream) acquired.getTracks().forEach((track) => track.stop());
      clearTimeout(acquisitionTimer);
    }
  })();
  inlineCameraRequest = pendingRequest;
  try {
    return await pendingRequest;
  } finally {
    if (inlineCameraRequest === pendingRequest) inlineCameraRequest = null;
  }
}

const persist = () => localStorage.setItem(settingsKey, JSON.stringify({
  mic: state.mic.on,
  micId: state.mic.deviceId,
  cam: state.cam.on,
  camId: state.cam.deviceId,
  cameraQuality: state.cameraQuality,
  showCameraPreview: state.showCameraPreview,
  cameraPreviewDefaultVersion: 2,
  sys: state.sys.on,
}));

function requestCameraPreview(visible, deviceId) {
  if (!state.starting && !state.finishing) void updateInlineCameraPreview();
  visible = Boolean(visible && state.showCameraPreview);
  const requestId = ++cameraRequestSequence;
  state.cam.requestId = requestId;
  if (!state.cam.captureFailed || !state.cam.on) {
    state.cam.captureFailed = false;
    state.cam.previewStatus = visible ? 'checking' : 'off';
    state.cam.previewError = null;
    state.cam.previewMessage = '';
  }
  ipcRenderer.send('recorder:camera-preview', { visible, deviceId, requestId });
  return requestId;
}

function restoreCameraPreviewIfEnabled() {
  if (state.starting || state.session || state.finishing) return;
  if (state.cam.on && state.showCameraPreview && state.cam.previewStatus === 'off') requestCameraPreview(true, state.cam.deviceId);
  else void updateInlineCameraPreview();
}

const SOURCE_LABELS = { display: '全屏录制', window: '窗口录制', area: '选定区域' };

// ------------------------------------------------------------------ 状态与渲染

function show(panel) {
  const busy = $('busy');
  const done = $('done');
  if (busy) busy.hidden = panel !== 'busy';
  if (done) done.hidden = panel !== 'done';
  const locked = panel !== 'idle';
  document.querySelectorAll('.page').forEach((page) => {
    page.hidden = locked || page.dataset.page !== state.page;
    page.classList.toggle('active', !page.hidden);
  });
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === state.page));
}

function showPage(page) {
  if (state.starting || state.finishing || !['home', 'general', 'video', 'about'].includes(page)) return;
  state.page = page;
  show('idle');
  if (page === 'home') void refreshHistory();
}

async function showHistoryPage() {
  if (state.starting || state.session || state.finishing) return;
  if (state.collapsed) {
    try {
      await ipcRenderer.invoke('recorder:set-collapsed', { collapsed: false, height: 0 });
      state.collapsed = false;
      lastCompactHeight = 0;
    } catch (error) {
      console.error('Failed to expand recorder history:', error);
      return;
    }
  }
  state.page = 'home';
  show('idle');
  render();
  await refreshHistory();
}

let historyMenu = null;

function closeHistoryMenu() {
  if (!historyMenu) return;
  historyMenu.remove();
  historyMenu = null;
}

function openHistoryMenu(event, items) {
  event.preventDefault();
  closeHistoryMenu();
  const menu = document.createElement('div');
  menu.className = 'history-context-menu';
  menu.setAttribute('role', 'menu');
  items.forEach(({ label, action, danger }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = danger ? 'danger' : '';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.addEventListener('click', async () => {
      closeHistoryMenu();
      await action();
    });
    menu.append(button);
  });
  document.body.append(menu);
  const margin = 8;
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - bounds.width - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - bounds.height - margin))}px`;
  historyMenu = menu;
}

document.addEventListener('pointerdown', (event) => {
  if (historyMenu && !historyMenu.contains(event.target)) closeHistoryMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeHistoryMenu();
});

function historyItem({ name, sizeText, file, directory, projectDirectory }) {
  const row = document.createElement('div');
  row.className = 'history-item';
  row.setAttribute('role', 'listitem');
  row.setAttribute('aria-selected', 'false');
  if (projectDirectory) row.dataset.projectDirectory = projectDirectory;
  row.tabIndex = 0;
  const info = document.createElement('div');
  info.className = 'history-info';
  const title = document.createElement('span');
  title.className = 'history-name';
  title.textContent = name;
  title.title = name;
  const size = document.createElement('span');
  size.className = 'history-size';
  size.textContent = sizeText || '—';
  info.append(title);
  row.append(info, size);
  const play = () => ipcRenderer.send('shell:open', file);
  row.addEventListener('dblclick', () => {
    if (projectDirectory) void ipcRenderer.invoke('project:open', projectDirectory);
    else play();
  });
  row.addEventListener('contextmenu', (event) => {
    if (historySelection) historySelection.selectRow(row, { preserveIfSelected: true });
    const selectedDirectories = historySelection ? historySelection.getSelectedDirectories() : [];
    const deleteSelected = Boolean(projectDirectory && selectedDirectories.length > 1 && selectedDirectories.includes(projectDirectory));
    const actions = [
      { label: '播放', action: play },
      ...(projectDirectory ? [{ label: '编辑', action: () => ipcRenderer.invoke('project:open', projectDirectory) }] : []),
      { label: '打开输出文件夹', action: () => ipcRenderer.send('shell:open', projectDirectory || directory || path.dirname(file)) },
      { label: deleteSelected ? `删除所选（${selectedDirectories.length}）` : projectDirectory ? '删除此工程' : '删除此视频', danger: true, action: async () => {
        if (deleteSelected) return trashSelectedHistoryProjects();
        try {
          const removed = projectDirectory
            ? await ipcRenderer.invoke('project:trash', projectDirectory)
            : await ipcRenderer.invoke('recording:export-trash', file);
          if (removed) await refreshHistory();
        } catch (error) {
          console.error('Failed to move history item to Recycle Bin:', error);
          window.alert(`无法删除记录：${error.message || error}`);
        }
      } },
    ];
    openHistoryMenu(event, actions);
  });
  return row;
}

function updateSelectedProjectsButton(directories) {
  const button = $('delete-selected-projects');
  if (!button) return;
  const count = directories.length;
  button.hidden = count === 0;
  button.textContent = `删除所选（${count}）`;
  button.setAttribute('aria-label', `删除所选 ${count} 个项目`);
}

const historySelection = $('recording-history') ? createHistorySelection($('recording-history'), {
  onChange: updateSelectedProjectsButton,
  isActive: () => state.page === 'home' && !state.starting && !state.session && !state.finishing,
}) : null;

async function trashSelectedHistoryProjects() {
  const directories = historySelection ? historySelection.getSelectedDirectories() : [];
  if (!directories.length) return;
  const button = $('delete-selected-projects');
  if (button) button.disabled = true;
  try {
    const result = await ipcRenderer.invoke('project:trash-selected', directories);
    if (!result || result.cancelled) return;
    const rowsByDirectory = new Map((historySelection?.getSelectedRows() || []).map((row) => [row.dataset.projectDirectory, row.querySelector('.history-name')?.textContent || path.basename(row.dataset.projectDirectory)]));
    const failureDetails = (result.failed || []).map(({ directory, error }) => `• ${rowsByDirectory.get(directory) || path.basename(directory)}：${error}`);
    const summary = [`已移入回收站：${result.moved} 个项目`];
    if (failureDetails.length) summary.push(`失败：${failureDetails.length} 个项目`, ...failureDetails);
    window.alert(summary.join('\n'));
    await refreshHistory();
  } catch (error) {
    console.error('Failed to move selected projects to Recycle Bin:', error);
    window.alert(`批量移入回收站失败：${error.message || error}`);
    await refreshHistory();
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshHistory() {
  try {
    const projects = await ipcRenderer.invoke('project:list');
    const recordings = $('recording-history');
    const recordingLocation = $('recording-location');
    if (recordingLocation) {
      recordingLocation.textContent = state.environment.projectsRoot || '';
      recordingLocation.title = recordingLocation.textContent;
      recordingLocation.hidden = !recordingLocation.textContent;
    }
    if (recordings) {
      historySelection?.clear();
      recordings.replaceChildren();
      projects.forEach((project) => recordings.append(historyItem({
        name: project.name || path.basename(project.directory),
        sizeText: project.sizeText,
        file: project.recordingFile,
        projectDirectory: project.directory,
      })));
      if (!projects.length) recordings.innerHTML = '<div class="history-empty">还没有录制项目</div>';
    }
  } catch (error) {
    console.error('Failed to load recording history:', error);
    const list = $('recording-history');
    if (list && !list.children.length) list.innerHTML = '<div class="history-empty">暂时无法读取视频记录</div>';
  }
}

$('delete-selected-projects')?.addEventListener('click', async (event) => {
  event.preventDefault();
  await trashSelectedHistoryProjects();
});

function render() {
  $('recorder-workspace').hidden = state.collapsed;
  const compactToggle = $('compact-toggle');
  compactToggle.title = state.collapsed ? '展开设置区域' : '折叠设置区域';
  compactToggle.setAttribute('aria-label', compactToggle.title);
  compactToggle.setAttribute('aria-expanded', String(!state.collapsed));
  if ($('camera-preview-toggle')) {
    $('camera-preview-toggle').classList.toggle('on', state.showCameraPreview);
    $('camera-preview-toggle').setAttribute('aria-checked', String(state.showCameraPreview));
  }
  if ($('recording-error')) {
    $('recording-error').hidden = !state.startError;
    $('recording-error').textContent = state.startError;
  }
  // 1. 录制模式入口
  const modeButton = $('mode-picker');
  const modeLabel = $('mode-label');
  const modeNames = { display: '全屏录制', window: '窗口录制', area: '区域录制' };
  if (modeLabel) modeLabel.textContent = modeNames[state.selection.kind] || '录制模式';
  if (modeButton) {
    modeButton.title = state.selectionLabel ? `${modeNames[state.selection.kind]} · ${state.selectionLabel}` : '切换录制模式';
    modeButton.disabled = Boolean(state.starting || state.session);
  }

  const sourceSummary = $('source-summary');
  if (sourceSummary) {
    let summaryText = '主显示器';
    if (state.selection.kind === 'display') {
      const display = state.displays.find((item) => item.id === state.selection.displayId)
        || state.displays.find((item) => item.isPrimary)
        || state.displays[0];
      if (display) {
        const res = display.physical ? `${display.physical.width}×${display.physical.height}` : '';
        summaryText = `${display.label || '显示器'}${res ? ` (${res})` : ''}${display.isPrimary ? ' · 主屏' : ''}`;
      } else {
        summaryText = '主显示器';
      }
    } else if (state.selection.kind === 'window') {
      summaryText = state.selectionLabel || state.selection.title || '选定窗口';
    } else if (state.selection.kind === 'area') {
      if (state.selection.rect) {
        summaryText = `选定区域 (${state.selection.rect.width}×${state.selection.rect.height})`;
      } else {
        summaryText = state.selectionLabel || '选定区域';
      }
    }
    sourceSummary.textContent = summaryText;
    sourceSummary.title = summaryText;
  }

  // 2. 设备开关及状态展示
  $('mic')?.classList.toggle('on', state.mic.on);
  $('cam-global')?.classList.toggle('on', state.cam.on);
  const cameraButton = $('cam-global');
  if (cameraButton) {
    const error = state.cam.on && state.cam.previewStatus === 'error' ? state.cam.previewMessage : '';
    const cameraLabel = cameraButton.querySelector('.camera-preview-label');
    if (cameraLabel && !$('cam-top-row')?.classList.contains('preview-ready')) {
      cameraLabel.textContent = state.cam.on ? (state.cam.previewMessage || '等待摄像头画面') : '点击开启摄像头';
    }
    cameraButton.classList.toggle('error', Boolean(error));
    cameraButton.title = error ? `切换摄像头 · ${error}` : '切换摄像头';
  }
  $('sys')?.classList.toggle('on', state.sys.on);
  $('mic-top-row')?.classList.toggle('on', state.mic.on);
  $('cam-top-row')?.classList.toggle('on', state.cam.on);
  $('sys-top-row')?.classList.toggle('on', state.sys.on);
  $('sys-row')?.classList.toggle('on', state.sys.on);

  const unavailableMicrophone = state.session && state.mic.on && !state.session.microphone;
  const microphoneError = unavailableMicrophone ? '未能打开' : state.mic.permissionError;
  const micButton = $('mic');
  if (micButton) {
    micButton.classList.toggle('error', Boolean(microphoneError));
    micButton.title = `当前：${state.mic.deviceName || '系统默认麦克风'} · 单击开关，右键选择设备${microphoneError ? ` · ${microphoneError}` : ''}`;
  }
  const micDeviceTip = $('mic-device-tip');
  if (micDeviceTip && !micDeviceTip.hidden) {
    micDeviceTip.textContent = `当前：${state.mic.deviceName || '系统默认麦克风'}`;
  }
  if ($('sys-desc')) $('sys-desc').textContent = state.sys.on ? '录制系统内部声音' : '已关闭';

  // 3. 兼容环境提示
  const hint = $('hint');
  if (hint) {
    hint.classList.toggle('error', !state.environment.ok);
    const b = hint.querySelector('b');
    const small = hint.querySelector('small');
    if (!state.environment.ok) {
      if (b) b.textContent = '暂时不能录制';
      if (small) small.textContent = state.environment.reason;
      hint.title = state.environment.reason;
    } else {
      if (b) b.textContent = '保存到 项目';
      if (small) small.textContent = state.environment.encoder || '';
      hint.title = state.environment.projectsRoot || '';
    }
  }

  // 4. REC 按钮可用状态
  const readiness = state.readiness;
  const notReady = readiness && !readiness.ready;
  const readyStatus = $('ready-status');
  if (readyStatus) {
    readyStatus.textContent = state.session ? '录制中' : state.starting ? '启动中…' : notReady ? (readiness.pending ? '准备中…' : '未就绪') : '已就绪';
    readyStatus.title = readiness?.reason || state.environment.reason || '';
    readyStatus.classList.toggle('pending', Boolean(notReady || state.starting));
  }
  const startBtn = $('start');
  if (startBtn) {
    const recording = Boolean(state.session);
    const label = recording ? '停止录制' : state.finishing ? '正在保存…' : state.starting ? '正在准备…' : 'REC';
    startBtn.disabled = state.starting || state.finishing || (!recording && (!state.environment.ok || notReady));
    startBtn.classList.toggle('is-recording', recording);
    const caption = startBtn.querySelector('.rec-label');
    if (caption) caption.textContent = label;
    startBtn.setAttribute('aria-label', label === 'REC' ? '开始录制' : label);
    startBtn.title = recording
      ? ['结束录制 (Ctrl+Alt+R)', ...state.session.problems].join('\n')
      : state.starting ? label : notReady ? readiness.reason : state.environment.ok ? '开始录制 (Ctrl+Alt+R)' : (state.environment.reason || '暂时无法录制');
    document.querySelector('.page-content').inert = state.starting || state.finishing || recording;
    document.querySelector('.main-nav').inert = state.starting || state.finishing;
    $('header-library').disabled = state.starting || state.finishing || recording;
    for (const id of ['cam-global', 'mic', 'sys', 'selection-pill']) if ($(id)) $(id).disabled = state.starting || state.finishing || recording;
  }

  if (state.collapsed) {
    const height = compactWindowHeight();
    if (height !== lastCompactHeight) {
      lastCompactHeight = height;
      void ipcRenderer.invoke('recorder:set-collapsed', { collapsed: true, height }).catch(console.error);
    }
  }

  const desktopIconsToggle = $('desktop-icons');
  if (desktopIconsToggle) {
    desktopIconsToggle.classList.toggle('on', state.hideDesktopIcons);
    desktopIconsToggle.setAttribute('aria-checked', String(state.hideDesktopIcons));
    desktopIconsToggle.disabled = state.selection.kind === 'window' || state.savingDesktopIconSetting;
    desktopIconsToggle.title = state.selection.kind === 'window'
      ? '窗口录制不包含桌面图标'
      : '录制桌面或区域时隐藏桌面图标';
  }
  const memoToggle = $('memo');
  $('summary-memo')?.setAttribute('aria-pressed', String(state.memoOpen));
  if (memoToggle) {
    memoToggle.classList.toggle('on', state.memoOpen);
    memoToggle.setAttribute('aria-checked', String(state.memoOpen));
  }
  $('selection-pill')?.classList.toggle('recording-disabled', Boolean(state.starting || state.session));
}

// ------------------------------------------------------------------ 目标源与设备选择

async function chooseSource(kind) {
  if (state.starting || state.session || state.finishing || state.configuring) return;
  state.configuring = true;
  readinessSequence += 1;
  state.readiness = { ready: false, pending: true, reason: '正在选择录制配置…' };
  render();
  try {
    if (kind === 'display') {
      let display = state.displays.find((item) => item.isPrimary) || state.displays[0];
      if (state.displays.length > 1) {
        const chosen = await ipcRenderer.invoke('recorder:menu', state.displays.map((item) => ({
          id: String(item.id),
          label: `${item.label}　${item.physical.width}×${item.physical.height}${item.isPrimary ? '（主屏）' : ''}`,
          checked: state.selection.displayId === item.id,
        })));
        if (!chosen) return;
        display = state.displays.find((item) => String(item.id) === chosen);
      }
      state.selection = { kind: 'display', displayId: display ? display.id : null };
      state.selectionLabel = state.displays.length > 1 && display ? display.label : '';
    } else if (kind === 'window') {
      const choice = await ipcRenderer.invoke('recorder:pick-window');
      if (!choice) return;
      state.selection = { kind: 'window', hwnd: choice.hwnd, title: choice.title };
      state.selectionLabel = choice.title;
    } else {
      const area = await ipcRenderer.invoke('recorder:pick-area');
      if (!area) return;
      state.selection = { kind: 'area', displayId: area.displayId, rect: area.rect };
      state.selectionLabel = `${area.rect.width}×${area.rect.height}`;
    }
    render();
  } finally {
    state.configuring = false;
    void prepareRecordingReadiness();
  }
}

async function deviceMenu(kind, target) {
  if (state.starting || state.session || state.finishing || state.configuring) return;
  state.configuring = true;
  readinessSequence += 1;
  state.readiness = { ready: false, pending: true, reason: '正在选择录制配置…' };
  render();
  try {
    // 摄像头菜单只枚举设备，避免默认摄像头占用时阻塞用户选择。
    let permissionError = null;
    if (kind === 'audioinput' && !microphoneStream?.getAudioTracks().some((track) => track.readyState === 'live')) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
      } catch (error) {
        permissionError = error;
      }
    }
    let devices;
    try {
      devices = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === kind && device.deviceId !== 'communications');
    } catch {
      if (target === state.mic) target.permissionError = '设备不可用';
      render();
      return;
    }
    if (target === state.mic) {
      target.permissionError = permissionError && permissionError.name === 'NotAllowedError' ? '需要麦克风权限' : null;
      render();
    }
    if (!devices.length) {
      await ipcRenderer.invoke('recorder:menu', [{ id: 'none', label: kind === 'audioinput' ? '没有找到麦克风' : '没有找到摄像头', enabled: false }]);
      return;
    }
    const chosen = await ipcRenderer.invoke('recorder:menu', devices.map((device) => ({
      id: device.deviceId,
      label: device.deviceId === 'default'
        ? `系统默认${device.label ? `（${device.label}）` : ''}`
        : device.label || '未命名设备',
      checked: target.deviceId ? target.deviceId === device.deviceId : device.deviceId === 'default',
    })));
    if (!chosen) return;
    target.deviceId = chosen;
    target.on = true;
    if (target === state.mic) {
      target.permissionError = permissionError && permissionError.name === 'NotAllowedError' ? '需要麦克风权限' : null;
      stopMicrophoneMeter(true);
    }
    persist();
    if (target === state.cam) requestCameraPreview(true, chosen);
    if (target === state.mic) await startMicrophoneMeter();
    await updateDeviceNames();
    render();
  } finally {
    state.configuring = false;
    void prepareRecordingReadiness();
  }
}

async function updateDeviceNames() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const selectedIsDefault = !state.mic.deviceId || state.mic.deviceId === 'default';
    const device = devices.find((item) => item.kind === 'audioinput' && item.deviceId === state.mic.deviceId)
      || (selectedIsDefault ? devices.find((item) => item.kind === 'audioinput' && (!item.deviceId || item.deviceId === 'default')) : null);
    const hasLabel = Boolean(device?.label);
    const fullName = hasLabel ? device.label : (selectedIsDefault ? '系统默认麦克风' : '未命名麦克风');
    state.mic.deviceName = fullName;
  } catch {
    const selectedIsDefault = !state.mic.deviceId || state.mic.deviceId === 'default';
    state.mic.deviceName = selectedIsDefault ? '系统默认麦克风' : '未命名麦克风';
  }
  render();
}

function showCurrentMicrophone() {
  const tip = $('mic-device-tip');
  if (!tip) return;
  clearTimeout(microphoneDeviceTipTimer);
  tip.textContent = `当前：${state.mic.deviceName || '系统默认麦克风'}`;
  tip.hidden = false;
  microphoneDeviceTipTimer = setTimeout(() => { tip.hidden = true; }, 2400);
}

// ------------------------------------------------------------------ 保存目录设置

async function refreshProjectsRoot() {
  try {
    const root = await ipcRenderer.invoke('config:get-projects-root');
    if (root && $('save-dir-path')) {
      $('save-dir-path').textContent = root;
      $('save-dir-path').title = root;
    }
  } catch {
    if (state.environment && state.environment.projectsRoot && $('save-dir-path')) {
      $('save-dir-path').textContent = state.environment.projectsRoot;
      $('save-dir-path').title = state.environment.projectsRoot;
    }
  }
}

async function refreshExportRoot() {
  const root = await ipcRenderer.invoke('config:get-export-root');
  $('export-dir-path').textContent = root || '未设置，每次导出时选择';
  $('export-dir-path').title = root || '';
  $('change-export-dir').textContent = root ? '更改' : '设置';
  $('open-export-dir').disabled = !root;
}

// ------------------------------------------------------------------ 事件监听与交互绑定

// 单个模式入口通过原生菜单切换全屏、窗口或区域录制。
$('mode-picker')?.addEventListener('click', async () => {
  if (state.starting || state.session) return;
  const chosen = await ipcRenderer.invoke('recorder:menu', [
    { id: 'display', label: '全屏录制', checked: state.selection.kind === 'display' },
    { id: 'window', label: '窗口录制', checked: state.selection.kind === 'window' },
    { id: 'area', label: '区域录制', checked: state.selection.kind === 'area' },
  ]);
  if (chosen) await chooseSource(chosen);
});

// 窗口控制：最小化与关闭
$('win-min')?.addEventListener('click', () => ipcRenderer.send('window:minimize'));
$('win-tray')?.addEventListener('click', () => ipcRenderer.send('recorder:hide'));
$('win-close')?.addEventListener('click', () => ipcRenderer.send('window:close'));
$('quit')?.addEventListener('click', () => ipcRenderer.send('window:close'));

// 麦克风测试与录制共用同一输入流；只有实时电平分析，不保存待机音频。
function stopMicrophoneMeter(stopStream = false) {
  if (microphoneMeterFrame) cancelAnimationFrame(microphoneMeterFrame);
  microphoneMeterFrame = 0;
  if (microphoneMeterContext) {
    void microphoneMeterContext.close().catch(() => {});
    microphoneMeterContext = null;
    microphoneMeterAnalyser = null;
  }
  const meter = $('mic-level');
  if (meter) {
    meter.setAttribute('aria-valuenow', '0');
    meter.querySelectorAll('span').forEach((bar) => { bar.style.height = '2px'; bar.classList.remove('active', 'peak'); });
  }
  if (stopStream && !state.session && microphoneStream) {
    microphoneStream.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
    microphoneStreamDeviceId = null;
  }
}

function paintMicrophoneLevel() {
  if (!microphoneMeterAnalyser || !microphoneStream) return;
  const samples = new Uint8Array(microphoneMeterAnalyser.fftSize);
  microphoneMeterAnalyser.getByteTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sum += normalized * normalized;
  }
  const level = Math.min(1, Math.sqrt(sum / samples.length) * 4.5);
  const meter = $('mic-level');
  if (meter) {
    meter.setAttribute('aria-valuenow', String(Math.round(level * 100)));
    const bars = meter.querySelectorAll('span');
    bars.forEach((bar, index) => {
      const animation = 0.72 + 0.28 * Math.abs(Math.sin(performance.now() / 145 + index * 0.63));
      const value = Math.max(0, level * animation - index * 0.005);
      bar.style.height = `${Math.round(2 + value * 11)}px`;
      bar.classList.toggle('active', value > 0.035);
      bar.classList.toggle('peak', value > 0.82);
    });
  }
  microphoneMeterFrame = requestAnimationFrame(paintMicrophoneLevel);
}

async function acquireMicrophoneStream() {
  const requestedDeviceId = state.mic.deviceId;
  if (!state.mic.on || rendererPageClosing) return null;
  if (microphoneStream?.getAudioTracks().some((track) => !track.readyState || track.readyState === 'live')
    && microphoneStreamDeviceId === requestedDeviceId) return microphoneStream;
  if (microphoneRequest) {
    if (microphoneRequestDeviceId === requestedDeviceId) return microphoneRequest;
    await microphoneRequest;
    if (!state.mic.on || state.mic.deviceId !== requestedDeviceId || rendererPageClosing) return null;
    if (microphoneStream?.getAudioTracks().some((track) => !track.readyState || track.readyState === 'live')
      && microphoneStreamDeviceId === requestedDeviceId) return microphoneStream;
  }
  stopMicrophoneMeter(true);
  let request;
  request = navigator.mediaDevices.getUserMedia({
    audio: { ...device(requestedDeviceId), echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
  }).then((stream) => {
    if (rendererPageClosing || !state.mic.on || state.mic.deviceId !== requestedDeviceId
      || state.session) {
      stream.getTracks().forEach((track) => track.stop());
      return null;
    }
    microphoneStream = stream;
    microphoneStreamDeviceId = requestedDeviceId;
    stream.getAudioTracks().forEach((track) => track.addEventListener?.('ended', () => {
      if (microphoneStream !== stream || !state.mic.on) return;
      invalidateRecordingReadiness('麦克风已断开，请重新选择设备');
    }, { once: true }));
    state.mic.permissionError = null;
    void updateDeviceNames();
    render();
    return stream;
  }).catch((error) => {
    if (state.mic.deviceId === requestedDeviceId) {
      state.mic.permissionError = error.name === 'NotAllowedError' ? '需要麦克风权限' : '设备不可用';
      render();
    }
    return null;
  }).finally(() => {
    if (microphoneRequest === request) {
      microphoneRequest = null;
      microphoneRequestDeviceId = null;
    }
  });
  microphoneRequest = request;
  microphoneRequestDeviceId = requestedDeviceId;
  return request;
}

async function startMicrophoneMeter() {
  if (!state.mic.on || state.session) return null;
  const stream = await acquireMicrophoneStream();
  if (!stream || document.hidden || state.session) return stream;
  if (!microphoneMeterContext && (window.AudioContext || window.webkitAudioContext)) {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      microphoneMeterContext = new AudioContextClass();
      microphoneMeterAnalyser = microphoneMeterContext.createAnalyser();
      microphoneMeterAnalyser.fftSize = 512;
      microphoneMeterContext.createMediaStreamSource(stream).connect(microphoneMeterAnalyser);
    } catch (error) {
      console.warn('麦克风电平表无法启动：', error.message || error);
      stopMicrophoneMeter(false);
    }
  }
  try {
    if (microphoneMeterContext?.state === 'suspended') await microphoneMeterContext.resume();
    if (microphoneMeterAnalyser && !microphoneMeterFrame) microphoneMeterFrame = requestAnimationFrame(paintMicrophoneLevel);
  } catch (error) { console.warn('麦克风电平表暂时不可用：', error.message || error); }
  return stream;
}

async function toggleDevice(kind) {
  const target = state[kind];
  if (!target || state.session || state.starting) return;
  target.on = !target.on;
  persist();
  if (kind === 'cam') requestCameraPreview(target.on, target.deviceId);
  void prepareRecordingReadiness();
  if (kind === 'mic') {
    if (target.on) await startMicrophoneMeter();
    else stopMicrophoneMeter(true);
  }
  render();
}

$('mic')?.addEventListener('click', () => { showCurrentMicrophone(); void toggleDevice('mic'); });
$('cam-global')?.addEventListener('click', () => { void toggleDevice('cam'); });
$('sys')?.addEventListener('click', () => { void toggleDevice('sys'); });

$('desktop-icons')?.addEventListener('click', async () => {
  if (state.selection.kind === 'window' || state.savingDesktopIconSetting) return;
  const previous = state.hideDesktopIcons;
  state.hideDesktopIcons = !previous;
  state.savingDesktopIconSetting = true;
  render();
  try {
    state.hideDesktopIcons = await ipcRenderer.invoke('config:set-hide-desktop-icons', state.hideDesktopIcons) === true;
  } catch (error) {
    state.hideDesktopIcons = previous;
    console.error('Failed to save desktop icon recording setting:', error);
  } finally {
    state.savingDesktopIconSetting = false;
    render();
  }
});

$('mic')?.addEventListener('contextmenu', (e) => { e.preventDefault(); deviceMenu('audioinput', state.mic); });
$('mic-row')?.addEventListener('contextmenu', (e) => { e.preventDefault(); deviceMenu('audioinput', state.mic); });
$('cam-global')?.addEventListener('contextmenu', (e) => { e.preventDefault(); deviceMenu('videoinput', state.cam); });
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
$('header-library')?.addEventListener('click', async () => {
  const directory = await ipcRenderer.invoke('config:get-projects-root');
  if (directory) ipcRenderer.send('shell:open', directory);
});
$('summary-memo')?.addEventListener('click', () => ipcRenderer.send('recorder:memo'));
$('compact-toggle')?.addEventListener('click', async () => {
  const button = $('compact-toggle');
  button.disabled = true;
  const collapsed = !state.collapsed;
  try {
    await ipcRenderer.invoke('recorder:set-collapsed', { collapsed, height: compactWindowHeight() });
    state.collapsed = collapsed;
    lastCompactHeight = collapsed ? compactWindowHeight() : 0;
    render();
  } finally {
    button.disabled = false;
  }
});
$('camera-quality')?.addEventListener('change', (event) => {
  state.cameraQuality = ['4k', '1080p', '720p'].includes(event.target.value) ? event.target.value : '1080p';
  state.startError = '';
  persist();
  render();
  void prepareRecordingReadiness();
});
$('camera-preview-toggle')?.addEventListener('click', () => {
  if (state.starting || state.session || state.finishing) return;
  state.showCameraPreview = !state.showCameraPreview;
  persist();
  requestCameraPreview(state.cam.on && state.showCameraPreview, state.cam.deviceId);
  render();
});
$('record-shortcuts')?.addEventListener('click', () => { handleOpenShortcuts(); $('sc-recordToggle')?.focus(); });
$('pause-shortcuts')?.addEventListener('click', () => { handleOpenShortcuts(); $('sc-recordPause')?.focus(); });
$('selection-pill')?.addEventListener('click', () => { if (!state.starting && !state.session) void chooseSource(state.selection.kind); });
// 保存位置更改
$('change-save-dir')?.addEventListener('click', async () => {
  try {
    const chosen = await ipcRenderer.invoke('config:choose-projects-root');
    if (chosen && $('save-dir-path')) {
      state.environment.projectsRoot = chosen;
      $('save-dir-path').textContent = chosen;
      $('save-dir-path').title = chosen;
      if (state.page === 'home') void refreshHistory();
    }
  } catch (err) {
    console.error('Failed to choose projects root:', err);
  }
});

// 打开保存文件夹
$('change-export-dir')?.addEventListener('click', async () => {
  try {
    const chosen = await ipcRenderer.invoke('config:choose-export-root');
    if (chosen) await refreshExportRoot();
  } catch (error) {
    window.alert(`无法设置导出文件夹：${error.message}`);
  }
});

$('open-save-dir')?.addEventListener('click', () => {
  const dir = $('save-dir-path')?.title || $('save-dir-path')?.textContent;
  if (dir && dir !== '正在读取存储路径…') {
    ipcRenderer.send('shell:open', dir);
  }
});
$('open-export-dir')?.addEventListener('click', async () => {
  const directory = await ipcRenderer.invoke('config:get-export-root');
  if (directory) ipcRenderer.send('shell:open', directory);
});

// 底部工具栏
$('memo')?.addEventListener('click', () => ipcRenderer.send('recorder:memo'));

// 快捷键设置弹窗
function handleOpenShortcuts() {
  if (!openShortcutsModal) {
    try {
      openShortcutsModal = require('./editor/shortcuts-modal').openShortcutsModal;
    } catch {
      // 容错回退
    }
  }
  const modal = $('shortcuts-modal');
  if (typeof openShortcutsModal === 'function') {
    openShortcutsModal(modal || document.body);
  } else if (modal) {
    modal.hidden = false;
  }
}

$('shortcuts-btn')?.addEventListener('click', handleOpenShortcuts);
$('shortcuts-close')?.addEventListener('click', () => {
  const modal = $('shortcuts-modal');
  if (modal) modal.hidden = true;
});

// ------------------------------------------------------------------ 附加音视频轨

const device = (id) => (id && id !== 'default' ? { deviceId: { exact: id } } : {});

async function acquireRecordingCamera(constraints) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      const switching = ['OverconstrainedError', 'ConstraintNotSatisfiedError', 'NotReadableError', 'TrackStartError'].includes(error.name);
      if (!switching || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

function releasePreparedSystemAudio() {
  systemAudioGeneration += 1;
  const stream = systemAudioStream;
  systemAudioStream = null;
  if (stream) stream.getTracks().forEach((track) => track.stop());
}

async function acquireSystemAudioStream() {
  if (!state.sys.on || rendererPageClosing) return null;
  if (systemAudioStream?.getAudioTracks().some((track) => !track.readyState || track.readyState === 'live')) return systemAudioStream;
  if (systemAudioRequest) {
    if (systemAudioRequestGeneration === systemAudioGeneration) return systemAudioRequest;
    await systemAudioRequest.catch(() => {});
    if (!state.sys.on || rendererPageClosing) return null;
    return acquireSystemAudioStream();
  }
  const generation = systemAudioGeneration;
  let request;
  request = navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then((display) => {
    const audioTracks = display.getAudioTracks();
    display.getVideoTracks().forEach((track) => track.stop());
    if (generation !== systemAudioGeneration || !state.sys.on || rendererPageClosing) {
      display.getTracks().forEach((track) => track.stop());
      return null;
    }
    if (!audioTracks.length || audioTracks.some((track) => track.readyState === 'ended')) {
      display.getTracks().forEach((track) => track.stop());
      throw new Error('系统声音采集没有返回可用音轨');
    }
    const stream = new MediaStream(audioTracks);
    systemAudioStream = stream;
    for (const track of audioTracks) track.addEventListener?.('ended', () => {
      if (systemAudioStream === stream && state.sys.on) invalidateRecordingReadiness('系统声音采集已结束，请重新准备');
    }, { once: true });
    return stream;
  }).catch((error) => {
    if (generation !== systemAudioGeneration || !state.sys.on || rendererPageClosing) return null;
    throw error;
  }).finally(() => {
    if (systemAudioRequest === request) {
      systemAudioRequest = null;
      systemAudioRequestGeneration = -1;
    }
  });
  systemAudioRequest = request;
  systemAudioRequestGeneration = generation;
  return request;
}

async function prepareInputStreams() {
  const streams = {};
  const problems = [];
  const cameraTarget = { enabled: Boolean(state.cam.on), deviceId: state.cam.deviceId,
    quality: cameraModeFor(state.cameraQuality).quality, stream: null };
  const cameraPromise = state.cam.on
    ? (state.starting ? Promise.resolve(inlineCameraStreamIsReady(cameraTarget)) : updateInlineCameraPreview())
    : Promise.resolve().then(async () => {
      if (!state.starting && !state.session) await stopInlineCameraPreview();
      return false;
    });
  const microphonePromise = state.mic.on
    ? acquireMicrophoneStream().catch((error) => {
      state.mic.permissionError = error.name === 'NotAllowedError' ? '需要麦克风权限' : '设备不可用';
      return null;
    })
    : Promise.resolve().then(() => {
      if (!state.starting && !state.session) stopMicrophoneMeter(true);
      return null;
    });
  const systemPromise = state.sys.on
    ? acquireSystemAudioStream().catch((error) => {
      problems.push(`系统声音不可用：${error.message || error.name || '无法打开回环音频'}`);
      return null;
    })
    : Promise.resolve().then(() => {
      if (!state.starting && !state.session) releasePreparedSystemAudio();
      return null;
    });

  const [cameraReady, microphone, system] = await Promise.all([cameraPromise, microphonePromise, systemPromise]);
  if (state.cam.on) {
    if (cameraReady && inlineCameraStreamIsReady(cameraTarget)) streams.camera = inlineCameraStream;
    else if (!state.starting) problems.push(state.cam.previewMessage || '摄像头尚未提供有效新画面');
  }
  if (state.mic.on) {
    if (microphone?.getAudioTracks().some((track) => !track.readyState || track.readyState === 'live')) streams.microphone = microphone;
    else problems.push(state.mic.permissionError || '麦克风不可用');
  }
  if (state.sys.on) {
    if (system?.getAudioTracks().some((track) => !track.readyState || track.readyState === 'live')) streams.system = system;
    else if (!problems.some((problem) => problem.startsWith('系统声音'))) problems.push('系统声音不可用');
  }
  return { streams, problems };
}

async function takeReadyInlineCameraStream() {
  const target = { enabled: Boolean(state.cam.on), deviceId: state.cam.deviceId,
    quality: cameraModeFor(state.cameraQuality).quality, stream: null };
  if (!inlineCameraStreamIsReady(target)) return null;
  const stream = inlineCameraStream;
  const generation = inlineCameraGeneration;
  await stopInlineCameraPreview({ preserveStream: true });
  if (generation + 1 !== inlineCameraGeneration || inlineCameraStream !== stream
    || !state.cam.on || state.cam.deviceId !== target.deviceId
    || cameraModeFor(state.cameraQuality).quality !== target.quality
    || !inlineCameraHasFrame || performance.now() - inlineCameraLastFrameAt > 1000
    || !cameraStreamMatchesQuality(stream, target.quality)) return null;
  inlineCameraStream = null;
  inlineCameraOwnsStream = false;
  inlineCameraDevice = null;
  inlineCameraQuality = null;
  inlineCameraLastFrameAt = 0;
  inlineCameraHasFrame = false;
  return stream;
}

async function openStreams() {
  const streams = {};
  const problems = [];
  if (state.cam.on) {
    streams.camera = await takeReadyInlineCameraStream();
    if (!streams.camera) problems.push('摄像头尚未就绪，请重新准备');
  }
  if (state.mic.on) {
    if (microphoneStreamDeviceId === state.mic.deviceId
      && microphoneStream?.getAudioTracks().some((track) => track.readyState === 'live')) streams.microphone = microphoneStream;
    else problems.push('麦克风尚未就绪，请重新准备');
  }
  if (state.sys.on) {
    if (systemAudioStream?.getAudioTracks().some((track) => track.readyState === 'live')) {
      streams.system = systemAudioStream;
      systemAudioStream = null;
    } else problems.push('系统声音尚未就绪，请重新准备');
  }
  return { streams, problems };
}

function pickMimeType(candidates) {
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function startTrack(kind, stream, directory, hasAudio) {
  const isVideo = kind === 'camera';
  const mimeType = isVideo
    ? pickMimeType(['video/x-matroska;codecs=avc1,opus', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'])
    : pickMimeType(['audio/webm;codecs=opus', 'audio/webm']);
  const file = path.join(directory, `${kind}-raw.${mimeType.includes('matroska') ? 'mkv' : 'webm'}`);
  const cameraBitrate = state.cameraQuality === '4k' ? 20_000_000 : state.cameraQuality === '720p' ? 5_000_000 : 8_000_000;
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: isVideo ? cameraBitrate : undefined, audioBitsPerSecond: 192_000 });
  const track = { kind, file, startedAt: null, hasAudio: Boolean(hasAudio), recorder, stream };
  let writing = Promise.resolve();
  track.started = new Promise((resolve) => {
    recorder.onstart = () => { track.startedAt = Date.now() / 1000; resolve(); };
    setTimeout(resolve, 2500);
  });
  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    writing = writing.then(async () => fs.promises.appendFile(file, Buffer.from(await event.data.arrayBuffer())));
  };
  track.finished = new Promise((resolve) => { recorder.onstop = () => writing.then(resolve, resolve); });
  recorder.start(1000);
  return track;
}

async function stopTracks(tracks) {
  for (const track of tracks) if (track.recorder.state !== 'inactive') track.recorder.stop();
  await Promise.all(tracks.map((track) => track.finished));
  for (const track of tracks) track.stream.getTracks().forEach((item) => item.stop());
  return tracks.filter((track) => track.startedAt !== null).map(({ kind, file, startedAt, hasAudio }) => ({ kind, file, startedAt, hasAudio }));
}

// ------------------------------------------------------------------ 录制主流程

function beginStartFeedback() {
  state.startError = '';
  state.starting = true;
  if (state.readiness) state.readiness = { ready: false, pending: false, reason: '正在启动录制' };
  show('idle');
  render();
}

async function start() {
  if (state.starting || state.session || state.finishing || !state.environment.ok || $('busy')?.hidden === false
    || (state.readiness && !state.readiness.ready)) return;
  beginStartFeedback();
  let streams = {};
  let problems = [];
  const tracks = [];
  let captureStarted = false;
  const fail = async (error) => {
    state.starting = false;
    try { await stopTracks(tracks); } catch {}
    Object.values(streams).forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    await ipcRenderer.invoke('recorder:cancel', captureStarted ? 'recording' : 'preparing').catch(() => {});
    if (state.cam.on) requestCameraPreview(true, state.cam.deviceId);
    state.startError = `上次录制未启动：${String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
    state.environment = { ...state.environment, ok: false, reason: String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
    show('idle');
    render();
    setTimeout(() => { state.environment.ok = true; render(); void prepareRecordingReadiness(); }, 6000);
  };

  try {
    ({ streams, problems } = await openStreams());
    if (problems.length || (state.cam.on && !streams.camera)) {
      throw new Error(problems.length ? `录制设备尚未就绪（${problems.join('、')}），已取消本次录制。` : '未能获取摄像头画面，已取消本次录制。');
    }
    const prepared = await ipcRenderer.invoke('recorder:prepare', { selection: state.selection, frameRate: 60 });
    if (streams.camera) {
      const combined = new MediaStream([...streams.camera.getVideoTracks(), ...(streams.microphone ? streams.microphone.getAudioTracks() : [])]);
      tracks.push(startTrack('camera', combined, prepared.mediaDirectory, Boolean(streams.microphone)));
    } else if (streams.microphone) {
      tracks.push(startTrack('microphone', streams.microphone, prepared.mediaDirectory));
    }
    if (streams.system) tracks.push(startTrack('system', streams.system, prepared.mediaDirectory));
    await Promise.all(tracks.map((track) => track.started));
    await ipcRenderer.invoke('recorder:start');
    captureStarted = true;
    await ipcRenderer.invoke('recorder:commit-start');
  } catch (error) {
    await fail(error);
    return;
  }

  state.session = { tracks, wanted: { camera: state.cam.on, microphone: state.mic.on, system: state.sys.on } };
  state.starting = false;
  if (state.cam.on) requestCameraPreview(true, state.cam.deviceId);

  state.session.problems = problems;
  state.session.microphone = Boolean(streams.microphone);

  render();
}

async function stop() {
  if (!state.session) return;
  const session = state.session;
  state.session = null;
  state.finishing = true;
  await stopInlineCameraPreview();
  requestCameraPreview(false, state.cam.deviceId);
  ipcRenderer.send('recorder:close-overlays');

  if ($('busyTitle')) $('busyTitle').textContent = '正在整理素材…';
  show('busy');

  let tracks;
  try {
    tracks = await stopTracks(session.tracks);
  } catch (error) {
    for (const track of session.tracks) {
      if (track.recorder && track.recorder.state !== 'inactive') {
        try { track.recorder.stop(); } catch {}
      }
      track.stream.getTracks().forEach((item) => item.stop());
    }
    await ipcRenderer.invoke('recorder:cancel', 'recording').catch(() => {});
    state.finishing = false;
    state.environment = { ...state.environment, ok: false, reason: String(error.message || error) };
    ipcRenderer.send('recorder:show');
    show('idle');
    render();
    setTimeout(() => { state.environment.ok = true; render(); void prepareRecordingReadiness(); }, 6000);
    return;
  }
  try {
    state.result = await ipcRenderer.invoke('recorder:stop', tracks);
    state.finishing = false;
    if (state.result && state.result.directory) {
      state.result = null;
      show('idle');
      render();
      void prepareRecordingReadiness();
      return;
    }
  } catch (error) {
    state.finishing = false;
    state.result = null;
    ipcRenderer.send('recorder:show');
    if ($('doneTitle')) $('doneTitle').textContent = '这次录制没有保存成功';
    if ($('doneDetail')) {
      $('doneDetail').textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      $('doneDetail').classList.add('error');
    }
    if ($('edit')) $('edit').hidden = true;
    if ($('reveal')) $('reveal').hidden = true;
  }
  show('done');
  void prepareRecordingReadiness();
}

// 录制控制按钮
$('start')?.addEventListener('click', () => state.session ? stop() : start());

// 完成卡片交互：进入编辑、打开文件夹、返回主界面
$('edit')?.addEventListener('click', () => {
  if (state.result && state.result.directory) {
    ipcRenderer.invoke('project:open', state.result.directory);
  }
  show('idle');
  render();
});
$('reveal')?.addEventListener('click', () => {
  if (state.result && state.result.directory) {
    ipcRenderer.send('project:reveal', path.join(state.result.directory, 'project.json'));
  }
});
$('again')?.addEventListener('click', () => {
  show('idle');
  render();
});

// ------------------------------------------------------------------ IPC 消息与快捷键触发

ipcRenderer.on('camera:status', (event, status) => {
  if (!status || status.requestId !== state.cam.requestId || !state.cam.on) return;
  if (state.cam.captureFailed) return;
  state.cam.previewStatus = status.status;
  state.cam.previewError = status.error || null;
  state.cam.previewMessage = status.message || '';
  if (status.status === 'ready' || status.status === 'error') updateDeviceNames();
  render();
});

ipcRenderer.on('recorder:hidden', () => {
  stopMicrophoneMeter(false);
});

ipcRenderer.on('recorder:show-history', () => { void showHistoryPage(); });

ipcRenderer.on('recorder:start', () => {
  if (!state.starting && !state.session && $('start') && !$('start').disabled) {
    start();
  }
});

ipcRenderer.on('recorder:shown', () => {
  restoreCameraPreviewIfEnabled();
  if (state.mic.on && !state.session) void startMicrophoneMeter();
  if (state.page === 'home') void refreshHistory();
  if (!state.readiness.ready) void prepareRecordingReadiness();
});

ipcRenderer.on('recorder:stop', () => {
  if (state.session) {
    stop();
  }
});

ipcRenderer.on('recorder:toggle', () => {
  if (state.session) {
    stop();
  } else if (!state.starting && $('start') && !$('start').disabled) {
    start();
  }
});

ipcRenderer.on('recorder:pause', () => {
  if (state.session && state.session.tracks) {
    const first = state.session.tracks[0];
    const isPaused = first && first.recorder && first.recorder.state === 'paused';
    for (const track of state.session.tracks) {
      if (track.recorder) {
        if (isPaused && track.recorder.state === 'paused') {
          track.recorder.resume();
        } else if (!isPaused && track.recorder.state === 'recording') {
          track.recorder.pause();
        }
      }
    }
  }
});

ipcRenderer.on('recorder:stage', (event, stage) => {
  if ($('busyTitle')) $('busyTitle').textContent = `${stage}…`;
});

ipcRenderer.on('recorder:memo-state', (event, isOpen) => {
  state.memoOpen = Boolean(isOpen);
  render();
});

ipcRenderer.on('app:environment', (event, environment) => {
  state.environment = environment;
  render();
  refreshProjectsRoot();
  void prepareRecordingReadiness();
});

// ------------------------------------------------------------------ 初始化

(async () => {
  try {
    state.displays = await ipcRenderer.invoke('recorder:displays');
    const primary = state.displays.find((item) => item.isPrimary) || state.displays[0];
    state.selection = { kind: 'display', displayId: primary ? primary.id : null };
  } catch (err) {
    console.error('Failed to load displays:', err);
  }
  try {
    state.hideDesktopIcons = await ipcRenderer.invoke('config:get-hide-desktop-icons') === true;
  } catch (err) {
    console.error('Failed to load desktop icon recording setting:', err);
  }
  try {
    state.environment = await ipcRenderer.invoke('app:environment');
  } catch (err) {
    console.error('Failed to load environment:', err);
  }
  await refreshProjectsRoot();
  await refreshExportRoot();
  await updateDeviceNames();
  if ($('app-version')) $('app-version').textContent = state.environment.version || '未知';
  if ($('camera-quality')) $('camera-quality').value = state.cameraQuality;
  restoreCameraPreviewIfEnabled();
  render();
  void refreshHistory();
  if (state.mic.on) void startMicrophoneMeter();
  void prepareRecordingReadiness();
})();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopMicrophoneMeter(false);
  } else if (state.mic.on && !state.session) {
    void startMicrophoneMeter();
  }
});

window.addEventListener('pagehide', () => {
  rendererPageClosing = true;
  stopMicrophoneMeter(!state.starting && !state.session);
  void stopInlineCameraPreview();
  releasePreparedSystemAudio();
});
