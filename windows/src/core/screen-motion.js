'use strict';
// 屏幕卡片的 3D 运镜片段：布局与投影锚点按 RecorderCore/ScreenMotion.swift 求值。

const { clamp, uid } = require('./model');
const { ADJACENCY_TOLERANCE, bezierValue, easedProgress } = require('./zoom');

const BASE_STATE = Object.freeze({
  position: Object.freeze({ x: 0.5, y: 0.5 }),
  scale: 1,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  perspective: 0.65,
});
const DEFAULT_CURVE = Object.freeze({ x1: 0.65, y1: 0, x2: 0.35, y2: 1 });
const EASING_ALIASES = Object.freeze({
  '线性': 'linear',
  '二次方缓动': 'quadratic',
  '三次方缓动': 'cubic',
  '五次平滑': 'quintic',
  '弹簧': 'spring',
  '自定义曲线': 'custom',
});

function stateWithDefaults(state = {}) {
  return {
    position: {
      x: Number.isFinite(state.position?.x) ? state.position.x : BASE_STATE.position.x,
      y: Number.isFinite(state.position?.y) ? state.position.y : BASE_STATE.position.y,
    },
    scale: clamp(Number.isFinite(state.scale) ? state.scale : BASE_STATE.scale, 0.2, 4),
    rotationX: Number.isFinite(state.rotationX) ? state.rotationX : BASE_STATE.rotationX,
    rotationY: Number.isFinite(state.rotationY) ? state.rotationY : BASE_STATE.rotationY,
    rotationZ: Number.isFinite(state.rotationZ) ? state.rotationZ : BASE_STATE.rotationZ,
    perspective: clamp(Number.isFinite(state.perspective) ? state.perspective : BASE_STATE.perspective, 0, 2),
  };
}

function normalizeCurve(curve) {
  const result = {};
  for (const key of ['x1', 'y1', 'x2', 'y2']) {
    result[key] = clamp(Number.isFinite(curve?.[key]) ? curve[key] : DEFAULT_CURVE[key], 0, 1);
  }
  return result;
}

function makeScreenMotionClip(options = {}) {
  const timing = options.timing || {};
  const startTime = Math.max(Number.isFinite(timing.startTime) ? timing.startTime : 0, 0);
  const duration = Math.max(
    Number.isFinite(timing.duration) ? timing.duration : (Number.isFinite(timing.endTime) ? timing.endTime - startTime : 0.7),
    0.0001
  );
  const leadInDuration = timing.leadInDuration ?? timing.enterDuration ?? duration;
  return {
    id: options.id || uid(),
    timing: {
      startTime,
      duration,
      leadInDuration: clamp(Number.isFinite(leadInDuration) ? leadInDuration : duration, 0, 5),
      leadInProgressOffset: clamp(Number.isFinite(timing.leadInProgressOffset) ? timing.leadInProgressOffset : 0, 0, 1),
      easing: timing.easing || 'cubic',
      customCurve: normalizeCurve(timing.customCurve),
      returnDuration: clamp(Number.isFinite(timing.returnDuration) ? timing.returnDuration : 0, 0, 5),
      returnProgressOffset: clamp(Number.isFinite(timing.returnProgressOffset) ? timing.returnProgressOffset : 0, 0, 1),
    },
    target: stateWithDefaults(options.target),
  };
}

function normalizeClips(clips) {
  return (Array.isArray(clips) ? clips : [])
    .map((clip) => makeScreenMotionClip(clip))
    .filter((clip) => Number.isFinite(clip.timing.startTime) && Number.isFinite(clip.timing.duration) && clip.timing.duration > 0)
    .sort((a, b) => a.timing.startTime - b.timing.startTime || String(a.id).localeCompare(String(b.id)));
}

