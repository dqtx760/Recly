'use strict';
// 聚焦效果模型与时间线求值。
// 移植自 RecorderCore/FocusEffect.swift。

const { clamp } = require('./model');
const { easedProgress: zoomEasedProgress } = require('./zoom');

const CURVES = {
  linear: { x1: 0, y1: 0, x2: 1, y2: 1 },
  quadratic: { x1: 0.45, y1: 0, x2: 0.55, y2: 1 },
  cubic: { x1: 0.65, y1: 0, x2: 0.35, y2: 1 },
  quintic: { x1: 0.82, y1: 0, x2: 0.18, y2: 1 },
};

function bezierPoint(curve, parameter) {
  const t = clamp(parameter, 0, 1);
  const inv = 1 - t;
  return {
    x: 3 * inv * inv * t * curve.x1 + 3 * inv * t * t * curve.x2 + t * t * t,
    y: 3 * inv * inv * t * curve.y1 + 3 * inv * t * t * curve.y2 + t * t * t,
  };
}

function bezierValue(curve, normalizedTime) {
  const targetX = clamp(normalizedTime, 0, 1);
  if (targetX <= 0 || targetX >= 1) return targetX;
  let parameter = targetX;
  for (let i = 0; i < 7; i++) {
    const pt = bezierPoint(curve, parameter);
    const error = pt.x - targetX;
    if (Math.abs(error) < 0.00001) return pt.y;
    const t = parameter;
    const inv = 1 - t;
    const derivative = 3 * inv * inv * curve.x1 + 6 * inv * t * (curve.x2 - curve.x1) + 3 * t * t * (1 - curve.x2);
    if (Math.abs(derivative) < 0.00001) break;
    const next = parameter - error / derivative;
    if (next < 0 || next > 1) break;
    parameter = next;
  }
  let lower = 0;
  let upper = 1;
  parameter = targetX;
  for (let i = 0; i < 18; i++) {
    const pt = bezierPoint(curve, parameter);
    if (Math.abs(pt.x - targetX) < 0.00001) return pt.y;
    if (pt.x < targetX) lower = parameter; else upper = parameter;
    parameter = (lower + upper) / 2;
  }
  return bezierPoint(curve, parameter).y;
}

function computeEasedProgress(value, preset, customCurve, motion) {
  const t = clamp(value, 0, 1);
  if (preset === 'custom' && customCurve) {
    return bezierValue(customCurve, t);
  }
  if (preset === 'linear') return bezierValue(CURVES.linear, t);
  if (preset === 'quadratic') return bezierValue(CURVES.quadratic, t);
  if (preset === 'quintic') return bezierValue(CURVES.quintic, t);
  if (preset === 'spring' && motion) {
    return zoomEasedProgress(t, 'spring', motion);
  }
  return bezierValue(CURVES.cubic, t);
}

class FocusEffect {
  constructor(options = {}) {
    if (options.linear) {
      this.shape = 'linear';
      this.angleDegrees = 0;
      this.target = 'fixed';
      this.center = { x: 0.5, y: 0.5 };
      this.size = 0.32;
      this.blur = 0.35;
      this.softness = 0.5;
      this.dimming = 0;
    } else {
      this.shape = options.shape !== undefined ? options.shape : undefined;
      this.angleDegrees = options.angleDegrees !== undefined ? options.angleDegrees : undefined;
      this.target = options.target || 'animation';
      this.center = options.center ? { x: options.center.x, y: options.center.y } : { x: 0.5, y: 0.5 };
      this.size = options.size !== undefined ? options.size : 0.45;
      this.blur = options.blur !== undefined ? options.blur : 0.35;
      this.softness = options.softness !== undefined ? options.softness : 0.5;
      this.dimming = options.dimming !== undefined ? options.dimming : 0.18;
    }
  }

  static normalizedAngle(degrees) {
    const result = degrees % 360;
    return result < 0 ? result + 360 : result;
  }

  clearHalfWidth(shortEdge) {
    return (shortEdge * this.size) / 2;
  }

  featherWidth(shortEdge) {
    return Math.max(shortEdge * this.softness * 0.4, 1);
  }

