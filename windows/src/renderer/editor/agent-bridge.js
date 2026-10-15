'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const timeline = require('../../core/timeline');
const { normalizeSubtitles, mapCuesToOutput, toSrt } = require('../../core/subtitles');
const { applyOperations } = require('../../core/edit-commands');
const { exportProject: defaultExportProject, ExportCancelled } = require('./export');

const REQUEST_CACHE_LIMIT = 500;

function error(code, message) {
  throw Object.assign(new Error(message), { code });
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isTextEntryActive(documentRef) {
  const active = documentRef && documentRef.activeElement;
  if (!active) return false;
  const tag = String(active.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'hidden'].includes(String(active.type || 'text').toLowerCase());
}

function finite(value, name, min = -Infinity, max = Infinity) {
  if (!Number.isFinite(value) || value < min || value > max) error('invalid_params', `${name} 超出允许范围`);
  return value;
}

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) error('invalid_params', `${name} 必须是对象`);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) error('invalid_params', `${name} 不支持字段 ${unknown}`);
}

function checkStyle(style) {
  exactKeys(style, ['fontSize', 'color', 'backgroundColor', 'backgroundOpacity', 'baselineY'], 'style');
  const result = {};
  for (const [key, value] of Object.entries(style)) {
    if (key === 'fontSize') result[key] = finite(value, `style.${key}`, 12, 160);
    else if (key === 'backgroundOpacity') result[key] = finite(value, `style.${key}`, 0, 1);
    else if (key === 'baselineY') result[key] = finite(value, `style.${key}`, 0.1, 0.9);
    else {
      if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) error('invalid_params', `style.${key} 必须是 #RRGGBB 颜色`);
      result[key] = value.toUpperCase();
    }
  }
  return result;
}

function validatedWords(words, cue, duration) {
  if (!Array.isArray(words) || words.length > 1000) error('invalid_params', `字幕 ${cue.id} 的 words 必须是数组`);
  let previousEnd = cue.start;
  return words.map((word, index) => {
    exactKeys(word, ['start', 'end', 'text'], `字幕 ${cue.id} 的 words[${index}]`);
    const start = finite(word.start, `words[${index}].start`, 0, duration);
    const end = finite(word.end, `words[${index}].end`, 0, duration);
    if (end <= start || start < cue.start - 1e-5 || end > cue.end + 1e-5 || start < previousEnd - 1e-5) {
      error('invalid_params', `字幕 ${cue.id} 的词时间必须递增并位于字幕时间范围内`);
    }
    if (typeof word.text !== 'string' || word.text.length > 200) error('invalid_params', `words[${index}].text 无效`);
    previousEnd = end;
    return { start, end, text: word.text };
  });
}

function validateFullCues(cues, duration) {
  if (!Array.isArray(cues) || cues.length > 10000) error('invalid_params', 'replaceCues 必须是数组且最多包含 10000 条');
  const ids = new Set();
  return cues.map((cue, index) => {
    exactKeys(cue, ['id', 'start', 'end', 'text', 'originalText', 'alignment', 'words'], `replaceCues[${index}]`);
    if (typeof cue.id !== 'string' || !cue.id || cue.id.length > 200 || ids.has(cue.id)) error('invalid_params', `replaceCues[${index}].id 缺失或重复`);
    ids.add(cue.id);
    const start = finite(cue.start, `replaceCues[${index}].start`, 0, duration);
    const end = finite(cue.end, `replaceCues[${index}].end`, 0, duration);
    if (end <= start) error('invalid_params', `replaceCues[${index}] 的 end 必须大于 start`);
    if (typeof cue.text !== 'string' || cue.text.length > 4000) error('invalid_params', `replaceCues[${index}].text 无效`);
    const originalText = cue.originalText === undefined ? cue.text : cue.originalText;
    if (typeof originalText !== 'string' || originalText.length > 4000) error('invalid_params', `replaceCues[${index}].originalText 无效`);
    if (cue.alignment !== undefined && !['valid', 'stale'].includes(cue.alignment)) error('invalid_params', `replaceCues[${index}].alignment 无效`);
    const normalized = { id: cue.id, start, end, text: cue.text, originalText, alignment: cue.alignment || 'valid', words: [] };
    normalized.words = cue.words === undefined ? [] : validatedWords(cue.words, normalized, duration);
    return normalized;
  }).sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
}