function createScreenMotionClipAtTime({
  time,
  clips = [],
  timelineDuration,
  base,
  motionStyle = {},
  easing = 'cubic',
  transitionDuration = 0.7,
}) {
  if (!Number.isFinite(time) || !Number.isFinite(timelineDuration) || timelineDuration <= 0) return null;
  const ordered = normalizeClips(clips);
  const startRequest = clamp(time, 0, timelineDuration);
  let previous = null;
  for (const clip of ordered) {
    if (clip.timing.startTime > startRequest + 0.0001) break;
    previous = clip;
  }
  const next = ordered.find((clip) => !previous || clip.timing.startTime > previous.timing.startTime + 0.0001) || null;
  const lowerTouch = previous ? previous.timing.startTime + previous.timing.duration : 0;
  const lowerClear = previous
    ? lowerTouch + (previous.timing.returnDuration > 0.0001 ? previous.timing.returnDuration : transitionDuration)
    : 0;
  const upper = next ? next.timing.startTime : timelineDuration;
  if (upper - lowerTouch <= 0.001) return null;

  const requestedLength = Math.min(1.2, Math.max(timelineDuration * 0.15, 0.5));
  const minimumLength = 0.16;
  let startTime = clamp(startRequest, lowerTouch, upper);
  if (startTime < lowerClear) startTime = lowerTouch;
  let endTime = startTime + requestedLength;
  if (endTime > upper) {
    endTime = upper;
    const shiftedStart = Math.max(endTime - requestedLength, lowerTouch);
    startTime = upper - shiftedStart >= minimumLength ? shiftedStart : lowerTouch;
  }
  const duration = endTime - startTime;
  if (duration < minimumLength - 0.0001 || duration <= 0.001) return null;

  const timing = {
    startTime,
    duration,
    leadInDuration: Math.min(Math.max(transitionDuration, 0), duration),
    easing,
    returnDuration: Math.min(Math.max(transitionDuration, 0), Math.max(upper - endTime, 0)),
  };
  const target = evaluateScreenMotion(ordered, startTime, base, motionStyle);
  return makeScreenMotionClip({ timing, target });
}

function touchesNext(clips, index) {
  return index + 1 < clips.length
    && Math.abs(clips[index + 1].timing.startTime - (clips[index].timing.startTime + clips[index].timing.duration)) <= ADJACENCY_TOLERANCE;
}

const mix = (from, to, t) => from + (to - from) * t;

function mixAngle(from, to, t) {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return from + delta * t;
}

function interpolate(from, to, progress) {
  const t = clamp(progress, 0, 1);
  return {
    position: { x: mix(from.position.x, to.position.x, t), y: mix(from.position.y, to.position.y, t) },
    scale: mix(from.scale, to.scale, t),
    rotationX: mixAngle(from.rotationX, to.rotationX, t),
    rotationY: mixAngle(from.rotationY, to.rotationY, t),
    rotationZ: mixAngle(from.rotationZ, to.rotationZ, t),
    perspective: mix(from.perspective, to.perspective, t),
  };
}

function screenEasedProgress(value, easing, customCurve, motion) {
  const preset = EASING_ALIASES[easing] || easing;
  if (preset === 'custom') return bezierValue(normalizeCurve(customCurve), value);
  return easedProgress(value, preset, motion);
}

function progressFor(time, start, duration, offset, easing, customCurve, motion) {
  const local = clamp((time - start) / Math.max(duration, 0.0001), 0, 1);
  return screenEasedProgress(offset + (1 - offset) * local, easing, customCurve, motion);
}