  get isValid() {
    const checks = [this.center.x, this.center.y, this.blur, this.softness, this.dimming];
    const unitValid = checks.every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
    const angleValid =
      this.angleDegrees === undefined ||
      this.angleDegrees === null ||
      (Number.isFinite(this.angleDegrees) && this.angleDegrees >= 0 && this.angleDegrees <= 360);
    const sizeValid = Number.isFinite(this.size) && this.size >= 0.1 && this.size <= 1;
    return unitValid && angleValid && sizeValid;
  }
}

class FocusEffectEvaluator {
  static scene({
    zoom = null,
    screen = null,
    zoomFocus = { x: 0.5, y: 0.5 },
    crop = { x: 0, y: 0, width: 1, height: 1 },
    pointer = null,
    time = 0,
    motion = null,
  }) {
    let effect;
    let anchor;
    let timing;
    let holds;

    if (screen && screen.focusEffect) {
      const selected = new FocusEffect(screen.focusEffect);
      if (selected.shape === undefined || selected.shape === null) {
        selected.shape = 'linear';
        selected.target = 'fixed';
        selected.dimming = 0;
      }
      effect = selected;
      const posX = screen.target && screen.target.position ? screen.target.position.x : 0.5;
      const posY = screen.target && screen.target.position ? screen.target.position.y : 0.5;
      anchor = {
        x: crop.x + posX * crop.width,
        y: crop.y + posY * crop.height,
      };
      timing = screen.timing;
      holds = timing.returnDuration === 0;
    } else if (zoom && zoom.focusEffect) {
      effect = new FocusEffect(zoom.focusEffect);
      anchor = zoomFocus;
      const enterDur = zoom.enterDuration !== undefined ? zoom.enterDuration : (zoom.leadInDuration || 0.7);
      const exitDur = zoom.exitDuration !== undefined ? zoom.exitDuration : (zoom.returnDuration || 0.7);
      const duration = zoom.duration !== undefined ? zoom.duration : Math.max(zoom.endTime - zoom.startTime, 0);
      timing = {
        startTime: zoom.startTime,
        duration,
        endTime: zoom.startTime + duration,
        leadInDuration: enterDur,
        easing: zoom.easing || 'cubic',
        customCurve: zoom.customCurve || CURVES.cubic,
        returnDuration: exitDur,
        leadInProgressOffset: zoom.enterProgressOffset || zoom.leadInProgressOffset || 0,
        returnProgressOffset: zoom.exitProgressOffset || zoom.returnProgressOffset || 0,
      };
      holds = false;
    } else {
      return null;
    }

    if (!effect.isValid || (effect.blur <= 0 && effect.dimming <= 0)) {
      return null;
    }

    const amount = FocusEffectEvaluator.progress({ timing, time, holds, motion });
    if (amount <= 0) {
      return null;
    }

    let center;
    switch (effect.target) {
      case 'animation':
        center = anchor;
        break;
      case 'pointer':
        center = pointer || anchor;
        break;
      case 'fixed':
      default:
        center = effect.center;
        break;
    }

    const constrainedCenter = {
      x: clamp(center.x, 0, 1),
      y: clamp(center.y, 0, 1),
    };

    return {
      effect,
      center: constrainedCenter,
      progress: amount,
    };
  }

  static progress({ timing, time, holds, motion }) {
    if (time < timing.startTime) return 0;
    const enter = Math.min(timing.leadInDuration, timing.duration);
    let linear;
    let exiting;

    const endTime = timing.endTime !== undefined ? timing.endTime : timing.startTime + timing.duration;

    if (enter > 0 && time < timing.startTime + enter) {
      const offset = timing.leadInProgressOffset || 0;
      linear = offset + (1 - offset) * (time - timing.startTime) / enter;
      exiting = false;
    } else if (time < endTime) {
      return 1;
    } else if (timing.returnDuration > 0) {
      const offset = timing.returnProgressOffset || 0;
      linear = offset + (1 - offset) * (time - endTime) / timing.returnDuration;
      exiting = true;
    } else {
      return holds ? 1 : 0;
    }

    const eased = computeEasedProgress(
      clamp(linear, 0, 1),
      timing.easing,
      timing.customCurve,
      motion
    );

    return clamp(exiting ? 1 - eased : eased, 0, 1);
  }
}

module.exports = {
  FocusEffect,
  FocusEffectEvaluator,
};