function patchSubtitles(project, patch) {
  exactKeys(patch, ['enabled', 'sourceTrack', 'language', 'style', 'cues', 'replaceCues'], 'subtitles.patch');
  if (!Object.keys(patch).length) error('invalid_params', 'subtitles.patch 不能为空');
  if (patch.cues !== undefined && patch.replaceCues !== undefined) error('invalid_params', 'cues 与 replaceCues 不能同时使用');
  const duration = project.media.screen.duration;
  const current = normalizeSubtitles(project.subtitles);
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') error('invalid_params', 'enabled 必须是布尔值');
    current.enabled = patch.enabled;
  }
  if (patch.sourceTrack !== undefined) {
    if (!['microphone', 'systemAudio'].includes(patch.sourceTrack)) error('invalid_params', 'sourceTrack 只支持 microphone 或 systemAudio');
    current.sourceTrack = patch.sourceTrack;
  }
  if (patch.language !== undefined) {
    if (typeof patch.language !== 'string' || !/^[a-zA-Z0-9-]{2,20}$/.test(patch.language)) error('invalid_params', 'language 格式無效');
    try {
      if (!Intl.getCanonicalLocales(patch.language).length) error('invalid_params', 'language 格式無效');
    } catch {
      error('invalid_params', 'language 格式無效');
    }
    current.language = patch.language;
  }
  if (patch.style !== undefined) Object.assign(current.style, checkStyle(patch.style));
  if (patch.replaceCues !== undefined) {
    current.cues = validateFullCues(patch.replaceCues, duration);
  } else if (patch.cues !== undefined) {
    if (!Array.isArray(patch.cues) || !patch.cues.length || patch.cues.length > 1000) error('invalid_params', 'cues 必须是非空数组且最多包含 1000 条');
    const seen = new Set();
    for (let index = 0; index < patch.cues.length; index++) {
      const update = patch.cues[index];
      exactKeys(update, ['id', 'start', 'end', 'text', 'alignment', 'words'], `cues[${index}]`);
      if (typeof update.id !== 'string' || !update.id || seen.has(update.id)) error('invalid_params', `cues[${index}].id 缺失或重复`);
      seen.add(update.id);
      const cue = current.cues.find((item) => item.id === update.id);
      if (!cue) error('not_found', `找不到字幕 ${update.id}`);
      const oldText = cue.text;
      if (update.start !== undefined) cue.start = finite(update.start, `cues[${index}].start`, 0, duration);
      if (update.end !== undefined) cue.end = finite(update.end, `cues[${index}].end`, 0, duration);
      if (cue.end <= cue.start) error('invalid_params', `字幕 ${cue.id} 的 end 必须大于 start`);
      if (update.text !== undefined) {
        if (typeof update.text !== 'string' || update.text.length > 4000) error('invalid_params', `cues[${index}].text 无效`);
        cue.text = update.text;
      }
      if (update.words !== undefined) cue.words = validatedWords(update.words, cue, duration);
      if (update.alignment !== undefined && !['valid', 'stale'].includes(update.alignment)) error('invalid_params', `cues[${index}].alignment 无效`);
      if (cue.text !== oldText && update.words === undefined) cue.alignment = 'stale';
      else if (update.alignment !== undefined) cue.alignment = update.alignment;
      else if (update.words !== undefined) cue.alignment = 'valid';
      if (cue.text !== oldText && update.alignment === 'valid' && update.words === undefined) error('invalid_params', `修改字幕 ${cue.id} 的文字并声明对齐有效时必须同时提供 words`);
    }
  }
  project.subtitles = current;
  return { cueCount: current.cues.length, cueIds: current.cues.map((cue) => cue.id) };
}

