'use strict';
// 摄像运动：片段定义、布局/几何插值（方形、圆形、横向等 shape 以及全屏 fullscreen）。
// 移植自 RecorderCore/CameraMotion.swift。

const { clamp } = require('./model');
const { easedProgress, ADJACENCY_TOLERANCE } = require('./zoom');
const { randomUUID } = require('node:crypto');

const uid = () => (typeof randomUUID === 'function' ? randomUUID() : Math.random().toString(36).slice(2, 10));

function lerp(from, to, progress) {
  return from + (to - from) * progress;
}

/**
 * CameraMotionClip 结构规范：
 * {
 *   id: string,
 *   timing: {
 *     startTime: number,
 *     duration: number,
 *     leadInDuration?: number,
 *     enterDuration?: number, // 别名兼容
 *     exitDuration?: number,  // 别名兼容
 *     returnDuration?: number,
 *     leadInProgressOffset?: number,
 *     returnProgressOffset?: number,
 *     easing?: string,
 *     customCurve?: object,
 *     preferredLeadInDuration?: number,
 *     preferredReturnDuration?: number
 *   },
 *   target: {
 *     layout: 'shape' | 'fullscreen' | { kind: 'shape', shape: string },
 *     shape?: 'circle' | 'square' | 'horizontal' | 'vertical' | 'original' | 'landscape',
 *     position: { x: number, y: number },
 *     size: number,
 *     roundness?: number,
 *     opacity?: number
 *   },
 *   groupID?: string | null
 * }
 */
function makeCameraMotionClip(options = {}) {
  const timingOpt = options.timing || {};
  const targetOpt = options.target || {};

  const startTime = Math.max(timingOpt.startTime ?? 0, 0);
  const duration = Math.max(timingOpt.duration ?? 0.7, 0.0001);
  const leadIn = timingOpt.leadInDuration ?? timingOpt.enterDuration ?? duration;
  const returnDur = timingOpt.returnDuration ?? timingOpt.exitDuration ?? 0;

  let layout = targetOpt.layout ?? 'shape';
  let shape = targetOpt.shape;
  if (typeof layout === 'object' && layout !== null) {
    const layoutValue = layout;
    if (layoutValue.kind === 'shape') {
      layout = 'shape';
      shape = shape || layoutValue.shape;
    } else if (layoutValue.kind === 'fullscreen') {
      layout = 'fullscreen';
    }
  }

  return {
    id: options.id || uid(),
    timing: {
      startTime,
      duration,
      leadInDuration: clamp(leadIn, 0, 5),
      enterDuration: clamp(leadIn, 0, 5), // 兼容字段
      returnDuration: clamp(returnDur, 0, 5),
      exitDuration: clamp(returnDur, 0, 5),  // 兼容字段
      leadInProgressOffset: clamp(timingOpt.leadInProgressOffset ?? 0, 0, 1),
      returnProgressOffset: clamp(timingOpt.returnProgressOffset ?? 0, 0, 1),
      easing: timingOpt.easing || 'cubic',
      customCurve: timingOpt.customCurve || null,
      preferredLeadInDuration: timingOpt.preferredLeadInDuration ?? null,
      preferredReturnDuration: timingOpt.preferredReturnDuration ?? null,
    },
    target: {
      layout: layout === 'fullscreen' ? 'fullscreen' : 'shape',
      shape: shape || 'square',
      position: {
        x: targetOpt.position?.x ?? 0.86,
        y: targetOpt.position?.y ?? 0.82,
      },
      size: targetOpt.size ?? 0.35,
      roundness: targetOpt.roundness ?? 0.5,
      opacity: targetOpt.opacity ?? 1,
    },
    groupID: options.groupID || null,
  };
}

class CameraMotionClip {
  constructor(options = {}) {
    Object.assign(this, makeCameraMotionClip(options));
  }
}

/**
 * 将状态解析为连续的 CameraMotionSample 参数
 * state: { layout, shape, position, size, roundness, opacity }
 */
