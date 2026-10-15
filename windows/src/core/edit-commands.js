'use strict';

const timeline = require('./timeline');
const { uid, ASPECT_RATIOS, PATTERN_PRESETS, CAMERA_SHAPES, ZOOM_EASINGS } = require('./model');

const clone = (value) => JSON.parse(JSON.stringify(value));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_params', `${label} 必须是对象`);
  return value;
}

function keysOnly(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) fail('invalid_params', `${label} 不支持字段 ${unknown}`);
}

function finite(value, label, min = -Infinity, max = Infinity) {
  if (!Number.isFinite(value) || value < min || value > max) fail('invalid_params', `${label} 超出允许范围`);
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') fail('invalid_params', `${label} 必须是布尔值`);
  return value;
}

function text(value, label, maxLength = 200) {
  if (typeof value !== 'string' || value.length > maxLength) fail('invalid_params', `${label} 必须是长度不超过 ${maxLength} 的文本`);
  return value;
}

function point(value, label, min = 0, max = 1) {
  keysOnly(value, ['x', 'y'], label);
  if (!own(value, 'x') || !own(value, 'y')) fail('invalid_params', `${label} 需要 x 和 y`);
  return { x: finite(value.x, `${label}.x`, min, max), y: finite(value.y, `${label}.y`, min, max) };
}

function segmentsOf(project) {
  return project.timeline && Array.isArray(project.timeline.segments) ? project.timeline.segments : [];
}

function findSegment(project, id) {
  if (typeof id !== 'string' || !id) fail('invalid_params', 'segmentId 必须是非空字符串');
  const segment = segmentsOf(project).find((item) => item.id === id);
  if (!segment) fail('not_found', `找不到片段 ${id}`);
  return segment;
}

function mediaDuration(project) {
  const duration = project.media?.screen?.duration;
  if (!Number.isFinite(duration) || duration <= 0) fail('invalid_project', '项目缺少有效的录屏时长');
  return duration;
}

function sourceRanges(value, duration, label = 'ranges') {
  if (!Array.isArray(value) || !value.length) fail('invalid_params', `${label} 必须是非空数组`);
  const ranges = value.map((range, index) => {
    keysOnly(range, ['sourceStart', 'sourceEnd'], `${label}[${index}]`);
    const start = finite(range.sourceStart, `${label}[${index}].sourceStart`, 0, duration);
    const end = finite(range.sourceEnd, `${label}[${index}].sourceEnd`, 0, duration);
    if (end - start < timeline.MIN_SEGMENT) fail('invalid_params', `${label}[${index}] 长度至少为 ${timeline.MIN_SEGMENT} 秒`);
    return { sourceStart: start, sourceEnd: end };
  });
  ranges.sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd);
  return ranges.reduce((merged, range) => {
    const last = merged[merged.length - 1];
    if (last && range.sourceStart <= last.sourceEnd + 1e-6) last.sourceEnd = Math.max(last.sourceEnd, range.sourceEnd);
    else merged.push({ ...range });
    return merged;
  }, []);
}

