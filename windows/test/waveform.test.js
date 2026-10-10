'use strict';
// 音频波形提取与绘制测试：覆盖提取、重采样、归一化、缓存机制、Canvas 绘制及边界异常。
// 运行：node test/waveform.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const waveform = require('../src/renderer/editor/waveform');
const {
  extractWaveform,
  drawWaveform,
  extractWaveformFromPCM,
  resampleWaveform,
  normalizeSample,
  resolveWaveformCachePath,
} = waveform;

const near = (actual, expected, tolerance = 1e-4, label = '') => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} 期望 ${expected}，实际 ${actual} (偏差 ${Math.abs(actual - expected)})`
  );
};

let passed = 0;
const test = (name, body) => {
  const result = body();
  if (result && typeof result.then === 'function') {
    return result.then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    });
  }
  passed += 1;
  console.log(`  ok  ${name}`);
};

async function runAll() {
  console.log('--- 波形模块功能测试 (waveform.test.js) ---');

  test('模块必须导出核心 API：extractWaveform 与 drawWaveform', () => {
    assert.equal(typeof extractWaveform, 'function', 'extractWaveform 必须为函数');
    assert.equal(typeof drawWaveform, 'function', 'drawWaveform 必须为函数');
    assert.equal(typeof extractWaveformFromPCM, 'function');
    assert.equal(typeof resampleWaveform, 'function');
    assert.equal(typeof normalizeSample, 'function');
    assert.equal(typeof resolveWaveformCachePath, 'function');
  });

  test('归一化算法对齐 MediaAnalysis.swift 噪声底限与感知曲线', () => {
    // 绝对静音 (0) -> 0
    assert.equal(normalizeSample(0), 0);
    // 噪声底限以下 (<= 0.012) -> 必须截断为 0，UI 不制造虚假绿色底条
    assert.equal(normalizeSample(0.005), 0);
    assert.equal(normalizeSample(0.012), 0);
    // 噪声底限以上 -> 经曲率 0.95 提升
    const audible = normalizeSample(0.5);
    near(audible, Math.pow((0.5 - 0.012) / (1.0 - 0.012), 0.95), 1e-6);
    assert.ok(audible > 0.5, '曲率 0.95 应对中间振幅适度抬升');
    // 最大峰值 (1.0) -> 1.0
    near(normalizeSample(1.0), 1.0, 1e-6);
    // 超量程溢出 (> 1.0) -> 截断为 1.0
    assert.equal(normalizeSample(1.5), 1.0);
    // 非数字或 NaN -> 0
    assert.equal(normalizeSample(NaN), 0);
  });

  test('从合成 PCM (Int16Array / Float32Array) 中正确提取峰值与静音', () => {
    const bucketCount = 10;

    // 1. 全静音缓冲区
    const silence = new Float32Array(1000).fill(0);
    const silencePeaks = extractWaveformFromPCM(silence, bucketCount);
    assert.equal(silencePeaks.length, bucketCount);
    assert.ok(silencePeaks.every((val) => val === 0), '全静音音频提取出的每个 bucket 应均为 0');

    // 2. 在第 5 个 bucket 放置一个强峰值 (0.8)
    const impulse = new Float32Array(1000).fill(0);
    // bucket 5 覆盖的范围是 [500, 600)
    impulse[550] = 0.8;
    const impulsePeaks = extractWaveformFromPCM(impulse, bucketCount);
    assert.equal(impulsePeaks.length, bucketCount);
    for (let i = 0; i < bucketCount; i++) {
      if (i === 5) {
        near(impulsePeaks[i], normalizeSample(0.8), 1e-4, '冲激脉冲所在 bucket');
      } else {
        assert.equal(impulsePeaks[i], 0, `静音 bucket ${i} 应为 0`);
      }
    }

    // 3. Int16Array 缓冲区 (16-bit PCM: -32768 ~ +32767)
    const int16Impulse = new Int16Array(1000).fill(0);
    int16Impulse[250] = 32767; // bucket 2: 振幅约 1.0
    const int16Peaks = extractWaveformFromPCM(int16Impulse, bucketCount);
    near(int16Peaks[2], 1.0, 1e-3);
    assert.equal(int16Peaks[0], 0);

    // 4. Node.js Buffer (s16le 编码)
    const buf = Buffer.alloc(2000); // 1000 samples * 2 bytes
    buf.writeInt16LE(16384, 750 * 2); // bucket 7: 振幅约 0.5
    const bufPeaks = extractWaveformFromPCM(buf, bucketCount);
    near(bufPeaks[7], normalizeSample(16384 / 32768), 1e-3);
  });

  test('重采样功能 resampleWaveform 正确映射不同大小的数组', () => {
    const original = [0, 0.5, 1.0, 0];
    const upsampled = resampleWaveform(original, 8);
    assert.equal(upsampled.length, 8);
    // 最大值应保留
    assert.equal(Math.max(...upsampled), 1.0);

    const downsampled = resampleWaveform(original, 2);
    assert.equal(downsampled.length, 2);
    // 前半段最大值为 0.5，后半段为 1.0
    assert.ok(downsampled[0] >= 0.5);
    assert.ok(downsampled[1] >= 1.0);
  });

  test('Canvas 绘制函数 drawWaveform：垂直居中、对称与参数绘制验证', () => {
    // 构造 Mock Canvas Context，用于截获并检查绘图调用
    const calls = [];
    const mockCtx = {
      save() { calls.push(['save']); },
      restore() { calls.push(['restore']); },
      beginPath() { calls.push(['beginPath']); },
      fill() { calls.push(['fill']); },
      roundRect(x, y, w, h, r) { calls.push(['roundRect', { x, y, w, h, r }]); },
      rect(x, y, w, h) { calls.push(['rect', { x, y, w, h }]); },
      moveTo(x, y) { calls.push(['moveTo', { x, y }]); },
      lineTo(x, y) { calls.push(['lineTo', { x, y }]); },
      arcTo() { calls.push(['arcTo']); },
      closePath() { calls.push(['closePath']); },
      fillStyle: '',
    };

    const rect = { x: 10, y: 20, width: 30, height: 40 };
    // 30px 宽，barWidth=2, gap=1 -> step=3 -> 能画 10 根柱子
    const samples = [0, 0.2, 0.5, 0.8, 1.0, 0, 0.1, 0.4, 0.7, 0.9];

    // 1. 对称垂直居中绘制 (mirror: true)
    calls.length = 0;
    drawWaveform(mockCtx, samples, rect, {
      color: '#FFFFFF',
      mirror: true,
      barWidth: 2,
      gap: 1,
    });

    assert.equal(mockCtx.fillStyle, '#FFFFFF');
    const drawnRects = calls.filter((c) => c[0] === 'roundRect').map((c) => c[1]);
    // samples[0] 是 0，静音不绘制；其余非零 samples 应生成对应柱子
    assert.ok(drawnRects.length >= 8);

    // 检查第 4 根柱子 (sample = 1.0，满振幅)：
    // centerY = 20 + 40 / 2 = 40; height = 1.0 * 40 = 40; barY = 40 - 40 / 2 = 20.
    const fullBar = drawnRects.find((b) => Math.abs(b.h - 40) < 0.1);
    assert.ok(fullBar, '满振幅柱子高应等于 rect.height (40)');
    near(fullBar.y, 20, 0.1, '对称居中时满振幅柱子的顶部位置');

    // 检查非满柱子 (sample = 0.5 -> h = 20 -> barY = 40 - 10 = 30)
    const halfBar = drawnRects.find((b) => Math.abs(b.h - 20) < 1);
    assert.ok(halfBar, '半振幅柱子高度应约为 20');
    near(halfBar.y, 30, 1.0, '对称居中时半振幅柱子的 Y 坐标');

    // 2. 非对称底端对齐绘制 (mirror: false, align: 'bottom')
    calls.length = 0;
    drawWaveform(mockCtx, samples, rect, {
      color: '#00FF00',
      mirror: false,
      align: 'bottom',
      barWidth: 2,
      gap: 1,
    });
    const bottomRects = calls.filter((c) => c[0] === 'roundRect').map((c) => c[1]);
    for (const b of bottomRects) {
      // 底部应紧贴 rect.y + rect.height = 60
      near(b.y + b.h, 60, 0.1, '底部对齐时所有柱子的底端');
    }

    // 3. 边界异常：零宽/零高/空样本不报错且不触发绘制
    calls.length = 0;
    drawWaveform(mockCtx, [], rect);
    drawWaveform(mockCtx, samples, { x: 0, y: 0, width: 0, height: 40 });
    drawWaveform(mockCtx, null, rect);
    drawWaveform(null, samples, rect);
    assert.equal(calls.length, 0, '非法输入时不应产生绘制调用');
  });

  test('播放进度 progress 与 activeColor 双色波形绘制', () => {
    const fillColors = [];
    const mockCtx = {
      save() {},
      restore() {},
      beginPath() {},
      fill() { fillColors.push(this.fillStyle); },
      roundRect() {},
      fillStyle: '',
    };
    const rect = { x: 0, y: 0, width: 60, height: 40 };
    const samples = new Array(20).fill(0.8);

    drawWaveform(mockCtx, samples, rect, {
      color: 'rgba(255,255,255,0.4)',
      activeColor: '#3B82F6',
      progress: 0.5,
      barWidth: 2,
      gap: 1,
    });

    assert.equal(fillColors.length, 2, '有进度时应分别绘制已播放与未播放两个批次');
    assert.equal(fillColors[0], '#3B82F6', '第一批应为已播放 activeColor');
    assert.equal(fillColors[1], 'rgba(255,255,255,0.4)', '第二批应为未播放 color');
  });

  await test('不存在的文件被优雅处理，返回全零静音且不抛出异常', async () => {
    const nonExistentPath = path.join(os.tmpdir(), `non-existent-${Date.now()}.m4a`);
    const samples = await extractWaveform(nonExistentPath, 120);
    assert.equal(Array.isArray(samples), true);
    assert.equal(samples.length, 120);
    assert.ok(samples.every((val) => val === 0), '缺失音频文件应优雅返回全零静音');
  });

  await test('真实音频文件提取、波形计算与缓存文件持久化', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsc-waveform-test-'));
    const testAudioPath = path.join(tempDir, 'test-tone.wav');
    const cachePath = resolveWaveformCachePath(testAudioPath);

    try {
      // 1. 使用 ffmpeg 生成一个 2 秒的正弦波测试音频 (440Hz, 振幅 0.8)
      const gen = spawnSync('ffmpeg', [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-f', 'lavfi',
        '-i', 'sine=frequency=440:duration=2',
        '-af', 'volume=0.8',
        testAudioPath,
      ], { windowsHide: true });

      assert.equal(gen.status, 0, 'ffmpeg 测试音频生成');
      assert.ok(fs.existsSync(testAudioPath), '测试音频文件已创建');

      // 2. 第一次提取：从音频文件解析并写入缓存
      assert.ok(!fs.existsSync(cachePath), '初次提取前缓存文件不应存在');
      const sampleCount = 60;
      const samples1 = await extractWaveform(testAudioPath, sampleCount);

      assert.equal(samples1.length, sampleCount, '提取波形长度应等于 sampleCount');
      assert.ok(samples1.some((s) => s > 0), '正弦波测试音频必须包含有效振幅数据');
      assert.ok(samples1.every((s) => s >= 0 && s <= 1.0), '所有采样值必须在 [0.0, 1.0] 范围内');

      // 验证缓存文件已生成且内容正确
      assert.ok(fs.existsSync(cachePath), '缓存文件必须生成在 ${audioFilePath}.waveform.json');
      const cachedContent = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      assert.equal(cachedContent.length, sampleCount);
      near(cachedContent[10], samples1[10], 1e-6, '缓存文件内容与提取结果一致');

      // 3. 第二次提取：应直接从缓存加载
      const samples2 = await extractWaveform(testAudioPath, sampleCount);
      assert.deepEqual(samples2, samples1, '第二次提取应与第一次提取完全一致（从缓存命中）');

      // 4. 重采样请求：如果以不同 sampleCount 请求已有缓存，应通过缓存重采样返回
      const samplesResampled = await extractWaveform(testAudioPath, 30);
      assert.equal(samplesResampled.length, 30, '重采样后的采样点数量');
      assert.ok(samplesResampled.some((s) => s > 0));
    } finally {
      // 清理临时文件
      try {
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
        if (fs.existsSync(testAudioPath)) fs.unlinkSync(testAudioPath);
        fs.rmdirSync(tempDir);
      } catch {
        // ignore cleanup error
      }
    }
  });

  console.log(`\n全部 ${passed} 项测试用例全部通过！`);
}

runAll().catch((error) => {
  console.error('测试失败：', error);
  process.exit(1);
});
