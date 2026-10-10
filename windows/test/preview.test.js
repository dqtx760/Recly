'use strict';

const assert = require('node:assert/strict');
global.location = { search: '' };
const { Preview } = require('../src/renderer/editor/preview');

const node = {
  duration: 10, currentTime: 0, paused: false, seeking: true, playbackRate: 1,
  volume: 0, seeks: 0,
  play() { return Promise.resolve(); },
  pause() { this.paused = true; },
};
let position = 0;
Object.defineProperty(node, 'currentTime', {
  get() { return position; },
  set(value) { position = value; node.seeks += 1; },
});

const preview = Object.create(Preview.prototype);
preview.store = { project: { timeline: { segments: [{ sourceStart: 0, sourceEnd: 10, speed: 1 }] }, audio: {
  isMicrophoneMuted: false, microphoneVolume: 1, isSystemMuted: false, systemVolume: 1,
} } };
preview.time = 3;
preview.playing = true;
preview.screen = { node, offset: 0, duration: 10 };
preview.camera = null;
preview.microphone = null;
preview.system = null;

preview.syncMedia(false);
assert.equal(node.seeks, 0, '等待未完成的 seek 时不应再次定位');
node.seeking = false;
preview.syncMedia(false);
assert.equal(node.seeks, 1, 'seek 完成后应追上主时钟');
preview.playing = false;
preview.syncMedia(true);
assert.equal(node.seeks, 1, '暂停时已在目标帧不应重复 seek');

let draws = 0;
preview.canvas = { width: 100, height: 100 };
preview.ctx = {};
preview.store.zoomClips = [];
preview.store.pointerTrack = null;
preview.store.project.media = { screen: { width: 100, height: 100 } };
preview.compositor = { draw() { draws += 1; } };
node.readyState = 1;
preview.draw();
assert.equal(draws, 0, '等待新画面时保留上一帧');
node.readyState = 4;
preview.draw();
assert.equal(draws, 1, '新画面就绪后正常绘制');

const waitingVideo = {
  duration: 10, currentTime: 2, paused: false, seeking: true, readyState: 1,
  pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
};
const audibleTrack = {
  duration: 10, currentTime: 2, paused: false, seeking: false, readyState: 4,
  pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
};
const waitingPreview = Object.create(Preview.prototype);
waitingPreview.store = preview.store;
waitingPreview.time = 2;
waitingPreview.playing = true;
waitingPreview.lastTick = 1000;
waitingPreview.screen = { node: waitingVideo, offset: 0, duration: 10, inRange: true };
waitingPreview.camera = null;
waitingPreview.microphone = { node: audibleTrack, offset: 0, duration: 10, inRange: true };
waitingPreview.system = null;
waitingPreview.onTime = () => {};
waitingPreview.dirty = false;
waitingPreview.lastDraw = 0;
let paints = 0;
waitingPreview.draw = () => { paints += 1; };
const oldAnimationFrame = global.requestAnimationFrame;
global.requestAnimationFrame = () => {};
try {
  waitingPreview.syncMedia(true);
  assert.equal(audibleTrack.paused, true, '视频正在定位时，音频不应先行播放');
  waitingPreview.frame(2000);
  assert.equal(waitingPreview.time, 2, '等待视频画面时，时间线不应越过停住的画面');
  waitingVideo.seeking = false;
  waitingVideo.readyState = 4;
  waitingPreview.frame(2016);
  assert.equal(audibleTrack.paused, false, '视频画面到位后，音频应恢复播放');
  waitingVideo.currentTime = 2.5;
  waitingPreview.frame(4016);
  assert.ok(Math.abs(waitingPreview.time - 2.5) < 0.03, '播放时间线应跟随视频媒体时钟，避免画面和声音各走各的时间');
  const painted = paints;
  waitingVideo.currentTime = 2.516;
  waitingPreview.frame(4032);
  assert.equal(paints, painted, '播放时不能每个动画帧都重绘重负载画布');
  waitingVideo.currentTime = 2.57;
  waitingPreview.frame(4070);
  assert.equal(paints, painted + 1, '超过预览帧间隔后应显示新画面');
} finally {
  global.requestAnimationFrame = oldAnimationFrame;
}

const mappedVideo = {
  duration: 7, currentTime: 1.5, paused: false, seeking: false, readyState: 4, playbackRate: 2,
  pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
};
const mappedPreview = Object.create(Preview.prototype);
mappedPreview.store = { project: { timeline: { segments: [{ sourceStart: 0, sourceEnd: 2, speed: 2 }] }, audio: preview.store.project.audio } };
mappedPreview.time = 0.5;
mappedPreview.playing = true;
mappedPreview.lastTick = 1000;
mappedPreview.lastDraw = 0;
mappedPreview.screen = { node: mappedVideo, offset: 0, duration: 7, inRange: true };
mappedPreview.camera = null;
mappedPreview.microphone = null;
mappedPreview.system = null;
mappedPreview.onTime = () => {};
mappedPreview.dirty = false;
mappedPreview.draw = () => {};
global.requestAnimationFrame = () => {};
try {
  mappedPreview.frame(2000);
  assert.equal(mappedPreview.time, 0.75, '变速片段应把视频素材时间换算成输出时间');
  mappedPreview.store.project.timeline.segments = [
    { sourceStart: 0, sourceEnd: 2, speed: 1 },
    { sourceStart: 5, sourceEnd: 7, speed: 1 },
  ];
  mappedPreview.time = 1.9;
  mappedVideo.currentTime = 2.2;
  mappedVideo.playbackRate = 1;
  mappedPreview.frame(3000);
  assert.equal(mappedPreview.time, 2, '视频到达剪辑边界时应切换到下一片段');
  assert.equal(mappedVideo.currentTime, 5, '剪辑边界应跳到下一片段的素材起点');
} finally {
  global.requestAnimationFrame = oldAnimationFrame;
}

const preparingPreview = Object.create(Preview.prototype);
preparingPreview.playing = false;
preparingPreview.preparingProxy = true;
preparingPreview.pendingPlay = false;
preparingPreview.onState = () => {};
preparingPreview.play();
assert.equal(preparingPreview.pendingPlay, true, '预览素材准备期间应记住播放请求');
assert.equal(preparingPreview.playing, false, '预览素材准备期间不播放难以实时解码的原片');
preparingPreview.toggle();
assert.equal(preparingPreview.pendingPlay, false, '再次按播放键应能取消等待中的播放');
console.log('preview sync tests passed');