function replaceObject(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function durationOf(project) { return timeline.outputDuration(project.timeline.segments); }

class AgentBridge {
  constructor({ ipcRenderer, store, preview, directory, documentRef = globalThis.document, exportProject: exportProjectImpl = defaultExportProject }) {
    this.ipcRenderer = ipcRenderer;
    this.store = store;
    this.preview = preview;
    this.directory = directory;
    this.documentRef = documentRef;
    this.exportProject = exportProjectImpl;
    this.requests = new Map();
    this.jobs = new Map();
    this.plans = new Map();
    this.activeExportId = null;
    this.onRequest = this.onRequest.bind(this);
  }

  attach() {
    this.ipcRenderer.on('agent:request', this.onRequest);
    void this.waitAndAnnounceReady();
    return this;
  }

  detach() {
    this.ipcRenderer.removeListener('agent:request', this.onRequest);
  }

  async waitAndAnnounceReady() {
    while (this.preview.assetsPending) await new Promise((resolve) => setTimeout(resolve, 30));
    const node = this.preview.screen?.node;
    while (node && node.readyState < 2 && !node.error) await new Promise((resolve) => setTimeout(resolve, 30));
    this.ipcRenderer.send('agent:ready', { directory: this.directory });
  }

  respond(id, result, caught) {
    this.ipcRenderer.send('agent:response', {
      id,
      ...(caught ? { error: { code: caught.code || 'internal_error', message: String(caught.message || caught) } } : { result }),
    });
  }

  async onRequest(_event, request) {
    const id = request && request.id;
    try {
      if (typeof id !== 'string' || !id) error('invalid_request', 'agent request 缺少 id');
      if (!request || typeof request.method !== 'string') error('invalid_request', 'agent request 缺少 method');
      const params = request.params || {};
      this.checkDirectory(params);
      const result = await this.dispatch(request.method, params);
      this.respond(id, result);
    } catch (caught) {
      this.respond(id, undefined, caught);
    }
  }

  checkDirectory(params) {
    if (typeof params.directory !== 'string' || path.resolve(params.directory) !== path.resolve(this.directory)) {
      error('wrong_project', '请求目录与当前打开的工程不一致');
    }
  }

  checkBusy() {
    if (this.store.gesture || isTextEntryActive(this.documentRef)) error('project_busy', '请先完成当前拖动或输入，再重试工程写入');
  }

  checkExpectedRevision(params) {
    if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) error('invalid_params', 'expectedRevision 必须是非负整数');
    if (typeof params.requestId !== 'string' || !params.requestId || params.requestId.length > 200) error('invalid_params', 'requestId 必须是长度不超过 200 的非空字符串');
    if (params.expectedRevision !== this.store.revision) error('revision_conflict', `当前工程版本为 ${this.store.revision}，请求预期版本为 ${params.expectedRevision}`);
  }

  pruneRequests() {
    if (this.requests.size <= REQUEST_CACHE_LIMIT) return;
    for (const [id, entry] of this.requests) {
      if (!entry.settled) continue;
      this.requests.delete(id);
      if (this.requests.size <= REQUEST_CACHE_LIMIT) break;
    }
  }

  write(params, method, action) {
    if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) return Promise.reject(Object.assign(new Error('expectedRevision 必须是非负整数'), { code: 'invalid_params' }));
    if (typeof params.requestId !== 'string' || !params.requestId || params.requestId.length > 200) return Promise.reject(Object.assign(new Error('requestId 必须是长度不超过 200 的非空字符串'), { code: 'invalid_params' }));
    const fingerprint = stableStringify({ method, params });
    const previous = this.requests.get(params.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.reject(Object.assign(new Error('同一 requestId 不能用于不同请求内容'), { code: 'request_id_conflict' }));
      return previous.promise;
    }
    const entry = { fingerprint, settled: false, promise: null };
    entry.promise = Promise.resolve().then(async () => {
      this.checkBusy();
      if (params.expectedRevision !== this.store.revision) error('revision_conflict', `当前工程版本为 ${this.store.revision}，请求预期版本为 ${params.expectedRevision}`);
      return action();
    });
    this.requests.set(params.requestId, entry);
    entry.promise.finally(() => { entry.settled = true; this.pruneRequests(); }).catch(() => {});
    return entry.promise;
  }

  baseResult(extra = {}) {
    return { revision: this.store.revision, saveState: this.store.saveState, duration: durationOf(this.store.project), ...extra };
  }

  timelineView() {
    let outputStart = 0;
    const segments = this.store.project.timeline.segments.map((segment) => {
      const duration = timeline.segmentOutputDuration(segment);
      const view = { ...clone(segment), outputStart, outputEnd: outputStart + duration, outputDuration: duration };
      outputStart += duration;
      return view;
    });
    return { revision: this.store.revision, duration: outputStart, segments };
  }

  async dispatch(method, params) {
    switch (method) {
      case 'project.get':
        return this.baseResult({ directory: this.directory, name: this.store.project.name, project: clone(this.store.project) });
      case 'timeline.get':
        return this.timelineView();
      case 'edit.preview': {
        const result = applyOperations(this.store.project, params.operations);
        const planId = randomUUID();
        this.plans.set(planId, {
          revision: this.store.revision,
          operations: clone(params.operations),
          fingerprint: stableStringify(params.operations),
          project: clone(result.project),
          results: clone(result.results),
          summary: clone(result.summary),
        });
        if (this.plans.size > 100) this.plans.delete(this.plans.keys().next().value);
        return { planId, revision: this.store.revision, ...result.summary, results: result.results, project: result.project };
      }
      case 'edit.apply':
        return this.write(params, method, () => {
          let plan = null;
          if (params.planId !== undefined) {
            plan = this.plans.get(params.planId);
            if (!plan || plan.revision !== this.store.revision || (params.operations !== undefined && plan.fingerprint !== stableStringify(params.operations))) {
              error('plan_conflict', '预检计划已过期或与提交操作不一致，请重新预检');
            }
          }
          if (!plan && !Array.isArray(params.operations)) error('invalid_params', 'operations 必须是数组，或提供可用的 planId');
          const applied = plan
            ? { project: clone(plan.project), results: clone(plan.results), summary: clone(plan.summary) }
            : applyOperations(this.store.project, params.operations);
          this.store.mutate((project) => replaceObject(project, applied.project));
          return this.baseResult({ results: applied.results, summary: applied.summary });
        });
      case 'history.undo':
      case 'history.redo':
        return this.write(params, method, () => {
          const changed = method.endsWith('undo') ? this.store.undo() : this.store.redo();
          if (!changed) error('no_history', method.endsWith('undo') ? '没有可撤销的编辑' : '没有可重做的编辑');
          return this.baseResult({ changed: true });
        });
      case 'project.save':
        return this.write(params, method, async () => {
          const saved = await this.store.save({ throwOnError: true, untilStable: true });
          return { ...this.baseResult(), savedRevision: saved.savedRevision };
        });
      case 'subtitles.get':
      case 'transcript.get':
        return this.getSubtitles(params);
      case 'subtitles.patch':
        return this.write(params, method, () => {
          const applied = clone(this.store.project);
          const summary = patchSubtitles(applied, params.patch);
          this.store.mutate((project) => replaceObject(project, applied));
          return this.baseResult(summary);
        });
      case 'transcript.generate':
        return this.write(params, method, async () => {
          const trackName = params.track || this.store.project.subtitles?.sourceTrack || 'microphone';
          if (!['microphone', 'systemAudio'].includes(trackName)) error('invalid_params', 'track 只支持 microphone 或 systemAudio');
          const track = this.store.project.media[trackName];
          if (!track || !track.file) error('invalid_operation', `当前工程没有 ${trackName} 音轨`);
          const scope = params.scope;
          if (!['source', 'retained'].includes(scope)) error('invalid_params', 'scope 只支持 source 或 retained');
          const result = await this.ipcRenderer.invoke('subtitle:generate', {
            directory: this.directory, project: clone(this.store.project), track: trackName, scope,
          });
          return { jobId: typeof result === 'string' ? result : result.jobId, status: result.status || 'queued' };
        });
      case 'media.frame':
        return this.mediaFrame(params);
      case 'media.audio_excerpt':
      case 'audio_excerpt':
        return this.audioExcerpt(params);
      case 'export.start':
        return this.write(params, method, () => this.startExport(params));
      case 'jobs.get':
        return this.getJob(params);
      case 'jobs.cancel':
        return this.write(params, method, () => this.cancelJob(params));
      default:
        error('method_not_found', `不支持的 Agent 方法 ${method}`);
    }
  }

  async getSubtitles(params) {
    const project = clone(this.store.project);
    project.subtitles = normalizeSubtitles(project.subtitles);
    const mapped = mapCuesToOutput(project);
    const job = params.jobId ? await this.ipcRenderer.invoke('jobs:get', { jobId: params.jobId }) : null;
    return {
      revision: this.store.revision,
      subtitles: project.subtitles,
      mappedCues: mapped,
      srt: toSrt(project),
      warnings: mapped.warnings || [],
      ...(params.jobId ? { job } : {}),
    };
  }

  async mediaFrame(params) {
    const domain = params.timeDomain;
    if (!['source', 'output'].includes(domain)) error('invalid_params', 'timeDomain 只支持 source 或 output');
    const value = finite(params.time, 'time', 0, domain === 'source' ? this.store.project.media.screen.duration : durationOf(this.store.project));
    if (domain === 'source') {
      const result = await this.ipcRenderer.invoke('agent:media-frame', {
        directory: this.directory, project: clone(this.store.project), sourceTime: value,
      });
      if (!result || typeof result.path !== 'string') error('media_error', '主进程没有返回已解码画面');
      const data = await fs.readFile(result.path);
      return { mimeType: 'image/png', base64: data.toString('base64'), timeDomain: domain, time: value, sourceTime: value };
    }
    const hit = timeline.locate(this.store.project.timeline.segments, value);
    if (!hit) error('invalid_operation', '当前工程没有可读取的片段');
    const wasPlaying = this.preview.playing;
    const oldTime = this.preview.time;
    const oldQuality = this.preview.quality;
    this.preview.pause();
    try {
      if (oldQuality !== 'full') this.preview.setQuality('full');
      this.preview.seek(value);
      await this.waitForPreviewFrame(hit.sourceTime, value);
      this.preview.draw();
      const dataUrl = this.preview.canvas.toDataURL('image/png');
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      if (!base64) error('media_error', '预览合成器没有返回 PNG 画面');
      return { mimeType: 'image/png', base64, timeDomain: domain, time: value, sourceTime: hit.sourceTime };
    } finally {
      if (this.preview.quality !== oldQuality) this.preview.setQuality(oldQuality);
      this.preview.seek(oldTime);
      if (wasPlaying) this.preview.play();
    }
  }

  async waitForPreviewFrame(sourceTime, outputTime) {
    const deadline = Date.now() + 15000;
    while (this.preview.assetsPending && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (this.preview.assetsPending || this.preview.assetError) error('media_error', this.preview.assetError?.message || '预览素材尚未就绪');
    this.preview.syncMedia(true);
    const waitTrack = async (track, target, force = false) => {
      if (!track || (!force && !track.inRange)) return;
      const node = track.node;
      const knownDuration = Number.isFinite(node.duration) && node.duration > 0 ? node.duration : track.duration;
      const maxTime = Number.isFinite(knownDuration) ? Math.max(knownDuration - 0.03, 0) : target;
      const wanted = Math.min(Math.max(target, 0), maxTime);
      if (node.seeking || node.readyState < 2 || Math.abs(node.currentTime - wanted) > 0.01) {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            node.removeEventListener('seeked', onReady);
            node.removeEventListener('loadeddata', onReady);
            node.removeEventListener('error', onError);
          };
          const onReady = () => {
            if (!node.seeking && node.readyState >= 2 && Math.abs(node.currentTime - wanted) <= 0.03) { cleanup(); resolve(); }
          };
          const onError = () => { cleanup(); reject(new Error(`等待${track === this.preview.screen ? '屏幕' : '摄像头'}画面解码失败`)); };
          const timer = setTimeout(() => { cleanup(); reject(new Error('等待视频画面解码超时')); }, Math.max(deadline - Date.now(), 1));
          node.addEventListener('seeked', onReady);
          node.addEventListener('loadeddata', onReady);
          node.addEventListener('error', onError, { once: true });
          onReady();
        });
      }
      if (Math.abs(node.currentTime - wanted) > 0.03) throw new Error('视频定位未到请求画面');
    };
    const screen = this.preview.screen;
    if (!screen) error('media_error', '当前工程没有屏幕视频');
    await waitTrack(screen, sourceTime - screen.offset, true);
    const camera = this.preview.camera;
    if (camera && camera.inRange && !this.store.project.camera.isHidden) await waitTrack(camera, sourceTime - camera.offset);
    const background = this.preview.backgroundVideo;
    if (background) {
      const node = background.node;
      const mediaDuration = Number.isFinite(node.duration) && node.duration > 0 ? node.duration : background.duration;
      let wanted = outputTime;
      if (Number.isFinite(mediaDuration) && mediaDuration > 0) wanted = background.isLooping ? wanted % mediaDuration : Math.min(wanted, mediaDuration);
      await waitTrack({ node, offset: 0, duration: mediaDuration, inRange: true }, wanted, true);
    }
  }

  async audioExcerpt(params) {
    const domain = params.timeDomain || 'source';
    if (!['source', 'output'].includes(domain)) error('invalid_params', 'timeDomain 只支持 source 或 output');
    const duration = finite(params.duration, 'duration', 0.1, 30);
    const trackName = params.track;
    if (!['microphone', 'systemAudio'].includes(trackName)) error('invalid_params', 'track 只支持 microphone 或 systemAudio');
    const track = this.store.project.media[trackName];
    if (!track || !track.file) error('invalid_operation', `当前工程没有 ${trackName} 音轨`);
    const start = finite(params.start, 'start', 0, domain === 'source' ? this.store.project.media.screen.duration : durationOf(this.store.project));
    let sourceStart = start;
    let sourceDuration = duration;
    let speed = 1;
    if (domain === 'output') {
      const hit = timeline.locate(this.store.project.timeline.segments, start);
      if (!hit) error('invalid_operation', '当前工程没有可读取的片段');
      sourceStart = hit.sourceTime;
      speed = hit.segment.speed;
      if (params.speed !== undefined && params.speed !== speed) error('invalid_params', `请求 speed 与当前片段速度 ${speed} 不一致`);
      sourceDuration = duration * speed;
      const outputEnd = hit.outputStart + timeline.segmentOutputDuration(hit.segment);
      if (start + duration > outputEnd + 1e-6) error('invalid_params', '成片音频区间不能跨越剪辑点，请缩短区间');
      if (sourceStart + sourceDuration > hit.segment.sourceEnd + 1e-6) error('invalid_params', '源音频区间超出当前片段');
      if (sourceDuration > 120) error('invalid_params', '变速映射后的源音频区间不能超过 120 秒');
    } else if (sourceStart + sourceDuration > this.store.project.media.screen.duration + 1e-6) {
      error('invalid_params', '音频区间超出录屏素材范围');
    } else if (params.speed !== undefined && params.speed !== 1) {
      error('invalid_params', 'source 时间域始终按原速读取');
    }
    const result = await this.ipcRenderer.invoke('agent:audio-excerpt', {
      directory: this.directory, project: clone(this.store.project), track: trackName,
      sourceStart, sourceDuration, speed, timeDomain: domain, time: start, duration,
    });
    if (!result || typeof result.path !== 'string') error('media_error', '主进程没有返回音频片段');
    const data = await fs.readFile(result.path);
    return { mimeType: result.mimeType || 'audio/wav', base64: data.toString('base64'), timeDomain: result.timeDomain ?? domain,
      time: result.time ?? start, sourceStart: result.sourceStart ?? sourceStart,
      sourceDuration: result.sourceDuration ?? sourceDuration, duration: result.duration ?? duration, speed };
  }

  async startExport(params) {
    if (this.activeExportId) error('project_busy', '当前工程已有导出任务正在运行');
    if (typeof params.outputFile !== 'string' || !params.outputFile.trim()) error('invalid_params', 'export.start 必须指定 outputFile');
    const kind = params.kind || 'video';
    if (!['video', 'audio'].includes(kind)) error('invalid_params', 'kind 只支持 video 或 audio');
    const resolution = params.resolution || this.store.project.export?.resolution || 'source';
    const frameRate = params.frameRate || this.store.project.export?.frameRate || 60;
    if (!['source', 'fullHD', 'quadHD', 'ultraHD'].includes(resolution)) error('invalid_params', 'resolution 不受支持');
    if (![30, 60].includes(frameRate)) error('invalid_params', 'frameRate 只支持 30 或 60');
    const projectSnapshot = clone(this.store.project);
    const startRevision = this.store.revision;
    await this.ipcRenderer.invoke('agent:validate-export-output', {
      directory: this.directory, project: projectSnapshot, outputFile: params.outputFile, kind,
    });
    this.checkBusy();
    if (this.store.revision !== startRevision || startRevision !== params.expectedRevision) {
      error('revision_conflict', `导出校验期间工程已从版本 ${startRevision} 变为 ${this.store.revision}`);
    }
    const lock = await this.ipcRenderer.invoke('export:begin', { directory: this.directory });
    if (lock === false || lock?.ok === false) error('project_busy', lock?.message || '当前工程已有导出任务正在运行');
    const jobId = randomUUID();
    const controller = new AbortController();
    const job = { jobId, status: 'running', progress: { stage: '正在准备', fraction: 0 }, result: null, error: null, controller };
    this.jobs.set(jobId, job);
    this.activeExportId = jobId;
    void this.runExport(job, { project: projectSnapshot, outputFile: params.outputFile, kind, resolution, frameRate, signal: controller.signal });
    return { jobId, status: 'running' };
  }

  async runExport(job, options) {
    try {
      job.result = await this.exportProject({
        ...options,
        directory: this.directory,
        onProgress: (progress) => { job.progress = clone(progress); },
      });
      job.status = 'completed';
      job.progress = { stage: '导出完成', fraction: 1 };
    } catch (caught) {
      if (caught instanceof ExportCancelled || caught.cancelled || job.controller.signal.aborted) job.status = 'cancelled';
      else {
        job.status = 'failed';
        job.error = { code: caught.code || 'export_failed', message: String(caught.message || caught) };
      }
    } finally {
      job.controller = null;
      try { await this.ipcRenderer.invoke('export:end', { directory: this.directory }); } catch (caught) {
        if (job.status === 'completed') {
          job.status = 'failed';
          job.error = { code: 'export_lock_release_failed', message: String(caught.message || caught) };
        }
      }
      if (this.activeExportId === job.jobId) this.activeExportId = null;
    }
  }

  async getJob(params) {
    if (typeof params.jobId !== 'string' || !params.jobId) error('invalid_params', 'jobId 必须是非空字符串');
    const local = this.jobs.get(params.jobId);
    if (local) return this.jobView(local);
    return this.ipcRenderer.invoke('jobs:get', { jobId: params.jobId });
  }

  jobView(job) {
    return {
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      ...(job.result !== null ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  async cancelJob(params) {
    if (typeof params.jobId !== 'string' || !params.jobId) error('invalid_params', 'jobId 必须是非空字符串');
    const local = this.jobs.get(params.jobId);
    if (local) {
      if (local.status === 'running' && local.controller) local.controller.abort();
      return this.jobView(local);
    }
        return this.ipcRenderer.invoke('jobs:cancel', { jobId: params.jobId });
  }
}

function attachAgentBridge(options) { return new AgentBridge(options).attach(); }

module.exports = { AgentBridge, attachAgentBridge, isTextEntryActive, stableStringify };
