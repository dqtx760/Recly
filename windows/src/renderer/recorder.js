'use strict';
// DogSC Bandicam-style 录屏主控制台
// 屏幕画面由主进程 ffmpeg 采集；摄像头、麦克风、系统声音用 MediaRecorder 写成文件并按时钟对齐。

const fs = require('node:fs');
const path = require('node:path');
const { ipcRenderer } = require('electron');
const { icon, formatTime } = require('./common');

let openShortcutsModal = null;
try {
  openShortcutsModal = require('./editor/shortcuts-modal').openShortcutsModal;
} catch {
  // 快捷键面板将在模块准备就绪后动态引入
}

const $ = (id) => document.getElementById(id);
const settingsKey = 'dogsc.recorder';
const saved = JSON.parse(localStorage.getItem(settingsKey) || '{}');

const state = {
  environment: { ok: false, reason: '正在检查 ffmpeg…' },
  displays: [],
  selection: { kind: 'display', displayId: null },
  selectionLabel: '',
  mic: { on: saved.mic ?? true, deviceId: saved.micId || null, permissionError: null },
  cam: { on: false, deviceId: saved.camId || null },
  sys: { on: saved.sys ?? true },
  session: null,
  result: null,
};

const persist = () => localStorage.setItem(settingsKey, JSON.stringify({
  mic: state.mic.on,
  micId: state.mic.deviceId,
  camId: state.cam.deviceId,
  sys: state.sys.on,
}));

const SOURCE_LABELS = { display: '全屏录制', window: '窗口录制', area: '选定区域' };

// ------------------------------------------------------------------ 状态与渲染

function show(panel) {
  for (const id of ['idle', 'live', 'busy', 'done']) {
    const el = $(id);
    if (el) el.hidden = id !== panel;
  }
}

function render() {
  // 1. 录制模式高亮与副标题
  document.querySelectorAll('.source').forEach((button) => {
    const active = button.dataset.source === state.selection.kind;
    button.classList.toggle('active', active);
    const span = button.querySelector('span');
    if (span) {
      span.textContent = active && state.selectionLabel
        ? state.selectionLabel
        : (button.dataset.source === 'display' ? '显示器' : button.dataset.source === 'window' ? '窗口' : '区域');
    }
    button.title = active && state.selectionLabel ? state.selectionLabel : (button.getAttribute('title') || '');
  });

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
  $('cam')?.classList.toggle('on', state.cam.on);
  $('sys')?.classList.toggle('on', state.sys.on);
  $('mic-row')?.classList.toggle('on', state.mic.on);
  $('cam-row')?.classList.toggle('on', state.cam.on);
  $('sys-row')?.classList.toggle('on', state.sys.on);

  if ($('mic-status')) {
    $('mic-status').textContent = state.mic.permissionError || (state.mic.on ? '就绪' : '关闭');
    $('mic-status').classList.toggle('error', Boolean(state.mic.permissionError));
  }
  if ($('cam-status')) $('cam-status').textContent = state.cam.on ? '开启' : '关闭';
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
  const startBtn = $('start');
  if (startBtn) {
    startBtn.disabled = !state.environment.ok;
    startBtn.title = state.environment.ok ? '开始录制 (Ctrl+Alt+R)' : (state.environment.reason || '暂时无法录制');
  }
}

// ------------------------------------------------------------------ 目标源与设备选择

async function chooseSource(kind) {
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
}