function directOffset(state, viewport, framing) {
  const cardScale = state.scale;
  const contentWidth = viewport.fittedWidth * cardScale;
  const contentHeight = viewport.fittedHeight * cardScale;
  const border = viewport.borderWidthAtScaleOne * cardScale;
  const left = border + viewport.decorationLeftAtScaleOne * cardScale;
  const right = border + viewport.decorationRightAtScaleOne * cardScale;
  const top = border + viewport.decorationTopAtScaleOne * cardScale;
  const bottom = border + viewport.decorationBottomAtScaleOne * cardScale;
  const decoratedWidth = contentWidth + left + right;
  const decoratedHeight = contentHeight + top + bottom;
  let contentCenterX;
  let contentCenterY;

  if (framing === 'focus') {
    const focusX = clamp(state.position.x, 0, 1);
    const focusY = clamp(state.position.y, 0, 1);
    // 高倍率把目标点缓和带入 31%/69% 的画布安全区，平缓过渡来自原版。
    const recenter = clamp((cardScale - 1) / 2, 0, 1) * 0.62;
    const boundedX = left + focusX * Math.max(viewport.canvasWidth - left - right, 0);
    const boundedY = top + focusY * Math.max(viewport.canvasHeight - top - bottom, 0);
    const targetX = mix(boundedX, (viewport.canvasWidth + left - right) / 2, recenter);
    const targetY = mix(boundedY, (viewport.canvasHeight + top - bottom) / 2, recenter);
    contentCenterX = targetX + (0.5 - focusX) * contentWidth;
    contentCenterY = targetY + (0.5 - focusY) * contentHeight;
  } else {
    contentCenterX = state.position.x * (viewport.canvasWidth - decoratedWidth)
      + contentWidth / 2 + left;
    contentCenterY = state.position.y * (viewport.canvasHeight - decoratedHeight)
      + contentHeight / 2 + top;
  }

  return {
    x: contentCenterX - viewport.canvasWidth / 2,
    y: contentCenterY - viewport.canvasHeight / 2,
  };
}

function layoutSample(state, viewport, framing, isActive = false) {
  return {
    state,
    manualOffset: viewport ? directOffset(state, viewport, framing) : null,
    projectionAnchor: { ...state.position },
    isActive,
  };
}

function interpolateLayout({
  from,
  to,
  progress,
  viewport,
  fromFraming,
  toFraming,
  inheritedProjectionAnchor = null,
  projectionAnchor,
  isActive = true,
}) {
  const t = clamp(progress, 0, 1);
  let position;
  if (viewport) {
    // Swift 在卡片像素 rect 的 left/top 上插值，再还原 position；直接插值
    // normalized position 与 scale 会令目标锚点在放大途中漂移。
    const scaledW0 = from.scale * viewport.fittedWidth;
    const scaledW1 = to.scale * viewport.fittedWidth;
    const scaledH0 = from.scale * viewport.fittedHeight;
    const scaledH1 = to.scale * viewport.fittedHeight;
    const scaledW = mix(scaledW0, scaledW1, t);
    const scaledH = mix(scaledH0, scaledH1, t);
    const left = mix(
      from.position.x * (viewport.canvasWidth - scaledW0),
      to.position.x * (viewport.canvasWidth - scaledW1),
      t
    );
    const top = mix(
      from.position.y * (viewport.canvasHeight - scaledH0),
      to.position.y * (viewport.canvasHeight - scaledH1),
      t
    );
    const denominatorX = viewport.canvasWidth - scaledW;
    const denominatorY = viewport.canvasHeight - scaledH;
    position = {
      x: Math.abs(denominatorX) > 0.001 ? left / denominatorX : mix(from.position.x, to.position.x, t),
      y: Math.abs(denominatorY) > 0.001 ? top / denominatorY : mix(from.position.y, to.position.y, t),
    };
  } else {
    position = {
      x: mix(from.position.x, to.position.x, t),
      y: mix(from.position.y, to.position.y, t),
    };
  }

  const state = {
    position,
    scale: mix(from.scale, to.scale, t),
    rotationX: mixAngle(from.rotationX, to.rotationX, t),
    rotationY: mixAngle(from.rotationY, to.rotationY, t),
    rotationZ: mixAngle(from.rotationZ, to.rotationZ, t),
    perspective: mix(from.perspective, to.perspective, t),
  };
  const fromOffset = viewport ? directOffset(from, viewport, fromFraming) : null;
  const toOffset = viewport ? directOffset(to, viewport, toFraming) : null;
  return {
    state,
    manualOffset: viewport ? { x: mix(fromOffset.x, toOffset.x, t), y: mix(fromOffset.y, toOffset.y, t) } : null,
    // First entry pins the authored target from frame one. Between two tilted
    // targets, move the pivot along with the existing plane rotation.
    projectionAnchor: inheritedProjectionAnchor
      ? {
          x: mix(inheritedProjectionAnchor.x, projectionAnchor.x, t),
          y: mix(inheritedProjectionAnchor.y, projectionAnchor.y, t),
        }
      : { ...projectionAnchor },
    isActive,
  };
}

