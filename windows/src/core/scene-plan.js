'use strict';

const { uid } = require('./model');
const { outputDuration, segmentOutputDuration, MIN_SEGMENT } = require('./timeline');
const { makeScreenMotionClip } = require('./screen-motion');

// 成片时间分镜一次性执行，生成的片段 ID 由编辑器决定，不要求模型猜测分割后的 ID。
function applyScenePlan(project, operation) {
  const requested = operation.scenes;
  if (Object.keys(operation).some((key) => !['type', 'scenes'].includes(key)) || !Array.isArray(requested)
    || !requested.length || requested.length > 100) throw new Error('分镜方案需要 1 到 100 个片段');
  if (!project.media?.camera) throw new Error('这个项目没有摄像头素材，无法应用人像分镜');
  if (project.timeline.cameraMotionClips?.length) throw new Error('已有摄像头运镜会覆盖分镜，请先移除相关运镜再应用');
  const original = project.timeline.segments;
  const duration = outputDuration(original);
  const scenes = [];
  let cursor = 0;
  for (const scene of requested) {
    if (!scene || Object.keys(scene).some((key) => !['start', 'end', 'mode'].includes(key))
      || !Number.isFinite(scene.start) || !Number.isFinite(scene.end)
      || Math.abs(scene.start - cursor) > 0.010001 || scene.end <= cursor
      || scene.end > duration + 0.010001 || !['portrait', 'presenter', 'screen3d'].includes(scene.mode)) {
      throw new Error('分镜必须按成片秒连续覆盖全片，模式仅支持人像全屏、屏幕加摄像头和屏幕 3D');
    }
    // 接受百分之一秒显示精度，末尾贴齐真实时长，不积累舍入缺口。
    const end = scenes.length === requested.length - 1 && Math.abs(scene.end - duration) <= 0.010001 ? duration : scene.end;
    scenes.push({ start: cursor, end, mode: scene.mode });
    cursor = end;
  }
  if (Math.abs(cursor - duration) > 1e-6) throw new Error('分镜方案没有覆盖完整成片');
  const segments = [], effects = [];
  let outputStart = 0;
  for (const segment of original) {
    const outputEnd = outputStart + segmentOutputDuration(segment);
    let pieces = 0;
    for (const scene of scenes) {
      const start = Math.max(outputStart, scene.start), end = Math.min(outputEnd, scene.end);
      if (end - start < 1e-7) continue;
      const sourceStart = segment.sourceStart + (start - outputStart) * segment.speed;
      const sourceEnd = segment.sourceStart + (end - outputStart) * segment.speed;
      if (sourceEnd - sourceStart < MIN_SEGMENT - 1e-6) throw new Error('分镜切点距离已有剪辑点太近，请合并相邻短段后重试');
      segments.push({ ...segment, id: pieces++ ? uid() : segment.id, sourceStart, sourceEnd,
        camera: { ...segment.camera, layout: scene.mode === 'portrait' ? 'fullscreen' : 'shape' } });
      if (scene.mode === 'screen3d') {
        if (original.some((other) => other !== segment && other.sourceStart < sourceEnd - 1e-6 && other.sourceEnd > sourceStart + 1e-6)) {
          throw new Error('3D 区间的素材在时间线上重复使用，请先分别处理，避免影响其它片段');
        }
        if ((project.timeline.screenMotionClips || []).some((clip) => clip.timing.startTime < sourceEnd - 1e-6
          && clip.timing.startTime + clip.timing.duration + (clip.timing.returnDuration || 0) > sourceStart + 1e-6)) {
          throw new Error('分镜的 3D 区间与已有屏幕运镜重叠，请调整区间后重试');
        }
        const transition = Math.min(0.4 * segment.speed, (sourceEnd - sourceStart) / 4);
        effects.push(makeScreenMotionClip({ timing: { startTime: sourceStart, duration: sourceEnd - sourceStart - transition,
          leadInDuration: transition, returnDuration: transition, easing: 'cubic' },
        target: { position: project.canvas.contentPosition, scale: project.canvas.contentScale,
          rotationX: 4, rotationY: -10, rotationZ: 0, perspective: 0.65 } }));
      }
    }
    outputStart = outputEnd;
  }
  project.timeline.segments = segments;
  project.timeline.screenMotionClips = [...(project.timeline.screenMotionClips || []), ...effects];
  project.camera.isHidden = false;
  return { sceneCount: scenes.length, segmentCount: segments.length, screen3DCount: effects.length };
}

module.exports = { applyScenePlan };
