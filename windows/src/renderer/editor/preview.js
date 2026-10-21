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

const DRIFT_TOLERANCE = 0.08;
// 播放中只用限幅、限频的速率校正消除普通音轨漂移。
const AUDIO_DRIFT_DEADBAND = 0.025;
const AUDIO_RATE_RESET_TOLERANCE = 0.012;
const AUDIO_RATE_EVALUATION_INTERVAL = 200;
const AUDIO_RATE_GAIN = 0.3;
const AUDIO_RATE_LIMIT = 0.03;
const AUDIO_RATE_CHANGE_THRESHOLD = 0.004;
// readyState 2 仍有当前帧；只有媒体时钟连续停住才按缓冲等待处理。
const VISUAL_BUFFER_WAIT_MS = 250;
// 摄像头按呈现帧定时，处理管线常驻几十毫秒偏差；若按 80ms 反复 seek，摄像头会闪黑，
// 还会把主时钟（屏幕）暂停而摄像头继续播放，形成越追越偏的卡顿循环。
const CAMERA_DRIFT_TOLERANCE = 0.35;
// 只有显式跳转或摄像头严重错位时才暂停主时钟。
const CAMERA_HOLD_TOLERANCE = 0.3;
const MAX_PREVIEW_PIXELS = 2560;
const MAX_FULL_PREVIEW_PIXELS = 7680;
// 平衡预览按每个动画帧重绘（30fps 摄像头/代理每帧都能显示，叠加层也顺滑）。
// “完整”质量要直接画 2560 宽原始素材，保留 25ms 节流控制开销。
const PREVIEW_FRAME_INTERVAL = 25;

class Preview {
  constructor(store, canvas, wrap) {
    this.store = store;
    this.canvas = canvas;
    this.wrap = wrap;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.compositor = new Compositor(store.directory);
    this.time = 0; // 输出时间
    this.playing = false;
    this.cameraSeekHoldsScreen = false;
    this.visualWaitHeld = false;
    this.lastTick = 0;
    this.lastDraw = 0;
    this.dirty = true;
    this.onTime = () => {};
    this.onState = () => {};
    const { media } = store.project;
    this.onStatus = () => {};
    this.status = '';
    this.audioGainError = null;
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
      node.addEventListener('seeked', () => {
        if (node === this.screen?.node && this.screenFrame) this.screenFrame.mediaTime = null;
        if (this.playing && node.paused
          && (node !== this.screen?.node || !this.cameraSeekHoldsScreen)
          && (node !== this.camera?.node || !this.cameraSeekHoldsScreen)
          && (tag === 'video' || !this.visualWaiting())) node.play().catch(() => {});
        this.invalidate();
      });
      node.addEventListener('loadeddata', () => this.invalidate());
      node.addEventListener('loadedmetadata', () => this.invalidate());
      node.addEventListener('canplay', () => {
        if (this.playing && node.paused
          && (node !== this.screen?.node || !this.cameraSeekHoldsScreen)
          && (node !== this.camera?.node || !this.cameraSeekHoldsScreen)
          && (tag === 'video' || !this.visualWaiting())) node.play().catch(() => {});
        this.invalidate();
      });
      return { node, offset: track.offset || 0, duration: track.duration };
    };
    this.screen = make('video', media.screen, true);
    // 画布画的是已经呈现到屏幕上的那一帧，而不是解码器时钟的前沿。
    // 音频跟随呈现帧的时间才能和观众看到的画面同步。
    this.screenFrame = { mediaTime: null, presentedAt: 0 };
    this.watchScreenFrame();
    this.originalScreenUrl = this.screen?.node.src || null;
    this.activeScreenUrl = this.originalScreenUrl;
    this.camera = make('video', media.camera, true);
    this.microphone = make('audio', media.microphone, false);
    this.system = make('audio', media.systemAudio, false);
    this.setupMicrophoneAudio();
    this.backgroundVideo = null;
    this.setupBackgroundVideo();
    this.lastTransportSignature = this.transportSignature();