function cutRanges(project, ranges, keep) {
  const duration = mediaDuration(project);
  const normalized = sourceRanges(ranges, duration);
  const next = [];
  const changedIds = [];
  for (const segment of segmentsOf(project)) {
    let pieces;
    if (keep) {
      pieces = normalized
        .map((range) => ({ sourceStart: Math.max(segment.sourceStart, range.sourceStart), sourceEnd: Math.min(segment.sourceEnd, range.sourceEnd) }))
        .filter((piece) => piece.sourceEnd - piece.sourceStart >= timeline.MIN_SEGMENT - 1e-6);
    } else {
      pieces = [{ sourceStart: segment.sourceStart, sourceEnd: segment.sourceEnd }];
      for (const range of normalized) {
        pieces = pieces.flatMap((piece) => {
          if (range.sourceEnd <= piece.sourceStart || range.sourceStart >= piece.sourceEnd) return [piece];
          const remaining = [];
          if (range.sourceStart - piece.sourceStart >= timeline.MIN_SEGMENT - 1e-6) remaining.push({ sourceStart: piece.sourceStart, sourceEnd: range.sourceStart });
          if (piece.sourceEnd - range.sourceEnd >= timeline.MIN_SEGMENT - 1e-6) remaining.push({ sourceStart: range.sourceEnd, sourceEnd: piece.sourceEnd });
          return remaining;
        });
      }
    }
    if (pieces.length !== 1 || pieces[0].sourceStart !== segment.sourceStart || pieces[0].sourceEnd !== segment.sourceEnd) changedIds.push(segment.id);
    pieces.forEach((piece, index) => next.push({ ...segment, id: index === 0 ? segment.id : uid(), ...piece }));
  }
  if (!next.length) fail('invalid_operation', '操作会删除全部保留片段');
  project.timeline.segments = next;
  return { changedSegmentIds: changedIds, segmentCount: next.length };
}

function applySplit(project, operation) {
  keysOnly(operation, ['type', 'segmentId', 'sourceTime'], 'split 操作');
  const segments = segmentsOf(project);
  const index = segments.findIndex((item) => item.id === operation.segmentId);
  if (index < 0) fail('not_found', `找不到片段 ${operation.segmentId}`);
  const segment = segments[index];
  const time = finite(operation.sourceTime, 'sourceTime', segment.sourceStart + timeline.MIN_SEGMENT, segment.sourceEnd - timeline.MIN_SEGMENT);
  const outputStart = segments.slice(0, index).reduce((sum, item) => sum + timeline.segmentOutputDuration(item), 0);
  const next = timeline.splitAt(segments, outputStart + (time - segment.sourceStart) / segment.speed);
  if (!next) fail('invalid_operation', '分割点距离片段边缘太近');
  project.timeline.segments = next;
  return { segmentId: segment.id, sourceTime: time, createdSegmentId: next[index + 1].id };
}

function applyTrim(project, operation) {
  keysOnly(operation, ['type', 'segmentId', 'start', 'end'], 'trim 操作');
  const segment = findSegment(project, operation.segmentId);
  const start = finite(operation.start, 'start', segment.sourceStart, segment.sourceEnd - timeline.MIN_SEGMENT);
  const end = finite(operation.end, 'end', segment.sourceStart + timeline.MIN_SEGMENT, segment.sourceEnd);
  if (end - start < timeline.MIN_SEGMENT) fail('invalid_params', `裁切后至少保留 ${timeline.MIN_SEGMENT} 秒`);
  segment.sourceStart = start;
  segment.sourceEnd = end;
  return { segmentId: segment.id, sourceStart: start, sourceEnd: end };
}

function applyReorder(project, operation) {
  keysOnly(operation, ['type', 'segmentIds'], 'reorder 操作');
  const current = segmentsOf(project);
  const ids = operation.segmentIds;
  if (!Array.isArray(ids) || ids.length !== current.length || ids.some((id) => typeof id !== 'string')) fail('invalid_params', 'segmentIds 必须完整列出当前片段');
  if (new Set(ids).size !== ids.length || current.some((segment) => !ids.includes(segment.id))) fail('invalid_params', 'segmentIds 必须完整且不重复');
  const byId = new Map(current.map((segment) => [segment.id, segment]));
  project.timeline.segments = ids.map((id) => byId.get(id));
  return { segmentIds: ids.slice() };
}

