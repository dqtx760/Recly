'use strict';
// 开场编排与图层遮罩/贴图评估。
// 移植自 RecorderCore/ProjectModel.swift (OpeningSequence),
// FrameScene.swift (openingSample, overlayEffectProgress, stickerAnimationTransform),
// 及 RecorderCore/OverlayTimeline.swift (MosaicClip, StickerClip, StickerTransitionTrack).

const { randomUUID } = require('node:crypto');

const uid = () => (typeof randomUUID === 'function' ? randomUUID() : Math.random().toString(36).slice(2, 10));

const clamp = (value, lower, upper) => Math.min(Math.max(value, lower), upper);

/**
 * 缓动曲线评估 (移植自 ElementMotionEvaluator)
 * @param {number} linearProgress 0..1 线性进度
 * @param {'smooth' | 'swift' | 'gentle'} curve 缓动曲线名称
 * @returns {number}
 */
function evaluateMotionCurve(linearProgress, curve = 'swift') {
  const num = Number.isFinite(linearProgress) ? linearProgress : 0;
  const x = clamp(num, 0, 1);
  switch (curve) {
    case 'smooth':
      return x * x * x * (x * (x * 6 - 15) + 10);
    case 'gentle':
      return 1 - Math.pow(1 - x, 3);
    case 'swift':
    default:
      return 1 - Math.pow(1 - x, 4);
  }
}

/**
 * 五次平滑阶跃函数 (smootherStep)
 */
