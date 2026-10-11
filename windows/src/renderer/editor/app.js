'use strict';
// 编辑器入口：装配状态、预览、时间线、检查器，并接好工具栏与快捷键。

const { ipcRenderer } = require('electron');
const { query, icon, element, formatTime } = require('../common');
const { ASPECT_RATIOS } = require('../../core/model');
const timeline = require('../../core/timeline');
const { MosaicClip, StickerClip } = require('../../core/opening-overlay');
const { makeCameraMotionClip } = require('../../core/camera-motion');
const { Store } = require('./store');
const { Preview } = require('./preview');
const { TimelineView } = require('./timeline-view');
const { Inspector, TABS } = require('./inspector');
const { openExportDialog } = require('./export-dialog');
const { initPresetsUI } = require('./presets-ui');
const { openShortcutsModal } = require('./shortcuts-modal');
const { clipboard } = require('./clipboard');
const { splitEffectClip } = require('./effect-editing');
const { rippleTrimSeekTime } = require('./ripple-playhead');
const { initOverlayInteraction } = require('./overlay-interaction');
const $ = (id) => document.getElementById(id);
const directory = query.get('project');

const SHORTCUTS = [
  ['空格', '播放 / 暂停'], ['S　或　Ctrl+B', '在播放头处分割'], ['Delete', '删除选中的片段或缩放'], ['Z', '在播放头处添加缩放'],
  ['← / →', '逐帧移动（按住 Shift 每次 1 秒）'], ['Home / End', '跳到开头 / 结尾'], ['Ctrl+Z', '撤销'], ['Ctrl+Shift+Z　或　Ctrl+Y', '重做'],
  ['Ctrl+滚轮', '缩放时间线'], ['Ctrl+E', '导出'],
];

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 2200);
}