function applyAudio(project, operation) {
  keysOnly(operation, ['type', 'segmentId', 'settings'], 'audio 操作');
  const settings = operation.settings;
  const audioKeys = ['microphoneVolume', 'systemVolume', 'isMicrophoneMuted', 'isSystemMuted'];
  keysOnly(settings, audioKeys, 'audio.settings');
  if (!Object.keys(settings).length) fail('invalid_params', 'audio.settings 不能为空');
  const target = operation.segmentId ? findSegment(project, operation.segmentId) : project;
  const audio = operation.segmentId ? (target.audio || (target.audio = {})) : (target.audio || (target.audio = {}));
  for (const [key, value] of Object.entries(settings)) {
    if (key.endsWith('Muted')) audio[key] = bool(value, `audio.settings.${key}`);
    else audio[key] = finite(value, `audio.settings.${key}`, 0, 1);
  }
  return { segmentId: operation.segmentId || null, settings: { ...settings } };
}

const CANVAS_FIELDS = {
  aspectRatio: (value) => { if (!own(ASPECT_RATIOS, value)) fail('invalid_params', 'canvas.aspectRatio 不受支持'); return value; },
  padding: (value) => finite(value, 'canvas.padding', 0, 1000),
  contentScale: (value) => finite(value, 'canvas.contentScale', 0.1, 5),
  contentPosition: (value) => point(value, 'canvas.contentPosition', -2, 2),
  cornerRadius: (value) => finite(value, 'canvas.cornerRadius', 0, 1000),
  borderWidth: (value) => finite(value, 'canvas.borderWidth', 0, 100),
  borderColor: (value) => { text(value, 'canvas.borderColor', 16); if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value)) fail('invalid_params', 'canvas.borderColor 必须是十六进制颜色'); return value; },
  shadowStrength: (value) => finite(value, 'canvas.shadowStrength', 0, 1),
  patternScale: (value) => finite(value, 'canvas.patternScale', 0.1, 10),
  patternOpacity: (value) => finite(value, 'canvas.patternOpacity', 0, 1),
  patternMotion: (value) => finite(value, 'canvas.patternMotion', 0, 1),
  crop: (value) => {
    keysOnly(value, ['x', 'y', 'width', 'height'], 'canvas.crop');
    const crop = { x: finite(value.x, 'canvas.crop.x', 0, 1), y: finite(value.y, 'canvas.crop.y', 0, 1), width: finite(value.width, 'canvas.crop.width', 0.01, 1), height: finite(value.height, 'canvas.crop.height', 0.01, 1) };
    if (crop.x + crop.width > 1 || crop.y + crop.height > 1) fail('invalid_params', 'canvas.crop 必须位于素材画面内');
    return crop;
  },
  screenFrameScale: (value) => finite(value, 'canvas.screenFrameScale', 0.1, 5),
  screenFrameToolbarScale: (value) => finite(value, 'canvas.screenFrameToolbarScale', 0.1, 5),
  screenFrameTitle: (value) => text(value, 'canvas.screenFrameTitle', 200),
  screenFrameBrowserAddress: (value) => text(value, 'canvas.screenFrameBrowserAddress', 500),
  background: (value) => {
    keysOnly(value, ['kind', 'preset', 'color'], 'canvas.background');
    if (value.kind === 'pattern' && own(PATTERN_PRESETS, value.preset)) return { kind: 'pattern', preset: value.preset };
    if (value.kind === 'color' && typeof value.color === 'string' && /^#[0-9a-f]{6}$/i.test(value.color)) return { kind: 'color', color: value.color };
    fail('invalid_params', 'canvas.background 只支持已知网格预设或十六进制纯色');
  },
};

const CAMERA_FIELDS = {
  shape: (value) => { if (!own(CAMERA_SHAPES, value)) fail('invalid_params', 'camera.shape 不受支持'); return value; },
  position: (value) => point(value, 'camera.position', 0, 1),
  size: (value) => finite(value, 'camera.size', 0.01, 1),
  borderWidth: (value) => finite(value, 'camera.borderWidth', 0, 100),
  shadowStrength: (value) => finite(value, 'camera.shadowStrength', 0, 1),
  roundness: (value) => finite(value, 'camera.roundness', 0, 1),
  isMirrored: (value) => bool(value, 'camera.isMirrored'),
  isHidden: (value) => bool(value, 'camera.isHidden'),
  scaleDuringZoom: (value) => finite(value, 'camera.scaleDuringZoom', 0, 2),
  contentScale: (value) => finite(value, 'camera.contentScale', 0.1, 5),
  contentPosition: (value) => point(value, 'camera.contentPosition', 0, 1),
};

