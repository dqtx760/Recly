'use strict';
// 主轨剪辑：片段是素材时间区间 [sourceStart, sourceEnd) 加播放速度，按素材顺序排列。
// 缩放、光标、标记都以素材时间保存，剪切后自动跟随所在画面。

const { clamp, uid } = require('./model');

const MIN_SEGMENT = 0.1;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

const segmentOutputDuration = (segment) => (segment.sourceEnd - segment.sourceStart) / segment.speed;
const outputDuration = (segments) => segments.reduce((sum, segment) => sum + segmentOutputDuration(segment), 0);

/// 输出时间 → 所在片段与素材时间。超出末尾时停在最后一帧。
/// 按片段实际数组顺序遍历并累计输出时长。
function locate(segments, outputTime) {
  if (!segments || !segments.length) return null;
  let start = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const duration = segmentOutputDuration(segment);
    if (outputTime < start + duration || index === segments.length - 1) {
      const local = clamp(outputTime - start, 0, duration);
      return { index, segment, outputStart: start, sourceTime: segment.sourceStart + local * segment.speed };
    }
    start += duration;
  }
  return null;
}

/// 素材时间 → 输出时间。任意片段序列下，找到当前序列中首个包含 sourceTime 的片段并返回输出时间；
/// 落在被剪掉的区间时，吸附到素材时间上其后第一段的起点。
function sourceToOutput(segments, sourceTime) {
  if (!segments || !segments.length) return 0;
  let start = 0;
  // 1. 在当前序列中寻找首个包含该素材时间的片段
  for (const segment of segments) {
    const duration = segmentOutputDuration(segment);
    if (sourceTime >= segment.sourceStart && sourceTime <= segment.sourceEnd) {
      return start + (sourceTime - segment.sourceStart) / segment.speed;
    }
    start += duration;
  }

  // 2. 若落在被剪切的空隙或范围外，吸附到素材时间在 sourceTime 之后的最近保留片段起点
  let bestCandidate = null;
  let minSourceStart = Infinity;
  start = 0;
  for (const segment of segments) {
    const duration = segmentOutputDuration(segment);
    if (segment.sourceStart >= sourceTime && segment.sourceStart < minSourceStart) {
      minSourceStart = segment.sourceStart;
      bestCandidate = { outputStart: start };
    }
    start += duration;
  }
  if (bestCandidate) {
    return bestCandidate.outputStart;
  }
  return outputDuration(segments);
}

const isRetained = (segments, sourceTime) =>
  segments.some((segment) => sourceTime >= segment.sourceStart && sourceTime <= segment.sourceEnd);

function splitAt(segments, outputTime) {
  const hit = locate(segments, outputTime);
  if (!hit) return null;
  const { index, segment, sourceTime } = hit;
  if (sourceTime - segment.sourceStart < MIN_SEGMENT || segment.sourceEnd - sourceTime < MIN_SEGMENT) return null;
  const next = segments.slice();
  next.splice(index, 1,
    { ...segment, sourceEnd: sourceTime },
    { ...segment, id: uid(), sourceStart: sourceTime });
  return next;
}

function removeSegment(segments, id) {
  if (segments.length <= 1) return null;
  const next = segments.filter((segment) => segment.id !== id);
  return next.length === segments.length ? null : next;
}
/// 重新排序片段：将 fromIndex 位置的片段移动到 toIndex 位置，返回新数组。
function reorderSegments(segments, fromIndex, toIndex) {
  if (!Array.isArray(segments) || segments.length <= 1) return (segments || []).slice();
  if (fromIndex < 0 || fromIndex >= segments.length) return segments.slice();
  const target = clamp(toIndex, 0, segments.length - 1);
  if (fromIndex === target) return segments.slice();
  const next = segments.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(target, 0, moved);
  return next;
}

/// 移动片段：按片段 ID 查找到片段并移动到 targetIndex 位置，返回新数组。
function moveSegment(segments, id, targetIndex) {
  if (!Array.isArray(segments)) return [];
  const fromIndex = segments.findIndex((segment) => segment.id === id);
  if (fromIndex < 0) return segments.slice();
  return reorderSegments(segments, fromIndex, targetIndex);
}

/// 重排序时计算输出时间偏移量（对齐 ProjectTimelineEditingTransforms.swift 中的 reorderedOutputOffset）。
function reorderedOutputOffset(oldOutputTime, oldSegments, newSegments) {
  if (!oldSegments || !oldSegments.length || !newSegments || !newSegments.length) return 0;
  const oldDuration = outputDuration(oldSegments);
  const probe = clamp(oldOutputTime, 0, Math.max(oldDuration - 1e-5, 0));
  const hit = locate(oldSegments, probe);
  if (!hit || !hit.segment) return 0;

  const segmentId = hit.segment.id;
  let newStart = 0;
  let found = false;
  for (const seg of newSegments) {
    if (seg.id === segmentId) {
      found = true;
      break;
    }
    newStart += segmentOutputDuration(seg);
  }
  if (!found) return 0;
  return newStart - hit.outputStart;
}

