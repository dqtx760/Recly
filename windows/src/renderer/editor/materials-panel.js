'use strict';

const path = require('node:path');
const { ipcRenderer } = require('electron');
const { element, fileUrl, formatTime, openExternalUrl } = require('../common');
const timeline = require('../../core/timeline');
const { StickerClip } = require('../../core/opening-overlay');

const SUGGESTIONS = {
  unsplash: [['办公桌', 'desk'], ['科技', 'technology'], ['城市', 'city'], ['自然', 'nature'], ['抽象背景', 'abstract'], ['咖啡', 'coffee']],
  pixabay: [['城市延时', 'city timelapse'], ['键盘打字', 'typing'], ['科技', 'technology'], ['海浪', 'ocean'], ['星空', 'stars'], ['抽象', 'abstract']],
};

class MaterialsPanel {
  constructor(store, preview, inspector, root, toast) {
    Object.assign(this, { store, preview, inspector, root, toast });
    this.tab = 'clips';
    this.provider = 'unsplash';
    this.query = '';
    this.assets = [];
    this.filter = 'all';
    this.results = [];
    this.settings = {};
    this.page = 1;
    this.hasMore = false;
    this.busy = false;
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); this.close(); }
    });
    store.subscribe(() => {
      if (!root.hidden && this.tab === 'clips') this.render();
    });
  }

  close() {
    const wasOpen = !this.root.hidden;
    this.root.hidden = true;
    this.root.parentElement.classList.remove('materials-open');
    document.getElementById('materials').setAttribute('aria-expanded', 'false');
    if (wasOpen) document.getElementById('materials').focus();
  }

  async open() {
    this.root.hidden = false;
    this.root.parentElement.classList.add('materials-open');
    document.getElementById('materials').setAttribute('aria-expanded', 'true');
    this.render();
    await this.work(async () => {
      this.assets = await ipcRenderer.invoke('materials:list');
      this.settings = await ipcRenderer.invoke('materials:settings-get');
    });
    if (!this.root.hidden) this.root.querySelector('button')?.focus();
  }

  async work(action) {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try { await action(); }
    catch (error) { this.toast(error.message || '素材操作失败'); }
    finally { this.busy = false; this.render(); }
  }

  button(label, action, className = 'btn') {
    return element('button', { type: 'button', class: className, disabled: this.busy, onclick: action }, label);
  }

  render() {
    const tabs = [['clips', '片段'], ['library', '素材库'], ['online', '在线素材']];
    const navigation = element('div', { class: 'materials-tabs' }, tabs.map(([id, label]) =>
      this.button(label, () => { this.tab = id; this.render(); }, this.tab === id ? 'active' : '')));
    const body = element('div', { class: 'materials-body' });
    if (this.busy) body.append(element('p', { class: 'note', role: 'status' }, '正在处理素材…'));
    if (this.tab === 'clips') this.renderClips(body);
    else if (this.tab === 'library') this.renderLibrary(body);
    else this.renderOnline(body);
    this.root.replaceChildren(element('div', { class: 'materials-header' },
      this.button('← 返回编辑器', () => this.close(), 'btn ghost')), navigation, body);
  }

  importLocal(kind) {
    this.work(async () => {
      const asset = await ipcRenderer.invoke('materials:import-local', { kind });
      if (asset) {
        this.assets = await ipcRenderer.invoke('materials:list');
        this.tab = 'library';
      }
    });
  }

  renderClips(body) {
    body.append(element('div', { class: 'row' },
      this.button('新录制', () => ipcRenderer.send('recorder:show')),
      this.button('导入图片', () => this.importLocal('image')),
      this.button('导入视频', () => this.importLocal('video'))));
    body.append(element('p', { class: 'note' }, '点击片段定位画面。导入素材保存在素材库，可添加图片贴图或设置背景；新录制会创建新项目。'));
    let outputStart = 0;
    for (const [index, segment] of this.store.project.timeline.segments.entries()) {
      const start = outputStart;
      const duration = timeline.segmentOutputDuration(segment);
      outputStart += duration;
      const card = this.button('', () => {
        this.preview.seek(start);
        this.store.select({ type: 'segment', id: segment.id });
        this.close();
      }, 'materials-clip');
      const sprite = this.store.project.media.thumbnails;
      const thumbnail = sprite?.count > 0 && sprite.interval > 0
        ? element('i', { class: 'materials-thumbnail', style: `background-image:url("${fileUrl(path.join(this.store.directory, sprite.file))}");background-size:${112 * sprite.count}px 66px;background-position:${-112 * Math.min(sprite.count - 1, Math.floor(segment.sourceStart / sprite.interval))}px 0` })
        : element('video', { src: fileUrl(path.join(this.store.directory, this.store.project.media.screen.file)), muted: true, preload: 'metadata', tabindex: '-1' });
      if (!sprite?.count) thumbnail.addEventListener('loadedmetadata', () => { thumbnail.currentTime = segment.sourceStart; }, { once: true });
      card.append(thumbnail, element('span', {}, element('strong', {}, '片段 ' + (index + 1)), element('small', {}, formatTime(duration))));
      body.append(card);
    }
  }

  renderLibrary(body) {
    body.append(element('div', { class: 'row' },
      this.button('导入图片', () => this.importLocal('image')),
      this.button('导入视频', () => this.importLocal('video'))));
    body.append(element('div', { class: 'chips' }, [['all','全部'],['image','图片'],['video','视频']].map(([id,label]) => this.button(label, () => { this.filter = id; this.render(); }, this.filter === id ? 'active' : ''))));
    const used = new Set([this.store.project.canvas.background?.file, ...(this.store.project.timeline.stickerClips || []).map(c => c.relativePath)]);
    const usedAssets = this.assets.filter(a => used.has(a.file));
    body.append(element('h3', {}, '本视频在用 ' + (1 + usedAssets.length)));
    if (this.filter !== 'image') {
      body.append(element('div', { class: 'materials-grid' }, element('article', { class: 'materials-card' },
        element('video', { src: fileUrl(path.join(this.store.directory, this.store.project.media.screen.file)), preload: 'metadata', muted: true }),
        element('p', { class: 'materials-name' }, '录屏主素材'))));
    }
    if (usedAssets.length) body.append(element('p', { class: 'note' }, '已应用：' + usedAssets.map(a => a.name).join('、')));
    body.append(element('h3', {}, '素材库 ' + this.assets.length));
    if (!this.assets.length) body.append(element('div', { class: 'materials-empty' }, '导入图片或视频，或从在线素材下载到当前工程。'));
    const grid = element('div', { class: 'materials-grid' });
    for (const asset of this.assets.filter(a => this.filter === 'all' || a.kind === this.filter)) {
      const src = fileUrl(path.join(this.store.directory, asset.file));
      const media = asset.kind === 'video'
        ? element('video', { src, controls: true, muted: true, preload: 'metadata' })
        : element('img', { src, alt: asset.name || '图片素材', loading: 'lazy' });
      const card = element('article', { class: 'materials-card' }, media,
        element('p', { class: 'materials-name', title: asset.name }, asset.name || '素材'));
      if (asset.author) card.append(element('p', { class: 'note' }, `${asset.provider} · ${asset.author}`));
      if (asset.kind === 'image') card.append(this.button('添加到当前画面', () => this.addSticker(asset)));
      card.append(this.button(asset.kind === 'video' ? '设为动态背景' : '设为背景', () => this.setBackground(asset)));
      grid.append(card);
    }
    body.append(grid);
  }

  async addSticker(asset) {
    const hit = timeline.locate(this.store.project.timeline.segments, this.preview.time);
    if (!hit) return this.toast('请先选择一段画面');
    const duration = Math.min(3, hit.segment.sourceEnd - hit.sourceTime);
    if (duration < 0.1) return this.toast('请把播放头移到片段内');
    const clip = new StickerClip({ relativePath: asset.file, aspectRatio: asset.width / asset.height,
      timing: { startTime: hit.sourceTime, duration } });
    this.store.mutate((draft) => draft.timeline.stickerClips.push(JSON.parse(JSON.stringify(clip))));
    this.store.select({ type: 'sticker', id: clip.id });
    this.inspector.show('overlays');
    this.close();
  }

  setBackground(asset) {
    this.store.mutate((draft) => {
      draft.canvas.background = asset.kind === 'video'
        ? { kind: 'video', file: asset.file, index: asset.index, duration: asset.duration, isLooping: true }
        : { kind: 'image', file: asset.file, stamp: Date.now() };
    });
    this.inspector.canvasTab = 'background';
    this.inspector.show('canvas');
    this.close();
  }

  search(more = false) {
    if (!this.query.trim()) return this.toast('请输入搜索关键词');
    this.work(async () => {
      const page = more ? this.page + 1 : 1;
      const result = await ipcRenderer.invoke('materials:search', { provider: this.provider, query: this.query.trim(), page });
      this.results = more ? [...this.results, ...result.items] : result.items;
      this.page = page;
      this.hasMore = result.hasMore;
      this.searched = true;
    });
  }

  openServices() {
    const modal = document.getElementById('modal');
    let closed = false;
    const close = () => { closed = true; modal.hidden = true; modal.replaceChildren(); this.render(); this.root.querySelector('button')?.focus(); };
    const render = () => {
      if (closed) { this.render(); return; }
      const content = element('div', { class: 'dialog card materials-services', role: 'dialog', 'aria-modal': 'true', 'aria-label': '素材服务' },
        element('div', { class: 'materials-service-heading' }, element('h2', {}, '素材服务'), element('button', { class: 'btn ghost', onclick: close }, '关闭')),
        element('p', { class: 'note' }, '搜索图片和视频素材，密钥仅加密保存在本机。'));
      for (const [provider, name, description, url] of [
        ['unsplash', 'Unsplash', '免费图片素材', 'https://unsplash.com/developers'],
        ['pixabay', 'Pixabay', '免费视频素材', 'https://pixabay.com/api/docs/'],
      ]) {
        const configured = this.settings[provider + 'Configured'];
        const row = element('section', { class: 'materials-service-row' });
        const details = element('div', {}, element('strong', {}, name), element('p', { class: 'note' }, description));
        const edit = element('div', { class: 'materials-key-edit', hidden: true });
        const key = element('input', { type: 'password', autocomplete: 'off', placeholder: name + ' API Key', 'aria-label': name + ' API Key' });
        const status = element('span', { class: 'note' }, configured ? '已配置' : '未配置');
        const save = element('button', { class: 'btn primary', onclick: async () => {
          const value = key.value.trim(); if (!value) return this.toast('请输入密钥');
          key.value = ''; save.disabled = true;
          try { this.settings = await ipcRenderer.invoke('materials:settings-save', { provider, key: value }); render(); }
          catch (error) { this.toast(error.message || '保存失败'); save.disabled = false; }
        } }, '保存');
        edit.append(element('div', { class: 'materials-search' }, key, save), element('button', { class: 'btn ghost', onclick: () => openExternalUrl(url).catch(() => this.toast('无法打开素材服务网站')) }, '获取密钥'));
        row.append(element('div', { class: 'materials-service-summary' }, details, status, element('button', { class: 'btn', onclick: () => { edit.hidden = !edit.hidden; if (!edit.hidden) key.focus(); } }, configured ? '更换密钥' : '设置密钥')), edit);
        content.append(row);
      }
      content.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
      modal.replaceChildren(content); modal.hidden = false; content.querySelector('button').focus();
    };
    render();
  }

  renderOnline(body) {
    body.append(element('div', { class: 'materials-providers' },
      ...[['unsplash', '图片 · Unsplash'], ['pixabay', '视频 · Pixabay']].map(([id, label]) =>
        this.button(label, () => { this.provider = id; this.results = []; this.searched = false; this.page = 1; this.hasMore = false; this.showSettings = false; this.render(); }, this.provider === id ? 'active' : '')),
      this.button('⚙', () => this.openServices(), 'btn ghost')));
    const configured = this.settings[`${this.provider}Configured`];
    if (!configured) {
      body.append(element('p', { class: 'note' }, '连接 Unsplash 或 Pixabay，搜索并添加图片和视频。密钥仅加密保存在本机。'),
        this.button('设置素材服务', () => this.openServices(), 'btn primary materials-setup'));
      return;
    }
    const input = element('input', { type: 'search', value: this.query, placeholder: '搜索素材，如科技、城市、咖啡…',
      oninput: (event) => { this.query = event.target.value; },
      onkeydown: (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); this.search(); } } });
    body.append(element('div', { class: 'materials-search' }, input, this.button('搜索', () => this.search())),
      element('div', { class: 'chips' }, SUGGESTIONS[this.provider].map(([label, query]) => this.button(label, () => { this.query = query; this.search(); }, ''))));
    if (this.searched && !this.results.length) body.append(element('p', { class: 'note' }, '没有找到素材，试试其他关键词。'));
    const grid = element('div', { class: 'materials-grid' });
    for (const item of this.results) {
      grid.append(element('article', { class: 'materials-card' },
        element('img', { src: item.previewUrl, alt: `${item.provider} 素材`, loading: 'lazy', referrerpolicy: 'no-referrer' }),
        element('a', { href: item.pageUrl, onclick: (event) => {
          event.preventDefault();
          openExternalUrl(item.pageUrl).catch(() => this.toast('无法打开素材来源'));
        } }, item.author || item.provider),
        element('p', { class: 'note' }, `${item.provider}${item.duration ? ` · ${item.duration} 秒` : ''}`),
        this.button('下载到素材库', () => this.work(async () => {
          await ipcRenderer.invoke('materials:download', { id: item.id });
          this.assets = await ipcRenderer.invoke('materials:list');
          this.tab = 'library';
        }))));
    }
    body.append(grid);
    if (this.hasMore) body.append(this.button('加载更多', () => this.search(true)));
  }
}

module.exports = { MaterialsPanel };
