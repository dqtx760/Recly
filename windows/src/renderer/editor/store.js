'use strict';
// 编辑器状态：项目文档、选中项、撤销栈与自动保存。

const { ipcRenderer } = require('electron');
const { uid } = require('../../core/model');
const { orderedClips } = require('../../core/zoom');
const { loadPointerTrack } = require('./export');

const HISTORY_LIMIT = 120;

class Store {
  constructor(directory, project) {
    this.directory = directory;
    this.project = project;
    this.revision = Number.isSafeInteger(project.revision) && project.revision >= 0 ? project.revision : 0;
    this.project.revision = this.revision;
    this.pointerTrack = loadPointerTrack(directory, project);
    this.selection = null; // 兼容既有检查器的主选中项
    this.selections = []; // 时间线多选：[{ type, id }]，selection 始终指向第一项
    this.listeners = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.gesture = null;
    this.saveTimer = null;
    this.saveState = 'saved';
    this.savedRevision = this.revision;
    this.saveQueue = Promise.resolve();
    this.refreshDerived();
  }

  refreshDerived() {
    this.zoomClips = orderedClips(this.project.zoomAnimations);
  }

  subscribe(listener) { this.listeners.add(listener); }

  emit(reason) { for (const listener of this.listeners) listener(reason); }

  /// 所有改动都走这里。history 为 false 的改动（拖动过程）不单独进撤销栈。
  mutate(change, { history = true } = {}) {
    const before = history && !this.gesture ? JSON.stringify(this.project) : null;
    change(this.project);
    this.revision += 1;
    this.project.revision = this.revision;
    if (before !== null) this.pushUndo(before);
    this.afterChange();
  }