    new ResizeObserver(() => this.layout()).observe(wrap);
    store.subscribe((reason) => this.onStoreChange(reason));
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
      this.reportStatus();
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
        this.reportStatus();
      }
      this.invalidate();
    }).catch((error) => {
      if (request !== this.assetRequest) return;
      this.assetsPending = false;
      this.assetError = error;
      this.status = error.message;
      this.reportStatus();
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
    if (this.screenFrame) this.screenFrame.mediaTime = null;
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

  transportSignature() {
    const hit = timeline.locate(this.segments, this.time);
    const camera = this.store.project.camera || {};
    return [
      hit?.segment.id ?? null,
      hit?.segment.sourceStart ?? null,
      hit?.segment.sourceEnd ?? null,
      hit?.sourceTime ?? null,
      hit?.segment.speed ?? null,
      this.screen?.offset ?? null,
      this.microphone?.offset ?? null,
      this.system?.offset ?? null,
      this.camera ? this.camera.offset + (camera.timeOffset || 0) : null,
      Boolean(camera.isHidden),
    ];
  }

  onStoreChange(reason) {
    if (reason === 'project') {
      this.time = clamp(this.time, 0, this.duration);
      const nextTransportSignature = this.transportSignature();
      const previousTransportSignature = this.lastTransportSignature;
      const transportChanged = !previousTransportSignature
        || previousTransportSignature.length !== nextTransportSignature.length
        || nextTransportSignature.some((value, index) => value !== previousTransportSignature[index]);
      this.lastTransportSignature = nextTransportSignature;
      const quality = this.store.project.previewQuality === 'full' ? 'full' : 'balanced';
      if (quality !== this.quality) {
        this.quality = quality;
        this.switchScreenSource(quality === 'full'
          ? this.originalScreenUrl
          : (this.proxyFile ? fileUrl(this.proxyFile) : this.originalScreenUrl));
      }
      this.setupBackgroundVideo();
      this.prepareAssets(this.store.project);
      this.layout();
      this.syncMedia(transportChanged);
    }
    this.invalidate();
  }

  currentAudioSettings() {
    const hit = timeline.locate(this.segments, this.time);
    return resolveAudio(this.store.project.audio, hit?.segment.audio);
  }

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
    if (this.audioContext?.state === 'suspended') this.audioContext.resume().catch(() => {});
    this.playing = true;
    // 第一帧呈现前先按解码时钟走，避免用上一段播放的旧呈现帧定时。
    if (this.screenFrame) this.screenFrame.mediaTime = null;
    this.lastTick = performance.now();
    this.syncMedia(true);
    this.onState();
  }

  setupMicrophoneAudio() {
    const node = this.microphone?.node;
    if (!node || this.microphoneAudioInitialized) return;
    this.microphoneAudioInitialized = true;
    const AudioContextConstructor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextConstructor) return;
    try {
      this.audioContext = new AudioContextConstructor();
      this.microphoneSource = this.audioContext.createMediaElementSource(node);
      this.microphoneGain = this.audioContext.createGain();
      this.microphoneSource.connect(this.microphoneGain);
      this.microphoneGain.connect(this.audioContext.destination);
      node.volume = 1;
    } catch (error) {
      this.microphoneGain = null;
      let canUseMediaVolume = !this.microphoneSource;
      if (this.microphoneSource && this.audioContext) {
        try {
          this.microphoneSource.disconnect();
          this.microphoneSource.connect(this.audioContext.destination);
          node.volume = 1;
          canUseMediaVolume = true;
        } catch (fallbackError) {
          this.microphoneRouteError = true;
          console.warn('[Recly] 麦克风预览音频直连失败', fallbackError);
        }
      }
      this.audioGainError = canUseMediaVolume
        ? '当前运行环境无法应用麦克风放大，音量超过 100% 未生效'
        : '麦克风预览音频连接失败，播放可能无声';
      console.warn('[Recly] 麦克风 Web Audio 增益初始化失败', error);
    }
  }

  setMicrophoneGain(volume) {
    const node = this.microphone?.node;
    if (!node) return false;
    if (this.microphoneGain) {
      node.volume = 1;
      if (this.audioGainError) {
        this.audioGainError = null;
        this.reportStatus();
      }
      if (this.lastMicrophoneGain === volume) return true;
      const parameter = this.microphoneGain.gain;
      const now = this.audioContext.currentTime;
      if (volume === 0 || !this.playing || this.audioContext.state !== 'running') {
        if (typeof parameter.cancelScheduledValues === 'function') parameter.cancelScheduledValues(now);
        if (typeof parameter.setValueAtTime === 'function') parameter.setValueAtTime(volume, now);
        else parameter.value = volume;
      } else if (typeof parameter.setTargetAtTime === 'function') {
        parameter.setTargetAtTime(volume, now, 0.015);
      } else {
        parameter.value = volume;
      }
      this.lastMicrophoneGain = volume;
      return true;
    }
    if (volume > 1) {
      node.volume = 1;
      const message = this.microphoneRouteError
        ? '麦克风预览音频连接失败，播放可能无声'
        : '当前运行环境无法应用麦克风放大，音量超过 100% 未生效';
      if (this.audioGainError !== message) {
        this.audioGainError = message;
        this.reportStatus();
      }
      return false;
    }
    node.volume = volume;
    if (this.audioGainError && !this.microphoneRouteError) {
      this.audioGainError = null;
      this.reportStatus();
    }
    return true;
  }

  reportStatus() {
    this.onStatus(this.audioGainError || this.status);
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

  /// 记录屏幕上真正呈现过的那一帧。预览画布按 20fps 重绘，元素时钟比画面超前几十毫秒，
  /// 音频若跟着元素时钟走，声音就会比观众看到的画面早。
  watchScreenFrame() {
    const node = this.screen?.node;
    if (!node || typeof node.requestVideoFrameCallback !== 'function') return;
    const onFrame = (now, metadata) => {
      if (this.playing) {
        this.screenFrame.mediaTime = metadata.mediaTime;
        this.screenFrame.presentedAt = now;
      }
      node.requestVideoFrameCallback(onFrame);
    };
    node.requestVideoFrameCallback(onFrame);
  }

  /// 屏幕上当前这一帧对应的素材时间；没有呈现帧回调时退回解码器时钟。
  presentedSourceTime(now) {
    const node = this.screen?.node;
    if (!node) return 0;
    let time = node.currentTime;
    const frame = this.screenFrame || { mediaTime: null, presentedAt: 0 };
    if (frame.mediaTime !== null) {
      const elapsed = Math.max(0, (now - frame.presentedAt) / 1000);
      // 呈现帧不会晚于解码器已解出的时间；超出说明回调已过期，按解码时钟走。
      time = Math.min(frame.mediaTime + elapsed, time);
    }
    return time + (this.screen.offset || 0);
  }

  mediaBufferWaiting(track) {
    if (track.node.seeking) {
      track.waitingSince = null;
      track.lastWaitingTime = track.node.currentTime;
      return true;
    }
    if (!this.playing || track.node.readyState === undefined || track.node.readyState >= 3) {
      track.waitingSince = null;
      track.lastWaitingTime = null;
      return false;
    }
    if (track.node.readyState < 2) {
      track.waitingSince = null;
      track.lastWaitingTime = track.node.currentTime;
      return true;
    }
    if (track.node.paused) {
      track.waitingSince = null;
      track.lastWaitingTime = null;
      return false;
    }
    const now = performance.now();
    if (track.lastWaitingTime == null) {
      track.lastWaitingTime = track.node.currentTime;
      track.waitingSince = now;
      return false;
    }
    if (Math.abs(track.node.currentTime - track.lastWaitingTime) > 0.001) {
      track.lastWaitingTime = track.node.currentTime;
      track.waitingSince = now;
      return false;
    }
    if (track.waitingSince == null) track.waitingSince = now;
    return now - track.waitingSince >= VISUAL_BUFFER_WAIT_MS;
  }

  screenWaiting() {
    const track = this.screen;
    if (!track?.inRange) {
      if (track) {
        track.waitingSince = null;
        track.lastWaitingTime = null;
      }
      return false;
    }
    return this.mediaBufferWaiting(track);
  }
  cameraWaiting() {
    const track = this.camera;
    if (!track?.inRange || this.store.project.camera?.isHidden) {
      if (track) {
        track.waitingSince = null;
        track.lastWaitingTime = null;
      }
      return false;
    }
    return this.mediaBufferWaiting(track);
  }
  visualWaiting() { return this.screenWaiting() || this.cameraWaiting(); }

  syncAudioRate(track, node, speed, drift, now, reset) {
    if (reset) {
      if (Math.abs(node.playbackRate - speed) >= AUDIO_RATE_CHANGE_THRESHOLD) node.playbackRate = speed;
      track.lastAudioRateSyncAt = now - AUDIO_RATE_EVALUATION_INTERVAL;
      return;
    }
    if (node.paused || node.seeking) {
      track.lastAudioRateSyncAt = now - AUDIO_RATE_EVALUATION_INTERVAL;
      return;
    }
    if (now - (track.lastAudioRateSyncAt ?? -Infinity) < AUDIO_RATE_EVALUATION_INTERVAL) return;
    track.lastAudioRateSyncAt = now;
    const absDrift = Math.abs(drift);
    let correction;
    if (absDrift > AUDIO_DRIFT_DEADBAND) {
      correction = clamp(drift * AUDIO_RATE_GAIN, -AUDIO_RATE_LIMIT, AUDIO_RATE_LIMIT);
    } else if (absDrift <= AUDIO_RATE_RESET_TOLERANCE) {
      correction = 0;
    } else {
      return;
    }
    const targetRate = speed * (1 - correction);
    if (Math.abs(node.playbackRate - targetRate) >= AUDIO_RATE_CHANGE_THRESHOLD) node.playbackRate = targetRate;
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
    if (!this.playing || this.visualWaiting() || this.cameraSeekHoldsScreen) {
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
    if (this.cameraSeekHoldsScreen && !this.cameraWaiting()) this.cameraSeekHoldsScreen = false;
    const now = performance.now();
    const wasVisualWaiting = Boolean(this.visualWaitHeld);
    const hit = timeline.locate(this.segments, this.time);
    if (!hit) {
      this.visualWaitHeld = false;
      this.syncBackgroundMedia(force);
      this.lastTransportSignature = this.transportSignature();
      return;
    }
    const audio = this.currentAudioSettings();
    const volumes = {
      microphone: audio.isMicrophoneMuted ? 0 : audio.microphoneVolume,
      system: audio.isSystemMuted ? 0 : audio.systemVolume,
    };
    let visualWaiting = false;
    let screenWaiting = false;
    for (const [name, track] of [['screen', this.screen], ['camera', this.camera], ['microphone', this.microphone], ['system', this.system]]) {
      if (!track) continue;
      const { node } = track;
      const isAudio = name === 'microphone' || name === 'system';
      const limit = (Number.isFinite(node.duration) ? node.duration : track.duration) - 0.03;
      const wasInRange = Boolean(track.inRange);
      const effectiveOffset = name === 'camera'
        ? (track.offset + (this.store.project.camera?.timeOffset || 0))
        : track.offset;
      const wanted = hit.sourceTime - effectiveOffset;
      let inRange = wanted >= 0 && wanted <= limit;
      if (!inRange && name === 'camera' && !this.playing && wanted < 0 && wanted >= -3.0) {
        inRange = true;
      }
      track.inRange = inRange;
      if (isAudio) {
        if (!this.playing || !inRange) track.pendingExplicitSeek = false;
        else if (force) track.pendingExplicitSeek = Math.abs(node.currentTime - wanted) > AUDIO_DRIFT_DEADBAND;
      }
      if (name === 'screen') {
        screenWaiting = this.screenWaiting();
        visualWaiting = screenWaiting;
      }
      if (name === 'camera') {
        const cameraWaiting = this.cameraWaiting();
        visualWaiting = visualWaiting || cameraWaiting;
        // 主时钟停住（屏幕等待/显式跳转 hold）时摄像头也必须停，否则它会跑在时间线前面，
        // 触发下一轮 drift seek，表现为闪黑和整段卡顿。
        if (inRange && this.playing && (visualWaiting || this.cameraSeekHoldsScreen)) {
          if ((screenWaiting || this.cameraSeekHoldsScreen) && !node.paused && !node.seeking) node.pause();
          continue;
        }
      }
      if (volumes[name] !== undefined) {
        if (name === 'microphone') this.setMicrophoneGain(volumes[name]);
        else node.volume = clamp(volumes[name], 0, 1);
      }
      if (!inRange) {
        if (!node.paused) node.pause();
        if (name === 'microphone' || name === 'system') this.syncAudioRate(track, node, hit.segment.speed, 0, now, true);
        // 屏幕画面超出范围时停在最近的一帧上。
        if (name === 'screen' && (force || node.paused)) {
          const edge = clamp(wanted, 0, Math.max(limit, 0));
          if (Math.abs(node.currentTime - edge) > 0.01) node.currentTime = edge;
        }
        continue;
      }
      if (this.playing && (name === 'microphone' || name === 'system') && visualWaiting) {
        if (!node.paused) node.pause();
        this.syncAudioRate(track, node, hit.segment.speed, 0, now, true);
        if (!wasVisualWaiting && !node.seeking
          && Math.abs(node.currentTime - wanted) > AUDIO_DRIFT_DEADBAND) {
          node.currentTime = wanted;
          track.pendingExplicitSeek = false;
        }
        continue;
      }
      if (this.playing) {
        const drift = node.currentTime - wanted;
        const absDrift = Math.abs(drift);
        const discontinuity = force || (isAudio && !wasInRange);
        if (isAudio) this.syncAudioRate(track, node, hit.segment.speed, drift, now, discontinuity);
        else if (node.playbackRate !== hit.segment.speed) node.playbackRate = hit.segment.speed;
        if (isAudio && track.pendingExplicitSeek && absDrift <= AUDIO_DRIFT_DEADBAND) track.pendingExplicitSeek = false;
        const tolerance = name === 'camera' ? CAMERA_DRIFT_TOLERANCE : DRIFT_TOLERANCE;
        // 屏幕是主时钟：播放中只按呈现帧推进，绝不为漂移去 seek 它。
        // 代理的关键帧间隔约 12s，一次 seek 会让预览停住、摄像头趁机跑远。
        const shouldSeek = isAudio
          ? ((discontinuity || track.pendingExplicitSeek) && absDrift > AUDIO_DRIFT_DEADBAND)
          : (force && absDrift > 0.02) || (name !== 'screen' && absDrift > tolerance);
        const holdForCamera = name === 'camera' && !this.store.project.camera?.isHidden
          && (force || absDrift > CAMERA_HOLD_TOLERANCE);
        if (!node.seeking && shouldSeek) {
          if (holdForCamera) {
            this.cameraSeekHoldsScreen = true;
            if (this.screen?.inRange && !this.screen.node.paused) this.screen.node.pause();
            visualWaiting = true;
          }
          if (isAudio && !node.paused) node.pause();
          node.currentTime = wanted;
          if (isAudio) track.pendingExplicitSeek = false;
        }
        const canResume = name === 'camera'
          || (name === 'screen' ? !this.cameraSeekHoldsScreen : !node.seeking);
        if (node.paused && canResume) {
          node.play().catch(() => {});
        }
      } else {
        if (!node.paused) node.pause();
        if (name === 'microphone' || name === 'system') this.syncAudioRate(track, node, hit.segment.speed, 0, now, true);
        const targetTime = clamp(wanted, 0, Math.max(limit, 0));
        if (Math.abs(node.currentTime - targetTime) > 0.005) node.currentTime = targetTime;
      }
    }
    this.visualWaitHeld = visualWaiting;
    this.syncBackgroundMedia(force);
    this.lastTransportSignature = this.transportSignature();
  }

  frame(now) {
    if (typeof document !== 'undefined' && document.hidden) {
      if (this.playing) this.pause();
      requestAnimationFrame((next) => this.frame(next));
      return;
    }
    if (this.playing) {
      if (this.visualWaiting() || this.cameraSeekHoldsScreen) {
        this.lastTick = now;
        this.syncMedia(false);
        requestAnimationFrame((next) => this.frame(next));
        return;
      }
      const previous = timeline.locate(this.segments, this.time);
      const previousIndex = previous.index;
      if (this.screen?.inRange) {
        const sourceTime = this.presentedSourceTime(now);
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
    const frameInterval = this.quality === 'full' ? PREVIEW_FRAME_INTERVAL : 0;
    if (this.dirty && (!this.playing || now - this.lastDraw >= frameInterval)) {
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