function resolveCameraState(state = {}, cameraAspectRatio = 16 / 9, canvasAspectRatio = 16 / 9) {
  let layout = state.layout || 'shape';
  let shape = state.shape;
  if (typeof layout === 'object' && layout !== null) {
    const layoutValue = layout;
    if (layoutValue.kind === 'shape') {
      layout = 'shape';
      shape = shape || layoutValue.shape;
    } else if (layoutValue.kind === 'fullscreen') {
      layout = 'fullscreen';
    }
  }
  shape = shape || 'square';
  // landscape 别名对应 horizontal (1.5) 或 16/9
  if (shape === 'landscape') shape = 'horizontal';

  const roundness = state.roundness ?? 0.5;
  const opacity = state.opacity ?? 1;
  const position = {
    x: state.position?.x ?? 0.86,
    y: state.position?.y ?? 0.82,
  };
  const size = state.size ?? 0.35;

  let aspect = 1;
  let cornerFraction = 0.5 * roundness;
  let fullscreenProgress = 0;

  if (layout === 'fullscreen') {
    aspect = Math.max(canvasAspectRatio || 16 / 9, 0.01);
    cornerFraction = 0;
    fullscreenProgress = 1;
  } else {
    fullscreenProgress = 0;
    switch (shape) {
      case 'circle':
        aspect = 1;
        cornerFraction = 0.5;
        break;
      case 'horizontal':
        aspect = 1.5;
        cornerFraction = 0.5 * roundness;
        break;
      case 'vertical':
        aspect = 0.72;
        cornerFraction = 0.5 * roundness;
        break;
      case 'original':
        aspect = Math.max(cameraAspectRatio || 16 / 9, 0.01);
        cornerFraction = 0.5 * roundness;
        break;
      case 'square':
      default:
        aspect = 1;
        cornerFraction = 0.5 * roundness;
        break;
    }
  }

  return {
    position,
    size,
    aspectRatio: aspect,
    cornerFraction,
    roundness, // 方便直接读取
    fullscreenProgress,
    opacity,
  };
}

function interpolateSamples(from, to, progress) {
  const t = clamp(progress, 0, 1);
  return {
    position: {
      x: lerp(from.position.x, to.position.x, t),
      y: lerp(from.position.y, to.position.y, t),
    },
    size: lerp(from.size, to.size, t),
    aspectRatio: lerp(from.aspectRatio, to.aspectRatio, t),
    cornerFraction: lerp(from.cornerFraction, to.cornerFraction, t),
    roundness: lerp(from.roundness ?? (from.cornerFraction / 0.5), to.roundness ?? (to.cornerFraction / 0.5), t),
    fullscreenProgress: lerp(from.fullscreenProgress, to.fullscreenProgress, t),
    opacity: lerp(from.opacity, to.opacity, t),
  };
}

function transitionSample(inherited, target, progress) {
  const hiddenTarget = target.opacity < 0.01;
  const hiddenSource = inherited.opacity < 0.01;
  const t = clamp(progress, 0, 1);

  if (hiddenTarget) {
    const sample = { ...inherited, position: { ...inherited.position } };
    sample.opacity = lerp(inherited.opacity, 0, t);
    return sample;
  }
  if (hiddenSource) {
    const sample = { ...target, position: { ...target.position } };
    sample.opacity = lerp(0, target.opacity, t);
    return sample;
  }
  return interpolateSamples(inherited, target, t);
}

function normalizeClips(clips) {
  if (!Array.isArray(clips) || clips.length === 0) return [];
  return clips
    .map((c) => (c instanceof CameraMotionClip ? c : makeCameraMotionClip(c)))
    .filter((c) => Number.isFinite(c.timing.startTime) && Number.isFinite(c.timing.duration) && c.timing.duration > 0)
    .sort((a, b) => (a.timing.startTime - b.timing.startTime) || String(a.id).localeCompare(String(b.id)));
}

function touchesNextClip(clips, index) {
  if (index + 1 >= clips.length) return false;
  const curr = clips[index];
  const next = clips[index + 1];
  const currEndTime = curr.timing.startTime + curr.timing.duration;
  return Math.abs(next.timing.startTime - currEndTime) <= ADJACENCY_TOLERANCE;
}

