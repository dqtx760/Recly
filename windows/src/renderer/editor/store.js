'use strict';
// 编辑器状态：项目文档、选中项、撤销栈与自动保存。

const { ipcRenderer } = require('electron');
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
    this.selection = null; // { type: 'segment' | 'zoom' | 'screen' | 'camera' | 'mosaic' | 'sticker', id }
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
    if (this.selection) {
      const pool = this.clipPool(this.selection.type);
      if (!pool.some((item) => item.id === this.selection.id)) this.selection = null;
    }
    this.afterChange();
  }

  clipPool(type) {
    if (type === 'zoom') return this.project.zoomAnimations || [];
    if (type === 'segment') return this.project.timeline.segments || [];
    const pools = {
      screen: this.project.timeline.screenMotionClips,
      camera: this.project.timeline.cameraMotionClips,
      mosaic: this.project.timeline.mosaicClips,
      sticker: this.project.timeline.stickerClips,
    };
    return pools[type] || [];
  }

  getClip(type, id) {
    return this.clipPool(type).find((item) => item.id === id) || null;
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
    this.selection = selection;
    this.emit('selection');
  }

  get selectedZoom() {
    return this.selection && this.selection.type === 'zoom' ? this.project.zoomAnimations.find((clip) => clip.id === this.selection.id) || null : null;
  }

  get selectedScreenMotion() { return this.selection && this.selection.type === 'screen' ? this.getClip('screen', this.selection.id) : null; }

  get selectedCameraMotion() { return this.selection && this.selection.type === 'camera' ? this.getClip('camera', this.selection.id) : null; }

  get selectedMosaic() { return this.selection && this.selection.type === 'mosaic' ? this.getClip('mosaic', this.selection.id) : null; }

  get selectedSticker() { return this.selection && this.selection.type === 'sticker' ? this.getClip('sticker', this.selection.id) : null; }

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
