'use strict';
// 音频波形分析与绘制：从音频文件提取归一化峰值并使用 Canvas 绘制平滑波形条。
// 对齐 macOS 版 MediaAnalysis.swift#234 与 EditorTimelineWaveformCache.swift。

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const NOISE_FLOOR = 0.012;
const DEFAULT_CURVE = 0.95;
const DEFAULT_SAMPLE_COUNT = 2000;

// 正在进行中的提取任务，避免同一音频文件被多次并发重复解析。
const activeExtractions = new Map();

/**
 * 归一化单个振幅峰值（对齐 MediaAnalysis.swift:163-171）。
 * 低于噪声底限 (0.012) 视为绝对静音（返回 0），UI 不制造虚假绿色底条；
 * 高于噪声底限经曲率 0.95 提升，兼顾人耳感知的动态范围。
 */
function normalizeSample(rawPeak, options = {}) {
  const noiseFloor = options.noiseFloor !== undefined ? options.noiseFloor : NOISE_FLOOR;
  const curve = options.curve !== undefined ? options.curve : DEFAULT_CURVE;
  if (!Number.isFinite(rawPeak) || rawPeak <= noiseFloor) return 0;
  const elevated = (rawPeak - noiseFloor) / (1.0 - noiseFloor);
  const curved = Math.pow(Math.max(elevated, 0), curve);
  return Math.min(Math.max(curved, 0), 1);
}

/**
 * 探测可用的 ffmpeg 可执行文件路径。
 */
function resolveFfmpegBinary() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  const workspaceBin = path.resolve(__dirname, '../../../../bin/ffmpeg.exe');
  if (fs.existsSync(workspaceBin)) return workspaceBin;
  return 'ffmpeg';
}

/**
 * 重采样波形数组到目标 bucket 数量。
 */
function resampleWaveform(samples, targetCount) {
  const count = Math.max(Math.floor(targetCount), 1);
  if (!samples || !samples.length) {
    return new Array(count).fill(0);
  }
  if (samples.length === count) {
    return samples.slice();
  }
  const result = new Array(count);
  const srcLen = samples.length;
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * srcLen) / count);
    const end = Math.max(Math.floor(((i + 1) * srcLen) / count), start + 1);
    let peak = 0;
    for (let j = start; j < end && j < srcLen; j++) {
      const val = samples[j];
      if (val > peak) peak = val;
    }
    result[i] = peak;
  }
  return result;
}

/**
 * 从 PCM 数据（Buffer、Int16Array、Float32Array 或 number[]）中提取 bucket 峰值 / RMS。
 */
function extractWaveformFromPCM(pcmData, sampleCount = DEFAULT_SAMPLE_COUNT, options = {}) {
  const count = Math.max(Math.floor(sampleCount), 1);
  if (!pcmData) return new Array(count).fill(0);

  const method = options.method || 'peak'; // 'peak' | 'rms'
  const isBuffer = Buffer.isBuffer(pcmData);
  const isFloat32 = pcmData instanceof Float32Array;
  const isInt16 = pcmData instanceof Int16Array;
  const isArray = Array.isArray(pcmData);

  let length = 0;
  if (isBuffer) {
    length = Math.floor(pcmData.length / 2); // 16-bit PCM: 2 bytes per sample
  } else if (isFloat32 || isInt16 || isArray) {
    length = pcmData.length;
  } else {
    return new Array(count).fill(0);
  }

  if (length === 0) {
    return new Array(count).fill(0);
  }

  // 辅助函数：读取指定索引的绝对振幅 [0, 1]
  const readMagnitude = (index) => {
    if (isBuffer) {
      return Math.abs(pcmData.readInt16LE(index * 2)) / 32768.0;
    }
    if (isInt16) {
      return Math.abs(pcmData[index]) / 32768.0;
    }
    if (isFloat32 || isArray) {
      return Math.abs(pcmData[index]);
    }
    return 0;
  };

  const rawValues = new Array(count);
  let globalMax = 0;

  if (length <= count) {
    // 样本数少于目标 bucket 数，直接线性映射
    for (let i = 0; i < count; i++) {
      const idx = Math.min(Math.floor((i / count) * length), length - 1);
      const mag = readMagnitude(idx);
      rawValues[i] = mag;
      if (mag > globalMax) globalMax = mag;
    }
  } else {
    // 样本数大于目标 bucket 数，每个 bucket 计算峰值或 RMS
    for (let i = 0; i < count; i++) {
      const start = Math.floor((i * length) / count);
      const end = Math.max(Math.floor(((i + 1) * length) / count), start + 1);
      if (method === 'rms') {
        let sumSq = 0;
        let c = 0;
        for (let j = start; j < end && j < length; j++) {
          const mag = readMagnitude(j);
          sumSq += mag * mag;
          c++;
        }
        const rms = c > 0 ? Math.sqrt(sumSq / c) : 0;
        rawValues[i] = rms;
        if (rms > globalMax) globalMax = rms;
      } else {
        let peak = 0;
        for (let j = start; j < end && j < length; j++) {
          const mag = readMagnitude(j);
          if (mag > peak) peak = mag;
        }
        rawValues[i] = peak;
        if (peak > globalMax) globalMax = peak;
      }
    }
  }

  // 轨道整体自动增益归一化（可选，默认保持绝对振幅）
  const scale = (options.normalize && globalMax > 0) ? (1.0 / globalMax) : 1.0;

  // 应用 MediaAnalysis 归一化曲线
  const normalized = new Array(count);
  for (let i = 0; i < count; i++) {
    const scaled = Math.min(rawValues[i] * scale, 1.0);
    normalized[i] = normalizeSample(scaled, options);
  }

  return normalized;
}

