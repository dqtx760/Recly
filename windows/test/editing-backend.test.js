'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { resolveAudio } = require('../src/core/audio');
const { normalizeProject, makeProject } = require('../src/core/model');
const { importAsset, readClipboardImage } = require('../src/main/asset-import');
const media = require('../src/main/ffmpeg');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recly-editing-backend-'));
  const project = makeProject({ name: '编辑验收', media: { screen: { duration: 3, width: 640, height: 360 } }, capture: {} });
  fs.writeFileSync(path.join(directory, 'project.json'), JSON.stringify(project));
  const inherited = resolveAudio({ systemVolume: 0.7, isSystemMuted: true }, { isSystemMuted: false });
  assert.equal(inherited.systemVolume, 0.7);
  assert.equal(inherited.isSystemMuted, false);
  assert.equal(resolveAudio({ microphoneVolume: 0.8 }, { microphoneVolume: 0 }).microphoneVolume, 0);

  const bitmap = { isEmpty: () => false, getSize: () => ({ width: 2, height: 3 }), toPNG: () => Buffer.from('fixture-png') };
  const clipboardBytes = Buffer.from('fixture-clipboard-png');
  const clipboardImage = await readClipboardImage({ read: async () => [{
    types: ['text/plain', 'image/png'],
    getType: async (type) => {
      assert.equal(type, 'image/png');
      return { arrayBuffer: async () => clipboardBytes.buffer.slice(clipboardBytes.byteOffset, clipboardBytes.byteOffset + clipboardBytes.byteLength) };
    },
  }] }, { createFromBuffer: (bytes) => ({ bytes, isEmpty: () => false }), createEmpty: () => ({ isEmpty: () => true }) });
  assert.deepEqual(clipboardImage.bytes, clipboardBytes, 'Electron ClipboardItem Blob 转成 NativeImage buffer');
  const emptyClipboardImage = await readClipboardImage({ read: async () => [{ types: ['text/plain'] }] }, { createEmpty: () => ({ isEmpty: () => true }) });
  assert.equal(emptyClipboardImage.isEmpty(), true, '没有图片 MIME 时返回空图');
  await assert.rejects(readClipboardImage({ read: async () => { throw new Error('clipboard read failed'); } }, {}), /clipboard read failed/);
  const first = await importAsset({ directory, kind: 'clipboard', image: bitmap }, media, {});
  const second = await importAsset({ directory, kind: 'clipboard', image: bitmap }, media, {});
  assert.notEqual(first.file, second.file);
  assert.equal(fs.readFileSync(path.join(directory, first.file), 'utf8'), 'fixture-png');
  await assert.rejects(importAsset({ directory, kind: 'clipboard', image: { isEmpty: () => true } }, media, {}), /剪贴板/);
  project.canvas.background = { kind: 'video', file: 'media/bg.mp4', index: 'media/bg.index.json', width: 640, height: 360, duration: 3, isLooping: true };
  project.timeline.stickerClips.push({ id: 'image', timing: { startTime: 1, duration: 1 }, relativePath: first.file });
  project.timeline.segments[0].audio = { isMicrophoneMuted: false, microphoneVolume: 0.25 };
  const reopened = normalizeProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(reopened.canvas.background, project.canvas.background);
  assert.deepEqual(reopened.timeline.stickerClips, project.timeline.stickerClips);
  assert.deepEqual(reopened.timeline.segments[0].audio, project.timeline.segments[0].audio);

  media.resolveBinaries(null);
  const input = path.join(directory, 'tone.wav');
  await media.ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:a', 'pcm_s16le', input]);
  const output = path.join(directory, 'edited.m4a');
  const segments = [
    { id: 'last', sourceStart: 2, sourceEnd: 3, speed: 2, audio: { isMicrophoneMuted: false, microphoneVolume: 0.25 } },
    { id: 'first', sourceStart: 0, sourceEnd: 1, speed: 1 },
  ];
  const track = { file: input, kind: 'microphone', offset: 0, baseVolume: 0.8, baseMuted: true };
  await media.ffmpeg(media.buildMuxArguments({ videoFile: null, audioTracks: [track], segments, sourceDuration: 3, outputDuration: 1.5, outputFile: output }));
  const decoded = path.join(directory, 'edited.pcm');
  await media.ffmpeg(['-loglevel', 'error', '-i', output, '-f', 'f32le', '-ac', '1', '-ar', '48000', decoded]);
  const bytes = fs.readFileSync(decoded);
  const rms = (start, end) => {
    let sum = 0;
    const lo = Math.round(start * 48000), hi = Math.min(Math.round(end * 48000), bytes.length / 4);
    for (let i = lo; i < hi; i++) sum += bytes.readFloatLE(i * 4) ** 2;
    return Math.sqrt(sum / (hi - lo));
  };
  assert.ok(rms(0.1, 0.4) > 0.018 && rms(0.1, 0.4) < 0.027, '片段解除全局静音并应用独立音量');
  assert.ok(rms(0.7, 1.3) < 0.0001, '后一片段继续继承全局静音');
  assert.ok(Math.abs((await media.probe(output)).duration - 1.5) < 0.05, '重排与变速后的音频长度');
  console.log('编辑后端验收通过：音量覆盖、唯一素材、保存重开、真实 FFmpeg 重排/变速/静音。');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
