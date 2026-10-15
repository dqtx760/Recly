'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SPECIAL_TOKEN = /^\[_[^\]]+_\]$/;

function resolveWhisperPaths({ resourcesPath = null, moduleDirectory = __dirname, env = process.env } = {}) {
  const runtimeDirectory = resourcesPath
    ? path.join(resourcesPath, 'whisper')
    : path.join(moduleDirectory, '..', '..', 'runtime', 'whisper');
  const configuredExecutable = env.RECLY_WHISPER_EXE;
  const configuredModel = env.RECLY_WHISPER_MODEL;
  const executableCandidates = configuredExecutable
    ? [path.resolve(configuredExecutable)]
    : [
      path.join(runtimeDirectory, 'Release', 'whisper-cli.exe'),
      path.join(runtimeDirectory, 'Release', 'main.exe'),
    ];
  const executable = executableCandidates.find((candidate) => fs.existsSync(candidate)) || executableCandidates[0];
  const model = configuredModel ? path.resolve(configuredModel) : path.join(runtimeDirectory, 'ggml-small.bin');
  return { executable, model };
}

function parseTimestampMs(value) {
  if (Number.isFinite(value)) return Number(value);
  if (typeof value !== 'string') return NaN;
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value);
  if (!match) return NaN;
  return ((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000) + Number(match[4]);
}

function tokenMilliseconds(token, edge) {
  const direct = token && token.offsets && token.offsets[edge];
  if (Number.isFinite(direct)) return Number(direct);
  return parseTimestampMs(token && token.timestamps && token.timestamps[edge]);
}

function parseWhisperJson(document, { sourceStart, sourceEnd = screenDuration, screenDuration }) {
  const segments = Array.isArray(document) ? document : document && document.transcription;
  if (!Array.isArray(segments)) throw new Error('whisper.cpp JSON 缺少 transcription 数组。');
  const cues = [];
  for (const segment of segments) {
    const words = [];
    for (const token of segment.tokens || []) {
      const text = typeof token.text === 'string' ? token.text : '';
      if (!text || SPECIAL_TOKEN.test(text)) continue;
      const from = tokenMilliseconds(token, 'from');
      const to = tokenMilliseconds(token, 'to');
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const start = Math.max(0, sourceStart + from / 1000);
      const end = Math.min(screenDuration, sourceEnd, sourceStart + to / 1000);
      if (end - start < 0.001) continue;
      words.push({ start, end, text });
    }
    let text = words.map((word) => word.text).join('').trim();
    if (!text) {
      const fallback = String(segment.text || '').trim();
      const offsetFrom = segment.offsets && parseTimestampMs(segment.offsets.from);
      const offsetTo = segment.offsets && parseTimestampMs(segment.offsets.to);
      const from = Number.isFinite(offsetFrom) ? offsetFrom : parseTimestampMs(segment.timestamps && segment.timestamps.from);
      const to = Number.isFinite(offsetTo) ? offsetTo : parseTimestampMs(segment.timestamps && segment.timestamps.to);
      if (!fallback || !Number.isFinite(from) || !Number.isFinite(to)) continue;
      const start = Math.max(0, sourceStart + from / 1000);
      const end = Math.min(screenDuration, sourceEnd, sourceStart + to / 1000);
      if (end - start < 0.001) continue;
      cues.push({ id: crypto.randomUUID(), start, end, text: fallback, originalText: fallback, alignment: 'valid', words: [] });
      continue;
    }
    cues.push({
      id: crypto.randomUUID(),
      start: words[0].start,
      end: words[words.length - 1].end,
      text,
      originalText: text,
      alignment: 'valid',
      words,
    });
  }
  return cues;
}

function retainedSourceRanges(project, scope) {
  const duration = Number(project?.media?.screen?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('工程没有有效的录屏时长。');
  if (scope === 'source') return [{ sourceStart: 0, sourceEnd: duration }];
  if (scope !== 'retained') throw new Error('scope 必须是 retained 或 source。');
  const segments = project.timeline && Array.isArray(project.timeline.segments) ? project.timeline.segments : [];
  const ranges = segments.map((segment) => ({
    sourceStart: Math.max(0, Number(segment.sourceStart)),
    sourceEnd: Math.min(duration, Number(segment.sourceEnd)),
  })).filter((range) => Number.isFinite(range.sourceStart) && Number.isFinite(range.sourceEnd) && range.sourceEnd > range.sourceStart);
  ranges.sort((left, right) => left.sourceStart - right.sourceStart || left.sourceEnd - right.sourceEnd);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.sourceStart <= last.sourceEnd + 1e-6) last.sourceEnd = Math.max(last.sourceEnd, range.sourceEnd);
    else merged.push({ ...range });
  }
  return merged;
}

