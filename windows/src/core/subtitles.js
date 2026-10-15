'use strict';

const { randomUUID } = require('node:crypto');

const DEFAULT_STYLE = Object.freeze({
  fontSize: 48,
  color: '#FFFFFF',
  backgroundColor: '#000000',
  backgroundOpacity: 1,
  baselineY: 0.86,
});

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const isFiniteNumber = (value) => Number.isFinite(Number(value));
const isHexColor = (value) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);

function normalizeSubtitleLanguage(language) {
  if (typeof language !== 'string' || !language.trim() || typeof Intl.getCanonicalLocales !== 'function') return 'zh';
  try {
    return Intl.getCanonicalLocales(language.trim())[0] || 'zh';
  } catch {
    return 'zh';
  }
}

function normalizeSubtitles(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const rawStyle = input.style && typeof input.style === 'object' ? input.style : {};
  const style = {
    fontSize: isFiniteNumber(rawStyle.fontSize) ? clamp(Number(rawStyle.fontSize), 12, 160) : DEFAULT_STYLE.fontSize,
    color: isHexColor(rawStyle.color) ? rawStyle.color.toUpperCase() : DEFAULT_STYLE.color,
    backgroundColor: isHexColor(rawStyle.backgroundColor) ? rawStyle.backgroundColor.toUpperCase() : DEFAULT_STYLE.backgroundColor,
    backgroundOpacity: isFiniteNumber(rawStyle.backgroundOpacity) ? clamp(Number(rawStyle.backgroundOpacity), 0, 1) : DEFAULT_STYLE.backgroundOpacity,
    baselineY: isFiniteNumber(rawStyle.baselineY) ? clamp(Number(rawStyle.baselineY), 0.1, 0.9) : DEFAULT_STYLE.baselineY,
  };
  const cues = (Array.isArray(input.cues) ? input.cues : []).flatMap((rawCue) => {
    if (!rawCue || typeof rawCue !== 'object') return [];
    const start = Number(rawCue.start);
    const end = Number(rawCue.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return [];
    const text = typeof rawCue.text === 'string' ? rawCue.text : '';
    const words = (Array.isArray(rawCue.words) ? rawCue.words : []).flatMap((rawWord) => {
      if (!rawWord || typeof rawWord !== 'object') return [];
      const rawStart = Number(rawWord.start);
      const rawEnd = Number(rawWord.end);
      if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart < 0 || rawEnd <= rawStart) return [];
      const wordStart = Math.max(rawStart, start);
      const wordEnd = Math.min(rawEnd, end);
      if (wordEnd <= wordStart) return [];
      return [{ start: wordStart, end: wordEnd, text: typeof rawWord.text === 'string' ? rawWord.text : '' }];
    });
    return [{
      id: typeof rawCue.id === 'string' && rawCue.id ? rawCue.id : randomUUID(),
      start,
      end,
      text,
      originalText: typeof rawCue.originalText === 'string' ? rawCue.originalText : text,
      alignment: rawCue.alignment === 'stale' ? 'stale' : 'valid',
      words,
    }];
  });

  return {
    enabled: input.enabled !== false,
    sourceTrack: input.sourceTrack === 'systemAudio' ? 'systemAudio' : 'microphone',
    language: normalizeSubtitleLanguage(input.language),
    style,
    cues,
  };
}

