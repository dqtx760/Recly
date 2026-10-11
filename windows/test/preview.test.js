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

const microphoneNode = {
  duration: 10, currentTime: 0, paused: true, seeking: false, playbackRate: 1, volume: 0,
  play() { this.paused = false; return Promise.resolve(); },
  pause() { this.paused = true; },
};
const systemNode = { ...microphoneNode };
preview.microphone = { node: microphoneNode, offset: 0, duration: 10 };
preview.system = { node: systemNode, offset: 0, duration: 10 };
preview.store.project.timeline.segments = [
  { id: 'quiet-system', sourceStart: 0, sourceEnd: 10, speed: 1, audio: { microphoneVolume: 0.2, isSystemMuted: true } },
  { id: 'quiet-microphone', sourceStart: 0, sourceEnd: 10, speed: 1, audio: { isMicrophoneMuted: true, systemVolume: 0.75, isSystemMuted: false } },
];
preview.time = 3;
preview.syncMedia(true);
assert.equal(microphoneNode.volume, 0.2, '预览麦克风音量应读取当前主片段覆盖');
assert.equal(systemNode.volume, 0, '预览系统声音应读取当前片段静音覆盖');
preview.time = 11;
preview.syncMedia(true);
assert.equal(microphoneNode.volume, 0, '切到下一段后应应用其麦克风静音覆盖');
assert.equal(systemNode.volume, 0.75, '切到下一段后应应用其系统声音音量覆盖');

const backgroundNode = {
  duration: 2, currentTime: 0, paused: true, seeking: false, playbackRate: 1,
  pause() { this.paused = true; },
  play() { this.paused = false; return Promise.resolve(); },
};
const backgroundPreview = Object.create(Preview.prototype);
backgroundPreview.backgroundVideo = { node: backgroundNode, duration: 2, isLooping: true };
backgroundPreview.time = 5.5;
backgroundPreview.playing = false;
backgroundPreview.screen = null;
backgroundPreview.syncBackgroundMedia(true);
assert.equal(backgroundNode.currentTime, 1.5, '预览动态背景应按成片输出时间循环定位');

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
  assert.equal(waitingVideo.paused, false, '定位主视频时应允许解码继续，不能主动暂停造成 seek 死锁');
  waitingVideo.paused = true;
  waitingPreview.syncMedia(false);
  assert.equal(waitingVideo.paused, false, '剪辑后暂停中的主视频即使仍在 seek 也必须恢复解码');
  assert.equal(audibleTrack.paused, true, '主视频恢复解码期间仍等待画面再播放声音');
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
preparingPreview.store = preview.store;
preparingPreview.time = 3;
preparingPreview.playing = false;
preparingPreview.preparingProxy = true;
preparingPreview.quality = 'balanced';
preparingPreview.originalScreenUrl = 'file:///project/screen.mp4';
preparingPreview.activeScreenUrl = preparingPreview.originalScreenUrl;
preparingPreview.screen = { node: { src: 'screen.mp4', load() { this.loads = (this.loads || 0) + 1; } }, offset: 0, duration: 10 };
const proxySwitchStates = [];
preparingPreview.syncMedia = () => { proxySwitchStates.push(preparingPreview.playing); };
preparingPreview.invalidate = () => {};
preparingPreview.onState = () => {};
preparingPreview.play();
assert.equal(preparingPreview.playing, true, '预览素材生成期间应立即尝试播放原片');
preparingPreview.readyProxyFile = 'screen.preview.mp4';
assert.equal(preparingPreview.applyReadyProxy(), true, '代理生成后应自动切入流畅预览');
assert.deepEqual(proxySwitchStates.slice(-3), [false, false, true], '切源前应暂停所有媒体，切源后再恢复同步播放');
assert.match(preparingPreview.screen.node.src, /screen\.preview\.mp4$/);
assert.equal(preparingPreview.playing, true);
preparingPreview.pause();
assert.equal(preparingPreview.playing, false);
assert.equal(preparingPreview.screen.node.loads, 1, '代理素材只应加载一次');
preparingPreview.readyProxyFile = 'screen.preview.mp4';
preparingPreview.applyReadyProxy();
assert.equal(preparingPreview.playing, false, '暂停状态下切换代理不应自动播放');
console.log('preview sync tests passed');