/**
 * 通过 child_process 运行 ffmpeg 导出单声道 s16le PCM 数据流。
 */
function dumpPCMWithFfmpeg(audioFilePath) {
  return new Promise((resolve) => {
    const binary = resolveFfmpegBinary();
    const args = [
      '-hide_banner',
      '-nostdin',
      '-i', audioFilePath,
      '-vn',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      '-f', 's16le',
      'pipe:1',
    ];

    let child;
    try {
      child = spawn(binary, args, { windowsHide: true });
    } catch {
      return resolve(null);
    }

    const chunks = [];
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });
    child.on('error', () => {
      resolve(null);
    });
    child.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) {
        resolve(null);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

/**
 * 浏览器 / Electron 渲染进程中通过 Web AudioContext.decodeAudioData 解码音频。
 */
async function decodeAudioWithContext(audioFilePath) {
  const AudioCtx = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) ||
    (typeof AudioContext !== 'undefined' && AudioContext);
  if (!AudioCtx) return null;

  try {
    const fileBuffer = await fs.promises.readFile(audioFilePath);
    const ctx = new AudioCtx();
    try {
      const arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      if (!audioBuffer || audioBuffer.length === 0) return null;

      const numChannels = audioBuffer.numberOfChannels;
      const length = audioBuffer.length;
      if (numChannels === 1) {
        return audioBuffer.getChannelData(0);
      }

      // 多声道合并取最大振幅
      const mixed = new Float32Array(length);
      const channels = [];
      for (let c = 0; c < numChannels; c++) {
        channels.push(audioBuffer.getChannelData(c));
      }
      for (let i = 0; i < length; i++) {
        let maxVal = 0;
        for (let c = 0; c < numChannels; c++) {
          const val = Math.abs(channels[c][i]);
          if (val > maxVal) maxVal = val;
        }
        mixed[i] = maxVal;
      }
      return mixed;
    } finally {
      if (ctx.state !== 'closed' && typeof ctx.close === 'function') {
        ctx.close().catch(() => {});
      }
    }
  } catch {
    return null;
  }
}

/**
 * 缓存文件路径生成。
 */
function resolveWaveformCachePath(audioFilePath) {
  return `${audioFilePath}.waveform.json`;
}

/**
 * 提取音频波形数据。
 * @param {string} audioFilePath 音频或视频文件路径
 * @param {number} [sampleCount=2000] bucket 数量
 * @param {object} [options] 额外选项（forceRefresh, method, normalize, noiseFloor, curve）
 * @returns {Promise<number[]>} 长度为 sampleCount 的归一化浮点数组 [0.0 ~ 1.0]
 */