function applySimplePatch(project, operation, target, fields, label) {
  keysOnly(operation, ['type', 'patch'], `${label} 操作`);
  const patch = operation.patch;
  keysOnly(patch, Object.keys(fields), `${label}.patch`);
  if (!Object.keys(patch).length) fail('invalid_params', `${label}.patch 不能为空`);
  for (const [key, value] of Object.entries(patch)) target[key] = fields[key](value);
  return { fields: Object.keys(patch) };
}

const ZOOM_FIELDS = {
  startTime: (value, project) => finite(value, 'zoom.startTime', 0, mediaDuration(project)),
  endTime: (value, project) => finite(value, 'zoom.endTime', 0, mediaDuration(project)),
  scale: (value) => finite(value, 'zoom.scale', 1, 8),
  focus: (value) => point(value, 'zoom.focus'),
  enterDuration: (value) => finite(value, 'zoom.enterDuration', 0, 5),
  exitDuration: (value) => finite(value, 'zoom.exitDuration', 0, 5),
  easing: (value) => { if (!own(ZOOM_EASINGS, value)) fail('invalid_params', 'zoom.easing 不受支持'); return value; },
};

function applyZoom(project, operation) {
  keysOnly(operation, ['type', 'segmentId', 'patch'], 'zoom 操作');
  const id = operation.segmentId;
  if (typeof id !== 'string' || !id) fail('invalid_params', 'zoom.segmentId 必须是非空字符串');
  const clip = (project.zoomAnimations || []).find((item) => item.id === id);
  if (!clip) fail('not_found', `找不到缩放片段 ${id}`);
  const patch = operation.patch;
  keysOnly(patch, Object.keys(ZOOM_FIELDS), 'zoom.patch');
  if (!Object.keys(patch).length) fail('invalid_params', 'zoom.patch 不能为空');
  for (const [key, value] of Object.entries(patch)) clip[key] = ZOOM_FIELDS[key](value, project);
  if (clip.endTime - clip.startTime < 0.05) fail('invalid_params', '缩放保持区间至少为 0.05 秒');
  return { segmentId: id, fields: Object.keys(patch) };
}