  pushUndo(snapshot) {
    const previous = JSON.parse(snapshot);
    const current = JSON.parse(JSON.stringify(this.project));
    delete previous.revision;
    delete current.revision;
    if (JSON.stringify(previous) === JSON.stringify(current)) return;
    this.undoStack.push(snapshot);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /// 一次拖动（滑块、片段边缘、缩放块）只算一步撤销。
  beginGesture() {
    if (!this.gesture) this.gesture = JSON.stringify(this.project);
  }

  endGesture() {
    if (!this.gesture) return;
    const snapshot = this.gesture;
    this.gesture = null;
    this.pushUndo(snapshot);
    this.emit('history');
  }

  restore(snapshot) {
    const media = this.project.media;
    this.project = JSON.parse(snapshot);
    this.project.media = media; // 素材引用不随撤销变化
    this.revision += 1;
    this.project.revision = this.revision;
    this.selections = this.selections.filter((selection) => this.clipPool(selection.type).some((item) => item.id === selection.id));
    this.selection = this.selections[0] || null;
    this.afterChange();
  }

  clipPool(type) {
    if (type === 'zoom') return this.project.zoomAnimations || [];
    if (type === 'segment') return this.project.timeline.segments || [];
    if (type === 'subtitle') return this.project.subtitles?.cues || [];
    const pools = {
      screen: this.project.timeline.screenMotionClips,
      camera: this.project.timeline.cameraMotionClips,
      mosaic: this.project.timeline.mosaicClips,
      sticker: this.project.timeline.stickerClips,
      audio: this.project.timeline.audioClips,
    };
    return pools[type] || [];
  }

  getClip(type, id) {
    return this.clipPool(type).find((item) => item.id === id) || null;
  }

  splitAudioClip(id, outputTime) {
    const clip = this.getClip('audio', id);
    if (!clip || !Number.isFinite(outputTime)) return false;
    const clipStart = Number(clip.startTime) || 0;
    const sourceStart = Number(clip.sourceStart) || 0;
    const sourceEnd = Number(clip.sourceEnd ?? clip.duration);
    const sourceTime = sourceStart + outputTime - clipStart;
    if (!Number.isFinite(sourceEnd) || sourceTime - sourceStart < 0.05 || sourceEnd - sourceTime < 0.05) return false;

    const right = { ...clip, id: uid(), startTime: outputTime, sourceStart: sourceTime };
    this.mutate((project) => {
      const index = project.timeline.audioClips.findIndex((item) => item.id === id);
      if (index < 0) return;
      project.timeline.audioClips[index].sourceEnd = sourceTime;
      project.timeline.audioClips.splice(index + 1, 0, right);
    });
    return true;
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.project));
    this.restore(this.undoStack.pop());
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.project));
    this.restore(this.redoStack.pop());
    return true;
  }

  afterChange() {
    this.refreshDerived();
    this.scheduleSave();
    this.emit('project');
  }

  select(selection) {
    const items = Array.isArray(selection) ? selection : selection ? [selection] : [];
    const unique = new Map();
    for (const item of items) {
      if (!item?.type || !item?.id) continue;
      unique.set(`${item.type}:${item.id}`, { type: item.type, id: item.id });
    }
    this.selections = [...unique.values()];
    this.selection = this.selections[0] || null;
    this.emit('selection');
  }

  isSelected(type, id) {
    return this.selections.some((item) => item.type === type && item.id === id);
  }

  selectAll() {
    const types = ['segment', 'subtitle', 'audio', 'zoom', 'screen', 'camera', 'mosaic', 'sticker'];
    this.select(types.flatMap((type) => this.clipPool(type).map((item) => ({ type, id: item.id }))));
  }


  removeSelections() {
    if (!this.selections.length) return false;
    const ids = new Map();
    for (const { type, id } of this.selections) {
      if (!ids.has(type)) ids.set(type, new Set());
      ids.get(type).add(id);
    }
    this.mutate((draft) => {
      if (ids.has('segment')) draft.timeline.segments = draft.timeline.segments.filter((item) => !ids.get('segment').has(item.id));
      if (ids.has('subtitle') && draft.subtitles) draft.subtitles.cues = (draft.subtitles.cues || []).filter((item) => !ids.get('subtitle').has(item.id));
      if (ids.has('audio')) draft.timeline.audioClips = (draft.timeline.audioClips || []).filter((item) => !ids.get('audio').has(item.id));
      if (ids.has('zoom')) draft.zoomAnimations = (draft.zoomAnimations || []).filter((item) => !ids.get('zoom').has(item.id));
      const pools = { screen: 'screenMotionClips', camera: 'cameraMotionClips', mosaic: 'mosaicClips', sticker: 'stickerClips' };
      for (const [type, key] of Object.entries(pools)) {
        if (ids.has(type)) draft.timeline[key] = (draft.timeline[key] || []).filter((item) => !ids.get(type).has(item.id));
      }
    });
    this.select(null);
    return true;
  }

  get selectedZoom() {
    return this.selection && this.selection.type === 'zoom' ? this.project.zoomAnimations.find((clip) => clip.id === this.selection.id) || null : null;
  }

  get selectedScreenMotion() { return this.selection && this.selection.type === 'screen' ? this.getClip('screen', this.selection.id) : null; }

  get selectedCameraMotion() { return this.selection && this.selection.type === 'camera' ? this.getClip('camera', this.selection.id) : null; }

  get selectedMosaic() { return this.selection && this.selection.type === 'mosaic' ? this.getClip('mosaic', this.selection.id) : null; }

  get selectedSticker() { return this.selection && this.selection.type === 'sticker' ? this.getClip('sticker', this.selection.id) : null; }

  get selectedAudioClip() { return this.selection && this.selection.type === 'audio' ? this.getClip('audio', this.selection.id) : null; }

  get selectedSegment() {
    return this.selection && this.selection.type === 'segment' ? this.project.timeline.segments.find((segment) => segment.id === this.selection.id) || null : null;
  }

  scheduleSave() {
    this.saveState = 'pending';
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.save(); }, 500);
  }

  save({ throwOnError = false, untilStable = false } = {}) {
    clearTimeout(this.saveTimer);
    if (this.saveState === 'saved' && this.savedRevision === this.revision) {
      return Promise.resolve({ savedRevision: this.savedRevision, revision: this.revision, saveState: this.saveState });
    }
    const task = this.saveQueue.catch(() => {}).then(async () => {
      let savedRevision = this.savedRevision;
      do {
        const revision = this.revision;
        const snapshot = JSON.parse(JSON.stringify(this.project));
        try {
          await ipcRenderer.invoke('project:write', { directory: this.directory, project: snapshot });
        } catch (error) {
          this.saveState = this.revision === revision ? 'failed' : 'pending';
          this.emit('save');
          if (throwOnError) throw error;
          console.error('[DogSC] 保存失败', error);
          return { savedRevision: this.savedRevision, revision: this.revision, saveState: this.saveState, error };
        }
        savedRevision = revision;
        this.savedRevision = revision;
        if (this.revision === revision) {
          this.saveState = 'saved';
          break;
        }
        this.saveState = 'pending';
        if (!untilStable) {
          this.scheduleSave();
          break;
        }
      } while (untilStable);
      this.emit('save');
      return { savedRevision, revision: this.revision, saveState: this.saveState };
    });
    this.saveQueue = task.catch(() => {});
    return task;
  }
}

module.exports = { Store };
