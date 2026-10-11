'use strict';

const { randomUUID } = require('node:crypto');

const clone = (value) => JSON.parse(JSON.stringify(value));

function splitEffectClip(clip, kind, sourceTime, minimumDuration = 0.05) {
  if (!clip || !Number.isFinite(sourceTime) || !Number.isFinite(minimumDuration) || minimumDuration < 0) return null;
  const start = kind === 'zoom' ? clip.startTime : clip.timing?.startTime;
  const duration = kind === 'zoom' ? clip.endTime - clip.startTime : clip.timing?.duration;
  if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return null;
  const end = start + duration;
  if (sourceTime - start < minimumDuration || end - sourceTime < minimumDuration) return null;

  const left = clone(clip);
  const right = clone(clip);
  right.id = randomUUID();
  if (kind === 'zoom') {
    left.endTime = sourceTime;
    right.startTime = sourceTime;
    // 两半保持同一目标，避免在切点处重复播放进入或退出过渡。
    left.exitDuration = 0;
    right.enterDuration = 0.002;
  } else {
    left.timing.duration = sourceTime - start;
    right.timing.startTime = sourceTime;
    right.timing.duration = end - sourceTime;
    if (kind === 'screen') {
      left.timing.returnDuration = 0;
      right.timing.leadInDuration = 0;
    } else if (kind === 'camera') {
      left.timing.returnDuration = 0;
      left.timing.exitDuration = 0;
      right.timing.leadInDuration = 0;
      right.timing.enterDuration = 0;
    } else if (kind === 'mosaic') {
      left.transitionOutDuration = 0;
      right.transitionInDuration = 0;
    } else if (!['sticker'].includes(kind)) {
      return null;
    }
  }
  return [left, right];
}

module.exports = { splitEffectClip };