function audioRangesForTrack(project, trackName, scope, trackDuration) {
  const source = project?.media?.[trackName];
  if (!source) throw new Error(`工程没有${trackName === 'microphone' ? '麦克风' : '系统声音'}音轨。`);
  const offset = Number(source.offset) || 0;
  const screenDuration = Number(project.media.screen.duration);
  const ranges = retainedSourceRanges(project, scope);
  return ranges.map((range) => {
    const audioStart = Math.max(0, range.sourceStart - offset);
    const audioEnd = Math.min(trackDuration, screenDuration - offset, range.sourceEnd - offset);
    return { audioStart, duration: audioEnd - audioStart, sourceStart: audioStart + offset };
  }).filter((range) => range.duration > 0.01);
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveProjectFile(directory, relativeFile) {
  if (typeof relativeFile !== 'string' || !relativeFile) throw new Error('工程缺少音视频素材路径。');
  const root = fs.realpathSync(directory);
  const candidate = path.resolve(root, relativeFile);
  const actual = fs.realpathSync(candidate);
  if (!isWithin(root, actual) || !fs.statSync(actual).isFile()) throw new Error('素材路径超出了工程目录。');
  return actual;
}

class TranscriptionManager {
  constructor({ media, resourcesPath = null, userDataPath, tempDirectory, env = process.env } = {}) {
    this.media = media;
    this.resourcesPath = resourcesPath;
    this.userDataPath = userDataPath || process.env.TEMP || process.env.TMP || process.cwd();
    this.tempDirectory = tempDirectory || path.join(this.userDataPath, 'whisper-jobs');
    this.env = env;
    this.paths = resolveWhisperPaths({ resourcesPath, env });
    this.ffmpeg = media.resolveBinaries(resourcesPath).ffmpeg;
    this.jobs = new Map();
    this.queue = [];
    this.activeJob = null;
    this.running = false;
    this.stopping = false;
    this.drainPromise = null;
  }

  environment() {
    const executableReady = fs.existsSync(this.paths.executable);
    const modelReady = fs.existsSync(this.paths.model);
    let reason = null;
    if (!executableReady) reason = '找不到 whisper.cpp 可执行文件。';
    else if (!modelReady) reason = '找不到 ggml-small.bin 多语言模型。';
    return { ready: executableReady && modelReady, executable: this.paths.executable, model: this.paths.model, reason };
  }

  async generate({ directory, project, track, scope }) {
    if (this.stopping) throw Object.assign(new Error('语音识别服务正在关闭。'), { code: 'SERVICE_STOPPED' });
    if (!['microphone', 'systemAudio'].includes(track)) throw Object.assign(new Error('track 必须是 microphone 或 systemAudio。'), { code: 'INVALID_PARAMS' });
    if (!['retained', 'source'].includes(scope)) throw Object.assign(new Error('scope 必须是 retained 或 source。'), { code: 'INVALID_PARAMS' });
    const environment = this.environment();
    if (!environment.ready) throw Object.assign(new Error(environment.reason), { code: 'ASR_UNAVAILABLE' });
    const projectDirectory = fs.realpathSync(directory);
    const trackInfo = project?.media?.[track];
    if (!project?.media?.screen || !trackInfo) throw Object.assign(new Error('工程缺少录屏或所选音轨。'), { code: 'TRACK_NOT_FOUND' });
    const audioFile = resolveProjectFile(projectDirectory, trackInfo.file);
    const jobId = crypto.randomUUID();
    const job = {
      jobId,
      directory: projectDirectory,
      status: 'queued',
      progress: 0,
      result: null,
      error: null,
      backend: null,
      project,
      track,
      scope,
      audioFile,
      child: null,
      cancelled: false,
      workDirectory: null,
      tempFiles: [],
    };
    this.jobs.set(jobId, job);
    this.queue.push(job);
    this.startDrain();
    return { jobId };
  }

  get(jobId, directory) {
    const job = this.jobs.get(jobId);
    if (!job || (directory && path.resolve(job.directory).toLowerCase() !== path.resolve(directory).toLowerCase())) return null;
    return {
      jobId: job.jobId,
      status: job.status,
      progress: job.progress / 100,
      result: job.result,
      error: job.error,
      backend: job.backend,
    };
  }

  cancel(jobId, directory) {
    const job = this.jobs.get(jobId);
    if (!job || (directory && path.resolve(job.directory).toLowerCase() !== path.resolve(directory).toLowerCase())) return { cancelled: false, reason: 'not_found' };
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return { cancelled: false, status: job.status };
    job.cancelled = true;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.error = { code: 'CANCELLED', message: '任务已取消。' };
      this.queue = this.queue.filter((item) => item !== job);
    } else if (job.child && !job.child.killed) {
      job.child.kill();
    }
    return { cancelled: true, jobId };
  }

  startDrain() {
    if (this.running || this.stopping) return;
    this.running = true;
    this.drainPromise = (async () => {
      while (!this.stopping && this.queue.length) {
        const job = this.queue.shift();
        if (job.cancelled) continue;
        this.activeJob = job;
        await this.runJob(job);
        this.activeJob = null;
      }
    })().finally(() => {
      this.running = false;
      this.drainPromise = null;
      if (this.queue.length && !this.stopping) this.startDrain();
    });
  }

  async runJob(job) {
    if (job.cancelled) return;
    job.status = 'running';
    try {
      await fs.promises.mkdir(this.tempDirectory, { recursive: true });
      const workDirectory = fs.mkdtempSync(path.join(this.tempDirectory, 'recly-whisper-'));
      job.workDirectory = workDirectory;
      const modelLink = path.join(workDirectory, 'model.bin');
      job.tempFiles.push(modelLink);
      await this.ensureCachedModel(modelLink);

      const audioTrack = job.project.media[job.track];
      const trackDuration = Number(audioTrack.duration) > 0
        ? Number(audioTrack.duration)
        : (await this.media.probe(job.audioFile)).duration;
      const ranges = audioRangesForTrack(job.project, job.track, job.scope, trackDuration);
      if (!ranges.length) throw Object.assign(new Error('所选音轨与录屏范围没有重叠的音频。'), { code: 'NO_AUDIO_RANGE' });
      const cues = [];
      let totalDuration = ranges.reduce((sum, range) => sum + range.duration, 0);
      let elapsedDuration = 0;
      for (let index = 0; index < ranges.length; index++) {
        this.throwIfCancelled(job);
        const range = ranges[index];
        const wavName = `audio-${String(index + 1).padStart(4, '0')}.wav`;
        const resultName = `result-${String(index + 1).padStart(4, '0')}`;
        const wavPath = path.join(workDirectory, wavName);
        const jsonPath = path.join(workDirectory, `${resultName}.json`);
        job.tempFiles.push(wavPath, jsonPath);
        const inputProgressBase = elapsedDuration / totalDuration;
        await this.runProcess(job, this.ffmpeg, [
          '-hide_banner', '-nostdin', '-y', '-ss', range.audioStart.toFixed(3), '-i', job.audioFile,
          '-t', range.duration.toFixed(3), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
          '-progress', 'pipe:1', '-nostats', wavName,
        ], {
          cwd: workDirectory,
          progressDuration: range.duration,
          progress: (fraction) => { job.progress = Math.min(45, 5 + 40 * (inputProgressBase + fraction * range.duration / totalDuration)); },
        });
        this.throwIfCancelled(job);
        const stderr = await this.runProcess(job, this.paths.executable, [
          '-m', 'model.bin', '-f', wavName, '-l', 'zh', '-ojf', '-of', resultName, '-pp',
        ], {
          cwd: workDirectory,
          progress: (fraction) => { job.progress = Math.min(95, 45 + 50 * ((index + fraction) / ranges.length)); },
        });
        if (/using CUDA\d* backend/i.test(stderr) || (/CUDA\d+ total size\s*=\s*\S+/i.test(stderr) && /found GPU device/i.test(stderr))) job.backend = 'cuda';
        else if (!job.backend) job.backend = 'cpu';
        const document = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        cues.push(...parseWhisperJson(document, {
          sourceStart: range.sourceStart,
          sourceEnd: range.sourceStart + range.duration,
          screenDuration: Number(job.project.media.screen.duration),
        }));
        elapsedDuration += range.duration;
        job.progress = Math.min(95, 45 + 50 * elapsedDuration / totalDuration);
      }
      this.throwIfCancelled(job);
      cues.sort((left, right) => left.start - right.start || left.end - right.end);
      job.result = { cues, backend: job.backend || 'cpu' };
      job.status = 'completed';
      job.progress = 100;
    } catch (error) {
      if (job.cancelled || error.code === 'CANCELLED') {
        job.status = 'cancelled';
        job.error = { code: 'CANCELLED', message: '任务已取消。' };
      } else {
        job.status = 'failed';
        job.error = { code: error.code || 'ASR_FAILED', message: String(error.message || error).slice(0, 1000) };
      }
    } finally {
      job.child = null;
      this.cleanWorkDirectory(job.workDirectory, job.tempFiles);
      job.tempFiles = [];
      job.workDirectory = null;
    }
  }

  async ensureCachedModel(modelLink) {
    await fs.promises.mkdir(this.tempDirectory, { recursive: true });
    const source = fs.realpathSync(this.paths.model);
    const stat = fs.statSync(source);
    const key = crypto.createHash('sha256').update(`${source}\0${stat.size}\0${stat.mtimeMs}`).digest('hex').slice(0, 16);
    const cacheDirectory = path.join(this.userDataPath, 'whisper-model-cache');
    await fs.promises.mkdir(cacheDirectory, { recursive: true });
    const cachedModel = path.join(cacheDirectory, `${key}.bin`);
    if (!fs.existsSync(cachedModel)) {
      const temporary = `${cachedModel}.${crypto.randomUUID()}.tmp`;
      try { await fs.promises.link(source, temporary); } catch (error) {
        if (!['EXDEV', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        await fs.promises.copyFile(source, temporary);
      }
      try { await fs.promises.rename(temporary, cachedModel); } catch (error) {
        try { await fs.promises.unlink(temporary); } catch { /* another task may have filled the same cache key. */ }
        if (!fs.existsSync(cachedModel)) throw error;
      }
    }
    try { await fs.promises.link(cachedModel, modelLink); } catch (error) {
      if (!['EXDEV', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      await fs.promises.copyFile(cachedModel, modelLink);
    }
  }

  runProcess(job, binary, args, { cwd, progress, progressDuration = 0 } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawn(binary, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { reject(error); return; }
      job.child = child;
      let stderr = '';
      let stdout = '';
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        if (job.child === child) job.child = null;
        if (error) reject(error);
        else resolve(result);
      };
      child.stdout.on('data', (chunk) => {
        const text = String(chunk);
        stdout = (stdout + text).slice(-20000);
        const match = /out_time_ms=(\d+)/.exec(stdout.slice(-4000));
        if (match && progress && progressDuration > 0) progress(Math.max(0, Math.min(1, Number(match[1]) / 1e6 / progressDuration)));
        stdout = stdout.slice(-4000);
      });
      child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        stderr = (stderr + text).slice(-20000);
        const match = /(?:progress\s*=\s*|\b)(\d{1,3})%/i.exec(text);
        if (match && progress) progress(Math.max(0, Math.min(1, Number(match[1]) / 100)));
      });
      child.on('error', (error) => finish(job.cancelled ? Object.assign(new Error('已取消'), { code: 'CANCELLED' }) : error));
      child.on('close', (code) => {
        if (job.cancelled) return finish(Object.assign(new Error('已取消'), { code: 'CANCELLED' }));
        if (code !== 0) return finish(Object.assign(new Error(`${path.basename(binary)} 失败（${code}）：${stderr.trim().split(/\r?\n/).slice(-4).join(' / ')}`), { code: 'ASR_PROCESS_FAILED' }));
        finish(null, binary.toLowerCase().includes('ffmpeg') ? stdout : stderr);
      });
    });
  }

  throwIfCancelled(job) {
    if (job.cancelled) throw Object.assign(new Error('已取消'), { code: 'CANCELLED' });
  }

  cleanWorkDirectory(directory, files) {
    if (!directory || !fs.existsSync(directory)) return;
    for (const file of files) {
      if (path.dirname(file) !== directory) continue;
      try { fs.unlinkSync(file); } catch { /* Leave files that are still held open. */ }
    }
    try { fs.rmdirSync(directory); } catch { /* 只删除已清空的任务目录。 */ }
  }

  async close() {
    this.stopping = true;
    for (const job of this.queue.splice(0)) {
      job.cancelled = true;
      job.status = 'cancelled';
      job.error = { code: 'CANCELLED', message: 'Recly 正在关闭，任务已取消。' };
    }
    if (this.activeJob) {
      this.activeJob.cancelled = true;
      if (this.activeJob.child && !this.activeJob.child.killed) this.activeJob.child.kill();
    }
    if (this.drainPromise) await this.drainPromise;
  }
}

module.exports = {
  TranscriptionManager,
  audioRangesForTrack,
  parseWhisperJson,
  resolveProjectFile,
  resolveWhisperPaths,
  retainedSourceRanges,
};
