'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { listBuiltInMusic, importBuiltInMusic } = require('../src/main/music-library');
const root = path.join(__dirname, '..', 'assets', 'music');
let invoke;
const calls = [];
const players = [];
class AudioMock {
  constructor(url) { this.src = url; this.paused = true; players.push(this); }
  async play() { this.paused = false; }
  pause() { this.paused = true; }
}
global.Audio = AudioMock;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { ipcRenderer: { invoke: (...args) => { calls.push(args); return invoke(...args); } } };
  if (request === '../common' && parent.filename.endsWith('music-library-panel.js')) return {
    element: (tag, attributes, ...children) => ({ tag, attributes, children }), icon: () => '', formatTime: String,
  };
  return originalLoad.call(this, request, parent, isMain);
};
const { MusicLibraryPanel } = require('../src/renderer/editor/music-library-panel');
Module._load = originalLoad;

(async () => {
  const tracks = listBuiltInMusic(root);
  assert.equal(tracks.length, 16);
  assert.equal(tracks[0].name, 'Focus Flow');
  assert.ok(tracks.every((track) => track.duration > 0 && track.url.startsWith('file:')));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recly-music-test-'));
  fs.writeFileSync(path.join(directory, 'project.json'), '{}');
  let converted = false;
  const media = { async finalizeAudio(source, target) {
    assert.ok(fs.readFileSync(source).equals(fs.readFileSync(path.join(root, 'focus-flow.mp3'))));
    fs.writeFileSync(target, 'audio-fixture');
    converted = true;
    return { hasAudio: true, duration: tracks[0].duration };
  } };
  await assert.rejects(importBuiltInMusic({ root, directory, id: '../outside' }, media), /未找到/);
  assert.equal(converted, false);
  const asset = await importBuiltInMusic({ root, directory, id: tracks[0].id }, media);
  assert.ok(converted);
  assert.equal(asset.name, 'Focus Flow');
  assert.ok(fs.existsSync(path.join(directory, asset.file)), '加入工程后必须使用工程自身的素材副本');
  assert.equal(fs.readdirSync(path.join(directory, 'media')).filter((name) => name.startsWith('audio-source-')).length, 0);

  let added = null, time = 7, timelinePauses = 0;
  const panel = new MusicLibraryPanel({ directory, addClip: (clip, start) => { added = { clip, start }; }, getTime: () => time,
    pauseTimeline: () => { timelinePauses += 1; }, onChange() {}, onToast(message) { throw Error(message); } });
  invoke = async () => tracks;
  await panel.open();
  assert.equal(panel.tracks.length, 16);
  await panel.togglePreview(tracks[0]);
  const first = players.at(-1);
  await panel.togglePreview(tracks[1]);
  assert.equal(first.paused, true);
  assert.equal(first.src, '');
  assert.equal(timelinePauses, 2);
  let finishAdd;
  invoke = () => new Promise((resolve) => { finishAdd = resolve; });
  const before = calls.length;
  const adding = panel.add(tracks[0]);
  await panel.add(tracks[0]);
  assert.equal(calls.length - before, 1, '忙碌时不能重复添加同一首音乐');
  time = 11;
  finishAdd(asset);
  await adding;
  assert.equal(added.start, 7, '素材放在点击添加时的播放头位置');
  assert.equal(panel.visible, false);
  assert.equal(players.at(-1).paused, true);
  assert.equal(panel.busy, null);

  added = null;
  panel.visible = true;
  invoke = async () => null;
  await panel.add();
  assert.equal(calls.at(-1)[0], 'project:import-audio');
  assert.equal(added, null, '取消本地导入不能添加空音频');
  assert.equal(panel.visible, true);
  panel.tracks = null;
  let finishLoad;
  invoke = () => new Promise((resolve) => { finishLoad = resolve; });
  const loading = panel.open();
  panel.deactivate();
  finishLoad(tracks);
  await loading;
  assert.equal(panel.visible, false, '离开音频页后，迟到的目录结果不能重新打开音乐页');
  console.log('音乐库测试通过：16 首素材、受限导入、工程副本、单首试听、去重添加、插入位置、取消及离页清理。');
})().catch((error) => { console.error(error); process.exitCode = 1; });