async function extractWaveform(audioFilePath, sampleCount = DEFAULT_SAMPLE_COUNT, options = {}) {
  const count = Math.max(Math.floor(sampleCount) || DEFAULT_SAMPLE_COUNT, 1);
  if (!audioFilePath || typeof audioFilePath !== 'string') {
    return new Array(count).fill(0);
  }

  const cachePath = resolveWaveformCachePath(audioFilePath);
  const forceRefresh = Boolean(options && options.forceRefresh);

  // 1. 尝试从缓存读取
  if (!forceRefresh) {
    try {
      const raw = await fs.promises.readFile(cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      const cachedSamples = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.samples) ? parsed.samples : null);
      if (cachedSamples && cachedSamples.length > 0) {
        return resampleWaveform(cachedSamples, count);
      }
    } catch {
      // 缓存不存在或损坏，继续实际提取
    }
  }

  // 2. 检查源文件是否存在（优雅处理不存在的文件，非阻塞，直接返回静音）
  try {
    await fs.promises.access(audioFilePath, fs.constants.R_OK);
  } catch {
    return new Array(count).fill(0);
  }

  // 3. 避免同一文件并发重复解码
  const taskKey = `${path.resolve(audioFilePath)}:${count}`;
  if (activeExtractions.has(taskKey)) {
    return activeExtractions.get(taskKey);
  }

  const extractionPromise = (async () => {
    let pcm = null;

    // 优先尝试 ffmpeg dump PCM（高效、不占主线程渲染、支持所有视频容器）
    try {
      pcm = await dumpPCMWithFfmpeg(audioFilePath);
    } catch {
      pcm = null;
    }

    // 若 ffmpeg 不可用或返回空，尝试 AudioContext 解码
    if (!pcm) {
      try {
        pcm = await decodeAudioWithContext(audioFilePath);
      } catch {
        pcm = null;
      }
    }

    // 若仍无法获取音频数据（如无声视频或静音），返回静音
    if (!pcm) {
      const silence = new Array(count).fill(0);
      try {
        await fs.promises.writeFile(cachePath, JSON.stringify(silence), 'utf8');
      } catch {
        // 忽略写缓存失败
      }
      return silence;
    }

    // 4. 计算归一化波形
    const samples = extractWaveformFromPCM(pcm, count, options);

    // 5. 写入缓存（EditorTimelineWaveformCache 策略：失败不阻断编辑流程）
    try {
      await fs.promises.writeFile(cachePath, JSON.stringify(samples), 'utf8');
    } catch {
      // Disposable acceleration cache: write error ignored
    }

    return samples;
  })();

  activeExtractions.set(taskKey, extractionPromise);
  try {
    return await extractionPromise;
  } finally {
    activeExtractions.delete(taskKey);
  }
}

/**
 * 规范化矩形区域为 { x, y, width, height }
 */
function normalizeRect(rect) {
  if (Array.isArray(rect)) {
    return {
      x: Number(rect[0]) || 0,
      y: Number(rect[1]) || 0,
      width: Math.max(Number(rect[2]) || 0, 0),
      height: Math.max(Number(rect[3]) || 0, 0),
    };
  }
  if (!rect) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: Number(rect.x !== undefined ? rect.x : (rect.left || 0)),
    y: Number(rect.y !== undefined ? rect.y : (rect.top || 0)),
    width: Math.max(Number(rect.width !== undefined ? rect.width : (rect.w || 0)), 0),
    height: Math.max(Number(rect.height !== undefined ? rect.height : (rect.h || 0)), 0),
  };
}

/**
 * 在 Canvas 上绘制平滑波形条。
 * @param {CanvasRenderingContext2D} ctx 绘图上下文
 * @param {number[]} samples 归一化采样值数组 [0.0 ~ 1.0]
 * @param {object|number[]} rect 绘制区域 { x, y, width, height }
 * @param {object} [options] 配置选项
 *        options.color {string} 默认 'rgba(255,255,255,0.4)'
 *        options.mirror {boolean} 默认 true，对称垂直居中
 *        options.barWidth {number} 默认 2
 *        options.gap {number} 默认 1
 *        options.radius {number} 默认 barWidth / 2
 *        options.minBarHeight {number} 默认 0
 *        options.maxBarHeight {number} 默认 null
 *        options.align {'center'|'bottom'|'top'} 默认 mirror ? 'center' : 'center'
 *        options.scale {number} 默认 1.0
 *        options.progress {number} 可选播放进度 [0, 1]
 *        options.activeColor {string} 可选已播放部分的颜色
 */
