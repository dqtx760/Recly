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
assert.equal(node.seeks, 0, '屏幕是主时钟，播放中不应为漂移 seek 自己');
preview.playing = false;
preview.syncMedia(true);
assert.equal(node.seeks, 1, '暂停时应把主画面定位到目标时间');

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

const previousPerformance = global.performance;
let syncNow = 1000;
global.performance = { now: () => syncNow };
try {
  let audioPosition = 1.9;
  const syncedAudio = {
    duration: 10, paused: false, seeking: false, playbackRate: 1, volume: 1,
    seeks: 0, pauses: 0, rateWrites: 0,
    get currentTime() { return audioPosition; },
    set currentTime(value) { audioPosition = value; this.seeks += 1; this.seeking = true; },
    pause() { this.pauses += 1; this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
  Object.defineProperty(syncedAudio, 'playbackRate', {
    get() { return this.currentRate ?? 1; },
    set(value) { this.currentRate = value; this.rateWrites += 1; },
  });
  const syncScreen = {
    duration: 10, currentTime: 2, paused: false, seeking: false, readyState: 4, playbackRate: 1,
    pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
  };
  const audioSyncPreview = Object.create(Preview.prototype);
  audioSyncPreview.store = { project: {
    timeline: { segments: [{ sourceStart: 0, sourceEnd: 10, speed: 1 }] },
    audio: { isMicrophoneMuted: false, microphoneVolume: 1, isSystemMuted: true, systemVolume: 0 },
    camera: { isHidden: false, timeOffset: 0 },
  } };
  audioSyncPreview.time = 2;
  audioSyncPreview.playing = true;
  audioSyncPreview.screen = { node: syncScreen, offset: 0, duration: 10, inRange: true };
  audioSyncPreview.camera = null;
  audioSyncPreview.microphone = { node: syncedAudio, offset: 0, duration: 10, inRange: true };
  audioSyncPreview.system = null;
  audioSyncPreview.syncMedia(false);
  assert.equal(syncedAudio.seeks, 0, 'ordinary audio drift must not hard-seek');
  assert.ok(syncedAudio.playbackRate > 1.02, 'audio behind the screen clock should receive a bounded rate correction');
  const firstCorrection = syncedAudio.playbackRate;
  syncNow += 100;
  audioSyncPreview.syncMedia(false);
  assert.equal(syncedAudio.playbackRate, firstCorrection, 'audio correction should be evaluated no more often than every 200ms');
  audioPosition = 1.95;
  syncNow += 100;
  audioSyncPreview.syncMedia(false);
  assert.ok(syncedAudio.playbackRate > 1 && syncedAudio.playbackRate < firstCorrection, 'rate correction should shrink as drift closes');
  audioPosition = 2;
  syncNow += 200;
  audioSyncPreview.syncMedia(false);
  assert.equal(syncedAudio.playbackRate, 1, 'rate correction should return to the segment speed inside the deadband');
  audioPosition = 2.1;
  syncNow += 200;
  audioSyncPreview.syncMedia(false);
  assert.ok(syncedAudio.playbackRate < 1, 'audio ahead of the screen clock should be slowed');
  assert.equal(syncedAudio.seeks, 0, 'ordinary drift must remain seek-free');
  assert.equal(syncedAudio.pauses, 0, 'ordinary drift must not pause audio');

  audioSyncPreview.store.project.timeline.segments = [
    { sourceStart: 0, sourceEnd: 2, speed: 1 },
    { sourceStart: 5, sourceEnd: 7, speed: 1.5 },
  ];
  audioSyncPreview.time = 2;
  audioSyncPreview.microphone.offset = 0.25;
  audioPosition = 4;
  syncedAudio.seeking = false;
  audioSyncPreview.syncMedia(true);
  assert.equal(syncedAudio.seeks, 1, 'a clip boundary should align audio once');
  assert.equal(audioPosition, 4.75, 'a clip boundary should preserve the audio project offset');
  assert.equal(syncedAudio.playbackRate, 1.5, 'a clip boundary should apply the new segment speed');
  syncedAudio.seeking = false;
  audioSyncPreview.syncMedia(false);
  assert.equal(syncedAudio.seeks, 1, 'settling after a boundary must not issue another seek');

  audioSyncPreview.store.project.timeline.segments = [{ sourceStart: 0, sourceEnd: 10, speed: 1 }];
  let transientAudioPosition = 2.4;
  const transientAudio = {
    duration: 10, paused: false, seeking: false, readyState: 4, playbackRate: 1, volume: 1,
    seeks: 0, pauses: 0,
    get currentTime() { return transientAudioPosition; },
    set currentTime(value) { transientAudioPosition = value; this.seeks += 1; this.seeking = true; },
    pause() { this.pauses += 1; this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
  const transientScreen = { ...syncScreen, currentTime: 2, readyState: 2 };
  const transientPreview = Object.create(Preview.prototype);
  transientPreview.store = audioSyncPreview.store;
  transientPreview.time = 2;
  transientPreview.playing = true;
  transientPreview.screen = { node: transientScreen, offset: 0, duration: 10, inRange: true };
  transientPreview.camera = null;
  transientPreview.microphone = { node: transientAudio, offset: 0, duration: 10, inRange: true };
  transientPreview.system = null;
  syncNow = 3000;
  transientPreview.syncMedia(false);
  assert.equal(transientAudio.paused, false, 'a single readyState 2 sample must not pause continuous audio');
  syncNow += 200;
  transientScreen.currentTime += 0.033;
  transientPreview.syncMedia(false);
  assert.equal(transientAudio.paused, false, 'readyState 2 with continuing media time must not be treated as a stall');
  syncNow += 249;
  transientPreview.syncMedia(false);
  assert.equal(transientAudio.paused, false, 'brief screen buffering must not pause continuous audio');
  syncNow += 1;
  transientPreview.syncMedia(false);
  assert.equal(transientAudio.paused, true, 'sustained screen buffering should hold audio with the screen clock');
  assert.equal(transientAudio.seeks, 1, 'entering a sustained visual wait should realign audio only once');
  syncNow += 100;
  transientPreview.syncMedia(false);
  assert.equal(transientAudio.seeks, 1, 'a sustained wait must not repeat audio seeks');
  transientScreen.readyState = 4;
  transientAudio.seeking = false;
  syncNow += 100;
  transientPreview.syncMedia(false);
  assert.equal(transientAudio.paused, false, 'audio should resume when the screen clock recovers');
  assert.equal(transientAudio.seeks, 1, 'recovery should resume from the one-time alignment');

  const transientCamera = {
    duration: 10, currentTime: 2, paused: false, seeking: false, readyState: 2, playbackRate: 1,
    pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
  };
  const cameraAudio = {
    duration: 10, currentTime: 5, paused: false, seeking: false, readyState: 4, playbackRate: 1, volume: 1,
    pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
  };
  const transientCameraPreview = Object.create(Preview.prototype);
  transientCameraPreview.store = audioSyncPreview.store;
  transientCameraPreview.time = 2;
  transientCameraPreview.playing = true;
  transientCameraPreview.screen = { node: syncScreen, offset: 0, duration: 10, inRange: true };
  transientCameraPreview.camera = { node: transientCamera, offset: 0, duration: 10, inRange: true };
  transientCameraPreview.microphone = { node: cameraAudio, offset: 0, duration: 10, inRange: true };
  transientCameraPreview.system = null;
  syncNow = 4000;
  transientCameraPreview.syncMedia(false);
  assert.equal(cameraAudio.paused, false, 'a camera current frame at readyState 2 must not block audio');
  assert.equal(transientCamera.paused, false, 'a camera current frame at readyState 2 should keep playing during the grace period');
  syncNow += 200;
  transientCamera.currentTime += 0.033;
  transientCameraPreview.syncMedia(false);
  assert.equal(cameraAudio.paused, false, 'readyState 2 with continuing camera time must not be treated as a stall');
  syncNow += 250;
  transientCameraPreview.syncMedia(false);
  assert.equal(cameraAudio.paused, true, 'sustained visible-camera buffering should hold audio to avoid drift');
  assert.equal(transientCamera.paused, false, 'camera buffering should leave the decoder running so it can recover');

  const recoveryScreen = {
    duration: 10, currentTime: 2, paused: false, seeking: true, readyState: 1, playbackRate: 1,
    pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
  };
  const recoveryCamera = {
    duration: 10, currentTime: 2, paused: false, seeking: false, readyState: 2, playbackRate: 1,
    pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
  };
  const recoveryAudio = {
    duration: 10, currentTime: 2, paused: false, seeking: false, readyState: 4, playbackRate: 1, volume: 1,
    pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
  };
  const recoveryPreview = Object.create(Preview.prototype);
  recoveryPreview.store = audioSyncPreview.store;
  recoveryPreview.time = 2;
  recoveryPreview.playing = true;
  recoveryPreview.screen = { node: recoveryScreen, offset: 0, duration: 10, inRange: true };
  recoveryPreview.camera = { node: recoveryCamera, offset: 0, duration: 10, inRange: true };
  recoveryPreview.microphone = { node: recoveryAudio, offset: 0, duration: 10, inRange: true };
  recoveryPreview.system = null;
  syncNow = 5000;
  recoveryPreview.syncMedia(false);
  assert.equal(recoveryCamera.paused, true, 'a screen wait may pause the camera to keep tracks aligned');
  assert.equal(recoveryAudio.paused, true, 'audio should wait while the screen is seeking');
  recoveryScreen.seeking = false;
  recoveryScreen.readyState = 4;
  syncNow += 251;
  recoveryPreview.syncMedia(false);
  assert.equal(recoveryCamera.paused, false, 'a camera paused by another track must not become its own buffer wait');
  assert.equal(recoveryAudio.paused, false, 'camera recovery must release audio after the screen resumes');

  let explicitAudioPosition = 0;
  const explicitSeekAudio = {
    duration: 10, paused: false, seeking: false, readyState: 4, playbackRate: 1, volume: 1,
    seeks: 0,
    get currentTime() { return explicitAudioPosition; },
    set currentTime(value) { explicitAudioPosition = value; this.seeks += 1; this.seeking = true; },
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
  const explicitSeekPreview = Object.create(Preview.prototype);
  explicitSeekPreview.store = audioSyncPreview.store;
  explicitSeekPreview.time = 0;
  explicitSeekPreview.playing = true;
  explicitSeekPreview.screen = null;
  explicitSeekPreview.camera = null;
  explicitSeekPreview.microphone = { node: explicitSeekAudio, offset: 0, duration: 10, inRange: false };
  explicitSeekPreview.system = null;
  explicitSeekPreview.onTime = () => {};
  explicitSeekPreview.invalidate = () => {};
  syncNow = 6000;
  explicitSeekPreview.seek(2);
  assert.equal(explicitSeekAudio.currentTime, 2, 'the first explicit seek should start immediately');
  explicitSeekPreview.seek(6);
  assert.equal(explicitSeekAudio.currentTime, 2, 'a busy audio element should keep the active seek until it settles');
  explicitSeekAudio.seeking = false;
  explicitSeekPreview.syncMedia(false);
  assert.equal(explicitSeekAudio.currentTime, 6, 'the latest explicit seek should run after the previous seek settles');
  assert.equal(explicitSeekAudio.seeks, 2, 'ordinary drift should not add another hard seek');
} finally {
  global.performance = previousPerformance;
}

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
waitingPreview.quality = 'full';
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
  waitingVideo.currentTime = 2.54;
  waitingPreview.frame(4042);
  assert.equal(paints, painted + 1, '超过 25ms 预览帧间隔后应显示新画面，30fps 摄像头才不会掉帧');
  waitingPreview.frame(4050);
  assert.equal(paints, painted + 1, '25ms 内的连续动画帧不应重复重绘');
  waitingVideo.currentTime = 2.57;
  waitingPreview.frame(4070);
  assert.equal(paints, painted + 2, '再超过预览帧间隔后应继续显示新画面');
} finally {
  global.requestAnimationFrame = oldAnimationFrame;
}

const driftingCamera = {
  duration: 10, currentTime: 1.8, paused: false, seeking: false, readyState: 4, playbackRate: 1,
  rateWrites: 0,
  pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
};
let driftingCameraRate = 1;
Object.defineProperty(driftingCamera, 'playbackRate', {
  get() { return driftingCameraRate; },
  set(value) { driftingCameraRate = value; driftingCamera.rateWrites += 1; },
});
const driftPreview = Object.create(Preview.prototype);
driftPreview.store = {
  project: {
    timeline: { segments: [{ sourceStart: 0, sourceEnd: 10, speed: 1 }] },
    audio: preview.store.project.audio,
    camera: { isHidden: false, timeOffset: 0 },
  },
};
driftPreview.time = 2;
driftPreview.playing = true;
driftPreview.screen = { node: { ...waitingVideo, currentTime: 2, seeking: false, readyState: 4 }, offset: 0, duration: 10, inRange: true };
driftPreview.camera = { node: driftingCamera, offset: 0, duration: 10, inRange: true };
driftPreview.microphone = null;
driftPreview.system = null;
driftPreview.syncMedia(false);
assert.equal(driftingCamera.currentTime, 1.8, '几十到两百毫秒的摄像头偏差不应触发 seek，否则画面会闪黑');
driftingCamera.currentTime = 1.4;
driftPreview.syncMedia(false);
assert.equal(driftingCamera.currentTime, 2, '超过摄像头漂移容差后才重新定位到主时钟');
for (let index = 0; index < 4; index += 1) driftPreview.syncMedia(false);
assert.equal(driftingCamera.playbackRate, 1, '同步后摄像头应保持片段原始播放速度');
assert.ok(driftingCamera.rateWrites <= 1, '稳定播放时不应在每个动画帧重写播放速度');

const makeProjectChangeNode = ({ currentTime, duration = 10, readyState = 4 } = {}) => {
  let position = currentTime;
  return {
    duration, readyState, paused: false, seeking: false, playbackRate: 1, volume: 1,
    pauses: 0, seeks: 0,
    get currentTime() { return position; },
    set currentTime(value) { position = value; this.seeks += 1; },
    pause() { this.paused = true; this.pauses += 1; },
    play() { this.paused = false; return Promise.resolve(); },
  };
};
const projectChangePreview = Object.create(Preview.prototype);
projectChangePreview.store = { project: {
  timeline: { segments: [{ id: 'same-clip', sourceStart: 0, sourceEnd: 10, speed: 1 }] },
  audio: { microphoneVolume: 0.5, systemVolume: 1, isMicrophoneMuted: false, isSystemMuted: false },
  camera: { isHidden: false, timeOffset: 0 },
} };
projectChangePreview.time = 5.02;
projectChangePreview.playing = true;
projectChangePreview.quality = 'full';
projectChangePreview.screen = { node: makeProjectChangeNode({ currentTime: 5.02 }), offset: 0, duration: 10, inRange: true };
projectChangePreview.camera = { node: makeProjectChangeNode({ currentTime: 5.06 }), offset: 0, duration: 10, inRange: true };
projectChangePreview.microphone = { node: makeProjectChangeNode({ currentTime: 5.02 }), offset: 0, duration: 10, inRange: true };
projectChangePreview.system = null;
projectChangePreview.microphoneGain = { gain: { value: 0.5, setTargetAtTime(value) { this.value = value; } } };
projectChangePreview.audioContext = { currentTime: 0, state: 'running' };
projectChangePreview.lastTransportSignature = ['same-clip', 0, 10, 5, 1, 0, 0, null, 0, false];
projectChangePreview.setupBackgroundVideo = () => {};
projectChangePreview.prepareAssets = () => {};
projectChangePreview.layout = () => {};
projectChangePreview.invalidate = () => {};
projectChangePreview.syncMedia(false);
projectChangePreview.store.project.audio.microphoneVolume = 0.8;
projectChangePreview.onStoreChange('project');
assert.equal(projectChangePreview.camera.node.seeks, 0, '仅改音量时，领先 40ms 的可见摄像头不应被强制 seek');
assert.equal(projectChangePreview.camera.node.pauses, 0, '仅改音量时，领先 40ms 的可见摄像头不应暂停');
assert.equal(projectChangePreview.screen.node.pauses, 0, '仅改音量时，不应为摄像头校准暂停屏幕主时钟');
assert.equal(projectChangePreview.microphone.node.seeks, 0, '仅改音量时不应 seek 麦克风');
assert.equal(projectChangePreview.microphone.node.pauses, 0, '仅改音量时不应暂停麦克风');

const mappedAudioNode = makeProjectChangeNode({ currentTime: 5 });
const mappedChangePreview = Object.create(Preview.prototype);
mappedChangePreview.store = { project: {
  timeline: { segments: [{ id: 'same-clip', sourceStart: 0, sourceEnd: 10, speed: 1 }] },
  audio: { microphoneVolume: 0.5, systemVolume: 1, isMicrophoneMuted: false, isSystemMuted: false },
  camera: { isHidden: false, timeOffset: 0 },
} };
mappedChangePreview.time = 5;
mappedChangePreview.playing = true;
mappedChangePreview.quality = 'full';
mappedChangePreview.screen = null;
mappedChangePreview.camera = null;
mappedChangePreview.microphone = { node: mappedAudioNode, offset: 0, duration: 10, inRange: true };
mappedChangePreview.system = null;
mappedChangePreview.microphoneGain = { gain: { value: 0.5, setTargetAtTime(value) { this.value = value; } } };
mappedChangePreview.audioContext = { currentTime: 0, state: 'running' };
mappedChangePreview.lastTransportSignature = ['same-clip', 0, 10, 5, 1, null, 0, null, null, false];
mappedChangePreview.setupBackgroundVideo = () => {};
mappedChangePreview.prepareAssets = () => {};
mappedChangePreview.layout = () => {};
mappedChangePreview.invalidate = () => {};
mappedChangePreview.store.project.audio.microphoneVolume = 0.8;
mappedChangePreview.store.project.timeline.segments[0].sourceStart = 1;
mappedChangePreview.onStoreChange('project');
assert.equal(mappedAudioNode.seeks, 1, '同一次 Store 更新改音量和时间映射时，仍应强制对齐麦克风');
assert.equal(mappedAudioNode.currentTime, 6, '时间映射变化后麦克风应定位到新的素材时间');

const bufferingCamera = {
  duration: 10, currentTime: 2, paused: true, seeking: true, readyState: 1, playbackRate: 1,
  pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
};
const bufferedAudio = {
  duration: 10, currentTime: 2, paused: false, seeking: false, readyState: 4, playbackRate: 1, volume: 1,
  pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
};
const cameraWaitingPreview = Object.create(Preview.prototype);
cameraWaitingPreview.store = driftPreview.store;
cameraWaitingPreview.time = 2;
cameraWaitingPreview.playing = true;
cameraWaitingPreview.screen = { node: { ...waitingVideo, currentTime: 2, seeking: false, readyState: 4 }, offset: 0, duration: 10, inRange: true };
cameraWaitingPreview.camera = { node: bufferingCamera, offset: 0, duration: 10, inRange: true };
cameraWaitingPreview.microphone = { node: bufferedAudio, offset: 0, duration: 10, inRange: true };
cameraWaitingPreview.system = null;
cameraWaitingPreview.syncMedia(false);
assert.equal(bufferingCamera.paused, true, '摄像头等待时不应继续播放，避免跑在时间线前面');
assert.equal(bufferedAudio.paused, true, '摄像头画面未就绪时音频不应先行');
bufferingCamera.seeking = false;
bufferingCamera.readyState = 4;
cameraWaitingPreview.syncMedia(false);
assert.equal(bufferingCamera.paused, false, '摄像头画面就绪后应恢复播放');
assert.equal(bufferedAudio.paused, false, '摄像头画面就绪后音频应恢复播放');

let slowCameraTime = 1.5;
const slowCamera = {
  duration: 10, paused: false, seeking: false, readyState: 4, playbackRate: 1, seeks: 0,
  get currentTime() { return slowCameraTime; },
  set currentTime(value) {
    slowCameraTime = value;
    this.seeks += 1;
    this.seeking = true;
    this.readyState = 1;
  },
  pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
};
const slowScreen = {
  duration: 10, currentTime: 2, paused: false, seeking: false, readyState: 4, playbackRate: 1,
  pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
};
const slowMicrophone = { ...bufferedAudio, currentTime: 2, paused: false };
const slowSystem = { ...bufferedAudio, currentTime: 2, paused: false };
const slowSeekPreview = Object.create(Preview.prototype);
slowSeekPreview.store = driftPreview.store;
slowSeekPreview.time = 2;
slowSeekPreview.playing = true;
slowSeekPreview.lastTick = 2000;
slowSeekPreview.lastDraw = 0;
slowSeekPreview.dirty = false;
slowSeekPreview.screen = { node: slowScreen, offset: 0, duration: 10, inRange: true };
slowSeekPreview.camera = { node: slowCamera, offset: 0, duration: 10, inRange: true };
slowSeekPreview.microphone = { node: slowMicrophone, offset: 0, duration: 10, inRange: true };
slowSeekPreview.system = { node: slowSystem, offset: 0, duration: 10, inRange: true };
slowSeekPreview.onTime = () => {};
slowSeekPreview.draw = () => {};
const slowSeekOldAnimationFrame = global.requestAnimationFrame;
global.requestAnimationFrame = () => {};
try {
  slowSeekPreview.syncMedia(false);
  assert.equal(slowCamera.seeks, 1, '摄像头慢 seek 开始时只应重定位一次');
  assert.equal(slowMicrophone.paused, true, '摄像头画面定位时麦克风应等待');
  assert.equal(slowSystem.paused, true, '摄像头画面定位时系统音轨应等待');
  for (let index = 1; index <= 8; index += 1) {
    if (!slowScreen.paused) slowScreen.currentTime += 0.015;
    slowSeekPreview.frame(2000 + index * 15);
  }
  assert.equal(slowScreen.paused, true, '摄像头慢 seek 期间屏幕主时钟不得被同步逻辑重新播放');
  assert.equal(slowScreen.currentTime, 2, '摄像头慢 seek 期间屏幕时钟应保持在原位置');
  slowCamera.seeking = false;
  slowCamera.readyState = 4;
  slowSeekPreview.frame(2135);
  if (!slowScreen.paused) slowScreen.currentTime += 0.02;
  slowSeekPreview.frame(2151);
  assert.equal(slowCamera.seeks, 1, '慢 seek 完成后不得因屏幕时钟推进而立即重复定位');
  assert.ok(Math.abs(slowSeekPreview.time - 2) <= 0.03, '摄像头大偏差定位期间预览主时钟应冻结');
  assert.equal(slowCamera.paused, false, '慢 seek 完成后摄像头应继续播放');
  assert.equal(slowMicrophone.paused, false, '慢 seek 完成后麦克风应在有限时间内恢复');
  assert.equal(slowSystem.paused, false, '慢 seek 完成后系统音轨应在有限时间内恢复');
} finally {
  global.requestAnimationFrame = slowSeekOldAnimationFrame;
}

const hiddenCameraAudio = { ...bufferedAudio, paused: false };
const hiddenCameraPreview = Object.create(Preview.prototype);
hiddenCameraPreview.store = {
  project: {
    ...cameraWaitingPreview.store.project,
    camera: { isHidden: true, timeOffset: 0 },
  },
};
hiddenCameraPreview.time = 2;
hiddenCameraPreview.playing = true;
hiddenCameraPreview.screen = { node: { ...waitingVideo, currentTime: 2, seeking: false, readyState: 4 }, offset: 0, duration: 10, inRange: true };
hiddenCameraPreview.camera = {
  node: { ...bufferingCamera, currentTime: 1.2, paused: false, seeking: false, readyState: 4 },
  offset: 0,
  duration: 10,
  inRange: true,
};
hiddenCameraPreview.microphone = { node: hiddenCameraAudio, offset: 0, duration: 10, inRange: true };
hiddenCameraPreview.system = null;
hiddenCameraPreview.syncMedia(false);
assert.equal(hiddenCameraPreview.camera.node.currentTime, 2, '隐藏摄像头仍应纠正超过容差的大漂移');
assert.equal(hiddenCameraAudio.paused, false, '隐藏摄像头 seek 或缓冲时不应暂停音频');

cameraWaitingPreview.time = 9.5;
bufferingCamera.duration = 9;
bufferingCamera.seeking = true;
bufferingCamera.readyState = 1;
bufferedAudio.paused = true;
cameraWaitingPreview.syncMedia(false);
assert.equal(cameraWaitingPreview.camera.inRange, false, '摄像头尾段超出素材范围后不应继续等待');
assert.equal(bufferedAudio.paused, false, '摄像头尾段结束后音频应继续播放');

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
