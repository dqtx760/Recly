'use strict';

const { ipcRenderer } = require('electron');
const { element, icon, formatTime } = require('../common');

class MusicLibraryPanel {
  constructor({ directory, addClip, getTime, pauseTimeline, onChange, onToast }) {
    Object.assign(this, { directory, addClip, getTime, pauseTimeline, onChange, onToast });
    this.visible = false;
    this.tracks = null;
    this.loading = false;
    this.error = '';
    this.busy = null;
    this.audio = null;
    this.activeId = null;
    this.generation = 0;
  }

  stopPreview() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
    }
    this.audio = null;
    this.activeId = null;
  }

  deactivate() {
    this.visible = false;
    this.generation += 1;
    this.stopPreview();
  }

  async open() {
    this.visible = true;
    this.error = '';
    if (this.tracks) { this.onChange(); return; }
    this.loading = true;
    const generation = ++this.generation;
    this.onChange();
    try {
      const tracks = await ipcRenderer.invoke('music:list', { directory: this.directory });
      if (!this.visible || generation !== this.generation) return;
      this.tracks = tracks;
    } catch {
      if (generation === this.generation) this.error = '内置音乐暂时无法读取，请重试。';
    } finally {
      if (generation === this.generation) { this.loading = false; this.onChange(); }
    }
  }

  async togglePreview(track) {
    if (this.activeId === track.id) {
      this.stopPreview();
      this.onChange();
      return;
    }
    this.stopPreview();
    this.pauseTimeline();
    const audio = new Audio(track.url);
    this.audio = audio;
    this.activeId = track.id;
    const finished = () => {
      if (this.audio !== audio) return;
      this.stopPreview();
      this.onChange();
    };
    audio.onended = finished;
    audio.onerror = () => { if (this.audio === audio) { this.onToast('这首音乐暂时无法试听'); finished(); } };
    this.onChange();
    try { await audio.play(); } catch { if (this.audio === audio) { this.onToast('这首音乐暂时无法试听'); finished(); } }
  }

  async add(track = null) {
    if (this.busy) return;
    this.busy = track ? track.id : 'import';
    const time = this.getTime();
    this.stopPreview();
    this.onChange();
    try {
      const asset = await ipcRenderer.invoke(track ? 'music:add' : 'project:import-audio', {
        directory: this.directory, ...(track ? { id: track.id } : {}),
      });
      if (asset) {
        this.addClip(asset, time);
        this.deactivate();
      }
    } catch (error) {
      this.onToast(error.message || '添加音乐失败');
    } finally {
      this.busy = null;
      this.onChange();
    }
  }

  render() {
    const header = element('div', { class: 'music-library-header' },
      element('button', { class: 'btn ghost', disabled: Boolean(this.busy), onclick: () => { this.deactivate(); this.onChange(); } }, '‹ 返回'),
      element('b', {}, '内置音乐'));
    const importer = element('button', { class: 'btn music-import', disabled: Boolean(this.busy), onclick: () => { void this.add(); } },
      element('span', { html: icon('folder'), 'aria-hidden': 'true' }), this.busy === 'import' ? '正在导入…' : '导入本地音频');
    const rows = (this.tracks || []).map((track) => element('div', { class: 'music-library-row', 'data-music-id': track.id },
      element('button', { class: `music-play${this.activeId === track.id ? ' active' : ''}`, title: this.activeId === track.id ? '停止试听' : '试听', 'aria-label': `试听 ${track.name}`, disabled: Boolean(this.busy), onclick: () => { void this.togglePreview(track); } }, element('span', { html: icon(this.activeId === track.id ? 'pause' : 'play'), 'aria-hidden': 'true' })),
      element('span', { class: 'music-title', title: track.name }, track.name),
      element('span', { class: 'music-duration' }, formatTime(track.duration, false)),
      element('button', { class: 'music-add', title: `添加 ${track.name}`, 'aria-label': `添加 ${track.name}`, disabled: Boolean(this.busy), onclick: () => { void this.add(track); } }, this.busy === track.id ? '…' : '+')));
    return element('div', { class: 'music-library' }, header, importer,
      this.loading ? element('p', { class: 'note' }, '正在读取音乐…') : null,
      this.error ? element('p', { class: 'note error' }, this.error) : null,
      element('div', { class: 'music-library-list' }, rows));
  }
}

module.exports = { MusicLibraryPanel };
