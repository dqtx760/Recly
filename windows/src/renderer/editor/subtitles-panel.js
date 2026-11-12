'use strict';

const { ipcRenderer } = require('electron');
const path = require('node:path');
const { element } = require('../common');
const { uid } = require('../../core/model');
const { normalizeSubtitleLanguage, normalizeSubtitles, mapCuesToOutput, toSrt } = require('../../core/subtitles');
const timeline = require('../../core/timeline');

function ensureStylesheet() {
  if (document.getElementById('subtitles-panel-styles')) return;
  const link = document.createElement('link');
  link.id = 'subtitles-panel-styles';
  link.rel = 'stylesheet';
  link.href = 'editor/subtitles-panel.css';
  document.head.append(link);
}

function panelState(inspector) {
  if (!inspector.subtitlesState) {
    inspector.subtitlesState = {
      environment: null,
      environmentChecked: false,
      environmentLoading: false,
      environmentError: '',
      status: '',
      track: inspector.store.project.subtitles?.sourceTrack || 'microphone',
      scope: 'retained',
      jobId: null,
      starting: false,
      jobTrack: null,
      progressNode: null,
      candidate: null,
      candidateTrack: null,
      confirmReplace: false,
      tab: 'subtitles',
      query: '',
      replacement: '',
    };
  }
  return inspector.subtitlesState;
}

function semanticWords(text, language = 'zh') {
  const value = typeof text === 'string' ? text : '';
  if (typeof Intl.Segmenter === 'function') {
    try {
      return Array.from(new Intl.Segmenter(normalizeSubtitleLanguage(language), { granularity: 'word' }).segment(value))
        .filter((part) => part.isWordLike)
        .map((part) => part.segment);
    } catch {}
  }
  return value.match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) || [];
}

function alignedWordTexts(text, language) {
  const value = typeof text === 'string' ? text : '';
  let parts = null;
  if (typeof Intl.Segmenter === 'function') {
    try {
      parts = Array.from(new Intl.Segmenter(normalizeSubtitleLanguage(language), { granularity: 'word' }).segment(value));
    } catch {}
  }
  if (!parts) {
    parts = (value.match(/[\p{Script=Han}]|[\p{L}\p{N}]+|[^\p{L}\p{N}]/gu) || [])
      .map((segment) => ({ segment, isWordLike: /[\p{L}\p{N}]/u.test(segment) }));
  }
  const words = [];
  let prefix = '';
  for (const part of parts) {
    if (part.isWordLike) {
      words.push(`${prefix}${part.segment}`);
      prefix = '';
    } else if (words.length) words[words.length - 1] += part.segment;
    else prefix += part.segment;
  }
  if (prefix && words.length) words[words.length - 1] += prefix;
  return words;
}

function field(label, control, className = '') {
  return element('label', { class: `subtitles-field${className ? ` ${className}` : ''}` },
    element('span', {}, label), control);
}

function replaceCueText(cue, query, replacement) {
  if (!query || query === replacement) return 0;
  const parts = cue.text.split(query);
  if (parts.length === 1) return 0;
  const next = parts.join(replacement);
  const words = cue.words.map((word) => ({ ...word, text: word.text.split(query).join(replacement) }));
  if (cue.alignment === 'valid' && cue.words.length
    && cue.words.map((word) => word.text).join('') === cue.text
    && words.map((word) => word.text).join('') === next) cue.words = words;
  else cue.alignment = 'stale';
  cue.text = next;
  return parts.length - 1;
}

function formatOutputTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = String(value % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

function clearAllSubtitles(store, state) {
  if (!store.project.subtitles?.cues?.length) return false;
  if (state) {
    state.candidate = null;
    state.candidateTrack = null;
    state.confirmReplace = false;
  }
  store.mutate((draft) => { draft.subtitles.cues = []; });
  if (store.selection?.type === 'subtitle') store.select(null);
  return true;
}

function orderCuesByOutput(cues, mapped) {
  const firstOccurrences = new Map();
  for (const item of mapped) {
    if (!firstOccurrences.has(item.id)) firstOccurrences.set(item.id, item);
  }
  return {
    cues: [...cues].sort((a, b) => (firstOccurrences.get(a.id)?.start ?? Infinity) - (firstOccurrences.get(b.id)?.start ?? Infinity)),
    firstOccurrences,
  };
}

function numberInput(value, { min = 0, max, step = 0.01, label } = {}) {
  return element('input', {
    type: 'number', value: Number(value).toFixed(2), min, max, step,
    'aria-label': label,
  });
}

function renderSubtitlesPanel(inspector) {
  ensureStylesheet();
  const { store } = inspector;
  const state = panelState(inspector);
  const project = store.project;
  const subtitles = normalizeSubtitles(project.subtitles);
  const panel = element('div', { class: 'subtitles-panel' });
  const note = (text, className = '') => element('p', { class: `subtitles-note${className ? ` ${className}` : ''}` }, text);
  const button = (label, onClick, className = '') => element('button', { type: 'button', class: `btn ${className}`, onclick: onClick }, label);

  const write = (change) => store.mutate((draft) => {
    draft.subtitles = normalizeSubtitles(draft.subtitles);
    change(draft.subtitles, draft);
  });
  const updateCue = (id, change) => write((value) => {
    const cue = value.cues.find((item) => item.id === id);
    if (cue) change(cue, value);
  });

  if (!state.environmentChecked && !state.environmentLoading) {
    state.environmentLoading = true;
    ipcRenderer.invoke('subtitle:environment').then((environment) => {
      state.environment = environment || { ready: false };
      state.environmentChecked = true;
      state.environmentError = '';
      state.environmentLoading = false;
      if (inspector.tab === 'subtitles') inspector.render();
    }).catch((error) => {
      state.environmentChecked = true;
      state.environmentError = error.message || '无法读取本地语音识别环境。';
      state.environmentLoading = false;
      if (inspector.tab === 'subtitles') inspector.render();
    });
  }

  const enabled = element('button', {
    type: 'button',
    class: `subtitles-toggle${subtitles.enabled ? ' on' : ''}`,
    role: 'switch',
    'aria-checked': subtitles.enabled ? 'true' : 'false',
    onclick: () => write((value) => { value.enabled = !value.enabled; }),
  }, subtitles.enabled ? '已启用' : '已关闭');
  panel.append(element('nav', { class: 'subtitles-tabs frame-tabs', 'aria-label': '字幕分组' },
    [['subtitles', '内容'], ['text', '样式'], ['animation', '动画']].map(([id, label]) => element('button', {
      type: 'button', class: state.tab === id ? 'active' : '', 'aria-pressed': String(state.tab === id),
      onclick: () => { state.tab = id; inspector.root.scrollTop = 0; inspector.render(); },
    }, label))));

  const style = subtitles.style;
  const fontSize = element('input', { type: 'number', min: 12, max: 160, step: 1, value: style.fontSize, 'aria-label': '字号' });
  fontSize.addEventListener('change', () => {
    const size = Number(fontSize.value);
    if (Number.isFinite(size)) write((value) => { value.style.fontSize = Math.min(Math.max(size, 12), 160); });
  });
  const textColor = element('input', { type: 'color', value: style.color, 'aria-label': '字幕颜色' });
  textColor.addEventListener('pointerdown', () => store.beginGesture());
  textColor.addEventListener('input', () => {
    store.beginGesture();
    store.mutate((draft) => { draft.subtitles.style.color = textColor.value.toUpperCase(); }, { history: false });
  });
  textColor.addEventListener('change', () => store.endGesture());
  const backgroundColor = element('input', { type: 'color', value: style.backgroundColor, 'aria-label': '字幕底色' });
  backgroundColor.addEventListener('pointerdown', () => store.beginGesture());
  backgroundColor.addEventListener('input', () => {
    store.beginGesture();
    store.mutate((draft) => { draft.subtitles.style.backgroundColor = backgroundColor.value.toUpperCase(); }, { history: false });
  });
  backgroundColor.addEventListener('change', () => store.endGesture());
  const opacity = element('input', { type: 'range', min: 0, max: 1, step: 0.01, value: style.backgroundOpacity, 'aria-label': '底色不透明度' });
  opacity.addEventListener('pointerdown', () => store.beginGesture());
  opacity.addEventListener('input', () => {
    store.beginGesture();
    store.mutate((draft) => { draft.subtitles.style.backgroundOpacity = Number(opacity.value); }, { history: false });
  });
  for (const type of ['change', 'pointerup', 'blur']) opacity.addEventListener(type, () => store.endGesture());
  const baseline = element('input', { type: 'number', min: 0.1, max: 0.9, step: 0.01, value: style.baselineY, 'aria-label': '字幕基线位置' });
  baseline.addEventListener('change', () => {
    const position = Number(baseline.value);
    if (Number.isFinite(position)) write((value) => { value.style.baselineY = Math.min(Math.max(position, 0.1), 0.9); });
  });
  const fontFamily = element('select', { 'aria-label': '字幕字体' },
    [['DogSC PuHui', '普惠体'], ['Microsoft YaHei UI', '微软雅黑'], ['SimSun', '宋体'], ['KaiTi', '楷体']].map(([id, label]) => element('option', { value: id }, label)));
  fontFamily.value = style.fontFamily;
  fontFamily.addEventListener('change', () => write(value => { value.style.fontFamily = fontFamily.value; }));
  const bold = button(style.bold ? '已加粗' : '常规', () => write(value => { value.style.bold = !value.style.bold; }));
  const duration = element('input', { type: 'range', min: 0.1, max: 1.5, step: 0.05, value: style.animationDuration, 'aria-label': '字幕动画时长' });
  duration.addEventListener('change', () => write(value => { value.style.animationDuration = Number(duration.value); }));
  panel.append(element('section', { class: 'subtitles-section', hidden: state.tab !== 'animation' },
    element('div', { class: 'subtitle-animation-grid' }, [['none', '无动画'], ['fade', '淡入淡出'], ['slide', '向上滑入'], ['pop', '轻微放大']].map(([id, label]) => element('button', {
      type: 'button', class: `subtitle-animation-card${style.animation === id ? ' active' : ''}`, 'data-subtitle-animation': id,
      'aria-pressed': String(style.animation === id), onclick: () => write(value => { value.style.animation = id; }),
    }, element('span', {}, '字幕'), label))),
    style.animation !== 'none' ? field('时长', duration) : null, note('应用于全部字幕')));
  panel.append(element('section', { class: 'subtitles-section', hidden: state.tab !== 'text' },
    field('显示字幕', enabled),
    field('字体', fontFamily), field('加粗', bold), field('字号', fontSize),
    field('文字颜色', textColor),
    field('底色', backgroundColor),
    field('底色不透明度', opacity),
    field('垂直位置', baseline), note('应用于全部字幕')));

  const media = project.media || {};
  if (state.track === 'microphone' && !media.microphone && media.systemAudio) state.track = 'systemAudio';
  const trackSelect = element('select', { 'aria-label': '识别音轨', disabled: Boolean(state.starting || state.jobId) },
    element('option', { value: 'microphone', disabled: !media.microphone }, '麦克风'),
    element('option', { value: 'systemAudio', disabled: !media.systemAudio }, '系统声音'));
  trackSelect.value = state.track;
  trackSelect.addEventListener('change', () => {
    state.track = trackSelect.value;
    write((value) => { value.sourceTrack = state.track; });
  });
  const scopeSelect = element('select', { 'aria-label': '识别范围', disabled: Boolean(state.starting || state.jobId) },
    element('option', { value: 'retained' }, '只识别当前保留片段'),
    element('option', { value: 'source' }, '识别完整录制'));
  scopeSelect.value = state.scope;
  scopeSelect.addEventListener('change', () => { state.scope = scopeSelect.value; });
  const environment = state.environment;
  const engineLine = state.environmentLoading
    ? note('正在检查本地识别程序与模型…')
    : state.environmentError
      ? note(state.environmentError, 'error')
      : environment?.ready
        ? note(`本地识别已就绪${environment.model ? ` · ${path.basename(String(environment.model))}` : ''}`)
        : note(`本地识别环境未就绪${environment?.executable ? ` · 程序：${environment.executable}` : ''}${environment?.model ? ` · 模型：${environment.model}` : ''}`, 'error');

  const progress = element('p', { class: 'subtitles-note', role: 'status' }, state.status || '');
  state.progressNode = progress;

  const pollJob = async (jobId) => {
    try {
      while (state.jobId === jobId) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        if (state.jobId !== jobId) return;
        const job = await ipcRenderer.invoke('jobs:get', { jobId });
        if (state.jobId !== jobId) return;
        const statusText = job.status === 'running'
          ? `正在识别${Number.isFinite(job.progress) ? `：${Math.round(job.progress * 100)}%` : '…'}`
          : job.status === 'queued' ? '识别任务排队中…' : state.status;
        state.status = statusText;
        if (state.progressNode?.isConnected) state.progressNode.textContent = statusText;
        if (job.status === 'completed') {
          state.candidate = normalizeSubtitles({ cues: job.result?.cues || [] }).cues;
          state.candidateTrack = state.jobTrack;
          state.jobId = null;
          if (!state.candidate.length) {
            state.candidate = null;
            state.status = '识别完成，但没有检测到可用语音字幕。';
            if (inspector.tab === 'subtitles') inspector.render();
            return;
          }
          if (store.project.subtitles.cues.length === 0) {
            const cues = state.candidate.map((cue) => ({ ...cue, id: cue.id || uid() }));
            store.mutate((draft) => {
              draft.subtitles.cues = cues;
              draft.subtitles.sourceTrack = state.jobTrack;
            });
            state.candidate = null;
            state.status = `识别完成，已添加 ${cues.length} 条字幕。`;
          } else state.status = `识别完成，共 ${state.candidate.length} 条候选字幕。`;
          if (inspector.tab === 'subtitles') inspector.render();
          return;
        }
        if (['failed', 'cancelled'].includes(job.status)) {
          state.status = job.status === 'cancelled' ? '识别已取消。' : `识别失败：${job.error?.message || job.error || '未知错误'}`;
          state.jobId = null;
          if (inspector.tab === 'subtitles') inspector.render();
          return;
        }
      }
    } catch (error) {
      state.status = `查询识别进度失败：${error.message || error}`;
      state.jobId = null;
      if (inspector.tab === 'subtitles') inspector.render();
    }
  };

  const startRecognition = async () => {
    if (state.starting || state.jobId) return;
    state.starting = true;
    state.jobTrack = state.track;
    state.candidate = null;
    state.confirmReplace = false;
    state.status = '正在启动识别…';
    inspector.render();
    try {
      const result = await ipcRenderer.invoke('subtitle:generate', {
        directory: store.directory,
        project: JSON.parse(JSON.stringify(store.project)),
        track: state.jobTrack,
        scope: state.scope,
      });
      if (!result?.jobId) throw new Error('识别任务没有返回编号。');
      state.starting = false;
      state.jobId = result.jobId;
      state.status = '识别任务已开始…';
      inspector.render();
      pollJob(result.jobId);
    } catch (error) {
      state.starting = false;
      state.status = `无法开始识别：${error.message || error}`;
      inspector.render();
    }
  };

  const cancelRecognition = async () => {
    const jobId = state.jobId;
    if (!jobId) return;
    try { await ipcRenderer.invoke('jobs:cancel', { jobId }); }
    catch (error) { state.status = `取消失败：${error.message || error}`; }
    state.jobId = null;
    state.status = '正在取消识别…';
    inspector.render();
  };

  const availableTrack = state.track === 'microphone' ? media.microphone : media.systemAudio;
  panel.append(element('section', { class: 'subtitles-section subtitles-recognition', hidden: state.tab !== 'subtitles' },
    element('div', { class: 'subtitles-actions' },
      element('button', {
        type: 'button', class: 'btn primary', disabled: Boolean(state.starting || state.jobId || !environment?.ready || !availableTrack),
        onclick: startRecognition,
      }, state.starting ? '正在启动…' : state.jobId ? '正在识别…' : '识别字幕'),
      state.jobId ? button('取消', cancelRecognition, 'ghost') : null,
      element('details', { class: 'subtitle-recognition-settings' }, element('summary', {}, '识别设置'),
        engineLine, field('声音来源', trackSelect), field('识别范围', scopeSelect))),
    state.status ? progress : null,
    state.environmentError || (!state.environmentLoading && !environment?.ready) ? note('识别未就绪，请打开识别设置检查。', 'error') : null,
    !availableTrack ? note('本工程没有所选音轨，可在识别设置中切换。', 'error') : null));

  const addCue = () => {
    const hit = timeline.locate(store.project.timeline?.segments || [], inspector.preview.time || 0);
    const sourceStart = hit?.sourceTime ?? 0;
    const sourceEnd = Math.min(hit?.segment.sourceEnd ?? (sourceStart + 2), store.project.media.screen.duration, sourceStart + 2);
    if (sourceEnd - sourceStart < 0.1) {
      if (inspector.onToast) inspector.onToast('当前播放头附近没有可添加字幕的保留片段。');
      return;
    }
    write((value) => {
      value.cues.push({ id: uid(), start: sourceStart, end: sourceEnd, text: '', originalText: '', alignment: 'stale', words: [] });
    });
  };

  const saveSrt = async () => {
    const content = toSrt(store.project);
    if (!content) {
      if (inspector.onToast) inspector.onToast('没有可导出的字幕。');
      return;
    }
    try {
      const savedPath = await ipcRenderer.invoke('subtitle:save-srt', { name: project.name, content });
      if (savedPath && inspector.onToast) inspector.onToast(`SRT 已保存：${savedPath}`);
    } catch (error) {
      if (inspector.onToast) inspector.onToast(`SRT 保存失败：${error.message || error}`);
    }
  };

  const appendCandidate = (replace) => {
    if (!state.candidate) return;
    if (replace && !state.confirmReplace) {
      state.confirmReplace = true;
      inspector.render();
      return;
    }
    write((value) => {
      const existing = replace ? [] : value.cues;
      const fingerprints = new Set(existing.map((cue) => `${cue.start.toFixed(2)}|${cue.end.toFixed(2)}|${cue.text.trim()}`));
      value.cues = [...existing];
      for (const cue of state.candidate) {
        const fingerprint = `${cue.start.toFixed(2)}|${cue.end.toFixed(2)}|${cue.text.trim()}`;
        if (!replace && fingerprints.has(fingerprint)) continue;
        fingerprints.add(fingerprint);
        value.cues.push({ ...cue, id: existing.some((item) => item.id === cue.id) || value.cues.some((item) => item.id === cue.id) ? uid() : cue.id });
      }
      value.sourceTrack = state.candidateTrack || state.track;
    });
    state.status = replace ? '已用本次识别结果替换字幕。' : '已将新识别字幕追加到现有字幕。';
    state.candidate = null;
    state.candidateTrack = null;
    state.confirmReplace = false;
    inspector.render();
  };

  if (state.candidate) {
    const previewItems = state.candidate.slice(0, 4).map((cue) => element('li', {},
      element('time', {}, `${cue.start.toFixed(2)}–${cue.end.toFixed(2)} 秒`), cue.text));
    panel.append(element('section', { class: 'subtitles-candidate', hidden: state.tab !== 'subtitles' },
      element('h4', {}, `识别候选 · ${state.candidate.length} 条`),
      note('候选还没有写入工程。追加会保留已校对内容；替换需要再次确认。'),
      element('ul', {}, previewItems),
      state.candidate.length > 4 ? note(`另有 ${state.candidate.length - 4} 条候选字幕。`) : null,
      state.confirmReplace
        ? element('div', { class: 'subtitles-actions' },
          button('确认替换现有字幕', () => appendCandidate(true), 'danger'),
          button('取消替换', () => { state.confirmReplace = false; inspector.render(); }, 'ghost'))
        : element('div', { class: 'subtitles-actions' },
          button('追加到现有字幕', () => appendCandidate(false), 'primary'),
          subtitles.cues.length ? button('替换现有字幕…', () => appendCandidate(true), 'ghost') : null)));
  }

  const mapped = mapCuesToOutput(project);
  const warningCount = mapped.warnings?.length || 0;
  const search = element('input', { type: 'search', value: state.query, placeholder: '查找字幕', 'aria-label': '查找字幕' });
  const replacement = element('input', { type: 'text', value: state.replacement, placeholder: '替换为（可留空）', 'aria-label': '字幕替换为' });
  const searchStatus = element('p', { class: 'subtitles-note', role: 'status' });
  const replaceAll = button('全部替换', () => {
    let count = 0;
    write((value) => {
      for (const cue of value.cues) count += replaceCueText(cue, state.query, state.replacement);
    });
    inspector.onToast?.(`已替换 ${count} 处，可撤销恢复。`);
  });
  const cueNodes = [];
  const refreshSearch = () => {
    let matches = 0;
    for (const { node, cue } of cueNodes) {
      const count = state.query ? cue.text.split(state.query).length - 1 : 0;
      node.hidden = Boolean(state.query && !count);
      matches += count;
    }
    searchStatus.textContent = state.query ? `找到 ${matches} 处 · 精确匹配，区分大小写` : '搜索所有源字幕；替换只修改文字，不剪切音视频。';
    replaceAll.disabled = !matches || state.query === state.replacement;
    replaceAll.textContent = matches ? `全部替换（${matches} 处）` : '全部替换';
  };
  search.addEventListener('input', () => { state.query = search.value; refreshSearch(); });
  replacement.addEventListener('input', () => { state.replacement = replacement.value; refreshSearch(); });
  panel.append(element('details', { class: 'subtitles-section subtitles-search', hidden: state.tab !== 'subtitles' },
    element('summary', {}, '查找替换'), field('查找', search), field('替换为', replacement),
    element('div', { class: 'subtitles-actions' }, replaceAll), searchStatus));
  const { cues: orderedCues, firstOccurrences } = orderCuesByOutput(subtitles.cues, mapped);
  const clearAll = button('清空全部', () => {
    if (state.starting || state.jobId || !clearAllSubtitles(store, state)) return;
    state.status = '已清空全部字幕，可撤销恢复。';
    inspector.render();
  }, 'ghost');
  clearAll.disabled = subtitles.cues.length === 0 || Boolean(state.starting || state.jobId);
  panel.append(element('section', { class: 'subtitles-section', hidden: state.tab !== 'subtitles' },
    element('div', { class: 'subtitles-list-heading' }, element('h4', {}, `字幕 · ${subtitles.cues.length}`),
      element('div', { class: 'subtitles-actions' },
        clearAll, button('添加', addCue))),
    warningCount ? note(`${warningCount} 条字幕跨过剪切点，需检查时间后才会显示。`, 'warning') : null,
    subtitles.cues.length ? orderedCues.map((cue, index) => {
      const text = element('textarea', { rows: 2, 'aria-label': `字幕 ${index + 1} 文字`, spellcheck: 'false' });
      text.value = cue.text;
      const resizeText = () => {
        text.style.height = 'auto';
        text.style.height = `${Math.max(text.scrollHeight, 42)}px`;
      };
      text.addEventListener('input', resizeText);
      requestAnimationFrame(resizeText);
      text.addEventListener('change', () => updateCue(cue.id, (target, value) => {
        const oldCount = semanticWords(target.text, value.language).length;
        const nextWords = semanticWords(text.value, value.language);
        target.text = text.value;
        if (target.alignment === 'valid' && target.words.length) {
          const aligned = alignedWordTexts(text.value, value.language);
          if (oldCount !== nextWords.length || aligned.length !== target.words.length) target.alignment = 'stale';
          else target.words = target.words.map((word, wordIndex) => ({ ...word, text: aligned[wordIndex] }));
        } else if (oldCount !== nextWords.length) target.alignment = 'stale';
      }));
      const start = numberInput(cue.start, { max: project.media.screen.duration, step: 0.01, label: `第 ${index + 1} 条字幕开始秒` });
      const end = numberInput(cue.end, { max: project.media.screen.duration, step: 0.01, label: `第 ${index + 1} 条字幕结束秒` });
      start.addEventListener('change', () => {
        const next = Number(start.value);
        if (!Number.isFinite(next)) return;
        updateCue(cue.id, (target) => {
          target.start = Math.min(Math.max(next, 0), target.end - 0.01);
          target.alignment = 'stale';
        });
      });
      end.addEventListener('change', () => {
        const next = Number(end.value);
        if (!Number.isFinite(next)) return;
        updateCue(cue.id, (target) => {
          target.end = Math.max(target.start + 0.01, Math.min(next, project.media.screen.duration));
          target.alignment = 'stale';
        });
      });
      const remove = button('×', () => { write((value) => { value.cues = value.cues.filter((item) => item.id !== cue.id); }); if (store.selection?.type === 'subtitle' && store.selection.id === cue.id) store.select(null); }, 'danger');
      remove.title = '删除字幕';
      const occurrences = mapped.filter((item) => item.id === cue.id);
      const occurrence = firstOccurrences.get(cue.id);
      const selected = store.selection?.type === 'subtitle' && store.selection.id === cue.id;
      const locate = element('button', {
        type: 'button', class: 'subtitle-cue-time',
        title: !occurrence ? '此字幕未出现在成片中' : occurrences.length > 1
          ? `此字幕在成片中出现 ${occurrences.length} 次。定位到此处后，可在时间线上选择其他位置。` : '定位并编辑字幕',
        'aria-label': occurrence ? `定位至 ${formatOutputTime(occurrence.start)}${occurrences.length > 1 ? `，成片中共出现 ${occurrences.length} 次` : ''}，${cue.text}` : `字幕未出现在成片中，${cue.text}`,
        onclick: () => { store.select({ type: 'subtitle', id: cue.id }); if (occurrence) inspector.preview.seek(occurrence.start); },
      }, occurrence ? formatOutputTime(occurrence.start) : '—');
      const node = element('article', { class: `subtitle-cue${selected ? ' selected' : ''}`, 'data-cue-id': cue.id },
        element('div', { class: 'subtitle-cue-row' }, locate, text, remove),
        selected ? element('div', { class: 'subtitle-times' }, field('原片起点（秒）', start), field('原片终点（秒）', end)) : null);
      cueNodes.push({ node, cue });
      return node;
    }) : note('还没有字幕。可手动添加，也可从录制音轨识别。')));

  panel.append(element('div', { class: 'subtitles-actions subtitle-export', hidden: state.tab !== 'subtitles' }, button('导出 SRT', saveSrt, 'ghost')));
  refreshSearch();
  return [panel];
}

module.exports = { renderSubtitlesPanel, semanticWords, alignedWordTexts, replaceCueText, formatOutputTime, clearAllSubtitles, orderCuesByOutput };
