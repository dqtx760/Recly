'use strict';
// 场景预设定义、序列化与默认预设。对齐 macOS 版 EditorScenePresets.swift / EditorStylePresetStore.swift。

const { randomUUID } = require('node:crypto');
const {
  defaultCanvas,
  defaultCamera,
  defaultCursorStyle,
  defaultMotion,
  defaultAudio,
} = require('./model');

const BUILTIN_PRESET_IDS = {
  minimalist: 'builtin-preset-minimalist',
  obsidianGrid: 'builtin-preset-obsidian-grid',
  desktop: 'builtin-preset-desktop',
};

/**
 * 默认预设 1: "极简纯色" (Minimalist)
 * 无边框、低内边距、纯色/工程白网格背景、轻阴影、极简现代风
 */
function createMinimalistPreset() {
  const canvas = defaultCanvas();
  canvas.aspectRatio = 'adaptive';
  canvas.background = { kind: 'pattern', preset: 'engineeringWhiteGrid' };
  canvas.backgroundBlur = 0;
  canvas.padding = 60;
  canvas.cornerRadius = 16;
  canvas.borderWidth = 0;
  canvas.borderColor = '#FFFFFF';
  canvas.shadowStrength = 0.16;
  canvas.patternScale = 1;
  canvas.patternOpacity = 0.85;

  const camera = defaultCamera();
  camera.shape = 'circle';
  camera.roundness = 1;
  camera.borderWidth = 2;
  camera.shadowStrength = 0.2;

  const cursorStyle = defaultCursorStyle();
  cursorStyle.appearance = 'automatic';
  cursorStyle.size = 1.15;
  cursorStyle.clickEffectStyle = 'ripple';

  const motion = defaultMotion();
  motion.defaultZoomScale = 1.5;

  return {
    id: BUILTIN_PRESET_IDS.minimalist,
    name: '极简纯色',
    createdAt: '2026-01-01T00:00:00.000Z',
    isDefault: false,
    canvas,
    camera,
    cursorStyle,
    motion,
  };
}

/**
 * 默认预设 2: "黑曜石网格" (Obsidian Grid)
 * 经典黑曜石网格、标准圆角与内边距、沉浸暗色
 */
function createObsidianGridPreset() {
  const canvas = defaultCanvas();
  canvas.aspectRatio = 'adaptive';
  canvas.background = { kind: 'pattern', preset: 'obsidianGrid' };
  canvas.backgroundBlur = 0;
  canvas.padding = 100;
  canvas.cornerRadius = 24;
  canvas.borderWidth = 0;
  canvas.borderColor = '#FFFFFF';
  canvas.shadowStrength = 0.28;
  canvas.patternScale = 1;
  canvas.patternOpacity = 1;

  const camera = defaultCamera();
  camera.shape = 'square';
  camera.roundness = 0.5;
  camera.borderWidth = 3;
  camera.shadowStrength = 0.25;

  const cursorStyle = defaultCursorStyle();
  cursorStyle.appearance = 'automatic';
  cursorStyle.size = 1.25;
  cursorStyle.clickEffectStyle = 'ripple';

  const motion = defaultMotion();
  motion.defaultZoomScale = 1.6;

  return {
    id: BUILTIN_PRESET_IDS.obsidianGrid,
    name: '黑曜石网格',
    createdAt: '2026-01-01T00:00:00.000Z',
    isDefault: true,
    canvas,
    camera,
    cursorStyle,
    motion,
  };
}

/**
 * 默认预设 3: "Mac 桌面" (Desktop style)
 * 桌面壁纸风格、大圆角、优雅阴影、方圆摄像头
 */
