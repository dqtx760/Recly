'use strict';

const { clamp } = require('./model');

// 片段未设置的字段继承项目音量；显式取消静音也必须覆盖全局静音。
function resolveAudio(base = {}, overrides = {}) {
  const result = {};
  for (const name of ['system', 'microphone']) {
    const volumeKey = `${name}Volume`;
    const mutedKey = name === 'system' ? 'isSystemMuted' : 'isMicrophoneMuted';
    const volume = overrides[volumeKey] ?? base[volumeKey] ?? 1;
    result[volumeKey] = clamp(Number.isFinite(volume) ? volume : 1, 0, 1);
    result[mutedKey] = overrides[mutedKey] ?? base[mutedKey] ?? false;
  }
  return result;
}

module.exports = { resolveAudio };
