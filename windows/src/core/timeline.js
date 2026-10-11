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

/// 素材时间 → 输出时间。主片段按 [sourceStart, sourceEnd) 命中；只对素材最大末端保留闭区间定位。
/// 落在被剪掉的区间时，吸附到素材时间上其后第一段的起点。
function sourceToOutput(segments, sourceTime) {
  if (!segments || !segments.length) return 0;
  let start = 0;
  // 1. 半开区间优先，确保剪辑接点属于源时间上从此处开始的片段。
  for (const segment of segments) {
    const duration = segmentOutputDuration(segment);
    if (sourceTime >= segment.sourceStart && sourceTime < segment.sourceEnd) {
      return start + (sourceTime - segment.sourceStart) / segment.speed;
    }
    start += duration;
  }

  // 素材最大末端没有后继片段，仍需能定位到保留它的片段输出末端。
  const finalSourceEnd = Math.max(...segments.map((segment) => segment.sourceEnd));
  if (sourceTime === finalSourceEnd) {
    start = 0;
    for (const segment of segments) {
      const duration = segmentOutputDuration(segment);
      if (segment.sourceEnd === finalSourceEnd) return start + duration;
      start += duration;
    }
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

function isRetained(segments, sourceTime) {
  if (!segments || !segments.length || !Number.isFinite(sourceTime)) return false;
  if (segments.some((segment) => sourceTime >= segment.sourceStart && sourceTime < segment.sourceEnd)) return true;
  return sourceTime === Math.max(...segments.map((segment) => segment.sourceEnd));
}

function splitAt(segments, outputTime) {
  const hit = locate(segments, outputTime);
  if (!hit) return null;
  const { index, segment, sourceTime } = hit;
  if (sourceTime - segment.sourceStart < MIN_SEGMENT || segment.sourceEnd - sourceTime < MIN_SEGMENT) return null;
  const next = segments.slice();
  const copyAudio = () => segment.audio && typeof segment.audio === 'object' ? { audio: { ...segment.audio } } : {};
  next.splice(index, 1,
    { ...segment, ...copyAudio(), sourceEnd: sourceTime },
    { ...segment, ...copyAudio(), id: uid(), sourceStart: sourceTime });
  return next;
}

/// 在播放头所在主片段内裁切片段起点或终点。输出时间轴会随片段时长自动闭合。
function rippleTrimAt(segments, outputTime, edge) {
  if (!Array.isArray(segments) || !Number.isFinite(outputTime) || !['start', 'end'].includes(edge)) return null;
  const duration = outputDuration(segments);
  if (outputTime < 0 || outputTime > duration) return null;
  const hit = locate(segments, outputTime);
  if (!hit) return null;
  const { index, segment, sourceTime } = hit;
  const boundary = clamp(sourceTime, segment.sourceStart, segment.sourceEnd);
  if (edge === 'start') {
    if (segment.sourceEnd - boundary < MIN_SEGMENT || boundary - segment.sourceStart < 1e-6) return null;
  } else if (boundary - segment.sourceStart < MIN_SEGMENT || segment.sourceEnd - boundary < 1e-6) {
    return null;
  }
  const next = segments.slice();
  next[index] = edge === 'start'
    ? { ...segment, sourceStart: boundary }
    : { ...segment, sourceEnd: boundary };
  return next;
}

/// 列出素材时间轴上没有被任何主片段保留的区间。
function missingRanges(segments, mediaDuration) {
  if (!Array.isArray(segments) || !Number.isFinite(mediaDuration) || mediaDuration <= 0) return [];
  const retained = segments
    .map((segment) => ({
      sourceStart: clamp(segment.sourceStart, 0, mediaDuration),
      sourceEnd: clamp(segment.sourceEnd, 0, mediaDuration),
    }))
    .filter((range) => range.sourceEnd > range.sourceStart)
    .sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd);
  const gaps = [];
  let cursor = 0;
  for (const range of retained) {
    if (range.sourceStart > cursor + 1e-6) gaps.push({ sourceStart: cursor, sourceEnd: range.sourceStart });
    cursor = Math.max(cursor, range.sourceEnd);
  }
  if (cursor < mediaDuration - 1e-6) gaps.push({ sourceStart: cursor, sourceEnd: mediaDuration });
  return gaps;
}

/// 将已删除的素材区间按输出片段位置插回；范围已保留或与现有片段重叠时拒绝恢复。
function restoreRange(segments, range, insertionIndex) {
  if (!Array.isArray(segments) || !range) return null;
  const sourceStart = Number(range.sourceStart);
  const sourceEnd = Number(range.sourceEnd);
  if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceStart < 0 || sourceEnd - sourceStart < MIN_SEGMENT) return null;
  if (segments.some((segment) => sourceStart < segment.sourceEnd - 1e-6 && sourceEnd > segment.sourceStart + 1e-6)) return null;
  const segment = { id: uid(), sourceStart, sourceEnd, speed: 1 };
  const next = segments.slice();
  next.splice(clamp(Math.floor(Number(insertionIndex) || 0), 0, next.length), 0, segment);
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
  if (index < 0 || !['start', 'end'].includes(edge) || !Number.isFinite(sourceTime)) return null;
  const segment = segments[index];
  const next = segments.slice();
  const overlaps = (other) => other.sourceStart < segment.sourceEnd && other.sourceEnd > segment.sourceStart;
  if (edge === 'start') {
    const lower = segments
      .filter((other) => other.id !== id && (other.sourceEnd <= segment.sourceStart || overlaps(other)))
      .reduce((bound, other) => Math.max(bound, other.sourceEnd), 0);
    if (lower > segment.sourceEnd - MIN_SEGMENT) return null;
    next[index] = { ...segment, sourceStart: clamp(sourceTime, lower, segment.sourceEnd - MIN_SEGMENT) };
  } else {
    const upper = segments
      .filter((other) => other.id !== id && (other.sourceStart >= segment.sourceEnd || overlaps(other)))
      .reduce((bound, other) => Math.min(bound, other.sourceStart), Number.isFinite(mediaDuration) ? mediaDuration : segment.sourceEnd);
    if (upper < segment.sourceStart + MIN_SEGMENT) return null;
    next[index] = { ...segment, sourceEnd: clamp(sourceTime, segment.sourceStart + MIN_SEGMENT, upper) };
  }
  return next;
}