/// 重排序片段时调整各类动画／标记／贴图等 clip 的时间，使其跟随对应片段的画面位置。
function remapClipsOnReorder(clips, oldSegments, newSegments, timeKey = 'startTime') {
  if (!Array.isArray(clips) || !clips.length) return [];
  const newTotalDuration = outputDuration(newSegments);

  const translated = clips.map((clip) => {
    let clipTime = 0;
    if (clip[timeKey] !== undefined) {
      clipTime = clip[timeKey];
    } else if (clip.time !== undefined) {
      clipTime = clip.time;
    } else if (clip.timing && clip.timing[timeKey] !== undefined) {
      clipTime = clip.timing[timeKey];
    } else if (clip.timing && clip.timing.startTime !== undefined) {
      clipTime = clip.timing.startTime;
    }

    const delta = reorderedOutputOffset(clipTime, oldSegments, newSegments);
    const moved = { ...clip };
    if (clip.timing) {
      moved.timing = { ...clip.timing };
    }

    if (moved[timeKey] !== undefined) {
      moved[timeKey] = clamp(clip[timeKey] + delta, 0, newTotalDuration);
    }
    if (clip.endTime !== undefined) {
      const origStartTime = clip.startTime !== undefined ? clip.startTime : (clip[timeKey] !== undefined ? clip[timeKey] : 0);
      const newStart = moved[timeKey] !== undefined && (timeKey === 'startTime' || clip.startTime === undefined)
        ? moved[timeKey]
        : clamp(origStartTime + delta, 0, newTotalDuration);
      if (moved.startTime !== undefined) {
        moved.startTime = newStart;
      }
      moved.endTime = clamp(clip.endTime + delta, newStart, newTotalDuration);
      if (moved.enterDuration !== undefined) {
        moved.enterDuration = Math.min(moved.enterDuration, moved.endTime - newStart);
      }
      if (moved.exitDuration !== undefined) {
        moved.exitDuration = Math.min(moved.exitDuration, Math.max(newTotalDuration - moved.endTime, 0));
      }
    }
    if (clip.time !== undefined && moved[timeKey] === undefined) {
      moved.time = clamp(clip.time + delta, 0, newTotalDuration);
    }
    if (moved.timing) {
      if (moved.timing[timeKey] !== undefined) {
        moved.timing[timeKey] = clamp(clip.timing[timeKey] + delta, 0, newTotalDuration);
      } else if (moved.timing.startTime !== undefined) {
        moved.timing.startTime = clamp(clip.timing.startTime + delta, 0, newTotalDuration);
      }
      if (moved.timing.duration !== undefined) {
        const start = moved.timing[timeKey] ?? moved.timing.startTime ?? 0;
        moved.timing.duration = Math.min(clip.timing.duration, Math.max(newTotalDuration - start, 0));
      }
    }
    return moved;
  });

  translated.sort((a, b) => {
    const ta = a[timeKey] ?? a.startTime ?? a.time ?? (a.timing && (a.timing[timeKey] ?? a.timing.startTime)) ?? 0;
    const tb = b[timeKey] ?? b.startTime ?? b.time ?? (b.timing && (b.timing[timeKey] ?? b.timing.startTime)) ?? 0;
    return ta - tb;
  });

  return translated;
}

/// 拖动片段边缘裁短／恢复：不越过相邻片段，也不超出素材。
function trimSegment(segments, id, edge, sourceTime, mediaDuration) {
  const index = segments.findIndex((segment) => segment.id === id);
  if (index < 0) return null;
  const segment = segments[index];
  const next = segments.slice();
  if (edge === 'start') {
    const lower = index > 0 ? segments[index - 1].sourceEnd : 0;
    next[index] = { ...segment, sourceStart: clamp(sourceTime, lower, segment.sourceEnd - MIN_SEGMENT) };
  } else {
    const upper = index + 1 < segments.length ? segments[index + 1].sourceStart : mediaDuration;
    next[index] = { ...segment, sourceEnd: clamp(sourceTime, segment.sourceStart + MIN_SEGMENT, upper) };
  }
  return next;
}

function setSpeed(segments, id, speed) {
  return segments.map((segment) => (segment.id === id ? { ...segment, speed: clamp(speed, 0.25, 8) } : segment));
}

module.exports = {
  MIN_SEGMENT, SPEEDS,
  segmentOutputDuration, outputDuration, locate, sourceToOutput, isRetained,
  splitAt, removeSegment, trimSegment, setSpeed,
  moveSegment, reorderSegments, reorderedOutputOffset, remapClipsOnReorder,
};
