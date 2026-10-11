'use strict';
// 预览播放：屏幕视频作播放时钟，换算成输出时间后让音轨跟随。
// 画面由与导出相同的 Compositor 绘制。

const path = require('node:path');
const { ipcRenderer } = require('electron');
const { fileUrl } = require('../common');
const { canvasDimensions, clamp } = require('../../core/model');
const { resolveAudio } = require('../../core/audio');
const { evaluateScene } = require('../../core/scene');
const timeline = require('../../core/timeline');
const { Compositor } = require('./render');

const DRIFT_TOLERANCE = 0.14;
const MAX_PREVIEW_PIXELS = 2560;
const MAX_FULL_PREVIEW_PIXELS = 7680;
// 给高分辨率视频解码留出余量；导出仍按项目帧率逐帧渲染。
const PREVIEW_FRAME_INTERVAL = 50;

class Preview {
  constructor(store, canvas, wrap) {
    this.store = store;
    this.canvas = canvas;
    this.wrap = wrap;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.compositor = new Compositor(store.directory);
    this.time = 0; // 输出时间
    this.playing = false;
    this.lastTick = 0;
    this.lastDraw = 0;
    this.dirty = true;
    this.onTime = () => {};
    this.onState = () => {};
    const { media } = store.project;
    this.onStatus = () => {};
    this.status = '';
    this.preparingProxy = Boolean(media.screen && (media.screen.width > 1280 || media.screen.frameRate > 20) && ipcRenderer?.invoke);
    this.quality = store.project.previewQuality === 'full' ? 'full' : 'balanced';
    this.readyProxyFile = null;
    this.proxyFile = null;
    this.assetRequest = 0;
    this.assetsPending = true;
    this.assetError = null;
    this.resumeAfterVisibility = false;
    if (this.preparingProxy) this.status = '正在准备流畅预览…';

    const make = (tag, track, muted) => {
      if (!track) return null;
      const node = document.createElement(tag);
      node.src = fileUrl(path.join(store.directory, track.file));
      node.preload = 'auto';
      node.muted = muted;
      node.addEventListener('seeked', () => this.invalidate());
      node.addEventListener('loadeddata', () => this.invalidate());
      return { node, offset: track.offset || 0, duration: track.duration };
    };
    this.screen = make('video', media.screen, true);
    this.originalScreenUrl = this.screen?.node.src || null;
    this.activeScreenUrl = this.originalScreenUrl;
    this.camera = make('video', media.camera, true);
    this.microphone = make('audio', media.microphone, false);
    this.system = make('audio', media.systemAudio, false);
    this.backgroundVideo = null;
    this.setupBackgroundVideo();

    new ResizeObserver(() => this.layout()).observe(wrap);
    store.subscribe((reason) => {
      if (reason === 'project') {
        this.time = clamp(this.time, 0, this.duration);
        const quality = store.project.previewQuality === 'full' ? 'full' : 'balanced';
        if (quality !== this.quality) {
          this.quality = quality;
          this.switchScreenSource(quality === 'full'
            ? this.originalScreenUrl
            : (this.proxyFile ? fileUrl(this.proxyFile) : this.originalScreenUrl));
        }
        this.setupBackgroundVideo();
        this.prepareAssets(store.project);
        this.layout();
        this.syncMedia(true);
      }
      this.invalidate();
    });
    this.prepareAssets(store.project);
    this.layout();
    this.syncMedia(true);
    this.visibilityChange = () => {
      if (document.hidden) {
        this.resumeAfterVisibility = this.playing;
        if (this.playing) this.pause();
      } else if (this.resumeAfterVisibility) {
        this.resumeAfterVisibility = false;
        this.play();
      }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibilityChange);
    requestAnimationFrame((now) => this.frame(now));
    if (this.preparingProxy) this.prepareProxy();
  }

  async prepareProxy() {
    try {
      const file = await ipcRenderer.invoke('project:preview', this.store.directory);
      if (file) {
        this.proxyFile = file;
        this.readyProxyFile = file;
        if (this.quality === 'balanced') this.applyReadyProxy();
      }
      this.status = this.assetError?.message || '';
    } catch (error) {
      console.warn('[Recly] 流畅预览准备失败', error);
      this.status = this.assetError?.message || '预览优化失败，播放可能卡顿';
    } finally {
      this.preparingProxy = false;
      this.onStatus(this.status);
    }
  }

  prepareAssets(project) {
    const request = ++this.assetRequest;
    const previousError = this.assetError;
    this.assetsPending = true;
    this.assetError = null;
    this.compositor.prepare(project).then(() => {
      if (request !== this.assetRequest) return;
      this.assetsPending = false;
      if (previousError && this.status === previousError.message) {
        this.status = this.preparingProxy ? '正在准备流畅预览…' : '';
        this.onStatus(this.status);
      }
      this.invalidate();
    }).catch((error) => {
      if (request !== this.assetRequest) return;
      this.assetsPending = false;
      this.assetError = error;
      this.status = error.message;
      this.onStatus(this.status);
    });
  }