async function deviceMenu(kind, target) {
  // 设备名称要先拿到一次授权才会给出。
  let permissionError = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia(kind === 'audioinput' ? { audio: true } : { video: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch (error) {
    permissionError = error;
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
  target.permissionError = permissionError && permissionError.name === 'NotAllowedError' ? '需要麦克风权限' : null;
  persist();
  if (target === state.cam) ipcRenderer.send('recorder:camera-preview', { visible: true, deviceId: chosen });
  await updateDeviceNames();
  render();
}

async function updateDeviceNames() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (state.mic.deviceId) {
      const dev = devices.find((d) => d.kind === 'audioinput' && d.deviceId === state.mic.deviceId);
      if (dev && dev.label && $('mic-name-label')) {
        $('mic-name-label').textContent = dev.label;
        $('mic-name').title = dev.label;
      }
    } else if ($('mic-name-label')) {
      const defaultDev = devices.find((d) => d.kind === 'audioinput' && (d.deviceId === 'default' || !d.deviceId));
      if (defaultDev && defaultDev.label) {
        $('mic-name-label').textContent = defaultDev.label;
        $('mic-name').title = defaultDev.label;
      }
    }
    if (state.cam.deviceId) {
      const dev = devices.find((d) => d.kind === 'videoinput' && d.deviceId === state.cam.deviceId);
      if (dev && dev.label && $('cam-name')) {
        $('cam-name').textContent = dev.label;
        $('cam-name').title = dev.label;
      }
    } else if ($('cam-name')) {
      const defaultDev = devices.find((d) => d.kind === 'videoinput');
      if (defaultDev && defaultDev.label) {
        $('cam-name').textContent = defaultDev.label;
        $('cam-name').title = defaultDev.label;
      }
    }
  } catch {
    // 权限未就绪时忽略
  }
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

// ------------------------------------------------------------------ 事件监听与交互绑定

// 模式卡片点击
document.querySelectorAll('.source').forEach((button) => {
  const kind = button.dataset.source;
  button.addEventListener('click', () => chooseSource(kind));
});

// 窗口控制：最小化与关闭
$('win-min')?.addEventListener('click', () => ipcRenderer.send('window:minimize'));
$('win-close')?.addEventListener('click', () => ipcRenderer.send('window:close'));
$('quit')?.addEventListener('click', () => ipcRenderer.send('window:close'));

// 设备开关与菜单
function toggleDevice(kind) {
  const target = state[kind];
  if (!target) return;
  target.on = !target.on;
  persist();
  if (kind === 'cam') {
    ipcRenderer.send('recorder:camera-preview', { visible: target.on, deviceId: target.deviceId });
  }
  render();
}

function bindDeviceToggle(kind) {
  const row = $(`${kind}-row`);
  const toggle = $(kind);
  row?.addEventListener('click', (event) => {
    if (event.target.closest('.toggle-switch')) return;
    toggleDevice(kind);
  });
  toggle?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleDevice(kind);
  });
}

bindDeviceToggle('mic');
bindDeviceToggle('cam');
bindDeviceToggle('sys');

$('mic')?.addEventListener('contextmenu', (e) => { e.preventDefault(); deviceMenu('audioinput', state.mic); });
$('mic-row')?.addEventListener('contextmenu', (e) => { e.preventDefault(); deviceMenu('audioinput', state.mic); });
$('mic-name')?.addEventListener('click', (e) => {
  e.stopPropagation();
  deviceMenu('audioinput', state.mic);
});
$('cam')?.addEventListener('contextmenu', (e) => { e.preventDefault(); deviceMenu('videoinput', state.cam); });
$('cam-row')?.addEventListener('contextmenu', (e) => { e.preventDefault(); deviceMenu('videoinput', state.cam); });
// 保存位置更改
$('change-save-dir')?.addEventListener('click', async () => {
  try {
    const chosen = await ipcRenderer.invoke('config:choose-projects-root');
    if (chosen && $('save-dir-path')) {
      $('save-dir-path').textContent = chosen;
      $('save-dir-path').title = chosen;
    }
  } catch (err) {
    console.error('Failed to choose projects root:', err);
  }
});

// 打开保存文件夹
$('open-save-dir')?.addEventListener('click', () => {
  const dir = $('save-dir-path')?.title || $('save-dir-path')?.textContent;
  if (dir && dir !== '正在读取存储路径…') {
    ipcRenderer.send('shell:open', dir);
  }
});

// 底部工具栏
$('library')?.addEventListener('click', () => ipcRenderer.send('recorder:library'));
$('memo')?.addEventListener('click', () => ipcRenderer.send('recorder:memo'));
$('memo2')?.addEventListener('click', () => ipcRenderer.send('recorder:memo'));

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

