'use strict';

const assert = require('node:assert/strict');
const model = require('../src/core/model');
const timeline = require('../src/core/timeline');

const near = (actual, expected, tolerance = 1e-5, label = '') => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} expected ${expected}, got ${actual} (diff: ${Math.abs(actual - expected)})`
  );
};

let passed = 0;
const test = (name, body) => {
  body();
  passed += 1;
  console.log(`  ok  ${name}`);
};

console.log('Running timeline-video-bg.test.js...');

// ============================================================================
// 1. 片段移动与重排序 (reorderSegments & moveSegment)
// ============================================================================

test('reorderSegments: 正确调整片段位置并保持不可变性', () => {
  const segA = { id: 'A', sourceStart: 0, sourceEnd: 10, speed: 1 };
  const segB = { id: 'B', sourceStart: 10, sourceEnd: 15, speed: 1 };
  const segC = { id: 'C', sourceStart: 15, sourceEnd: 25, speed: 1 };
  const original = [segA, segB, segC];

  // 将 index 0 (A) 移动到末尾 index 2 -> [B, C, A]
  const reordered = timeline.reorderSegments(original, 0, 2);
  assert.deepEqual(reordered.map((s) => s.id), ['B', 'C', 'A']);
  // 原数组不应被修改
  assert.deepEqual(original.map((s) => s.id), ['A', 'B', 'C']);

  // 将 index 2 (A) 移回 index 0 -> [A, B, C]
  const restored = timeline.reorderSegments(reordered, 2, 0);
  assert.deepEqual(restored.map((s) => s.id), ['A', 'B', 'C']);

  // 相同位置不变
  const unchanged = timeline.reorderSegments(original, 1, 1);
  assert.deepEqual(unchanged.map((s) => s.id), ['A', 'B', 'C']);

  // 边界保护：越界索引
  const outOfBounds = timeline.reorderSegments(original, -1, 2);
  assert.deepEqual(outOfBounds.map((s) => s.id), ['A', 'B', 'C']);
});

test('moveSegment: 根据 ID 移动片段，支持从 [A, B, C] 变为 [B, C, A]', () => {
  const segA = { id: 'A', sourceStart: 0, sourceEnd: 10, speed: 1 };
  const segB = { id: 'B', sourceStart: 10, sourceEnd: 15, speed: 1 };
  const segC = { id: 'C', sourceStart: 15, sourceEnd: 25, speed: 1 };
  const segments = [segA, segB, segC];

  // 移动片段 A 到 index 2
  const reordered = timeline.moveSegment(segments, 'A', 2);
  assert.deepEqual(reordered.map((s) => s.id), ['B', 'C', 'A']);

  // 移动片段 C 到 index 0 -> [C, B, A]
  const movedC = timeline.moveSegment(reordered, 'C', 0);
  assert.deepEqual(movedC.map((s) => s.id), ['C', 'B', 'A']);

  // ID 不存在时安全返回原数组浅拷贝
  const notFound = timeline.moveSegment(segments, 'NON_EXISTENT', 1);
  assert.deepEqual(notFound.map((s) => s.id), ['A', 'B', 'C']);
});

// ============================================================================
// 2. 非单调重排序序列下的 locate 与 sourceToOutput
// ============================================================================

test('locate: 严格按照重排序后的序列 [B, C, A] 顺序定位输出时间', () => {
  // A: 0-10 (时长 10)
  // B: 10-15 (时长 5)
  // C: 15-25 (倍速 2，输出时长 5)
  const segA = { id: 'A', sourceStart: 0, sourceEnd: 10, speed: 1 };
  const segB = { id: 'B', sourceStart: 10, sourceEnd: 15, speed: 1 };
  const segC = { id: 'C', sourceStart: 15, sourceEnd: 25, speed: 2 };

  // 重排序为 [B, C, A]：
  // [0..5] 为 B
  // [5..10] 为 C
  // [10..20] 为 A
  const reordered = [segB, segC, segA];
  near(timeline.outputDuration(reordered), 20);

  // 落在 B 内 (输出时间 2)
  const hitB = timeline.locate(reordered, 2);
  assert.equal(hitB.index, 0);
  assert.equal(hitB.segment.id, 'B');
  near(hitB.outputStart, 0);
  near(hitB.sourceTime, 12); // 10 + 2 * 1

  // 落在 C 内 (输出时间 7.5)
  const hitC = timeline.locate(reordered, 7.5);
  assert.equal(hitC.index, 1);
  assert.equal(hitC.segment.id, 'C');
  near(hitC.outputStart, 5);
  near(hitC.sourceTime, 20); // 15 + (7.5 - 5) * 2 = 15 + 5 = 20

  // 落在 A 内 (输出时间 14)
  const hitA = timeline.locate(reordered, 14);
  assert.equal(hitA.index, 2);
  assert.equal(hitA.segment.id, 'A');
  near(hitA.outputStart, 10);
  near(hitA.sourceTime, 4); // 0 + (14 - 10) * 1 = 4

  // 超出末尾停在最后一帧 (片段 A 结尾 sourceTime 10)
  const hitEnd = timeline.locate(reordered, 99);
  assert.equal(hitEnd.index, 2);
  assert.equal(hitEnd.segment.id, 'A');
  near(hitEnd.sourceTime, 10);
});

test('sourceToOutput: 在非单调序列 [B, C, A] 中正确映射各片段素材时间', () => {
  const segA = { id: 'A', sourceStart: 0, sourceEnd: 10, speed: 1 };
  const segB = { id: 'B', sourceStart: 10, sourceEnd: 15, speed: 1 };
  const segC = { id: 'C', sourceStart: 15, sourceEnd: 25, speed: 2 };
  const reordered = [segB, segC, segA];

  // 素材时间 12 属于 B -> 输出时间 0 + (12 - 10) = 2
  near(timeline.sourceToOutput(reordered, 12), 2);

  // 素材时间 19 属于 C -> 输出时间 5 + (19 - 15) / 2 = 7
  near(timeline.sourceToOutput(reordered, 19), 7);

  // 素材时间 4 属于 A -> 输出时间 10 + (4 - 0) = 14
  near(timeline.sourceToOutput(reordered, 4), 14);

  // 素材时间 0 属于 A 起点 -> 输出时间 10
  near(timeline.sourceToOutput(reordered, 0), 10);

  // 素材时间 10 属于 A 末尾或 B 起点：找到首个匹配项 (当前序列首段为 B，包含 10) -> 输出时间 0
  near(timeline.sourceToOutput(reordered, 10), 0);
});

// ============================================================================
// 3. 重排序输出时间偏移量 (reorderedOutputOffset)
// ============================================================================

test('reorderedOutputOffset: 计算各片段在重排序前后的输出时间差', () => {
  // 原顺序 [A, B, C]
  // A: 0..10 (start: 0)
  // B: 10..15 (start: 10)
  // C: 15..25 (倍速 1，时长 10，start: 15)
  const segA = { id: 'A', sourceStart: 0, sourceEnd: 10, speed: 1 };
  const segB = { id: 'B', sourceStart: 10, sourceEnd: 15, speed: 1 };
  const segC = { id: 'C', sourceStart: 15, sourceEnd: 25, speed: 1 };
  const oldSegments = [segA, segB, segC];

  // 新顺序 [B, C, A]
  // B: 0..5 (start: 0, delta: 0 - 10 = -10)
  // C: 5..15 (start: 5, delta: 5 - 15 = -10)
  // A: 15..25 (start: 15, delta: 15 - 0 = +15)
  const newSegments = [segB, segC, segA];

  // 测试落在 B 中的时间点 (原时间 12)
  const deltaB = timeline.reorderedOutputOffset(12, oldSegments, newSegments);
  near(deltaB, -10);

  // 测试落在 C 中的时间点 (原时间 18)
  const deltaC = timeline.reorderedOutputOffset(18, oldSegments, newSegments);
  near(deltaC, -10);

  // 测试落在 A 中的时间点 (原时间 3)
  const deltaA = timeline.reorderedOutputOffset(3, oldSegments, newSegments);
  near(deltaA, 15);
});

// ============================================================================
// 4. 重排序后 Clip 时间重映射 (remapClipsOnReorder)
// ============================================================================

test('remapClipsOnReorder: 依附在片段 B 上的缩放动画移动至时间线开头', () => {
  const segA = { id: 'A', sourceStart: 0, sourceEnd: 10, speed: 1 };
  const segB = { id: 'B', sourceStart: 10, sourceEnd: 15, speed: 1 };
  const segC = { id: 'C', sourceStart: 15, sourceEnd: 25, speed: 1 };
  const oldSegments = [segA, segB, segC];
  const newSegments = [segB, segC, segA]; // [B, C, A]

  // 原时间线中的缩放动画：
  // zoomA: 落在 A 中 (2..6)
  // zoomB: 落在 B 中 (11..14)
  const zoomA = { id: 'zoom_A', startTime: 2, endTime: 6, scale: 1.5 };
  const zoomB = { id: 'zoom_B', startTime: 11, endTime: 14, scale: 2.0 };
  const clips = [zoomA, zoomB];

  const remapped = timeline.remapClipsOnReorder(clips, oldSegments, newSegments);
  assert.equal(remapped.length, 2);

  // 排序后首个动画应为 zoomB（因为 B 移到了开头 [0..5]）
  const first = remapped[0];
  assert.equal(first.id, 'zoom_B');
  // zoomB 原在 11..14 (B 中偏移 1s..4s)，现在 B 在 0..5，应变为 1..4
  near(first.startTime, 1);
  near(first.endTime, 4);
  near(first.endTime - first.startTime, 3); // 时长保持 3 秒

  // 第二个动画为 zoomA（A 移到了末尾 [15..25]）
  const second = remapped[1];
  assert.equal(second.id, 'zoom_A');
  // zoomA 原在 2..6 (A 中偏移 2s..6s)，现在 A 在 15..25，应变为 17..21
  near(second.startTime, 17);
  near(second.endTime, 21);
  near(second.endTime - second.startTime, 4); // 时长保持 4 秒
});

test('remapClipsOnReorder: 支持自定义 timeKey（如 marker 或 timing 结构）', () => {
  const segA = { id: 'A', sourceStart: 0, sourceEnd: 10, speed: 1 };
  const segB = { id: 'B', sourceStart: 10, sourceEnd: 15, speed: 1 };
  const oldSegments = [segA, segB];
  const newSegments = [segB, segA]; // B: 0..5 (delta -10), A: 5..15 (delta +5)

  // 带有 time 字段的标记
  const markers = [
    { id: 'm_a', time: 4, label: 'A点' },
    { id: 'm_b', time: 12, label: 'B点' },
  ];
  const remappedMarkers = timeline.remapClipsOnReorder(markers, oldSegments, newSegments, 'time');
  assert.equal(remappedMarkers[0].id, 'm_b');
  near(remappedMarkers[0].time, 2); // 12 - 10 = 2
  assert.equal(remappedMarkers[1].id, 'm_a');
  near(remappedMarkers[1].time, 9); // 4 + 5 = 9

  // 带有 timing 结构的贴图/运镜对象
  const motions = [
    { id: 'mot_b', timing: { startTime: 10.5, duration: 3 } },
  ];
  const remappedMotions = timeline.remapClipsOnReorder(motions, oldSegments, newSegments);
  near(remappedMotions[0].timing.startTime, 0.5);
  near(remappedMotions[0].timing.duration, 3);
});

// ============================================================================
// 5. 视频背景模型支持与求值 (video background in model.js)
// ============================================================================

test('Video background: 模型合法性验证与规范化', () => {
  const videoBg = { kind: 'video', file: 'assets/ambient-loop.mp4', isLooping: true };
  assert.ok(model.isValidBackground(videoBg));

  // 省略 isLooping 时自动补齐为 true
  const normalized = model.normalizeBackground({ kind: 'video', file: 'assets/clip.mov' });
  assert.equal(normalized.kind, 'video');
  assert.equal(normalized.file, 'assets/clip.mov');
  assert.equal(normalized.isLooping, true);

  // 明确 isLooping: false 时保留 false
  const noLoop = model.normalizeBackground({ kind: 'video', file: 'assets/clip.mov', isLooping: false });
  assert.equal(noLoop.isLooping, false);

  // 无效对象验证
  assert.equal(model.isValidBackground({ kind: 'video', file: '' }), false);
  assert.equal(model.isValidBackground({ kind: 'video' }), false);
  assert.equal(model.isValidBackground(null), false);
});

test('Video background: normalizeProject 保留并规范化视频背景', () => {
  const rawProject = {
    canvas: {
      background: { kind: 'video', file: 'background.mp4' },
    },
    media: { screen: { duration: 30 } },
  };
  const normalizedProj = model.normalizeProject(rawProject);
  assert.equal(normalizedProj.canvas.background.kind, 'video');
  assert.equal(normalizedProj.canvas.background.file, 'background.mp4');
  assert.equal(normalizedProj.canvas.background.isLooping, true);
});

test('Video background: evaluateBackground 正确求值视频时间与循环逻辑', () => {
  const canvas = {
    background: { kind: 'video', file: 'loop.mp4', isLooping: true },
    backgroundBlur: 15,
  };

  // 循环背景：视频素材时长 4 秒，时间到达 9 秒时应循环取 1 秒 (9 % 4 = 1)
  const evaluatedLoop = model.evaluateBackground(canvas, 9, { videoDuration: 4 });
  assert.equal(evaluatedLoop.kind, 'video');
  assert.equal(evaluatedLoop.file, 'loop.mp4');
  assert.equal(evaluatedLoop.isLooping, true);
  near(evaluatedLoop.time, 1);
  near(evaluatedLoop.blur, 15);

  // 非循环背景：视频素材时长 4 秒，时间到达 9 秒时应停在 4 秒末尾
  const canvasNoLoop = {
    background: { kind: 'video', file: 'once.mp4', isLooping: false },
  };
  const evaluatedNoLoop = model.evaluateBackground(canvasNoLoop, 9, { videoDuration: 4 });
  assert.equal(evaluatedNoLoop.isLooping, false);
  near(evaluatedNoLoop.time, 4);

  // 其它背景类型（图案与图片）求值兼容
  const evaluatedPattern = model.evaluateBackground({ background: { kind: 'pattern', preset: 'obsidianGrid' } });
  assert.equal(evaluatedPattern.kind, 'pattern');
  assert.equal(evaluatedPattern.preset, 'obsidianGrid');
});

console.log(`\n${passed} 项测试全部通过`);