const EFFECT_FIELDS = {
  screen: {
    startTime: (v, p) => finite(v, 'effect.startTime', 0, mediaDuration(p)), duration: (v) => finite(v, 'effect.duration', 0.05, 600),
    position: (v) => point(v, 'effect.position'), scale: (v) => finite(v, 'effect.scale', 0.2, 4),
    rotationX: (v) => finite(v, 'effect.rotationX', -180, 180), rotationY: (v) => finite(v, 'effect.rotationY', -180, 180), rotationZ: (v) => finite(v, 'effect.rotationZ', -180, 180), perspective: (v) => finite(v, 'effect.perspective', 0, 2),
  },
  camera: {
    startTime: (v, p) => finite(v, 'effect.startTime', 0, mediaDuration(p)), duration: (v) => finite(v, 'effect.duration', 0.05, 600),
    position: (v) => point(v, 'effect.position'), size: (v) => finite(v, 'effect.size', 0.01, 1), roundness: (v) => finite(v, 'effect.roundness', 0, 1), opacity: (v) => finite(v, 'effect.opacity', 0, 1),
    layout: (v) => { if (!['shape', 'fullscreen'].includes(v)) fail('invalid_params', 'effect.layout 不受支持'); return v; },
    shape: (v) => { if (!own(CAMERA_SHAPES, v)) fail('invalid_params', 'effect.shape 不受支持'); return v; },
  },
  mosaic: {
    startTime: (v, p) => finite(v, 'effect.startTime', 0, mediaDuration(p)), duration: (v) => finite(v, 'effect.duration', 0.05, 600),
    sourceRect: (v) => {
      keysOnly(v, ['x', 'y', 'width', 'height'], 'effect.sourceRect');
      const rect = { x: finite(v.x, 'effect.sourceRect.x', 0, 1), y: finite(v.y, 'effect.sourceRect.y', 0, 1), width: finite(v.width, 'effect.sourceRect.width', 0.01, 1), height: finite(v.height, 'effect.sourceRect.height', 0.01, 1) };
      if (rect.x + rect.width > 1 || rect.y + rect.height > 1) fail('invalid_params', 'effect.sourceRect 必须位于画面内');
      return rect;
    },
    style: (v) => { if (!['blur', 'spotlight'].includes(v)) fail('invalid_params', 'effect.style 不受支持'); return v; },
    cornerRadius: (v) => finite(v, 'effect.cornerRadius', 0, 0.5), intensity: (v) => finite(v, 'effect.intensity', 0, 1), spotlightDimming: (v) => finite(v, 'effect.spotlightDimming', 0, 1),
    transitionStyle: (v) => { if (!['none', 'linear', 'smooth'].includes(v)) fail('invalid_params', 'effect.transitionStyle 不受支持'); return v; },
    transitionInDuration: (v) => finite(v, 'effect.transitionInDuration', 0, 5), transitionOutDuration: (v) => finite(v, 'effect.transitionOutDuration', 0, 5),
  },
  sticker: {
    startTime: (v, p) => finite(v, 'effect.startTime', 0, mediaDuration(p)), duration: (v) => finite(v, 'effect.duration', 0.05, 600),
    position: (v) => point(v, 'effect.position'), width: (v) => finite(v, 'effect.width', 0.01, 3), height: (v) => finite(v, 'effect.height', 0.01, 3),
    rotationDegrees: (v) => finite(v, 'effect.rotationDegrees', -360, 360), opacity: (v) => finite(v, 'effect.opacity', 0, 1), cornerRadius: (v) => finite(v, 'effect.cornerRadius', 0, 500),
    borderWidth: (v) => finite(v, 'effect.borderWidth', 0, 100), borderColor: (v) => { text(v, 'effect.borderColor', 16); if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(v)) fail('invalid_params', 'effect.borderColor 必须是十六进制颜色'); return v; },
    shadowOpacity: (v) => finite(v, 'effect.shadowOpacity', 0, 1), shadowRadius: (v) => finite(v, 'effect.shadowRadius', 0, 200), shadowOffsetX: (v) => finite(v, 'effect.shadowOffsetX', -500, 500), shadowOffsetY: (v) => finite(v, 'effect.shadowOffsetY', -500, 500),
    enterDuration: (v) => finite(v, 'effect.enterDuration', 0, 10), exitDuration: (v) => finite(v, 'effect.exitDuration', 0, 10), backdropBlur: (v) => finite(v, 'effect.backdropBlur', 0, 100),
    backdropBlurIncludesCamera: (v) => bool(v, 'effect.backdropBlurIncludesCamera'), hidesScreen: (v) => bool(v, 'effect.hidesScreen'), hidesCamera: (v) => bool(v, 'effect.hidesCamera'), layerIndex: (v) => finite(v, 'effect.layerIndex', 0, 100), aspectRatio: (v) => finite(v, 'effect.aspectRatio', 0.01, 10),
  },
};

const EFFECT_POOLS = { screen: 'screenMotionClips', camera: 'cameraMotionClips', mosaic: 'mosaicClips', sticker: 'stickerClips' };

