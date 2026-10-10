'use strict';
// 剪贴板管理：支持复制片段、粘贴片段至播放头、粘贴属性至目标片段（不改变目标时长与ID）。
// 移植自 Sources/DogSCApp/EditorEffectTransfer.swift。

const { randomUUID } = require('node:crypto');

const uid = () => (typeof randomUUID === 'function' ? randomUUID() : Math.random().toString(36).slice(2, 10));

function getClipDuration(clip, kind) {
  if (!clip) return 0;
  if (kind === 'zoom') {
    return Math.max((clip.endTime ?? 0) - (clip.startTime ?? 0), 0);
  }
  if (clip.timing) {
    return Math.max(clip.timing.duration ?? 0, 0);
  }
  if (clip.endTime !== undefined && clip.startTime !== undefined) {
    return Math.max(clip.endTime - clip.startTime, 0);
  }
  return 0;
}

class ClipClipboard {
  constructor() {
    this.clipboardData = null; // { clip, kind, extra }
  }

  hasClip() {
    return this.clipboardData !== null;
  }

  clear() {
    this.clipboardData = null;
  }

  /**
   * 复制片段
   * @param {Object} clip 片段对象
   * @param {string} kind 'zoom' | 'screen' | 'camera' | 'mosaic' | 'sticker' 等
   * @param {Object} extra 附加元数据，如 stickerSourceURL 等
   */
  copy(clip, kind = 'zoom', extra = {}) {
    if (!clip) return;
    // 深拷贝存储
    const payload = JSON.parse(JSON.stringify(clip));
    this.clipboardData = {
      clip: payload,
      kind,
      extra: JSON.parse(JSON.stringify(extra || {})),
    };
  }

  /**
   * 粘贴片段在指定播放头时间处
   * @param {Object} project 项目对象
   * @param {number} playheadTime 播放头时间
   * @returns {Object|null} 新建的片段副本或 null
   */
  paste(project, playheadTime = 0) {
    if (!this.clipboardData || !project) return null;
    const { clip: sourceClip, kind, extra } = this.clipboardData;
    const newId = uid();
    const cloned = JSON.parse(JSON.stringify(sourceClip));
    cloned.id = newId;

    const proposedTime = Math.max(playheadTime, 0);
    const duration = getClipDuration(sourceClip, kind);

    if (kind === 'zoom') {
      cloned.startTime = proposedTime;
      cloned.endTime = proposedTime + duration;
      if (!Array.isArray(project.zoomAnimations)) {
        project.zoomAnimations = [];
      }
      project.zoomAnimations.push(cloned);
      project.zoomAnimations.sort((a, b) => a.startTime - b.startTime);
      return cloned;
    }

    if (!project.timeline) project.timeline = {};

    if (kind === 'camera') {
      if (!Array.isArray(project.timeline.cameraMotionClips)) {
        project.timeline.cameraMotionClips = [];
      }
      if (cloned.timing) {
        cloned.timing.startTime = proposedTime;
      } else {
        cloned.timing = { startTime: proposedTime, duration };
      }
      cloned.groupID = null;
      project.timeline.cameraMotionClips.push(cloned);
      project.timeline.cameraMotionClips.sort((a, b) => a.timing.startTime - b.timing.startTime);
      return cloned;
    }

    if (kind === 'screen') {
      if (!Array.isArray(project.timeline.screenMotionClips)) {
        project.timeline.screenMotionClips = [];
      }
      if (cloned.timing) {
        cloned.timing.startTime = proposedTime;
      } else {
        cloned.timing = { startTime: proposedTime, duration };
      }
      cloned.groupID = null;
      project.timeline.screenMotionClips.push(cloned);
      project.timeline.screenMotionClips.sort((a, b) => a.timing.startTime - b.timing.startTime);
      return cloned;
    }

    if (kind === 'mosaic') {
      if (!Array.isArray(project.timeline.mosaicClips)) {
        project.timeline.mosaicClips = [];
      }
      if (cloned.timing) {
        cloned.timing.startTime = proposedTime;
      }
      project.timeline.mosaicClips.push(cloned);
      return cloned;
    }

    if (kind === 'sticker') {
      if (!Array.isArray(project.timeline.stickerClips)) {
        project.timeline.stickerClips = [];
      }
      if (cloned.timing) {
        cloned.timing.startTime = proposedTime;
      }
      project.timeline.stickerClips.push(cloned);
      return cloned;
    }

    // 默认兜底：如果 clip 包含 timing
    if (cloned.timing) {
      cloned.timing.startTime = proposedTime;
    } else if (cloned.startTime !== undefined) {
      cloned.startTime = proposedTime;
      cloned.endTime = proposedTime + duration;
    }
    return cloned;
  }