async function main() {
  const project = await ipcRenderer.invoke('project:read', directory);
  const store = new Store(directory, project);
  const preview = new Preview(store, $('preview'), $('canvas-wrap'));
  const timelineView = new TimelineView(store, preview, {
    scroller: $('scroller'), lanes: $('lanes'), ruler: $('ruler'), screen: $('lane-screen'), zoom: $('lane-zoom'), playhead: $('playhead'), slider: $('timeline-zoom'),
    effects: { screen: $('lane-screen-motion'), camera: $('lane-camera-motion'), mosaic: $('lane-mosaic'), sticker: $('lane-sticker') },
  });
  $('scroller').addEventListener('scroll', () => { $('track-labels').scrollTop = $('scroller').scrollTop; }, { passive: true });
  const inspector = new Inspector(store, preview, $('inspector'), $('inspector-title'));
  inspector.onToast = toast;
  window.reclyEditor = { store, preview, timelineView, inspector };
  if (typeof preview.setQuality === 'function') preview.setQuality(project.previewQuality || 'balanced');

  // ---- 顶栏
  $('open-library').innerHTML = icon('folder');
  $('undo').innerHTML = icon('undo');
  $('redo').innerHTML = icon('redo');
  $('export').innerHTML = `${icon('export')}导出`;
  $('project-name').value = project.name;
  $('project-name').addEventListener('change', (event) => {
    const name = event.target.value.trim() || project.name;
    event.target.value = name;
    store.mutate((draft) => { draft.name = name; });
    document.title = `${name} — Recly`;
  });
  $('project-name').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === 'Escape') event.target.blur(); });
  $('open-library').addEventListener('click', () => ipcRenderer.send('recorder:library'));
  $('undo').addEventListener('click', () => store.undo());
  $('redo').addEventListener('click', () => store.redo());
  $('export').addEventListener('click', () => openExportDialog(store, preview, $('modal')));
  const presetsUI = await initPresetsUI({
    store,
    button: $('scene-preset'),
    modal: $('modal'),
    toast,
  });
  $('shortcuts').addEventListener('click', () => {
    openShortcutsModal($('modal'));
  });

  // ---- 窗口控制（最小化、最大化 / 还原、关闭）
  if ($('editor-min')) $('editor-min').addEventListener('click', () => ipcRenderer.send('window:minimize'));
  if ($('editor-max')) $('editor-max').addEventListener('click', () => ipcRenderer.send('window:toggle-maximize'));
  if ($('editor-close')) $('editor-close').addEventListener('click', () => ipcRenderer.send('window:close'));

  // ---- 左侧分类栏与画布比例
  const railButtons = TABS.map((tab) => element('button', { html: `${icon(tab.icon)}<span>${tab.label}</span>`, onclick: () => showTab(tab.id) }));
  $('rail').append(...railButtons);
  function showTab(id) {
    railButtons.forEach((button, index) => button.classList.toggle('active', TABS[index].id === id));
    inspector.show(id);
  }
  inspector.timelineView = timelineView;
  const createEffect = async (kind, outputTime) => {
    const hit = timeline.locate(store.project.timeline.segments, outputTime);
    if (!hit) return toast('请先保留一段录屏画面');
    const startTime = hit.sourceTime;
    const duration = Math.min(2, store.project.media.screen.duration - startTime);
    if (kind !== 'screen' && duration < 0.1) return toast('播放头离素材末尾太近，无法添加效果');
    let clip;
    let pool;
    if (kind === 'screen') {
      const project = store.project;
      const clips = project.timeline.screenMotionClips || [];
      const active = clips.find((item) => startTime >= item.timing.startTime
        && startTime < item.timing.startTime + item.timing.duration);
      if (active) {
        store.select({ type: 'screen', id: active.id });
        showTab('motion');
        return;
      }
      const { createScreenMotionClipAtTime } = require('../../core/screen-motion');
      clip = createScreenMotionClipAtTime({
        time: startTime,
        clips,
        timelineDuration: project.media.screen.duration,
        base: {
          position: project.canvas.contentPosition,
          scale: project.canvas.contentScale,
          rotationX: project.canvas.rotationX,
          rotationY: project.canvas.rotationY,
          rotationZ: project.canvas.rotationZ,
          perspective: project.canvas.perspective,
        },
        motionStyle: project.motion,
        easing: project.motion.defaultZoomEasing || 'cubic',
        transitionDuration: project.motion.defaultZoomTransitionDuration ?? 0.7,
      });
      if (!clip) return toast('播放头附近没有空间添加屏幕 3D，请先移动播放头。');
      pool = 'screenMotionClips';
    } else if (kind === 'camera') {
      if (!store.project.media.camera) return toast('这个项目没有摄像头素材');
      clip = makeCameraMotionClip({
        timing: { startTime, duration },
        target: {
          layout: 'shape', shape: store.project.camera.shape,
          position: { ...store.project.camera.position }, size: store.project.camera.size,
          roundness: store.project.camera.roundness, opacity: 1,
        },
      });
      pool = 'cameraMotionClips';
    } else if (kind === 'mosaic') {
      clip = new MosaicClip({ timing: { startTime, duration } });
      pool = 'mosaicClips';
    } else if (kind === 'sticker') {
      try {
        const asset = await ipcRenderer.invoke('project:import-asset', { directory, kind: 'image' });
        if (!asset) return;
        clip = new StickerClip({
          relativePath: asset.file,
          aspectRatio: asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 1,
          timing: { startTime, duration },
        });
        pool = 'stickerClips';
      } catch (error) {
        return toast(error.message || '贴图导入失败');
      }
    } else return;
    store.mutate((draft) => { draft.timeline[pool].push(JSON.parse(JSON.stringify(clip))); });
    const selectionType = kind;
    store.select({ type: selectionType, id: clip.id });
    showTab(kind === 'screen' ? 'motion' : kind === 'camera' ? 'camera' : 'overlays');
    if (kind === 'sticker') {
      try {
        await preview.compositor.prepare(store.project);
        preview.invalidate();
      } catch (error) {
        toast(error.message || '贴图预载失败');
      }
    }
  };
  timelineView.onAddEffect = createEffect;
  initOverlayInteraction({
    store, preview, stage: $('stage'), canvasWrap: $('canvas-wrap'),
    onAddMosaic: () => inspector.requestEffect('mosaic'),
    onImportImage: (file) => inspector.importSticker('image', file),
    onPasteImage: () => inspector.importSticker('clipboard'),
    onPasteSelected: () => pasteSelected(),
    onShowOverlayInspector: () => showTab('overlays'), onToast: toast,
  });
  inspector.onCopyClip = (kind, clip) => clipboard.copy(clip, kind);

  const rippleTrim = (edge) => {
    const segments = store.project.timeline.segments;
    const hit = timeline.locate(segments, preview.time);
    const next = timeline.rippleTrimAt(segments, preview.time, edge);
    if (!next) return toast('播放头不在可裁切的位置');
    const seekTime = rippleTrimSeekTime(hit, preview.time, edge);
    store.mutate((draft) => { draft.timeline.segments = next; });
    if (seekTime !== null) preview.seek(seekTime);
  };
  const splitSelectedEffect = () => {
    const selection = store.selection;
    if (!selection || !['zoom', 'screen', 'camera', 'mosaic', 'sticker'].includes(selection.type)) return false;
    const hit = timeline.locate(store.project.timeline.segments, preview.time);
    const clip = store.getClip(selection.type, selection.id);
    if (!hit || !clip) return toast('播放头需要位于选中的效果片段内');
    const split = splitEffectClip(clip, selection.type, hit.sourceTime);
    if (!split) return toast('分割点两侧至少需要保留 0.05 秒');
    const poolKey = {
      zoom: null,
      screen: 'screenMotionClips',
      camera: 'cameraMotionClips',
      mosaic: 'mosaicClips',
      sticker: 'stickerClips',
    }[selection.type];
    store.mutate((draft) => {
      const pool = selection.type === 'zoom' ? draft.zoomAnimations : draft.timeline[poolKey];
      const index = pool.findIndex((item) => item.id === selection.id);
      if (index >= 0) pool.splice(index, 1, ...split);
    });
    store.select({ type: selection.type, id: split[0].id });
    showTab(selection.type === 'camera' ? 'camera' : ['mosaic', 'sticker'].includes(selection.type) ? 'overlays' : 'motion');
    return true;
  };
  const restoreMissingRange = async () => {
    const segments = store.project.timeline.segments;
    const sourceTime = timeline.locate(segments, preview.time)?.sourceTime;
    const ranges = timeline.missingRanges(segments, store.project.media.screen.duration);
    if (!ranges.length) return toast('没有可恢复的素材缺口');
    const choice = await ipcRenderer.invoke('recorder:menu', ranges.map((range, index) => ({
      id: String(index), label: `${formatTime(range.sourceStart)} – ${formatTime(range.sourceEnd)}（${(range.sourceEnd - range.sourceStart).toFixed(2)} 秒）`,
    })));
    if (choice === undefined || choice === null) return;
    const range = ranges[Number(choice)];
    if (!range) return;
    const insertionIndex = segments.findIndex((segment) => segment.sourceStart >= range.sourceEnd);
    const next = timeline.restoreRange(segments, range, insertionIndex < 0 ? segments.length : insertionIndex);
    if (!next) return toast('这个缺口已被其他片段覆盖');
    store.mutate((draft) => { draft.timeline.segments = next; });
    if (sourceTime !== undefined) preview.seek(timeline.sourceToOutput(next, sourceTime));
  };

  $('display-mode').addEventListener('click', () => {
    const mode = timelineView.displayMode === 'waveform' ? 'frames' : 'waveform';
    timelineView.setDisplayMode(mode);
    $('display-mode').textContent = mode === 'waveform' ? '画面' : '波形';
  });
  $('snap-toggle').addEventListener('click', () => {
    timelineView.snapEnabled = !timelineView.snapEnabled;
    $('snap-toggle').classList.toggle('active', timelineView.snapEnabled);
    $('snap-toggle').title = timelineView.snapEnabled ? '吸附已开启' : '吸附已关闭';
  });
  $('ripple-start').addEventListener('click', () => rippleTrim('start'));
  $('ripple-end').addEventListener('click', () => rippleTrim('end'));
  $('restore-gap').addEventListener('click', restoreMissingRange);
  $('quality').addEventListener('click', () => {
    const quality = (store.project.previewQuality || 'balanced') === 'balanced' ? 'full' : 'balanced';
    if (typeof preview.setQuality === 'function') preview.setQuality(quality);
    else return toast('预览质量切换暂不可用');
    store.mutate((draft) => { draft.previewQuality = quality; });
    $('quality').textContent = quality === 'balanced' ? '流畅预览' : '原画预览';
  });
  $('quality').textContent = (project.previewQuality || 'balanced') === 'balanced' ? '流畅预览' : '原画预览';
  if (timelineView.setDisplayMode) timelineView.setDisplayMode('frames');
  function renderRatio() {
    $('ratio').replaceChildren(...Object.entries(ASPECT_RATIOS).map(([id, item]) => element('button', {
      class: store.project.canvas.aspectRatio === id ? 'active' : '', onclick: () => store.mutate((draft) => { draft.canvas.aspectRatio = id; }),
    }, item.label)));
  }

  // ---- 时间线工具栏
  $('split').innerHTML = icon('scissors');
  $('delete').innerHTML = icon('trash');
  $('previous').innerHTML = icon('previous');
  $('next').innerHTML = icon('next');
  $('zoom-out').innerHTML = icon('minus');
  $('zoom-in').innerHTML = icon('plus');
  $('label-screen').innerHTML = `${icon('display')}屏幕录制`;
  $('label-zoom').innerHTML = `${icon('motion')}缩放`;
  $('label-screen-motion').innerHTML = `${icon('motion')}屏幕 3D`;
  $('label-camera-motion').innerHTML = `${icon('camera')}摄像运镜`;
  $('label-mosaic').innerHTML = `${icon('area')}柔化 / 聚光`;
  $('label-sticker').innerHTML = `${icon('canvas')}贴图`;
  $('snap-toggle').innerHTML = icon('magnet');
  $('snap-toggle').classList.toggle('active', timelineView.snapEnabled);
  $('display-mode').textContent = timelineView.displayMode === 'waveform' ? '画面' : '波形';

  const split = () => {
    if (store.selection && ['zoom', 'screen', 'camera', 'mosaic', 'sticker'].includes(store.selection.type)) {
      return splitSelectedEffect();
    }
    const next = timeline.splitAt(store.project.timeline.segments, preview.time);
    if (!next) return toast('离片段边缘太近，无法在这里分割');
    store.mutate((draft) => { draft.timeline.segments = next; });
    return null;
  };
  const remove = () => {
    if (store.selectedZoom) {
      const { id } = store.selectedZoom;
      store.mutate((draft) => { draft.zoomAnimations = draft.zoomAnimations.filter((clip) => clip.id !== id); });
      store.select(null);
    } else if (store.selectedSegment) {
      const next = timeline.removeSegment(store.project.timeline.segments, store.selectedSegment.id);
      if (!next) return toast('至少要保留一个片段');
      store.mutate((draft) => { draft.timeline.segments = next; });
      store.select(null);
    } else if (store.selection && ['screen', 'camera', 'mosaic', 'sticker'].includes(store.selection.type)) {
      const { type, id } = store.selection;
      const pool = { screen: 'screenMotionClips', camera: 'cameraMotionClips', mosaic: 'mosaicClips', sticker: 'stickerClips' }[type];
      store.mutate((draft) => { draft.timeline[pool] = draft.timeline[pool].filter((clip) => clip.id !== id); });
      store.select(null);
    } else {
      toast('先在时间线上点选一个片段或效果');
    }
    return null;
  };
  const addZoom = () => {
    if (!timelineView.addZoomAt(preview.time)) return toast('这个位置已经有缩放了，或离下一段缩放太近');
    showTab('motion');
    return null;
  };
  const chooseSpeed = async () => {
    const segment = store.selectedSegment || timeline.locate(store.project.timeline.segments, preview.time).segment;
    const chosen = await ipcRenderer.invoke('recorder:menu', timeline.SPEEDS.map((speed) => ({ id: String(speed), label: `${speed}×`, checked: Math.abs(segment.speed - speed) < 1e-6 })));
    if (!chosen) return;
    // 变速后保持播放头停在同一处素材上。
    const sourceTime = preview.sourceTime;
    store.mutate((draft) => { draft.timeline.segments = timeline.setSpeed(draft.timeline.segments, segment.id, Number(chosen)); });
    preview.seek(timeline.sourceToOutput(store.project.timeline.segments, sourceTime));
  };
  /// 剪辑点、标记、缩放起点都算可跳转的位置。
  const jump = (direction) => {
    const { segments } = store.project.timeline;
    const points = new Set([0, timeline.outputDuration(segments)]);
    let start = 0;
    for (const segment of segments) { points.add(start); start += timeline.segmentOutputDuration(segment); }
    for (const marker of store.project.markers) if (timeline.isRetained(segments, marker.time)) points.add(timeline.sourceToOutput(segments, marker.time));
    for (const clip of store.zoomClips) if (timeline.isRetained(segments, clip.startTime)) points.add(timeline.sourceToOutput(segments, clip.startTime));
    const ordered = [...points].sort((a, b) => a - b);
    const target = direction > 0 ? ordered.find((point) => point > preview.time + 0.02) : ordered.reverse().find((point) => point < preview.time - 0.02);
    if (target !== undefined) preview.seek(target);
  };

  $('split').addEventListener('click', split);
  $('delete').addEventListener('click', remove);
  $('speed').addEventListener('click', chooseSpeed);
  $('add-zoom').addEventListener('click', addZoom);
  $('add-zoom').innerHTML = `${icon('plus')}缩放`;
  $('previous').addEventListener('click', () => jump(-1));
  $('next').addEventListener('click', () => jump(1));
  $('play').addEventListener('click', () => preview.toggle());
  $('zoom-out').addEventListener('click', () => timelineView.setZoom(Math.max(timelineView.zoomLevel - 0.1, 0)));
  $('zoom-in').addEventListener('click', () => timelineView.setZoom(Math.min(timelineView.zoomLevel + 0.1, 1)));

  const supportedClipTypes = new Set(['zoom', 'screen', 'camera', 'mosaic', 'sticker']);
  const selectedClip = () => store.selection && supportedClipTypes.has(store.selection.type)
    ? store.getClip(store.selection.type, store.selection.id)
    : null;
  const copySelected = () => {
    const clip = selectedClip();
    if (!clip) return toast('先选择一个缩放或效果片段');
    clipboard.copy(clip, store.selection.type);
  };
  const pasteSelected = async () => {
    if (!clipboard.hasClip()) return toast('先复制一个效果片段');
    const kind = clipboard.clipboardData.kind;
    if (!supportedClipTypes.has(kind)) return toast('剪贴板里的内容不能作为效果粘贴');
    const sourceTime = timeline.locate(store.project.timeline.segments, preview.time)?.sourceTime || 0;
    let pasted;
    store.mutate((draft) => { pasted = clipboard.paste(draft, sourceTime); });
    if (!pasted) return toast('无法粘贴这个效果');
    store.select({ type: kind, id: pasted.id });
    showTab(kind === 'zoom' || kind === 'screen' ? 'motion' : kind === 'camera' ? 'camera' : 'overlays');
    if (kind === 'sticker') {
      try {
        await preview.compositor.prepare(store.project);
        preview.invalidate();
      } catch (error) {
        toast(error.message || '贴图预载失败');
      }
    }
  };
  const pasteSelectedAttributes = () => {
    if (!clipboard.hasClip()) return toast('先复制一个效果片段');
    const kind = store.selection && store.selection.type;
    if (!supportedClipTypes.has(kind)) return toast('先选择一个效果片段');
    if (clipboard.clipboardData.kind !== kind) return toast('只能把同类效果的属性粘贴到一起');
    store.mutate((draft) => {
      const pool = kind === 'zoom' ? draft.zoomAnimations : draft.timeline[
        { screen: 'screenMotionClips', camera: 'cameraMotionClips', mosaic: 'mosaicClips', sticker: 'stickerClips' }[kind]
      ];
      const target = pool.find((clip) => clip.id === store.selection.id);
      clipboard.pasteAttributes(target, clipboard.clipboardData, kind);
    });
  };

  // ---- 状态同步
  const refreshChrome = () => {
    const segment = store.selectedSegment || timeline.locate(store.project.timeline.segments, preview.time).segment;
    $('speed').innerHTML = `${icon('speed')}${segment.speed}×`;
    $('undo').disabled = !store.undoStack.length;
    $('redo').disabled = !store.redoStack.length;
    $('clock-total').textContent = formatTime(timeline.outputDuration(store.project.timeline.segments));
    $('quality').textContent = (store.project.previewQuality || 'balanced') === 'balanced' ? '流畅预览' : '原画预览';
    $('save-state').textContent = { saved: '已保存', pending: '正在保存…', failed: '保存失败，请检查磁盘空间或权限' }[store.saveState];
    $('save-state').style.color = store.saveState === 'failed' ? 'var(--danger)' : '';
    renderRatio();
  };
  store.subscribe(refreshChrome);
  preview.onState = () => { $('play').innerHTML = icon(preview.playing ? 'pause' : 'play'); };
  preview.onStatus = (status) => { $('preview-status').textContent = status; };
  preview.onStatus(preview.status);
  preview.onTime = (time) => {
    $('clock-now').textContent = formatTime(time);
    timelineView.updatePlayhead();
  };
  preview.onState();
  preview.onTime(0);
  refreshChrome();
  showTab('canvas');

  // ---- 快捷键
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) && event.target.type !== 'range';
    const control = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (!$('modal').hidden) {
      if (event.key === 'Escape' && !$('modal').querySelector('.progress')) { $('modal').hidden = true; }
      return;
    }
    if (typing) return;
    const frame = 1 / (store.project.media.screen.frameRate || 60);
    const handlers = [
      [control && key === 'z' && !event.shiftKey, () => store.undo()],
      [control && ((key === 'z' && event.shiftKey) || key === 'y'), () => store.redo()],
      [control && key === 'c', copySelected],
      [control && key === 'v' && event.shiftKey, pasteSelectedAttributes],
      [control && key === 'v' && !event.shiftKey, pasteSelected],
      [control && key === 'e', () => openExportDialog(store, preview, $('modal'))],
      [control && key === 'b', split],
      [!control && key === ' ', () => preview.toggle()],
      [!control && key === 's', split],
      [!control && key === 'q', () => rippleTrim('start')],
      [!control && key === 'w', () => rippleTrim('end')],
      [!control && key === 'z', addZoom],
      [key === 'delete' || key === 'backspace', remove],
      [key === 'arrowleft', () => { preview.pause(); preview.seek(preview.time - (event.shiftKey ? 1 : frame)); }],
      [key === 'arrowright', () => { preview.pause(); preview.seek(preview.time + (event.shiftKey ? 1 : frame)); }],
      [key === 'home', () => preview.seek(0)],
      [key === 'end', () => preview.seek(preview.duration)],
      [key === 'escape', () => store.select(null)],
    ];
    const match = handlers.find(([condition]) => condition);
    if (!match) return;
    event.preventDefault();
    match[1]();
  });

  // 关窗前把还没落盘的改动写完。
  window.addEventListener('beforeunload', () => { store.save(); });
  document.title = `${project.name} — Recly`;

  // 自测钩子：切到运镜面板、选中第一段缩放并跳到它的保持区间。
  window.dogscSelfTest = () => {
    const clip = store.zoomClips[0];
    if (clip) {
      store.select({ type: 'zoom', id: clip.id });
      preview.seek(timeline.sourceToOutput(store.project.timeline.segments, clip.startTime + clip.enterDuration + 0.4));
    }
    showTab('motion');
    return { zoomClips: store.zoomClips.length, segments: store.project.timeline.segments.length, time: preview.time, canvas: `${$('preview').width}x${$('preview').height}`, screenReady: preview.screen.node.readyState };
  };
}

main().catch((error) => {
  document.body.replaceChildren(element('div', { style: 'padding:40px;font-size:15px;user-select:text' },
    element('b', {}, '这个项目打不开'), element('p', {}, String(error && error.message || error)),
    element('p', { class: 'muted' }, directory || '')));
});