function alignedTextTokens(text, language = 'zh') {
  if (typeof Intl.Segmenter !== 'function') return null;
  const value = typeof text === 'string' ? text : '';
  let parts;
  try {
    parts = Array.from(new Intl.Segmenter(normalizeSubtitleLanguage(language), { granularity: 'word' }).segment(value));
  } catch {
    return null;
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

function wordsForCurrentText(cue, language) {
  if (cue.words.map((word) => word.text).join('').trim() === cue.text.trim()) return cue.words;
  const tokens = alignedTextTokens(cue.text, language);
  if (!tokens || tokens.length !== cue.words.length) return null;
  return cue.words.map((word, index) => ({ ...word, text: tokens[index] }));
}

/// 将源录制时间的字幕按每个保留片段分别映射到成片时间。
/// 有词时间戳时只映射实际保留的词；未对齐字幕仅在完整保留时显示。
function mapCuesToOutput(project) {
  const subtitles = normalizeSubtitles(project?.subtitles);
  const segments = Array.isArray(project?.timeline?.segments) ? project.timeline.segments : [];
  const mapped = [];
  const warnings = [];
  let outputStart = 0;

  for (const segment of segments) {
    const sourceStart = Number(segment?.sourceStart);
    const sourceEnd = Number(segment?.sourceEnd);
    const speed = Number(segment?.speed);
    if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || !Number.isFinite(speed)
      || sourceEnd <= sourceStart || speed <= 0) continue;
    const segmentDuration = (sourceEnd - sourceStart) / speed;

    for (const cue of subtitles.cues) {
      const intersectionStart = Math.max(cue.start, sourceStart);
      const intersectionEnd = Math.min(cue.end, sourceEnd);
      if (intersectionEnd <= intersectionStart) continue;

      const whollyRetained = cue.start >= sourceStart && cue.end <= sourceEnd;
      if (whollyRetained) {
        mapped.push({
          ...cue,
          sourceStart: cue.start,
          sourceEnd: cue.end,
          start: outputStart + (cue.start - sourceStart) / speed,
          end: outputStart + (cue.end - sourceStart) / speed,
          segmentId: segment.id || null,
        });
        continue;
      }

      if (cue.alignment === 'valid' && cue.words.length) {
        const alignedWords = wordsForCurrentText(cue, subtitles.language);
        const words = (alignedWords || []).flatMap((word) => {
          // 词横跨切口时不显示整个词，避免把已剪掉的音节仍写在字幕里。
          if (word.start < sourceStart || word.end > sourceEnd) return [];
          const keptStart = word.start;
          const keptEnd = word.end;
          return [{
            ...word,
            sourceStart: keptStart,
            sourceEnd: keptEnd,
            start: outputStart + (keptStart - sourceStart) / speed,
            end: outputStart + (keptEnd - sourceStart) / speed,
          }];
        });
        const text = words.map((word) => word.text).join('').trim();
        if (words.length && text) {
          mapped.push({
            ...cue,
            text,
            words,
            sourceStart: words[0].sourceStart,
            sourceEnd: words[words.length - 1].sourceEnd,
            start: words[0].start,
            end: words[words.length - 1].end,
            segmentId: segment.id || null,
          });
        }
        if (!alignedWords || !words.length || !text) warnings.push({ cueId: cue.id, message: `字幕“${cue.text}”的当前文字无法与保留词时间戳可靠对应，已隐藏跨剪切部分。` });
        continue;
      }

      warnings.push({ cueId: cue.id, message: `字幕“${cue.text}”跨越剪切边界且没有可靠词对齐，已隐藏以免显示被剪掉的内容。` });
    }
    outputStart += segmentDuration;
  }

  mapped.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  mapped.warnings = warnings;
  return mapped;
}

const mappedCuesCache = new WeakMap();

function mappedCuesForActive(project) {
  if (!project || typeof project !== 'object' || !Number.isSafeInteger(project.revision)) {
    return mapCuesToOutput(project);
  }
  const cached = mappedCuesCache.get(project);
  if (cached?.revision === project.revision) return cached.cues;
  const cues = mapCuesToOutput(project);
  mappedCuesCache.set(project, { revision: project.revision, cues });
  return cues;
}

function activeCues(project, sourceTime, outputTime) {
  const time = Number(sourceTime);
  const output = Number(outputTime);
  if (!Number.isFinite(time) || project?.subtitles?.enabled === false) return [];
  const seen = new Set();
  return mappedCuesForActive(project).filter((cue) => {
    if (time < cue.sourceStart || time >= cue.sourceEnd) return false;
    if (Number.isFinite(output) && (output < cue.start || output >= cue.end)) return false;
    const occurrence = Number.isFinite(output) ? `${cue.id}|${cue.start}|${cue.end}` : cue.id;
    if (seen.has(occurrence)) return false;
    seen.add(occurrence);
    return true;
  });
}

function srtTimestamp(seconds) {
  const milliseconds = Math.max(Math.round(Number(seconds) * 1000), 0);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(remainder).padStart(3, '0')}`;
}

function toSrt(project) {
  return mapCuesToOutput(project)
    .filter((cue) => cue.text.trim() && cue.end > cue.start)
    .map((cue, index) => `${index + 1}\r\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\r\n${cue.text.trim()}\r\n`)
    .join('\r\n');
}

module.exports = { DEFAULT_STYLE, normalizeSubtitleLanguage, normalizeSubtitles, mapCuesToOutput, activeCues, toSrt };