  setupBackgroundVideo() {
    const background = this.store.project.canvas.background;
    const file = background?.kind === 'video' && background.file
      ? (path.isAbsolute(background.file) ? background.file : path.join(this.store.directory, background.file))
      : null;
    if (this.backgroundVideo?.file === file) {
      if (this.backgroundVideo) {
        this.backgroundVideo.duration = background.duration;
        this.backgroundVideo.isLooping = background.isLooping !== false;
      }
      return;
    }
    if (this.backgroundVideo) this.backgroundVideo.node.pause();
    this.backgroundVideo = null;
    if (!file) return;
    const node = document.createElement('video');
    node.src = fileUrl(file);
    node.preload = 'auto';
    node.muted = true;
    node.playsInline = true;
    node.addEventListener('seeked', () => this.invalidate());
    node.addEventListener('loadeddata', () => this.invalidate());
    this.backgroundVideo = { node, file, duration: background.duration, isLooping: background.isLooping !== false };
  }

  switchScreenSource(url) {
    if (!this.screen || !url || this.activeScreenUrl === url) return false;
    const resume = this.playing;
    this.playing = false;
    this.syncMedia(true);
    this.screen.node.src = url;
    this.activeScreenUrl = url;
    this.screen.node.load();
    this.syncMedia(true);
    this.invalidate();
    if (resume) {
      this.playing = true;
      this.lastTick = performance.now();
      this.syncMedia(true);
    }
    return true;
  }

  applyReadyProxy() {
    const file = this.proxyFile || this.readyProxyFile;
    if (!file || this.quality !== 'balanced') return false;
    this.proxyFile = file;
    this.readyProxyFile = file;
    return this.switchScreenSource(fileUrl(file));
  }

  setQuality(quality) {
    if (quality !== 'balanced' && quality !== 'full') throw new TypeError('预览质量只能是 balanced 或 full');
    if (this.quality === quality) return false;
    this.quality = quality;
    const target = quality === 'full'
      ? this.originalScreenUrl
      : (this.proxyFile ? fileUrl(this.proxyFile) : this.originalScreenUrl);
    this.switchScreenSource(target);
    this.layout();
    this.invalidate();
    this.onState();
    return true;
  }

  get segments() { return this.store.project.timeline.segments; }

  get duration() { return timeline.outputDuration(this.segments); }

  get sourceTime() { return timeline.locate(this.segments, this.time).sourceTime; }

  invalidate() { this.dirty = true; }

  /// 预览画布按导出画布的比例铺满可用区域。
  layout() {
    const { media, canvas } = this.store.project;
    const output = canvasDimensions(canvas, 'source', media.screen);
    const bounds = this.wrap.getBoundingClientRect();
    if (bounds.width < 10 || bounds.height < 10) return;
    const scale = Math.min(bounds.width / output.width, bounds.height / output.height);
    const cssWidth = Math.floor(output.width * scale);
    const cssHeight = Math.floor(output.height * scale);
    const maxPixels = this.quality === 'full'
      ? Math.min(MAX_FULL_PREVIEW_PIXELS, Math.max(media.screen.width, media.screen.height))
      : MAX_PREVIEW_PIXELS;
    const pixelScale = Math.min(devicePixelRatio, maxPixels / Math.max(cssWidth, cssHeight));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    const width = Math.max(Math.round(cssWidth * pixelScale), 2);
    const height = Math.max(Math.round(cssHeight * pixelScale), 2);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.invalidate();
  }