function evaluateScreenMotionLayout(clips, time, base = BASE_STATE, motionStyle = {}, anchorViewport = null) {
  const resolvedBase = stateWithDefaults(base);
  if (!Number.isFinite(time)) return layoutSample(resolvedBase, anchorViewport, 'placement');
  const ordered = normalizeClips(clips);
  if (!ordered.length) return layoutSample(resolvedBase, anchorViewport, 'placement');
  const motion = {
    screenSpringMass: 2.4,
    screenSpringStiffness: 210,
    screenSpringDamping: 42,
    ...(motionStyle || {}),
  };

  let index = -1;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].timing.startTime <= time) index = i;
    else break;
  }
  if (index < 0) return layoutSample(resolvedBase, anchorViewport, 'placement');

  const clip = ordered[index];
  const { timing, target } = clip;
  const endTime = timing.startTime + timing.duration;
  let inherited = resolvedBase;
  let inheritedFraming = 'placement';
  if (index > 0) {
    const previous = ordered[index - 1];
    const previousEnd = previous.timing.startTime + previous.timing.duration;
    const touchesPrevious = Math.abs(previousEnd - timing.startTime) <= ADJACENCY_TOLERANCE;
    inherited = touchesPrevious || previous.timing.returnDuration <= 0.0001
      ? previous.target
      : resolvedBase;
    inheritedFraming = inherited === previous.target ? 'focus' : 'placement';
  }

  if (time < endTime) {
    const leadIn = Math.min(timing.leadInDuration, timing.duration);
    if (leadIn <= 0.0001) return layoutSample(target, anchorViewport, 'focus', true);
    const progress = progressFor(
      time,
      timing.startTime,
      leadIn,
      timing.leadInProgressOffset,
      timing.easing,
      timing.customCurve,
      motion
    );
    return interpolateLayout({
      from: inherited,
      to: target,
      progress,
      viewport: anchorViewport,
      fromFraming: inheritedFraming,
      toFraming: 'focus',
      inheritedProjectionAnchor: inheritedFraming === 'focus' ? inherited.position : null,
      projectionAnchor: target.position,
    });
  }

  if (touchesNext(ordered, index)) return layoutSample(target, anchorViewport, 'focus', true);
  if (timing.returnDuration > 0.0001 && time <= endTime + timing.returnDuration) {
    const progress = progressFor(
      time,
      endTime,
      timing.returnDuration,
      timing.returnProgressOffset,
      timing.easing,
      timing.customCurve,
      motion
    );
    return interpolateLayout({
      from: target,
      to: resolvedBase,
      progress,
      viewport: anchorViewport,
      fromFraming: 'focus',
      toFraming: 'placement',
      projectionAnchor: target.position,
      isActive: time < endTime + timing.returnDuration,
    });
  }
  return timing.returnDuration > 0.0001
    ? layoutSample(resolvedBase, anchorViewport, 'placement')
    : layoutSample(target, anchorViewport, 'focus', true);
}

/// 兼容只读取关键帧状态的调用点；场景几何使用包含锚点偏移的 layout 结果。
function evaluateScreenMotion(clips, time, base = BASE_STATE, motionStyle = {}) {
  return evaluateScreenMotionLayout(clips, time, base, motionStyle).state;
}

module.exports = { makeScreenMotionClip, createScreenMotionClipAtTime, evaluateScreenMotion, evaluateScreenMotionLayout };