function createDesktopPreset() {
  const canvas = defaultCanvas();
  canvas.aspectRatio = 'adaptive';
  canvas.background = { kind: 'wallpaper', file: null };
  canvas.backgroundBlur = 20;
  canvas.padding = 120;
  canvas.cornerRadius = 28;
  canvas.borderWidth = 1;
  canvas.borderColor = 'rgba(255, 255, 255, 0.2)';
  canvas.shadowStrength = 0.35;
  canvas.patternScale = 1;
  canvas.patternOpacity = 1;

  const camera = defaultCamera();
  camera.shape = 'horizontal';
  camera.roundness = 0.4;
  camera.borderWidth = 3;
  camera.shadowStrength = 0.3;

  const cursorStyle = defaultCursorStyle();
  cursorStyle.appearance = 'automatic';
  cursorStyle.size = 1.3;
  cursorStyle.clickEffectStyle = 'glow';

  const motion = defaultMotion();
  motion.defaultZoomScale = 1.75;

  return {
    id: BUILTIN_PRESET_IDS.desktop,
    name: 'Mac 桌面',
    createdAt: '2026-01-01T00:00:00.000Z',
    isDefault: false,
    canvas,
    camera,
    cursorStyle,
    motion,
  };
}

/**
 * 获取所有内置预设列表
 */
function getDefaultPresets() {
  return [
    createObsidianGridPreset(),
    createMinimalistPreset(),
    createDesktopPreset(),
  ];
}

/**
 * 从当前项目快照创建新的场景预设
 */
function createPresetFromProject({ id, name, project, isDefault = false }) {
  if (!project) throw new Error('project is required to create a preset');
  const clone = (obj) => (obj ? JSON.parse(JSON.stringify(obj)) : null);

  return {
    id: id || randomUUID(),
    name: (name || '未命名预设').trim(),
    createdAt: new Date().toISOString(),
    isDefault: Boolean(isDefault),
    canvas: clone(project.canvas) || defaultCanvas(),
    camera: clone(project.camera) || defaultCamera(),
    cursorStyle: clone(project.cursorStyle) || defaultCursorStyle(),
    motion: clone(project.motion) || defaultMotion(),
  };
}

/**
 * 标准化并验证预设对象，确保缺少字段时安全回退
 */
function normalizePreset(rawPreset) {
  if (!rawPreset || typeof rawPreset !== 'object') return null;
  const clone = (obj) => (obj ? JSON.parse(JSON.stringify(obj)) : null);
  const merge = (defaults, value) => ({ ...defaults, ...(clone(value) || {}) });

  return {
    id: String(rawPreset.id || randomUUID()),
    name: String(rawPreset.name || '场景预设').trim(),
    createdAt: rawPreset.createdAt || new Date().toISOString(),
    isDefault: Boolean(rawPreset.isDefault),
    canvas: merge(defaultCanvas(), rawPreset.canvas),
    camera: merge(defaultCamera(), rawPreset.camera),
    cursorStyle: merge(defaultCursorStyle(), rawPreset.cursorStyle),
    motion: merge(defaultMotion(), rawPreset.motion),
  };
}

/**
 * 将预设应用到目标项目上
 * 遵循 Swift 版 EditorStylePreset.applying(to: baseline) 规则
 */
function applyPresetToProject(preset, project) {
  if (!preset || !project) return project;
  const clone = (obj) => JSON.parse(JSON.stringify(obj));
  const normalized = normalizePreset(preset);

  const updated = {
    ...project,
    canvas: clone(normalized.canvas),
    camera: clone(normalized.camera),
    cursorStyle: clone(normalized.cursorStyle),
    motion: clone(normalized.motion),
  };

  return updated;
}

/**
 * 检查当前项目配置是否与给定预设完全一致
 */
function matchesPreset(preset, project) {
  if (!preset || !project) return false;
  const p = normalizePreset(preset);
  const jsonEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  return (
    jsonEq(p.canvas, project.canvas) &&
    jsonEq(p.camera, project.camera) &&
    jsonEq(p.cursorStyle, project.cursorStyle) &&
    jsonEq(p.motion, project.motion)
  );
}

module.exports = {
  BUILTIN_PRESET_IDS,
  createMinimalistPreset,
  createObsidianGridPreset,
  createDesktopPreset,
  getDefaultPresets,
  createPresetFromProject,
  normalizePreset,
  applyPresetToProject,
  matchesPreset,
};