  play() {
    if (this.playing) return;
    if (this.time >= this.duration - 0.02) this.time = 0;
    this.playing = true;
    this.lastTick = performance.now();
    this.syncMedia(true);
    this.onState();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    if (!this.applyReadyProxy()) this.syncMedia(true);
    this.onState();
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  seek(time) {
    this.time = clamp(time, 0, this.duration);
    this.syncMedia(true);
    this.invalidate();
    this.onTime(this.time);
  }

  /// 把各媒体元素对到时间线上。播放中只在漂移超过容差时重新定位。
  screenWaiting() {
    return Boolean(this.screen?.inRange && (this.screen.node.seeking || this.screen.node.readyState < 2));
  }

  syncBackgroundMedia(force) {
    const track = this.backgroundVideo;
    if (!track) return;
    const { node } = track;
    const mediaDuration = Number.isFinite(node.duration) && node.duration > 0 ? node.duration : track.duration;
    let wanted = Math.max(this.time, 0);
    if (Number.isFinite(mediaDuration) && mediaDuration > 0) {
      wanted = track.isLooping
        ? wanted % mediaDuration
        : Math.min(wanted, Math.max(mediaDuration - 0.03, 0));
    }
    if (!this.playing || this.screenWaiting()) {
      if (!node.paused) node.pause();
      if (!node.seeking && Math.abs(node.currentTime - wanted) > 0.005) node.currentTime = wanted;
      return;
    }
    if (node.playbackRate !== 1) node.playbackRate = 1;
    const drift = Math.abs(node.currentTime - wanted);
    if (!node.seeking && (force || drift > DRIFT_TOLERANCE)) node.currentTime = wanted;
    if (!node.seeking && node.paused) node.play().catch(() => {});
  }

  syncMedia(force) {
    const hit = timeline.locate(this.segments, this.time);
    if (!hit) {
      this.syncBackgroundMedia(force);
      return;
    }
    const audio = resolveAudio(this.store.project.audio, hit.segment.audio);
    const volumes = {
      microphone: audio.isMicrophoneMuted ? 0 : audio.microphoneVolume,
      system: audio.isSystemMuted ? 0 : audio.systemVolume,
    };
    for (const [name, track] of [['screen', this.screen], ['camera', this.camera], ['microphone', this.microphone], ['system', this.system]]) {
      if (!track) continue;
      const { node } = track;
      const limit = (Number.isFinite(node.duration) ? node.duration : track.duration) - 0.03;
      const wanted = hit.sourceTime - track.offset;
      const inRange = wanted >= 0 && wanted <= limit;
      track.inRange = inRange;
      if (volumes[name] !== undefined) node.volume = clamp(volumes[name], 0, 1);
      if (!inRange) {
        if (!node.paused) node.pause();
        // 屏幕画面超出范围时停在最近的一帧上。
        if (name === 'screen' && (force || node.paused)) {
          const edge = clamp(wanted, 0, Math.max(limit, 0));
          if (Math.abs(node.currentTime - edge) > 0.01) node.currentTime = edge;
        }
        continue;
      }
      if (this.playing && (name === 'microphone' || name === 'system') && this.screenWaiting()) {
        if (!node.paused) node.pause();
        continue;
      }
      if (this.playing) {
        if (node.playbackRate !== hit.segment.speed) node.playbackRate = hit.segment.speed;
        const drift = Math.abs(node.currentTime - wanted);
        const shouldSeek = (force && drift > 0.005) || drift > DRIFT_TOLERANCE * Math.max(hit.segment.speed, 1);
        if (!node.seeking && shouldSeek) node.currentTime = wanted;
        // Chromium 的 seek 可能等待播放解码继续；暂停主视频会让剪辑后的
        // 定位卡在 HAVE_METADATA。主视频继续解码，音轨仍在上方等待画面。
        if (node.paused && (name === 'screen' || !node.seeking)) node.play().catch(() => {});
      } else {
        if (!node.paused) node.pause();
        if (Math.abs(node.currentTime - wanted) > 0.005) node.currentTime = wanted;
      }
    }
    this.syncBackgroundMedia(force);
  }

  frame(now) {
    if (typeof document !== 'undefined' && document.hidden) {
      if (this.playing) this.pause();
      requestAnimationFrame((next) => this.frame(next));
      return;
    }
    if (this.playing) {
      if (this.screenWaiting()) {
        this.lastTick = now;
        this.syncMedia(false);
        requestAnimationFrame((next) => this.frame(next));
        return;
      }
      const previous = timeline.locate(this.segments, this.time);
      const previousIndex = previous.index;
      if (this.screen?.inRange) {
        const sourceTime = this.screen.node.currentTime + this.screen.offset;
        const videoTime = previous.outputStart + (sourceTime - previous.segment.sourceStart) / previous.segment.speed;
        const segmentEnd = previous.outputStart + timeline.segmentOutputDuration(previous.segment);
        if (Number.isFinite(videoTime)) this.time = Math.max(this.time, Math.min(videoTime, segmentEnd));
      } else {
        this.time += (now - this.lastTick) / 1000;
      }
      this.lastTick = now;
      if (this.time >= this.duration) {
        this.time = this.duration;
        this.pause();
      } else {
        // 跨过剪辑点时素材时间跳变，需要立即重新定位而不是等漂移超限。
        this.syncMedia(timeline.locate(this.segments, this.time).index !== previousIndex);
      }
      this.onTime(this.time);
      this.dirty = true;
    }
    if (this.dirty && (!this.playing || now - this.lastDraw >= PREVIEW_FRAME_INTERVAL)) {
      this.dirty = false;
      this.lastDraw = now;
      this.draw();
    }
    requestAnimationFrame((next) => this.frame(next));
  }

  draw() {
    if (this.assetsPending || this.assetError) return;
    if (this.screen && this.screen.node.readyState < 2) return;
    const { project, zoomClips, pointerTrack } = this.store;
    const { media } = project;
    const ready = (track) => (track && track.node.readyState >= 2 ? track.node : null);
    const cameraVisible = this.camera && this.camera.inRange && !project.camera.isHidden;
    const scene = evaluateScene(project, {
      time: this.sourceTime,
      outputTime: this.time,
      width: this.canvas.width,
      height: this.canvas.height,
      sourceAspect: media.screen.width / media.screen.height,
      cameraAspect: cameraVisible ? media.camera.width / media.camera.height : null,
      zoomClips,
      pointerTrack,
    });
    this.scene = scene;
    this.compositor.draw(this.ctx, project, scene, {
      screen: ready(this.screen),
      camera: cameraVisible ? ready(this.camera) : null,
      background: ready(this.backgroundVideo),
    });
  }
}

module.exports = { Preview };