function applyEffect(project, operation) {
  keysOnly(operation, ['type', 'kind', 'segmentId', 'patch'], 'effect 操作');
  const fields = EFFECT_FIELDS[operation.kind];
  if (!fields) fail('invalid_params', 'effect.kind 只支持 screen、camera、mosaic、sticker');
  const id = operation.segmentId;
  if (typeof id !== 'string' || !id) fail('invalid_params', 'effect.segmentId 必须是非空字符串');
  const clip = (project.timeline[EFFECT_POOLS[operation.kind]] || []).find((item) => item.id === id);
  if (!clip) fail('not_found', `找不到 ${operation.kind} 效果 ${id}`);
  const patch = operation.patch;
  keysOnly(patch, Object.keys(fields), 'effect.patch');
  if (!Object.keys(patch).length) fail('invalid_params', 'effect.patch 不能为空');
  for (const [key, value] of Object.entries(patch)) {
    const checked = fields[key](value, project);
    if (key === 'startTime' || key === 'duration') clip.timing[key === 'startTime' ? 'startTime' : 'duration'] = checked;
    else if (operation.kind === 'screen') clip.target[key] = checked;
    else if (operation.kind === 'camera') clip.target[key] = checked;
    else clip[key === 'position' && operation.kind === 'sticker' ? 'position' : key] = checked;
  }
  const startTime = clip.timing?.startTime;
  const clipEnd = startTime + clip.timing?.duration;
  if (!Number.isFinite(startTime) || !Number.isFinite(clip.timing?.duration) || clip.timing.duration <= 0 || clipEnd > mediaDuration(project) + 1e-6) {
    fail('invalid_params', `effect ${id} 的时间必须位于录屏源素材内`);
  }
  return { kind: operation.kind, segmentId: id, fields: Object.keys(patch) };
}

function applyOne(project, operation) {
  object(operation, 'operation');
  if (typeof operation.type !== 'string') fail('invalid_params', 'operation.type 缺失');
  switch (operation.type) {
    case 'split': return applySplit(project, operation);
    case 'trim': return applyTrim(project, operation);
    case 'remove': {
      keysOnly(operation, ['type', 'segmentId'], 'remove 操作');
      findSegment(project, operation.segmentId);
      const next = timeline.removeSegment(segmentsOf(project), operation.segmentId);
      if (!next) fail('invalid_operation', '至少要保留一个片段');
      project.timeline.segments = next;
      return { segmentId: operation.segmentId };
    }
    case 'remove_range':
    case 'keep_ranges': {
      keysOnly(operation, ['type', 'ranges'], `${operation.type} 操作`);
      return cutRanges(project, operation.ranges, operation.type === 'keep_ranges');
    }
    case 'reorder': return applyReorder(project, operation);
    case 'speed': {
      keysOnly(operation, ['type', 'segmentId', 'value'], 'speed 操作');
      const segment = findSegment(project, operation.segmentId);
      const speed = finite(operation.value, 'speed.value', 0.25, 8);
      segment.speed = speed;
      return { segmentId: segment.id, speed };
    }
    case 'audio': return applyAudio(project, operation);
    case 'canvas': return applySimplePatch(project, operation, project.canvas, CANVAS_FIELDS, 'canvas');
    case 'camera': return applySimplePatch(project, operation, project.camera, CAMERA_FIELDS, 'camera');
    case 'zoom': return applyZoom(project, operation);
    case 'effect': return applyEffect(project, operation);
    default: fail('invalid_params', `不支持编辑操作 ${operation.type}`);
  }
}

function applyOperations(project, operations) {
  if (!Array.isArray(operations) || !operations.length) fail('invalid_params', 'operations 必须是非空数组');
  if (operations.length > 100) fail('invalid_params', '单批最多支持 100 个操作');
  const next = clone(project);
  const beforeDuration = timeline.outputDuration(segmentsOf(next));
  const results = operations.map((operation) => applyOne(next, operation));
  const afterDuration = timeline.outputDuration(segmentsOf(next));
  if (JSON.stringify(next) === JSON.stringify(project)) fail('invalid_operation', '操作没有产生变化');
  return {
    project: next,
    results,
    summary: { operationCount: operations.length, beforeDuration, afterDuration, segmentCount: segmentsOf(next).length },
  };
}

module.exports = { applyOperations, editError: fail };
