'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TranscriptionManager, audioRangesForTrack, parseWhisperJson, retainedSourceRanges, resolveWhisperPaths } = require('../src/main/transcription');

function unitTests() {
  const project = {
    media: {
      screen: { duration: 10 },
      microphone: { offset: -2 },
      systemAudio: { offset: 2 },
    },
    timeline: { segments: [
      { sourceStart: 0, sourceEnd: 3 },
      { sourceStart: 2, sourceEnd: 5 },
      { sourceStart: 7, sourceEnd: 9 },
    ] },
  };
  assert.deepEqual(retainedSourceRanges(project, 'retained'), [
    { sourceStart: 0, sourceEnd: 5 },
    { sourceStart: 7, sourceEnd: 9 },
  ]);
  assert.deepEqual(audioRangesForTrack(project, 'microphone', 'retained', 10), [
    { audioStart: 2, duration: 5, sourceStart: 0 },
    { audioStart: 9, duration: 1, sourceStart: 7 },
  ]);
  assert.deepEqual(audioRangesForTrack(project, 'systemAudio', 'retained', 10), [
    { audioStart: 0, duration: 3, sourceStart: 2 },
    { audioStart: 5, duration: 2, sourceStart: 7 },
  ]);

  const cues = parseWhisperJson({ transcription: [{
    offsets: { from: 0, to: 2000 },
    text: '你好',
    tokens: [
      { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
      { text: '你', offsets: { from: 0, to: 700 } },
      { text: '好', offsets: { from: 700, to: 2000 } },
    ],
  }] }, { sourceStart: -1, sourceEnd: 1, screenDuration: 10 });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, '好');
  assert.equal(cues[0].originalText, '好');
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 1);
  assert.equal(cues[0].alignment, 'valid');
  assert.deepEqual(cues[0].words, [
    { start: 0, end: 0, text: '你' },
    { start: 0, end: 1, text: '好' },
  ].filter((word) => word.end > word.start));
  const rangeClipped = parseWhisperJson({ transcription: [{
    offsets: { from: 0, to: 3000 }, text: '超出保留区间',
    tokens: [{ text: '超出保留区间', offsets: { from: 0, to: 3000 } }],
  }] }, { sourceStart: 7, sourceEnd: 9, screenDuration: 10 });
  assert.equal(rangeClipped[0].end, 9);
}

async function realWhisperIntegration() {
  const audioFile = path.resolve(process.env.RECLY_ASR_TEST_AUDIO);
  const sampleDirectory = path.dirname(audioFile);
  const { executable, model } = resolveWhisperPaths();
  assert.ok(fs.existsSync(audioFile), 'RECLY_ASR_TEST_AUDIO 指定的中文音频必须存在');
  assert.ok(fs.existsSync(executable), '真实 whisper-cli.exe 必须存在');
  assert.ok(fs.existsSync(model), '真实 ggml-small.bin 模型必须存在');

  const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'recly-asr-test-'));
  const tempDirectory = path.join(isolatedUserData, 'jobs');
  const environment = { ...process.env, RECLY_WHISPER_EXE: executable, RECLY_WHISPER_MODEL: model };
  const media = require('../src/main/ffmpeg');
  media.resolveBinaries(null);
  const { duration } = await media.probe(audioFile);
  assert.ok(Number.isFinite(duration) && duration > 0, '测试音频时长必须有效');
  const manager = new TranscriptionManager({ media, userDataPath: isolatedUserData, tempDirectory, env: environment });
  try {
    assert.equal(manager.environment().ready, true);
    const { jobId } = await manager.generate({
      directory: sampleDirectory,
      project: {
        media: {
          screen: { duration },
          microphone: { file: path.basename(audioFile), offset: 0, duration },
        },
        timeline: { segments: [{ sourceStart: 0, sourceEnd: duration, speed: 1 }] },
      },
      track: 'microphone',
      scope: 'source',
    });
    const deadline = Date.now() + 3 * 60 * 1000;
    let job;
    while (Date.now() < deadline) {
      job = manager.get(jobId);
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    assert.equal(job.progress, 1);
    assert.ok(['cuda', 'cpu'].includes(job.backend));
    assert.ok(job.result.cues.length > 0, '实际 whisper JSON 应生成字幕 cue');
    const transcript = job.result.cues.map((cue) => cue.text).join('');
    assert.match(transcript, /[\u3400-\u9fff]/, '结果应含识别出的中文');
    for (const cue of job.result.cues) {
      assert.ok(cue.start >= 0 && cue.end <= duration && cue.end > cue.start);
      assert.ok(cue.words.every((word) => word.start >= cue.start && word.end <= cue.end && word.end > word.start));
    }
    process.stdout.write(`真实 whisper.cpp 通过：${job.backend}，${job.result.cues.length} 条字幕，${transcript.slice(0, 80)}\n`);
  } finally {
    await manager.close();
    const cacheDirectory = path.join(isolatedUserData, 'whisper-model-cache');
    const modelStat = fs.statSync(model);
    const key = crypto.createHash('sha256').update(`${fs.realpathSync(model)}\0${modelStat.size}\0${modelStat.mtimeMs}`).digest('hex').slice(0, 16);
    const cachedModel = path.join(cacheDirectory, `${key}.bin`);
    if (fs.existsSync(cachedModel)) fs.unlinkSync(cachedModel);
    for (const directory of [cacheDirectory, tempDirectory, isolatedUserData]) {
      if (fs.existsSync(directory)) fs.rmdirSync(directory);
    }
  }
}

async function main() {
  unitTests();
  assert.ok(resolveWhisperPaths().executable.toLowerCase().endsWith('whisper-cli.exe'));
  process.stdout.write('语音识别单元测试通过：音轨偏移、保留区间与词时间裁切。\n');
  if (process.env.RECLY_ASR_TEST_AUDIO) await realWhisperIntegration();
  else process.stdout.write('跳过真实语音识别：未设置 RECLY_ASR_TEST_AUDIO；可显式提供中文音频，程序和模型沿用环境变量或 runtime 默认路径。\n');
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