async function openStreams() {
  const streams = {};
  const problems = [];
  const describe = (name, error) => (error && error.name === 'NotAllowedError'
    ? `${name}（请在 Windows 设置 → 隐私和安全性 → ${name} 里允许桌面应用访问）`
    : name);

  if (state.cam.on) {
    try {
      streams.camera = await navigator.mediaDevices.getUserMedia({
        video: { ...device(state.cam.deviceId), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
    } catch (error) { problems.push(describe('摄像头', error)); }
  }
  if (state.mic.on) {
    try {
      streams.microphone = await navigator.mediaDevices.getUserMedia({
        audio: { ...device(state.mic.deviceId), echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
      });
    } catch (error) { problems.push(describe('麦克风', error)); }
  }
  if (state.sys.on) {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      display.getVideoTracks().forEach((track) => track.stop());
      if (display.getAudioTracks().length) streams.system = new MediaStream(display.getAudioTracks());
      else problems.push('系统声音');
    } catch { problems.push('系统声音'); }
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
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
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

let timer = null;

async function start() {
  const startBtn = $('start');
  if (startBtn) startBtn.disabled = true;
  const { streams, problems } = await openStreams();
  const tracks = [];
  const fail = async (error) => {
    await stopTracks(tracks);
    Object.values(streams).forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    state.environment = { ...state.environment, ok: false, reason: String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
    render();
    setTimeout(() => { state.environment.ok = true; render(); }, 6000);
  };

  try {
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
  } catch (error) {
    await fail(error);
    return;
  }

  state.session = { tracks, beganAt: performance.now(), markers: 0, wanted: { camera: state.cam.on, microphone: state.mic.on, system: state.sys.on } };

  const inputs = [streams.microphone && '麦克风', streams.camera && '摄像头', streams.system && '系统声音'].filter(Boolean);
  if ($('liveTitle')) $('liveTitle').textContent = inputs.length ? `正在录制 · ${inputs.join(' + ')}` : '正在录制 · 仅画面';
  if ($('liveDetail')) {
    $('liveDetail').textContent = problems.length ? `未能打开：${problems.join('、')}` : '录制主控台不会被录入画面';
    $('liveDetail').title = problems.join('\n');
    $('liveDetail').classList.toggle('error', problems.length > 0);
  }
  state.session.problems = problems;
  const markerSpan = $('marker')?.querySelector('span');
  if (markerSpan) markerSpan.textContent = '标记';

  show('live');
  timer = setInterval(() => {
    if ($('timer') && state.session) {
      $('timer').textContent = formatTime((performance.now() - state.session.beganAt) / 1000, false);
    }
  }, 250);
  if ($('timer')) $('timer').textContent = '00:00';

  // 录制开始：主进程隐藏控制台窗口，实现全屏录制零遮挡
  ipcRenderer.send('recorder:hide');
}

async function stop(discard) {
  if (!state.session) return;
  clearInterval(timer);
  const session = state.session;
  state.session = null;

  // 录制停止：主进程恢复显示主控制台窗口
  ipcRenderer.send('recorder:show');

  if ($('busyTitle')) $('busyTitle').textContent = discard ? '正在放弃这次录制…' : '正在整理素材…';
  show('busy');

  const tracks = await stopTracks(session.tracks);
  if (discard) {
    await ipcRenderer.invoke('recorder:cancel');
    show('idle');
    render();
    return;
  }

  try {
    state.result = await ipcRenderer.invoke('recorder:stop', tracks);
    if (state.result && state.result.directory) {
      await ipcRenderer.invoke('project:open', state.result.directory);
      state.result = null;
      show('idle');
      render();
      return;
    }
  } catch (error) {
    state.result = null;
    if ($('doneTitle')) $('doneTitle').textContent = '这次录制没有保存成功';
    if ($('doneDetail')) {
      $('doneDetail').textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      $('doneDetail').classList.add('error');
    }
    if ($('edit')) $('edit').hidden = true;
    if ($('reveal')) $('reveal').hidden = true;
  }
  show('done');
}

// 录制控制按钮
$('start')?.addEventListener('click', start);
$('stop')?.addEventListener('click', () => stop(false));
$('discard')?.addEventListener('click', () => stop(true));
$('marker')?.addEventListener('click', async () => {
  const count = await ipcRenderer.invoke('recorder:marker');
  if (count) {
    const span = $('marker')?.querySelector('span');
    if (span) span.textContent = `标记 ${count}`;
  }
});

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

ipcRenderer.on('recorder:start', () => {
  if (!state.session && $('start') && !$('start').disabled) {
    show('idle');
    render();
    start();
  }
});

ipcRenderer.on('recorder:stop', () => {
  if (state.session) {
    stop(false);
  }
});

ipcRenderer.on('recorder:toggle', () => {
  if (state.session) {
    stop(false);
  } else if ($('start') && !$('start').disabled) {
    show('idle');
    render();
    start();
  }
});

ipcRenderer.on('recorder:discard', () => {
  if (state.session) {
    stop(true);
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

ipcRenderer.on('recorder:marker-added', (event, count) => {
  const span = $('marker')?.querySelector('span');
  if (span) span.textContent = `标记 ${count}`;
});

ipcRenderer.on('app:environment', (event, environment) => {
  state.environment = environment;
  render();
  refreshProjectsRoot();
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
    state.environment = await ipcRenderer.invoke('app:environment');
  } catch (err) {
    console.error('Failed to load environment:', err);
  }
  await refreshProjectsRoot();
  await updateDeviceNames();
  render();
})();