  /**
   * 粘贴属性到目标片段（transfers visual parameters while preserving target timing and ID）
   * @param {Object} targetClip 目标片段
   * @param {Object} sourcePayload 来源数据（可以传剪贴板数据或者片段对象）
   * @returns {Object} 目标片段
   */
  pasteAttributes(targetClip, sourcePayload) {
    if (!targetClip) return targetClip;
    const source = sourcePayload && sourcePayload.clip ? sourcePayload.clip : (sourcePayload || (this.clipboardData && this.clipboardData.clip));
    if (!source) return targetClip;

    // 保留 target 的核心标识与时间参数
    const preservedId = targetClip.id;

    // 针对 zoom 片段
    if (targetClip.startTime !== undefined && targetClip.endTime !== undefined) {
      const origStartTime = targetClip.startTime;
      const origEndTime = targetClip.endTime;
      const origEnter = targetClip.enterDuration;
      const origExit = targetClip.exitDuration;

      // 转移视觉属性：scale, focus, easing 等
      if (source.scale !== undefined) targetClip.scale = source.scale;
      if (source.focus) targetClip.focus = JSON.parse(JSON.stringify(source.focus));
      if (source.easing !== undefined) targetClip.easing = source.easing;

      // 缓动时长根据 source preferred 或 fallback，但保留起止时间
      if (source.enterDuration !== undefined) {
        targetClip.enterDuration = source.preferredEnterDuration ?? source.enterDuration;
      }
      if (source.exitDuration !== undefined) {
        targetClip.exitDuration = source.preferredExitDuration ?? source.exitDuration;
      }

      targetClip.id = preservedId;
      targetClip.startTime = origStartTime;
      targetClip.endTime = origEndTime;
      return targetClip;
    }

    // 针对带 timing 的片段（如 camera / screen）
    if (targetClip.timing) {
      const origTiming = { ...targetClip.timing };
      const origGroupId = targetClip.groupID;

      // 如果目标是 cameraMotionClip 或 target 带有视觉参数
      if (targetClip.target && source.target) {
        targetClip.target = JSON.parse(JSON.stringify(source.target));
      } else {
        // 直接属性复制（如 scale, focus, shape, roundness, opacity 等）
        const visualKeys = [
          'layout', 'shape', 'position', 'size', 'scale', 'focus',
          'roundness', 'opacity', 'borderWidth', 'shadowStrength', 'isMirrored', 'crop'
        ];
        for (const key of visualKeys) {
          if (source[key] !== undefined) {
            targetClip[key] = typeof source[key] === 'object' && source[key] !== null
              ? JSON.parse(JSON.stringify(source[key]))
              : source[key];
          }
        }
      }

      // timing 中保留起止位置，转移 easing 与过渡风格
      if (source.timing) {
        if (source.timing.easing) targetClip.timing.easing = source.timing.easing;
        if (source.timing.customCurve) targetClip.timing.customCurve = JSON.parse(JSON.stringify(source.timing.customCurve));
        if (source.timing.leadInDuration !== undefined) {
          targetClip.timing.leadInDuration = source.timing.preferredLeadInDuration ?? source.timing.leadInDuration;
        }
        if (source.timing.returnDuration !== undefined) {
          targetClip.timing.returnDuration = source.timing.preferredReturnDuration ?? source.timing.returnDuration;
        }
      }

      targetClip.id = preservedId;
      targetClip.timing.startTime = origTiming.startTime;
      targetClip.timing.duration = origTiming.duration;
      targetClip.groupID = origGroupId;
      return targetClip;
    }

    // 通用属性兜底
    const visualKeys = ['scale', 'focus', 'shape', 'roundness', 'opacity', 'easing', 'target'];
    for (const key of visualKeys) {
      if (source[key] !== undefined) {
        targetClip[key] = typeof source[key] === 'object' && source[key] !== null
          ? JSON.parse(JSON.stringify(source[key]))
          : source[key];
      }
    }
    targetClip.id = preservedId;

    return targetClip;
  }
}

// 导出一个默认实例和类定义
const defaultClipboard = new ClipClipboard();

module.exports = {
  ClipClipboard,
  clipboard: defaultClipboard,
};