function returnFalloff(clips, index, resolvedBase, time, cameraAspect, canvasAspect, motionStyle) {
  const clip = clips[index];
  const returnDuration = clip.timing.returnDuration ?? clip.timing.exitDuration ?? 0;
  if (returnDuration <= 0.0001) return null;
  if (touchesNextClip(clips, index)) return null;

  const clipEndTime = clip.timing.startTime + clip.timing.duration;
  if (time > clipEndTime + returnDuration) return null;

  const local = clamp((time - clipEndTime) / returnDuration, 0, 1);
  const linear = clip.timing.returnProgressOffset + (1 - clip.timing.returnProgressOffset) * local;
  const progress = easedProgress(linear, clip.timing.easing || 'cubic', motionStyle);
  const target = resolveCameraState(clip.target, cameraAspect, canvasAspect);
  return transitionSample(target, resolvedBase, progress);
}

/**
 * 核心求值函数：evaluateCameraMotion
 * 
 * @param {Array<CameraMotionClip>} clips 
 * @param {Object} baseCamera 默认基础摄像机状态 { layout, shape, position, size, roundness, opacity }
 * @param {number} time 当前采样时间
 * @param {Object} motionStyle 运动缓动配置 (defaultMotion)
 * @param {number} cameraAspectRatio 摄像头素材原始纵横比（可选）
 * @param {number} canvasAspectRatio 画布纵横比（可选）
 * @returns {Object} CameraMotionSample: { position, size, aspectRatio, roundness, cornerFraction, fullscreenProgress, opacity }
 */
function evaluateCameraMotion(clips, baseCamera, time, motionStyle = {}, cameraAspectRatio = 16 / 9, canvasAspectRatio = 16 / 9) {
  const resolvedBase = resolveCameraState(baseCamera, cameraAspectRatio, canvasAspectRatio);

  if (!Number.isFinite(time)) return resolvedBase;
  const ordered = normalizeClips(clips);
  if (ordered.length === 0) return resolvedBase;

  // 扫描/二分寻找片段
  // 遵循 Swift CameraMotionTrack:
  // 遍历 clips
  var inherited = resolvedBase;
  var previousIndex = null;

  for (let index = 0; index < ordered.length; index++) {
    const clip = ordered[index];
    const startTime = clip.timing.startTime;
    const endTime = startTime + clip.timing.duration;

    if (time < startTime) {
      if (previousIndex !== null) {
        const falling = returnFalloff(ordered, previousIndex, resolvedBase, time, cameraAspectRatio, canvasAspectRatio, motionStyle);
        if (falling) return falling;
      }
      return inherited;
    }

    const target = resolveCameraState(clip.target, cameraAspectRatio, canvasAspectRatio);

    if (time < endTime) {
      const leadIn = Math.min(clip.timing.leadInDuration ?? clip.timing.enterDuration ?? clip.timing.duration, clip.timing.duration);
      if (leadIn <= 0.0001) {
        return target;
      }
      const local = Math.min((time - startTime) / leadIn, 1);
      const linear = clip.timing.leadInProgressOffset + (1 - clip.timing.leadInProgressOffset) * local;
      const progress = easedProgress(linear, clip.timing.easing || 'cubic', motionStyle);
      return transitionSample(inherited, target, progress);
    }

    // time >= endTime
    inherited = !touchesNextClip(ordered, index) && (clip.timing.returnDuration ?? clip.timing.exitDuration ?? 0) > 0.0001
      ? resolvedBase
      : target;
    previousIndex = index;
  }

  if (previousIndex !== null) {
    const falling = returnFalloff(ordered, previousIndex, resolvedBase, time, cameraAspectRatio, canvasAspectRatio, motionStyle);
    if (falling) return falling;
    const lastClip = ordered[previousIndex];
    const returnDur = lastClip.timing.returnDuration ?? lastClip.timing.exitDuration ?? 0;
    return returnDur > 0.0001 ? resolvedBase : inherited;
  }

  return inherited;
}

module.exports = {
  CameraMotionClip,
  makeCameraMotionClip,
  resolveCameraState,
  evaluateCameraMotion,
};