function smootherStep(value) {
  const x = clamp(Number.isFinite(value) ? value : 0, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

// 支持的中英文开场预设名映射
const PRESET_ALIASES = {
  converge: 'converge',
  '聚拢': 'converge',
  sideSlide: 'sideSlide',
  '侧滑': 'sideSlide',
  light3D: 'light3D',
  '轻 3D': 'light3D',
};

function normalizePreset(preset) {
  return PRESET_ALIASES[preset] || 'light3D';
}

// 支持的中英文开场元素映射
const ELEMENT_ALIASES = {
  screen: 'screen',
  '屏幕': 'screen',
  camera: 'camera',
  '摄像头': 'camera',
  stickers: 'stickers',
  '贴图': 'stickers',
};

const ALL_ELEMENTS = ['screen', 'camera', 'stickers'];

function normalizeElement(elem) {
  return ELEMENT_ALIASES[elem] || null;
}

function normalizeElements(elements, appendingMissing = false) {
  const seen = new Set();
  const result = [];
  if (Array.isArray(elements)) {
    for (const raw of elements) {
      const el = normalizeElement(raw);
      if (el && !seen.has(el)) {
        seen.add(el);
        result.push(el);
      }
    }
  }
  if (appendingMissing) {
    for (const el of ALL_ELEMENTS) {
      if (!seen.has(el)) {
        seen.add(el);
        result.push(el);
      }
    }
  }
  return result;
}

/**
 * 开场编排模型 (移植自 ProjectModel.swift: OpeningSequence)
 */
class OpeningSequence {
  static minimumElementDuration = 0.18;

  constructor(options = {}) {
    this.isEnabled = Boolean(options.isEnabled ?? false);
    this.preset = normalizePreset(options.preset ?? 'light3D');
    this.motionCurve = options.motionCurve ?? 'swift';

    const dur = Number.isFinite(options.duration) ? options.duration : 2.2;
    this.duration = clamp(dur, 0.4, 8);

    const stag = Number.isFinite(options.stagger) ? options.stagger : 0.16;
    this.stagger = clamp(stag, 0, 1.2);

    this.includedElements = normalizeElements(
      options.includedElements ?? ALL_ELEMENTS,
      false
    );
    this.elementOrder = normalizeElements(
      options.elementOrder ?? ALL_ELEMENTS,
      true
    );

    this.normalizeTiming();
  }

  maximumStagger(elementCount) {
    const count = elementCount !== undefined ? elementCount : this.includedElements.length;
    const gapCount = Math.max(count - 1, 0);
    if (gapCount <= 0) return 1.2;
    return Math.min(
      1.2,
      Math.max(this.duration - OpeningSequence.minimumElementDuration, 0) / gapCount
    );
  }

  normalizeTiming() {
    const dur = Number.isFinite(this.duration) ? this.duration : 2.2;
    this.duration = clamp(dur, 0.4, 8);
    const maxStagger = this.maximumStagger(this.includedElements.length);
    const stag = Number.isFinite(this.stagger) ? this.stagger : 0.16;
    this.stagger = clamp(stag, 0, maxStagger);
  }
}

const IDENTITY_SAMPLE = Object.freeze({
  opacity: 1,
  scale: 1,
  offset: Object.freeze({ x: 0, y: 0 }),
  rotationX: 0,
  rotationY: 0,
  perspective: 0,
  remaining: 0,
});

/**
 * 采样特定图层在给定时间下的开场动画状态 (移植自 FrameScene.swift: openingSample)
 *
 * @param {'screen' | 'camera' | 'stickers'} element
 * @param {OpeningSequence|object} sequence
 * @param {string[]} [activeElements]
 * @param {number} time
 * @param {number} [canvasWidth=1920]
 * @param {number} [canvasHeight=1080]
 * @returns {{ opacity: number, scale: number, offset: { x: number, y: number }, rotationX: number, rotationY: number, perspective: number, remaining: number }}
 */
function openingSample(
  element,
  sequence,
  activeElements,
  time,
  canvasWidth = 1920,
  canvasHeight = 1080
) {
  if (!sequence || !sequence.isEnabled) {
    return { ...IDENTITY_SAMPLE, offset: { x: 0, y: 0 } };
  }

  const duration = Number.isFinite(sequence.duration) ? sequence.duration : 2.2;
  if (time >= duration) {
    return { ...IDENTITY_SAMPLE, offset: { x: 0, y: 0 } };
  }

  const normElement = normalizeElement(element);
  if (!normElement) {
    return { ...IDENTITY_SAMPLE, offset: { x: 0, y: 0 } };
  }

  let resolvedActive = activeElements;
  if (!Array.isArray(resolvedActive) || resolvedActive.length === 0) {
    const order = sequence.elementOrder || ALL_ELEMENTS;
    const included = sequence.includedElements || ALL_ELEMENTS;
    resolvedActive = order.filter((e) => included.includes(e));
  }
  const normalizedActive = resolvedActive.map(normalizeElement).filter(Boolean);

  const index = normalizedActive.indexOf(normElement);
  if (index === -1) {
    return { ...IDENTITY_SAMPLE, offset: { x: 0, y: 0 } };
  }

  const count = normalizedActive.length;
  let maxStagger = 1.2;
  if (typeof sequence.maximumStagger === 'function') {
    maxStagger = sequence.maximumStagger(count);
  } else {
    const gapCount = Math.max(count - 1, 0);
    maxStagger = gapCount > 0 ? Math.min(1.2, Math.max(duration - OpeningSequence.minimumElementDuration, 0) / gapCount) : 1.2;
  }

  const configuredStagger = Number.isFinite(sequence.stagger) ? sequence.stagger : 0.16;
  const effectiveStagger = Math.min(configuredStagger, maxStagger);
  const lastDelay = effectiveStagger * Math.max(count - 1, 0);
  const itemDuration = Math.max(
    duration - lastDelay,
    OpeningSequence.minimumElementDuration
  );

  const start = effectiveStagger * index;
  const linear = clamp((time - start) / itemDuration, 0, 1);
  const curve = sequence.motionCurve || 'swift';
  const eased = evaluateMotionCurve(linear, curve);
  const opacity = evaluateMotionCurve(Math.min(linear * 1.65, 1), curve);
  const remaining = 1 - eased;
  const rotationRemaining = Math.pow(1 - linear, 1.5);
  const overshoot = 1 + 1.35 * Math.pow(linear - 1, 3) + 0.35 * Math.pow(linear - 1, 2);

  const cw = Number.isFinite(canvasWidth) && canvasWidth > 0 ? canvasWidth : 1920;
  const ch = Number.isFinite(canvasHeight) && canvasHeight > 0 ? canvasHeight : 1080;

  const preset = normalizePreset(sequence.preset);
  let scaleStart = 1.0;
  let initialOffset = { x: 0, y: 0 };
  let rotationX = 0;
  let rotationY = 0;
  let perspective = 0;

  switch (preset) {
    case 'converge':
      switch (normElement) {
        case 'screen':
          scaleStart = 0.72;
          initialOffset = { x: -cw * 1.05, y: -ch * 0.62 };
          break;
        case 'camera':
          scaleStart = 0.58;
          initialOffset = { x: cw * 1.12, y: ch * 0.72 };
          break;
        case 'stickers':
          scaleStart = 0.62;
          initialOffset = { x: -cw * 1.30, y: -ch * 0.70 };
          break;
      }
      break;

    case 'sideSlide':
      switch (normElement) {
        case 'screen':
          scaleStart = 0.94;
          initialOffset = { x: -cw * 1.12, y: 0 };
          break;
        case 'camera':
          scaleStart = 0.88;
          initialOffset = { x: cw * 1.15, y: 0 };
          break;
        case 'stickers':
          scaleStart = 0.90;
          initialOffset = { x: -cw * 1.35, y: 0 };
          break;
      }
      break;

    case 'light3D':
    default:
      switch (normElement) {
        case 'screen':
          scaleStart = 0.80;
          initialOffset = { x: -cw * 1.05, y: ch * 0.08 };
          rotationX = 9 * rotationRemaining;
          rotationY = -22 * rotationRemaining;
          perspective = 0.72 * rotationRemaining;
          break;
        case 'camera':
          scaleStart = 0.72;
          initialOffset = { x: cw * 1.10, y: ch * 0.16 };
          break;
        case 'stickers':
          scaleStart = 0.76;
          initialOffset = { x: -cw * 1.30, y: -ch * 0.12 };
          break;
      }
      break;
  }

  const settledScale = clamp(overshoot, 0, 1.04);
  return {
    opacity,
    scale: scaleStart + (settledScale - scaleStart) * eased,
    offset: {
      x: initialOffset.x * remaining,
      y: initialOffset.y * remaining,
    },
    rotationX,
    rotationY,
    perspective,
    remaining,
  };
}

/**
 * 马赛克/局部模糊/聚光灯效果片段 (移植自 OverlayTimeline.swift: MosaicClip)
 */
class MosaicClip {
  constructor(options = {}) {
    this.id = options.id || uid();
    this.timing = {
      startTime: options.timing?.startTime ?? options.startTime ?? 0,
      duration: options.timing?.duration ?? options.duration ?? 3,
    };
    this.sourceRect = {
      x: options.sourceRect?.x ?? options.x ?? 0.35,
      y: options.sourceRect?.y ?? options.y ?? 0.39,
      width: options.sourceRect?.width ?? options.width ?? 0.30,
      height: options.sourceRect?.height ?? options.height ?? 0.22,
    };
    this.cornerRadius = options.cornerRadius ?? 0.08;
    this.style = options.style ?? 'blur'; // 'blur' | 'spotlight'
    this.intensity = options.intensity ?? 0.55;
    this.spotlightDimming = options.spotlightDimming ?? 0.22;
    this.transitionStyle =
      options.transitionStyle ?? (this.style === 'spotlight' ? 'smooth' : 'none');
    this.transitionInDuration = options.transitionInDuration ?? 0.30;
    this.transitionOutDuration = options.transitionOutDuration ?? 0.30;
  }
}

/**
 * 计算遮罩淡入淡出过渡进度 (移植自 FrameScene.swift: overlayEffectProgress)
 */
function overlayEffectProgress(timing, style, enterDuration, exitDuration, time) {
  const duration = timing.duration;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (style === 'none') return 1;

  const elapsed = Math.max(time - timing.startTime, 0);
  const remaining = Math.max(timing.startTime + duration - time, 0);

  const linearEnter = enterDuration > 0 ? clamp(elapsed / enterDuration, 0, 1) : 1;
  const linearExit = exitDuration > 0 ? clamp(remaining / exitDuration, 0, 1) : 1;

  let enter = 1;
  let exit = 1;
  switch (style) {
    case 'none':
      return 1;
    case 'linear':
      enter = linearEnter;
      exit = linearExit;
      break;
    case 'smooth':
    default:
      enter = smootherStep(linearEnter);
      exit = smootherStep(linearExit);
      break;
  }
  return Math.min(enter, exit);
}

/**
 * 评估所有马赛克片段在指定时间的状态 (移植自 FrameScene.swift activeMosaics)
 *
 * @param {Array<MosaicClip|object>} mosaicClips
 * @param {number} time
 * @returns {Array<object>} 活动马赛克及其当前过渡进度 (0..1)
 */
function evaluateMosaics(mosaicClips = [], time = 0) {
  if (!Array.isArray(mosaicClips)) return [];

  const active = [];
  for (const clip of mosaicClips) {
    const startTime = clip.timing?.startTime ?? clip.startTime ?? 0;
    const duration = clip.timing?.duration ?? clip.duration ?? 0;
    const endTime = clip.timing?.endTime ?? startTime + duration;

    if (!Number.isFinite(startTime) || !Number.isFinite(duration) || duration <= 0) {
      continue;
    }

    // 仅在 [startTime, endTime) 区间内生效
    if (time >= startTime && time < endTime) {
      const timingObj = { startTime, duration, endTime };
      const transitionStyle =
        clip.transitionStyle ?? (clip.style === 'spotlight' ? 'smooth' : 'none');
      const inDur = clip.transitionInDuration ?? 0.30;
      const outDur = clip.transitionOutDuration ?? 0.30;

      const progress = overlayEffectProgress(
        timingObj,
        transitionStyle,
        inDur,
        outDur,
        time
      );

      active.push({
        id: clip.id,
        clip,
        sourceRect: {
          x: clip.sourceRect?.x ?? clip.x ?? 0.35,
          y: clip.sourceRect?.y ?? clip.y ?? 0.39,
          width: clip.sourceRect?.width ?? clip.width ?? 0.30,
          height: clip.sourceRect?.height ?? clip.height ?? 0.22,
        },
        cornerRadius: clip.cornerRadius ?? 0.08,
        style: clip.style ?? 'blur',
        intensity: clip.intensity ?? 0.55,
        spotlightDimming: clip.spotlightDimming ?? 0.22,
        transitionProgress: progress,
        progress,
      });
    }
  }

  return active;
}

/**
 * 贴图出场动画对应的自动退场方向 (移植自 OverlayTimeline.swift: StickerAnimationPreset.automaticExit)
 */
function automaticExit(preset) {
  switch (preset) {
    case 'slideLeft':
      return 'slideRight';
    case 'slideRight':
      return 'slideLeft';
    case 'slideUp':
      return 'slideDown';
    case 'slideDown':
      return 'slideUp';
    case 'slideTopLeft':
      return 'slideBottomRight';
    case 'slideTopRight':
      return 'slideBottomLeft';
    case 'slideBottomLeft':
      return 'slideTopRight';
    case 'slideBottomRight':
      return 'slideTopLeft';
    case 'pop':
      return 'pop';
    case 'fade':
      return 'fade';
    case 'none':
    default:
      return 'none';
  }
}

/**
 * 计算贴图动画入场/退场形变 (移植自 FrameScene.swift: stickerAnimationTransform)
 */
function stickerAnimationTransform(preset, progress, position, width) {
  const p = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
  const travel = 1 - p;

  const halfExtent = Math.max(width, 0.02) / 2;
  const outsideLeading = Math.min(-0.85, -halfExtent - 0.06);
  const outsideTrailing = Math.max(1.85, 1 + halfExtent + 0.06);

  const posX = position?.x ?? 0.5;
  const posY = position?.y ?? 0.5;

  const left = outsideLeading - posX;
  const right = outsideTrailing - posX;
  const top = outsideLeading - posY;
  const bottom = outsideTrailing - posY;

  const offset = { x: 0, y: 0 };
  let scale = 1.0;

  switch (preset) {
    case 'none':
    case 'fade':
      break;
    case 'pop':
      scale = 0.72 + p * 0.28;
      break;
    case 'slideLeft':
      offset.x = left * travel;
      break;
    case 'slideRight':
      offset.x = right * travel;
      break;
    case 'slideUp':
      offset.y = top * travel;
      break;
    case 'slideDown':
      offset.y = bottom * travel;
      break;
    case 'slideTopLeft':
      offset.x = left * travel;
      offset.y = top * travel;
      break;
    case 'slideTopRight':
      offset.x = right * travel;
      offset.y = top * travel;
      break;
    case 'slideBottomLeft':
      offset.x = left * travel;
      offset.y = bottom * travel;
      break;
    case 'slideBottomRight':
      offset.x = right * travel;
      offset.y = bottom * travel;
      break;
  }

  return { scale, offset };
}

/**
 * 贴图剪辑模型 (移植自 OverlayTimeline.swift: StickerClip)
 */
class StickerClip {
  constructor(options = {}) {
    this.id = options.id || uid();
    this.timing = {
      startTime: options.timing?.startTime ?? options.startTime ?? 0,
      duration: options.timing?.duration ?? options.duration ?? 3,
    };
    this.relativePath = options.relativePath ?? '';
    this.position = {
      x: options.position?.x ?? 0.5,
      y: options.position?.y ?? 0.5,
    };
    this.width = options.width ?? 0.38;
    this.height = options.height;
    this.rotationDegrees = options.rotationDegrees ?? options.rotation ?? 0;
    this.opacity = options.opacity ?? 1;
    this.cornerRadius = options.cornerRadius ?? 18;
    this.borderWidth = options.borderWidth ?? 0;
    this.borderColor = options.borderColor ?? '#FFFFFF';
    this.shadowOpacity = options.shadowOpacity ?? 0.28;
    this.shadowRadius = options.shadowRadius ?? 24;
    this.shadowOffsetX = options.shadowOffsetX ?? 0;
    this.shadowOffsetY = options.shadowOffsetY ?? 10;
    this.animation = options.animation ?? 'pop';
    this.animationCurve = options.animationCurve ?? 'swift';
    this.exitAnimation = options.exitAnimation ?? null;
    this.enterDuration = options.enterDuration ?? 0.7;
    this.exitDuration = options.exitDuration ?? 0.22;
    this.backdropBlur = options.backdropBlur ?? 20;
    this.backdropBlurIncludesCamera = options.backdropBlurIncludesCamera ?? false;
    this.hidesScreen = options.hidesScreen ?? false;
    this.hidesCamera = options.hidesCamera ?? false;
    this.layerIndex = options.layerIndex ?? 0;
    this.aspectRatio = options.aspectRatio ?? 1;
  }
}

/**
 * 评估所有贴图片段在指定时间下的变换及渲染属性 (移植自 FrameScene.swift stickerScenes)
 *
 * @param {Array<StickerClip|object>} stickerClips
 * @param {number} time
 * @param {number} [canvasWidth=1920]
 * @param {number} [canvasHeight=1080]
 * @param {object} [options={}]
 * @returns {Array<object>} 活动贴图列表，每项包含 { x, y, width, height, rotation, opacity, scale } 及剪辑样式
 */
function evaluateStickers(
  stickerClips = [],
  time = 0,
  canvasWidth = 1920,
  canvasHeight = 1080,
  options = {}
) {
  if (!Array.isArray(stickerClips)) return [];

  const cw = Number.isFinite(canvasWidth) && canvasWidth > 0 ? canvasWidth : 1920;
  const ch = Number.isFinite(canvasHeight) && canvasHeight > 0 ? canvasHeight : 1080;

  const active = [];

  for (const rawClip of stickerClips) {
    const startTime = rawClip.timing?.startTime ?? rawClip.startTime ?? 0;
    const duration = rawClip.timing?.duration ?? rawClip.duration ?? 0;
    const endTime = rawClip.timing?.endTime ?? startTime + duration;

    if (!Number.isFinite(startTime) || !Number.isFinite(duration) || duration <= 0) {
      continue;
    }

    if (time < startTime || time >= endTime) {
      continue;
    }

    const enter = Math.max(rawClip.enterDuration ?? 0.7, 0);
    const exit = Math.max(rawClip.exitDuration ?? 0.22, 0);
    const totalTransitions = enter + exit;
    const timeScale =
      totalTransitions > duration && totalTransitions > 0
        ? duration / totalTransitions
        : 1;

    const enterDuration = enter * timeScale;
    const exitDuration = exit * timeScale;

    const localTime = Math.max(time - startTime, 0);
    const remaining = Math.max(endTime - time, 0);

    const suppressesEntry =
      Boolean(options.suppressesInitialEntry) && startTime <= 0.0001;
    const linearEnter = suppressesEntry
      ? 1
      : enterDuration > 0
      ? Math.min(localTime / enterDuration, 1)
      : 1;
    const linearExit =
      exitDuration > 0 ? Math.min(remaining / exitDuration, 1) : 1;

    const curve = rawClip.animationCurve ?? 'swift';
    const enterProgress = evaluateMotionCurve(linearEnter, curve);
    const exitProgress = evaluateMotionCurve(linearExit, curve);

    const enterPreset = rawClip.animation ?? 'pop';
    const exitPreset = rawClip.exitAnimation ?? automaticExit(enterPreset);

    const isExiting = exitDuration > 0 && remaining < exitDuration;
    const activePreset = isExiting ? exitPreset : enterPreset;
    const activeProgress = isExiting ? exitProgress : enterProgress;

    const visibility = Math.min(
      enterPreset === 'none' ? 1 : enterProgress,
      exitPreset === 'none' ? 1 : exitProgress
    );

    const pos = {
      x: rawClip.position?.x ?? 0.5,
      y: rawClip.position?.y ?? 0.5,
    };
    const clipWidth = Math.min(Math.max(rawClip.width ?? 0.38, 0.02), 2);

    const transform = stickerAnimationTransform(
      activePreset,
      activeProgress,
      pos,
      clipWidth
    );

    const evaluatedScale = transform.scale;
    const evaluatedOpacity =
      clamp(rawClip.opacity ?? 1, 0, 1) * visibility;
    const rotation = rawClip.rotationDegrees ?? rawClip.rotation ?? 0;

    const stickerPixelWidth = cw * clipWidth * evaluatedScale;
    let aspectRatio = rawClip.aspectRatio ?? 1;
    if (rawClip.sourceWidth && rawClip.sourceHeight) {
      aspectRatio = rawClip.sourceWidth / rawClip.sourceHeight;
    }
    const stickerPixelHeight =
      rawClip.height !== undefined
        ? (rawClip.height <= 2 ? ch * rawClip.height * evaluatedScale : rawClip.height * evaluatedScale)
        : stickerPixelWidth / aspectRatio;

    const centerX = cw * (pos.x + transform.offset.x);
    const centerY = ch * (pos.y + transform.offset.y);

    const evaluatedItem = {
      id: rawClip.id || uid(),
      clip: rawClip,
      relativePath: rawClip.relativePath ?? '',
      // 主变换属性（要求字段）
      x: centerX,
      y: centerY,
      width: stickerPixelWidth,
      height: stickerPixelHeight,
      rotation,
      opacity: evaluatedOpacity,
      scale: evaluatedScale,
      // 方便渲染器/布局使用的附加几何数据
      centerX,
      centerY,
      offset: { ...transform.offset },
      position: { ...pos },
      visibility,
      transitionProgress: visibility,
      isExiting,
      activePreset,
      activeProgress,
      cornerRadius: Math.max(rawClip.cornerRadius ?? 18, 0),
      borderWidth: Math.max(rawClip.borderWidth ?? 0, 0),
      borderColor: rawClip.borderColor ?? '#FFFFFF',
      shadowOpacity: clamp(rawClip.shadowOpacity ?? 0.28, 0, 1),
      shadowRadius: Math.max(rawClip.shadowRadius ?? 24, 0),
      shadowOffsetX: rawClip.shadowOffsetX ?? 0,
      shadowOffsetY: rawClip.shadowOffsetY ?? 10,
      backdropBlur: Math.max(rawClip.backdropBlur ?? 20, 0) * visibility,
      backdropBlurIncludesCamera: Boolean(rawClip.backdropBlurIncludesCamera),
      hidesScreen: Boolean(rawClip.hidesScreen),
      hidesCamera: Boolean(rawClip.hidesCamera),
      layerIndex: rawClip.layerIndex ?? 0,
      transform: {
        x: centerX,
        y: centerY,
        width: stickerPixelWidth,
        height: stickerPixelHeight,
        rotation,
        opacity: evaluatedOpacity,
        scale: evaluatedScale,
      },
    };

    active.push(evaluatedItem);
  }

  active.sort((a, b) => a.layerIndex - b.layerIndex);
  return active;
}

module.exports = {
  OpeningSequence,
  openingSample,
  MosaicClip,
  StickerClip,
  evaluateMosaics,
  evaluateStickers,
  evaluateMotionCurve,
  smootherStep,
  overlayEffectProgress,
  automaticExit,
  stickerAnimationTransform,
};
