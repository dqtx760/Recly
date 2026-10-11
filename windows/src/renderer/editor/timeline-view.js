'use strict';
// 时间线：标尺与标记、屏幕录制轨（缩略图片段，可分割 / 裁边）、缩放轨（可拖动 / 改长短）。
// 横轴是输出时间；缩放与标记以素材时间保存，绘制时经片段映射到输出时间。

const path = require('node:path');
const { element, icon, formatTime, fileUrl } = require('../common');
const { clamp } = require('../../core/model');
const zoomCore = require('../../core/zoom');
const timeline = require('../../core/timeline');
const waveform = require('./waveform');

const PAD = 14;
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MIN_ZOOM_CLIP = 0.2;
const EFFECT_POOL_KEYS = {
  screen: 'screenMotionClips',
  camera: 'cameraMotionClips',
  mosaic: 'mosaicClips',
  sticker: 'stickerClips',
};

class TimelineView {
  constructor(store, preview, nodes) {
    this.store = store;
    this.preview = preview;
    this.nodes = nodes; // { scroller, lanes, ruler, screen, zoom, effects, playhead, slider }
    this.zoomLevel = 0;
    this.pps = 60;
    this.displayMode = 'frames';
    this.snapEnabled = true;
    this.waveformCache = new Map();
    this.waveformSamples = new Map();
    this.segmentDrag = null;
    this.onAddEffect = null;
    const thumbnails = store.project.media.thumbnails;
    this.sprite = thumbnails ? { ...thumbnails, url: fileUrl(path.join(store.directory, thumbnails.file)) } : null;

    new ResizeObserver(() => this.render()).observe(nodes.scroller);
    store.subscribe((reason) => {
      if (reason === 'project' || reason === 'selection') this.render();
      if (reason === 'project' && this.displayMode === 'waveform') this.loadWaveforms();
    });
    nodes.slider.addEventListener('input', () => this.setZoom(Number(nodes.slider.value)));
    nodes.scroller.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      this.setZoom(clamp(this.zoomLevel - Math.sign(event.deltaY) * 0.06, 0, 1), event.clientX);
    }, { passive: false });

    nodes.ruler.addEventListener('pointerdown', (event) => this.scrub(event));
    for (const lane of [nodes.screen, nodes.zoom]) {
      lane.addEventListener('pointerdown', (event) => {
        if (event.target !== lane) return;
        store.select(null);
        this.scrub(event);
      });
    }
    for (const kind of ['screen', 'camera', 'mosaic', 'sticker']) {
      const lane = nodes.effects?.[kind];
      if (!lane) continue;
      lane.addEventListener('pointerdown', (event) => {
        if (event.target !== lane) return;
        store.select(null);
        this.scrub(event);
      });
      lane.addEventListener('dblclick', (event) => {
        if (event.target === lane && typeof this.onAddEffect === 'function') {
          this.onAddEffect(kind, this.timeAt(event.clientX));
        }
      });
    }
    nodes.zoom.addEventListener('dblclick', (event) => { if (event.target === nodes.zoom) this.addZoomAt(this.timeAt(event.clientX)); });
    this.render();
  }

  get segments() { return this.store.project.timeline.segments; }

  get duration() { return timeline.outputDuration(this.segments); }

  setDisplayMode(mode) {
    if (!['frames', 'waveform'].includes(mode)) return false;
    this.displayMode = mode;
    this.renderSegments();
    if (mode === 'waveform') this.loadWaveforms();
    return true;
  }

  async loadWaveforms() {
    const media = this.store.project.media;
    const tracks = [media.microphone, media.systemAudio].filter((track) => track && track.file && Number.isFinite(track.duration) && track.duration > 0);
    await Promise.all(tracks.map(async (track) => {
      const file = path.join(this.store.directory, track.file);
      if (!this.waveformCache.has(file)) {
        this.waveformCache.set(file, waveform.extractWaveform(file, 4000));
      }
      const samples = await this.waveformCache.get(file);
      this.waveformSamples.set(file, samples);
    }));
    if (this.displayMode === 'waveform') this.renderSegments();
  }

  effectPools() {
    const timelineState = this.store.project.timeline;
    return Object.fromEntries(Object.entries(EFFECT_POOL_KEYS).map(([kind, key]) => [kind, timelineState[key] || []]));
  }

  sourceSnapPoints(excludeKind, excludeId) {
    const points = this.segments.flatMap((segment) => [segment.sourceStart, segment.sourceEnd]);
    const playhead = timeline.locate(this.segments, this.preview.time);
    if (playhead) points.push(playhead.sourceTime);
    for (const [kind, clips] of Object.entries(this.effectPools())) {
      for (const clip of clips) {
        if (kind === excludeKind && clip.id === excludeId) continue;
        const start = clip.timing?.startTime;
        const end = start + (clip.timing?.duration || 0);
        if (timeline.isRetained(this.segments, start)) points.push(start);
        if (timeline.isRetained(this.segments, end)) points.push(end);
      }
    }
    for (const clip of this.store.zoomClips || []) {
      if (excludeKind === 'zoom' && clip.id === excludeId) continue;
      points.push(clip.startTime, clip.endTime, zoomCore.effectEndTime(clip));
    }
    return points;
  }

  snapSourceTime(sourceTime, speed, event, excludeKind, excludeId) {
    if (!this.snapEnabled || event?.shiftKey) return sourceTime;
    let best = sourceTime;
    let distance = 8;
    for (const candidate of this.sourceSnapPoints(excludeKind, excludeId)) {
      const pixels = Math.abs(candidate - sourceTime) / Math.max(speed, 0.01) * this.pps;
      if (pixels <= distance) {
        distance = pixels;
        best = candidate;
      }
    }
    return best;
  }

  effectPieces() {
    return timeline.mapEffectClipsToOutput(this.segments, this.effectPools());
  }

  zoomPieces() {
    return timeline.mapEffectClipsToOutput(this.segments, { zoom: this.store.zoomClips || [] }).zoom;
  }

  zoomExitPieces() {
    const tails = (this.store.zoomClips || [])
      .filter((clip) => clip.exitDuration > 0.02)
      .map((clip) => ({ id: clip.id, startTime: clip.endTime, endTime: zoomCore.effectEndTime(clip) }));
    return timeline.mapEffectClipsToOutput(this.segments, { zoom: tails }).zoom;
  }

  outputSnapPoints() {
    const points = [this.preview.time];
    let start = 0;
    for (const segment of this.segments) {
      points.push(start, start + timeline.segmentOutputDuration(segment));
      start += timeline.segmentOutputDuration(segment);
    }
    for (const pieces of Object.values(this.effectPieces())) {
      for (const piece of pieces) points.push(piece.outputStart, piece.outputEnd);
    }
    for (const piece of [...this.zoomPieces(), ...this.zoomExitPieces()]) points.push(piece.outputStart, piece.outputEnd);
    return points;
  }

  snapOutputTime(outputTime, event) {
    if (!this.snapEnabled || event?.shiftKey) return outputTime;
    let best = outputTime;
    let distance = 8;
    for (const candidate of this.outputSnapPoints()) {
      const pixels = Math.abs(candidate - outputTime) * this.pps;
      if (pixels <= distance) {
        distance = pixels;
        best = candidate;
      }
    }
    return best;
  }

  beginSegmentPointer(event, segment) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.store.select({ type: 'segment', id: segment.id });
    const originalSegments = this.segments.slice();
    let outputStart = 0;
    const originalPositions = new Map();
    for (const item of originalSegments) {
      const duration = timeline.segmentOutputDuration(item);
      originalPositions.set(item.id, outputStart + duration / 2);
      outputStart += duration;
    }
    const state = {
      id: segment.id,
      startX: event.clientX,
      startY: event.clientY,
      originalSegments,
      originalPositions,
      targetIndex: originalSegments.findIndex((item) => item.id === segment.id),
      dragging: false,
    };
    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - state.startX;
      const dy = moveEvent.clientY - state.startY;
      if (!state.dragging && Math.hypot(dx, dy) >= 5) {
        state.dragging = true;
        this.segmentDrag = state;
        this.preview.pause();
      }
      if (!state.dragging) return;
      const snappedTime = this.snapOutputTime(this.timeAt(moveEvent.clientX), moveEvent);
      const targetTime = clamp(snappedTime, 0, this.duration);
      const remaining = originalSegments.filter((item) => item.id !== state.id);
      state.targetIndex = remaining.reduce((count, item) => count + (originalPositions.get(item.id) < targetTime ? 1 : 0), 0);
      this.renderSegments();
    };
    const onUp = (upEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (state.dragging) {
        const fromIndex = originalSegments.findIndex((item) => item.id === state.id);
        if (fromIndex !== state.targetIndex) {
          this.store.beginGesture();
          this.store.mutate((project) => {
            project.timeline.segments = timeline.reorderSegments(originalSegments, fromIndex, state.targetIndex);
          }, { history: false });
          this.store.endGesture();
        }
        this.segmentDrag = null;
        this.renderSegments();
      } else {
        this.preview.pause();
        this.preview.seek(this.timeAt(upEvent.clientX));
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  x(outputTime) { return PAD + outputTime * this.pps; }

  timeAt(clientX) {
    const bounds = this.nodes.lanes.getBoundingClientRect();
    return clamp((clientX - bounds.left - PAD) / this.pps, 0, this.duration);
  }

  setZoom(level, anchorClientX) {
    const anchorTime = anchorClientX === undefined ? this.preview.time : this.timeAt(anchorClientX);
    const anchorOffset = this.x(anchorTime) - this.nodes.scroller.scrollLeft;
    this.zoomLevel = level;
    this.nodes.slider.value = level;
    this.render();
    this.nodes.scroller.scrollLeft = this.x(anchorTime) - anchorOffset;
  }

  /// 拖动通用逻辑：move(dx 像素, 事件)。整个拖动只记一步撤销。
  drag(event, { move, end, gesture = true }) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    if (gesture) this.store.beginGesture();
    const onMove = (moveEvent) => move(moveEvent.clientX - startX, moveEvent);
    const onUp = (upEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (gesture) this.store.endGesture();
      if (end) end(upEvent.clientX - startX);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  scrub(event) {
    this.preview.pause();
    this.preview.seek(this.timeAt(event.clientX));
    this.drag(event, { gesture: false, move: (dx, moveEvent) => this.preview.seek(this.timeAt(moveEvent.clientX)) });
  }

  render() {
    const { scroller, lanes, slider } = this.nodes;
    const duration = Math.max(this.duration, 0.1);
    const available = Math.max(scroller.clientWidth - PAD * 2, 100);
    // 0 档正好铺满可视宽度，1 档放大到约 40 倍。
    this.pps = (available / duration) * (1 + this.zoomLevel * this.zoomLevel * 39);
    lanes.style.width = `${Math.max(duration * this.pps + PAD * 2, scroller.clientWidth)}px`;
    slider.value = this.zoomLevel;
    this.renderRuler(duration);
    this.renderSegments();
    this.renderZoomClips();
    this.renderEffectClips();
    this.updatePlayhead();
  }

  renderRuler(duration) {
    const step = TICK_STEPS.find((value) => value * this.pps >= 72) || TICK_STEPS[TICK_STEPS.length - 1];
    const nodes = [];
    for (let n = 0; n * step <= duration + 1e-6; n++) {
      const time = n * step;
      nodes.push(element('div', { class: 'tick', style: `left:${this.x(time)}px` }, step < 1 ? formatTime(time).slice(1) : formatTime(time, false)));
      const half = time + step / 2;
      if (half < duration && step * this.pps >= 110) nodes.push(element('div', { class: 'tick minor', style: `left:${this.x(half)}px` }));
    }
    for (const marker of this.store.project.markers) {
      if (!timeline.isRetained(this.segments, marker.time)) continue;
      const outputTime = timeline.sourceToOutput(this.segments, marker.time);
      nodes.push(element('div', {
        class: 'marker', style: `left:${this.x(outputTime)}px`, html: icon('flag'), title: `录制标记 ${formatTime(outputTime)} · 右键删除`,
        onpointerdown: (event) => { event.stopPropagation(); this.preview.seek(outputTime); },
        oncontextmenu: () => this.store.mutate((project) => { project.markers = project.markers.filter((item) => item.id !== marker.id); }),
      }));
    }
    this.nodes.ruler.replaceChildren(...nodes);
  }

  filmstrip(segment, width, height) {
    if (!this.sprite) return null;
    const { media } = this.store.project;
    const tileWidth = height * media.screen.width / media.screen.height;
    const tiles = [];
    for (let left = 0; left < width; left += tileWidth) {
      const sourceTime = segment.sourceStart + ((left + tileWidth / 2) / this.pps) * segment.speed;
      const index = clamp(Math.floor(sourceTime / this.sprite.interval), 0, this.sprite.count - 1);
      tiles.push(element('i', { style: `width:${tileWidth}px;background-image:url("${this.sprite.url}");background-size:${tileWidth * this.sprite.count}px ${height}px;background-position:${-index * tileWidth}px 0` }));
    }
    return element('div', { class: 'film' }, tiles);
  }

  waveformStrip(segment, width, height) {
    const media = this.store.project.media;
    const tracks = [media.microphone, media.systemAudio]
      .filter((track) => track && track.file && Number.isFinite(track.duration) && track.duration > 0)
      .map((track) => ({
        samples: this.waveformSamples.get(path.join(this.store.directory, track.file)) || [],
        duration: track.duration,
        offset: track.offset || 0,
      }));
    const count = Math.max(Math.ceil(width / 2), 1);
    const samples = timeline.waveformSamplesForSegment(segment, tracks, count);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = element('canvas', {
      class: 'film waveform',
      style: `position:absolute;inset:0;width:${width}px;height:${height}px;pointer-events:none`,
      'aria-hidden': 'true',
    });
    canvas.width = Math.max(Math.round(width * pixelRatio), 1);
    canvas.height = Math.max(Math.round(height * pixelRatio), 1);
    const context = canvas.getContext('2d');
    if (context) {
      context.scale(pixelRatio, pixelRatio);
      waveform.drawWaveform(context, samples, { x: 0, y: height * 0.12, width, height: height * 0.76 }, {
        color: 'rgba(140, 210, 196, 0.9)', barWidth: 2, gap: 1, mirror: true, minBarHeight: 1,
      });
    }
    return canvas;
  }

  renderSegments() {
    const lane = this.nodes.screen;
    if (!lane) return;
    const height = lane.clientHeight - 20;
    const mediaDuration = this.store.project.media.screen.duration;
    const visualSegments = this.segmentDrag?.dragging
      ? timeline.reorderSegments(this.segmentDrag.originalSegments,
        this.segmentDrag.originalSegments.findIndex((item) => item.id === this.segmentDrag.id), this.segmentDrag.targetIndex)
      : this.segments;
    let start = 0;
    const nodes = visualSegments.map((segment) => {
      const duration = timeline.segmentOutputDuration(segment);
      const width = Math.max(duration * this.pps - 2, 6);
      const selected = this.store.selection && this.store.selection.type === 'segment' && this.store.selection.id === segment.id;
      const trim = (edge) => (event) => {
        const original = segment[edge === 'start' ? 'sourceStart' : 'sourceEnd'];
        this.store.select({ type: 'segment', id: segment.id });
        this.drag(event, {
          move: (dx, moveEvent) => this.store.mutate((project) => {
            let sourceTime = original + (dx / this.pps) * segment.speed;
            sourceTime = this.snapSourceTime(sourceTime, segment.speed, moveEvent, 'segment', segment.id);
            const next = timeline.trimSegment(project.timeline.segments, segment.id, edge, sourceTime, mediaDuration);
            if (next) project.timeline.segments = next;
          }, { history: false }),
        });
      };
      const node = element('div', {
        class: `segment${selected ? ' selected' : ''}`, style: `left:${this.x(start)}px;width:${width}px`,
        'data-segment-id': segment.id,
        onpointerdown: (event) => this.beginSegmentPointer(event, segment),
      },
      this.displayMode === 'waveform' ? this.waveformStrip(segment, width, height) : this.filmstrip(segment, width, height),
      element('span', { class: 'tag' }, `${formatTime(duration)}${Math.abs(segment.speed - 1) > 1e-6 ? ` · ${segment.speed}×` : ''}`),
      element('div', { class: 'handle start', title: '拖动裁短或恢复', onpointerdown: trim('start') }),
      element('div', { class: 'handle end', title: '拖动裁短或恢复', onpointerdown: trim('end') }));
      start += duration;
      return node;
    });
    lane.replaceChildren(...nodes);
  }

  /// 缩放块在素材时间上可移动的范围：不越过相邻缩放块（含对方的退出过渡）与素材两端。
  zoomBounds(clip) {
    const ordered = this.store.zoomClips;
    const index = ordered.findIndex((item) => item.id === clip.id);
    const previous = ordered[index - 1];
    const next = ordered[index + 1];
    return {
      lower: previous ? zoomCore.effectEndTime(previous) : 0,
      upper: (next ? next.startTime : this.store.project.media.screen.duration) - clip.exitDuration,
    };
  }

  renderZoomClips() {
    const nodes = [];
    for (const piece of this.zoomPieces()) {
      const { clip, segment } = piece;
      const selected = this.store.selection?.type === 'zoom' && this.store.selection.id === clip.id;
      const original = { start: clip.startTime, end: clip.endTime };
      const hasStartHandle = Math.abs(piece.sourceStart - original.start) < 1e-6;
      const hasEndHandle = Math.abs(piece.sourceEnd - original.end) < 1e-6;
      const edit = (mode) => (event) => {
        const bounds = this.zoomBounds(clip);
        this.store.select({ type: 'zoom', id: clip.id });
        this.preview.pause();
        this.drag(event, {
          move: (dx, moveEvent) => this.store.mutate((project) => {
            const target = project.zoomAnimations.find((item) => item.id === clip.id);
            if (!target) return;
            const speed = segment.speed;
            const delta = (dx / this.pps) * speed;
            if (mode === 'move') {
              const proposedStart = this.snapSourceTime(original.start + delta, speed, moveEvent, 'zoom', clip.id);
              const shift = clamp(proposedStart - original.start, bounds.lower - original.start, Math.max(bounds.upper - original.end, bounds.lower - original.start));
              target.startTime = original.start + shift;
              target.endTime = original.end + shift;
            } else if (mode === 'start') {
              const proposedStart = this.snapSourceTime(original.start + delta, speed, moveEvent, 'zoom', clip.id);
              target.startTime = clamp(proposedStart, bounds.lower, original.end - MIN_ZOOM_CLIP);
            } else {
              const proposedEnd = this.snapSourceTime(original.end + delta, speed, moveEvent, 'zoom', clip.id);
              target.endTime = clamp(proposedEnd, original.start + MIN_ZOOM_CLIP, Math.max(bounds.upper, original.start + MIN_ZOOM_CLIP));
            }
          }, { history: false }),
        });
      };
      const left = this.x(piece.outputStart);
      const width = Math.max((piece.outputEnd - piece.outputStart) * this.pps, 8);
      nodes.push(element('div', {
        class: `zoom-clip${selected ? ' selected' : ''}`, style: `left:${left}px;width:${width}px`,
        'data-zoom-id': clip.id,
        title: '拖动移动，拖两端改长短', onpointerdown: edit('move'),
      },
      `缩放 ${clip.scale.toFixed(1)}× · ${clip.origin === 'automatic' ? '自动' : '手动'}`,
      hasStartHandle ? element('div', { class: 'handle start', onpointerdown: edit('start') }) : null,
      hasEndHandle ? element('div', { class: 'handle end', onpointerdown: edit('end') }) : null));
    }
    for (const piece of this.zoomExitPieces()) {
      const left = this.x(piece.outputStart);
      const width = Math.max((piece.outputEnd - piece.outputStart) * this.pps, 4);
      nodes.push(element('div', { class: 'zoom-tail', style: `left:${left}px;width:${width}px`, 'data-zoom-id': piece.clip.id }));
    }
    this.nodes.zoom.replaceChildren(...nodes);
  }

  renderEffectClips() {
    const labels = { screen: '屏幕运镜', camera: '摄像运镜', mosaic: '柔化区域', sticker: '贴图' };
    const mediaDuration = this.store.project.media.screen.duration;
    const piecesByKind = this.effectPieces();
    for (const kind of ['screen', 'camera', 'mosaic', 'sticker']) {
      const lane = this.nodes.effects?.[kind];
      if (!lane) continue;
      const nodes = [];
      for (const piece of piecesByKind[kind] || []) {
        const { clip, segment } = piece;
        const selected = this.store.selection?.type === kind && this.store.selection.id === clip.id;
        const originalStart = clip.timing.startTime;
        const originalEnd = originalStart + clip.timing.duration;
        const hasStartHandle = Math.abs(piece.sourceStart - originalStart) < 1e-6;
        const hasEndHandle = Math.abs(piece.sourceEnd - originalEnd) < 1e-6;
        const edit = (mode) => (event) => {
          this.store.select({ type: kind, id: clip.id });
          this.preview.pause();
          this.drag(event, {
            move: (dx, moveEvent) => this.store.mutate((project) => {
              const target = (project.timeline[EFFECT_POOL_KEYS[kind]] || [])
                .find((item) => item.id === clip.id);
              if (!target) return;
              const delta = (dx / this.pps) * segment.speed;
              if (mode === 'move') {
                const shiftedStart = this.snapSourceTime(originalStart + delta, segment.speed, moveEvent, kind, clip.id);
                const start = clamp(shiftedStart, 0, Math.max(mediaDuration - clip.timing.duration, 0));
                target.timing.startTime = start;
              } else if (mode === 'start') {
                const shiftedStart = this.snapSourceTime(originalStart + delta, segment.speed, moveEvent, kind, clip.id);
                const start = clamp(shiftedStart, 0, originalEnd - 0.05);
                target.timing.startTime = start;
                target.timing.duration = originalEnd - start;
              } else {
                const shiftedEnd = this.snapSourceTime(originalEnd + delta, segment.speed, moveEvent, kind, clip.id);
                target.timing.duration = clamp(shiftedEnd - originalStart, 0.05, Math.max(mediaDuration - originalStart, 0.05));
              }
            }, { history: false }),
          });
        };
        const left = this.x(piece.outputStart);
        const width = Math.max((piece.outputEnd - piece.outputStart) * this.pps, 8);
        nodes.push(element('div', {
          class: `effect-clip effect-${kind}${selected ? ' selected' : ''}`,
          style: `left:${left}px;width:${width}px`,
          title: `${labels[kind]} · 源 ${formatTime(piece.sourceStart)}–${formatTime(piece.sourceEnd)} · 拖动移动，拖两端裁切`,
          'data-effect-id': clip.id,
          'data-effect-kind': kind,
          onpointerdown: edit('move'),
        },
        element('span', { class: 'effect-tag' }, labels[kind]),
        hasStartHandle ? element('div', { class: 'handle start', title: '裁切开始时间', onpointerdown: edit('start') }) : null,
        hasEndHandle ? element('div', { class: 'handle end', title: '裁切结束时间', onpointerdown: edit('end') }) : null));
      }
      lane.replaceChildren(...nodes);
    }
  }

  /// 在输出时间处添加一段手动缩放。位置被已有缩放占用时返回 false。
  addZoomAt(outputTime) {
    const { project, pointerTrack, zoomClips } = this.store;
    const sourceTime = timeline.locate(this.segments, outputTime).sourceTime;
    if (zoomClips.some((clip) => sourceTime >= clip.startTime - 0.05 && sourceTime <= zoomCore.effectEndTime(clip) + 0.05)) return false;
    const next = zoomClips.find((clip) => clip.startTime > sourceTime);
    const transition = project.motion.defaultZoomTransitionDuration;
    const limit = (next ? next.startTime : project.media.screen.duration) - 0.05;
    const endTime = Math.min(sourceTime + 2, limit - Math.min(transition, 0.3));
    if (endTime - sourceTime < MIN_ZOOM_CLIP) return false;
    // 默认对准当时指针所在的位置。
    const pointer = pointerTrack ? pointerTrack.evaluation(sourceTime, project.motion, project.cursorStyle).position : null;
    const clip = zoomCore.makeClip({
      startTime: sourceTime, endTime, scale: project.motion.defaultZoomScale, focus: pointer || zoomCore.CENTER, origin: 'manual',
      easing: project.motion.defaultZoomEasing, enterDuration: transition, exitDuration: Math.min(transition, limit - endTime),
    });
    this.store.mutate((draft) => { draft.zoomAnimations.push(clip); });
    this.store.select({ type: 'zoom', id: clip.id });
    return true;
  }

  updatePlayhead() {
    const { scroller, playhead } = this.nodes;
    const x = this.x(this.preview.time);
    playhead.style.transform = `translateX(${x}px)`;
    if (this.preview.playing && (x < scroller.scrollLeft + 20 || x > scroller.scrollLeft + scroller.clientWidth - 30)) {
      scroller.scrollLeft = x - 60;
    }
  }
}

module.exports = { TimelineView };