/// 将麦克风/系统音波形按主片段源区间、速度与音轨 offset 映射到该片段的输出显示序列。
function waveformSamplesForSegment(segment, tracks, sampleCount) {
  const count = Math.max(1, Math.floor(sampleCount) || 1);
  const result = new Array(count).fill(0);
  const duration = segmentOutputDuration(segment);
  const audioTracks = Array.isArray(tracks) ? tracks : [];
  for (let index = 0; index < count; index++) {
    const sourceTime = segment.sourceStart + ((index + 0.5) / count) * duration * segment.speed;
    for (const track of audioTracks) {
      if (!track || !Array.isArray(track.samples) || !track.samples.length || !Number.isFinite(track.duration) || track.duration <= 0) continue;
      const audioTime = sourceTime - (Number.isFinite(track.offset) ? track.offset : 0);
      if (audioTime < 0 || audioTime >= track.duration) continue;
      const sampleIndex = Math.min(Math.floor((audioTime / track.duration) * track.samples.length), track.samples.length - 1);
      result[index] = Math.max(result[index], track.samples[sampleIndex] || 0);
    }
  }
  return result;
}

/// 把按素材时间记录的效果片段投影到主片段序列；一个效果可在重排/剪切后显示为多个可见块。
function mapEffectClipsToOutput(segments, pools) {
  const result = {};
  let segmentOutputStart = 0;
  for (const kind of Object.keys(pools || {})) result[kind] = [];
  for (let segmentIndex = 0; segmentIndex < (segments || []).length; segmentIndex++) {
    const segment = segments[segmentIndex];
    const segmentDuration = segmentOutputDuration(segment);
    for (const [kind, clips] of Object.entries(pools || {})) {
      for (const clip of clips || []) {
        const sourceStart = clip.timing?.startTime ?? clip.startTime;
        const sourceEnd = clip.timing
          ? sourceStart + (clip.timing.duration || 0)
          : clip.endTime;
        const intersectionStart = Math.max(segment.sourceStart, sourceStart);
        const intersectionEnd = Math.min(segment.sourceEnd, sourceEnd);
        if (!Number.isFinite(intersectionStart) || intersectionEnd - intersectionStart < 1e-6) continue;
        result[kind].push({
          kind, clip, segment, segmentIndex,
          sourceStart: intersectionStart,
          sourceEnd: intersectionEnd,
          outputStart: segmentOutputStart + (intersectionStart - segment.sourceStart) / segment.speed,
          outputEnd: segmentOutputStart + (intersectionEnd - segment.sourceStart) / segment.speed,
        });
      }
    }
    segmentOutputStart += segmentDuration;
  }
  return result;
}

function setSpeed(segments, id, speed) {
  return segments.map((segment) => (segment.id === id ? { ...segment, speed: clamp(speed, 0.25, 8) } : segment));
}

module.exports = {
  MIN_SEGMENT, SPEEDS,
  segmentOutputDuration, outputDuration, locate, sourceToOutput, isRetained,
  splitAt, rippleTrimAt, missingRanges, restoreRange, removeSegment, trimSegment, setSpeed,
  moveSegment, reorderSegments, reorderedOutputOffset, remapClipsOnReorder,
  waveformSamplesForSegment, mapEffectClipsToOutput,
};