function drawWaveform(ctx, samples, rect, options = {}) {
  if (!ctx || !samples || !samples.length) return;
  const bounds = normalizeRect(rect);
  if (bounds.width <= 0 || bounds.height <= 0) return;

  const {
    color = 'rgba(255,255,255,0.4)',
    mirror = true,
    barWidth = 2,
    gap = 1,
    minBarHeight = 0,
    maxBarHeight = null,
    scale = 1.0,
    progress = null,
    activeColor = null,
  } = options || {};

  const step = Math.max(barWidth + gap, 1);
  const numBars = Math.max(1, Math.floor((bounds.width + gap) / step));
  const defaultRadius = barWidth / 2;
  const userRadius = options.radius !== undefined ? options.radius : defaultRadius;
  const centerY = bounds.y + bounds.height / 2;
  const align = options.align || (mirror ? 'center' : 'center');

  // 构建各条柱子的几何参数
  const bars = [];
  const srcCount = samples.length;

  for (let i = 0; i < numBars; i++) {
    const barX = bounds.x + i * step;
    if (barX + barWidth > bounds.x + bounds.width + 0.001) break;

    // 将 sample 映射到当前柱子（取对应区间的峰值，保留瞬态细节）
    const startIndex = Math.floor((i * srcCount) / numBars);
    const endIndex = Math.max(Math.floor(((i + 1) * srcCount) / numBars), startIndex + 1);
    let peak = 0;
    for (let s = startIndex; s < endIndex && s < srcCount; s++) {
      if (samples[s] > peak) peak = samples[s];
    }

    const clampedPeak = Math.min(Math.max(peak * scale, 0), 1.0);
    let barHeight = clampedPeak > 0 ? clampedPeak * bounds.height : minBarHeight;
    if (minBarHeight > 0 && barHeight < minBarHeight) {
      barHeight = minBarHeight;
    }
    if (maxBarHeight !== null && barHeight > maxBarHeight) {
      barHeight = maxBarHeight;
    }
    barHeight = Math.min(barHeight, bounds.height);

    if (barHeight <= 0) continue;

    let barY;
    if (mirror) {
      barY = centerY - barHeight / 2;
    } else if (align === 'bottom') {
      barY = bounds.y + bounds.height - barHeight;
    } else if (align === 'top') {
      barY = bounds.y;
    } else {
      barY = centerY - barHeight / 2;
    }

    const r = Math.min(userRadius, barWidth / 2, barHeight / 2);
    bars.push({ x: barX, y: barY, width: barWidth, height: barHeight, radius: r, index: i });
  }

  if (bars.length === 0) return;

  const hasProgress = activeColor && typeof progress === 'number' && Number.isFinite(progress);
  const splitIndex = hasProgress ? Math.floor(numBars * Math.min(Math.max(progress, 0), 1)) : -1;

  // 内部辅助函数：将柱子集合绘制为单次 fill 路径
  const renderBarsGroup = (barsGroup, fillColor) => {
    if (!barsGroup.length) return;
    ctx.save();
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    for (let b = 0; b < barsGroup.length; b++) {
      const { x, y, width, height, radius } = barsGroup[b];
      if (radius > 0 && typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, width, height, radius);
      } else if (radius > 0) {
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.arcTo(x + width, y, x + width, y + radius, radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
        ctx.lineTo(x + radius, y + height);
        ctx.arcTo(x, y + height, x, y + height - radius, radius);
        ctx.lineTo(x, y + radius);
        ctx.arcTo(x, y, x + radius, y, radius);
        ctx.closePath();
      } else {
        ctx.rect(x, y, width, height);
      }
    }
    ctx.fill();
    ctx.restore();
  };

  if (hasProgress) {
    const activeBars = bars.filter((b) => b.index < splitIndex);
    const inactiveBars = bars.filter((b) => b.index >= splitIndex);
    renderBarsGroup(activeBars, activeColor);
    renderBarsGroup(inactiveBars, color);
  } else {
    renderBarsGroup(bars, color);
  }
}

module.exports = {
  extractWaveform,
  drawWaveform,
  extractWaveformFromPCM,
  resampleWaveform,
  normalizeSample,
  resolveWaveformCachePath,
};
