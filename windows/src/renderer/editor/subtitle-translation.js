'use strict';

const { normalizeSubtitles, mapCuesToOutput } = require('../../core/subtitles');
const { patchSubtitles } = require('./agent-bridge');

const MAX_TRANSLATION_CUES = 50;
const MAX_TRANSLATION_CHARACTERS = 5000;

const TRANSLATION_LANGUAGES = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en', label: '英语' },
  { id: 'ja', label: '日语' },
  { id: 'ko', label: '韩语' },
];

function availableAssistantBackends(value) {
  if (!Array.isArray(value)) throw new Error('AI 后端检测结果格式无效，请重新检测。');
  const ids = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id
      || typeof item.label !== 'string' || typeof item.available !== 'boolean'
      || (item.model !== null && item.model !== undefined && typeof item.model !== 'string')
      || (item.modelSource !== undefined && typeof item.modelSource !== 'string') || ids.has(item.id)) {
      throw new Error('AI 后端检测结果格式无效，请重新检测。');
    }
    ids.add(item.id);
  }
  return value.filter((item) => item.available).map(({ id, label, model, modelSource }) => ({ id, label, model, modelSource }));
}

function getTranslationTargets(project, scope = 'all', selectedId = null) {
  const cues = normalizeSubtitles(project?.subtitles).cues;
  const targets = scope === 'selected'
    ? cues.filter((cue) => cue.id === selectedId)
    : cues;
  if (!targets.length) throw new Error(scope === 'selected' ? '请先在字幕列表中选中一条字幕。' : '当前工程没有可翻译的字幕。');
  const empty = targets.find((cue) => !cue.text.trim());
  if (empty) throw new Error(`字幕 ${empty.id} 为空，先填写或删除后再翻译。`);
  if (targets.length > MAX_TRANSLATION_CUES) {
    throw new Error(`一次最多翻译 ${MAX_TRANSLATION_CUES} 条字幕；请选中单条字幕分批处理。`);
  }
  const characters = targets.reduce((total, cue) => total + cue.text.length, 0);
  if (characters > MAX_TRANSLATION_CHARACTERS) {
    throw new Error(`一次最多发送 ${MAX_TRANSLATION_CHARACTERS} 个原文字；请选中单条字幕分批处理。`);
  }
  return targets;
}

function cuesHiddenAfterTranslation(project, targets) {
  const probe = JSON.parse(JSON.stringify(project));
  patchSubtitles(probe, { cues: targets.map((cue) => ({ id: cue.id, text: `${cue.text}\u2060` })) });
  const targetIds = new Set(targets.map((cue) => cue.id));
  return [...new Set(mapCuesToOutput(probe).warnings.filter((warning) => targetIds.has(warning.cueId)).map((warning) => warning.cueId))];
}

function validateTranslationResult(result, targets) {
  if (!result || typeof result.reply !== 'string' || !Array.isArray(result.operations) || result.operations.length
    || result.historyAction !== 'none' || !result.subtitlePatch || typeof result.subtitlePatch !== 'object'
    || Array.isArray(result.subtitlePatch) || Object.keys(result.subtitlePatch).length !== 1
    || !Object.hasOwn(result.subtitlePatch, 'cues') || !Array.isArray(result.subtitlePatch.cues)) {
    throw new Error('助手没有按要求只返回 subtitlePatch.cues，本次未应用。');
  }
  const expectedIds = new Set(targets.map((cue) => cue.id));
  const translated = new Map();
  for (const update of result.subtitlePatch.cues) {
    if (!update || typeof update !== 'object' || Array.isArray(update)
      || Object.keys(update).length !== 2 || !Object.hasOwn(update, 'id') || !Object.hasOwn(update, 'text')
      || typeof update.id !== 'string' || !expectedIds.has(update.id) || translated.has(update.id)
      || typeof update.text !== 'string' || !update.text.trim() || update.text.length > 4000) {
      throw new Error('翻译结果包含重复、缺失或无效的字幕，本次未应用。');
    }
    translated.set(update.id, update.text);
  }
  if (translated.size !== expectedIds.size || [...expectedIds].some((id) => !translated.has(id))) {
    throw new Error('翻译结果没有完整覆盖本次字幕，本次未应用。');
  }
  return translated;
}

function makeSubtitlePatch(targets, translated, mode) {
  const cues = targets.map((cue) => {
    const value = translated.get(cue.id);
    const text = mode === 'bilingual' ? `${cue.text}\n${value}` : value;
    if (text.length > 4000) throw new Error(`字幕 ${cue.id} 翻译后超过 4000 字符，本次未应用。`);
    return { id: cue.id, text };
  });
  return { cues };
}

function translationMessage(language, label, targets) {
  const message = [
    `只翻译字幕，不要修改剪辑工程。目标语言：${label}。`,
    '仅返回 subtitlePatchJson，格式为 {"cues":[{"id":"原字幕ID","text":"译文"}]}。',
    'operationsJson 必须是 []，historyAction 必须是 none。cues 必须对下面每个 ID 恰好返回一次，只返回 id 和 text 两个字段；不得改时间、词时间、字幕样式、原文或其他字幕。译文应自然、简洁并适合字幕阅读。',
    `目标语言代码：${language}`,
    `目标字幕：${JSON.stringify(targets.map(({ id, text }) => ({ id, text })))}`,
  ].join('\n');
  if (message.length > 8000) throw new Error('本次翻译请求超过 AI 助手的 8,000 字符上限；请选中单条字幕分批处理。');
  return message;
}

module.exports = {
  MAX_TRANSLATION_CUES,
  MAX_TRANSLATION_CHARACTERS,
  TRANSLATION_LANGUAGES,
  availableAssistantBackends,
  getTranslationTargets,
  cuesHiddenAfterTranslation,
  validateTranslationResult,
  makeSubtitlePatch,
  translationMessage,
};
