'use strict';

const assert = require('node:assert/strict');
global.location = { search: '' };
const { Preview } = require('../src/renderer/editor/preview');

let sourceCount = 0;
let gainCount = 0;
let resumeCount = 0;
const gainAutomation = [];
class MockAudioContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.destination = {};
  }

  createMediaElementSource(node) {
    sourceCount += 1;
    return { node, connections: [], connect(target) { this.connections.push(target); }, disconnect() { this.connections = []; } };
  }

  createGain() {
    gainCount += 1;
    return {
      gain: {
        value: 1,
        targets: [],
        cancelScheduledValues(time) { gainAutomation.push(['cancel', time]); },
        setValueAtTime(value, time) { this.value = value; gainAutomation.push(['set', value, time]); },
        setTargetAtTime(value, time, constant) { this.value = value; this.targets.push(value); gainAutomation.push(['target', value, time, constant]); },
      },
      connections: [],
      connect(target) { this.connections.push(target); },
    };
  }

  resume() {
    resumeCount += 1;
    this.state = 'running';
    return Promise.resolve();
  }
}

const previousAudioContext = global.AudioContext;
global.AudioContext = MockAudioContext;

const mediaElement = {
  duration: 10,
  currentTime: 0,
  paused: true,
  seeking: false,
  playbackRate: 1,
  volume: 0.9,
  play() { this.paused = false; return Promise.resolve(); },
  pause() { this.paused = true; },
};
const preview = Object.create(Preview.prototype);
preview.microphone = { node: mediaElement, offset: 0, duration: 10 };
preview.status = '';
preview.audioGainError = null;
const statuses = [];
preview.onStatus = (status) => statuses.push(status);
preview.setupMicrophoneAudio();
preview.setupMicrophoneAudio();

assert.equal(sourceCount, 1, '同一麦克风元素只能创建一个 MediaElementSource');
assert.equal(gainCount, 1, '重复初始化不得再创建 GainNode');
assert.equal(mediaElement.volume, 1, 'Web Audio 路径将元素音量固定为 100%，由 GainNode 控制实际增益');
assert.equal(preview.microphoneSource.connections[0], preview.microphoneGain);
assert.equal(preview.microphoneGain.connections[0], preview.audioContext.destination);

const mutedPreview = Object.create(Preview.prototype);
mutedPreview.microphone = { node: { volume: 1 } };
mutedPreview.status = '';
mutedPreview.audioGainError = null;
mutedPreview.onStatus = () => {};
mutedPreview.playing = false;
mutedPreview.setupMicrophoneAudio();
mutedPreview.setMicrophoneGain(0);
assert.equal(mutedPreview.microphoneGain.gain.value, 0, '初始静音应在 AudioContext 恢复前直接归零');
assert.ok(gainAutomation.some(([kind, value]) => kind === 'set' && value === 0), '初始静音不得依赖渐变淡出');
mutedPreview.audioContext.state = 'suspended';
mutedPreview.store = { project: { timeline: { segments: [{ sourceStart: 0, sourceEnd: 1, speed: 1 }] } } };
mutedPreview.time = 0;
mutedPreview.screenFrame = null;
mutedPreview.lastTick = 0;
mutedPreview.syncMedia = () => {};
mutedPreview.onState = () => {};
mutedPreview.play();
assert.equal(mutedPreview.microphoneGain.gain.value, 0, '首次播放恢复 AudioContext 时仍应保持静音');

const fallbackStatus = [];
class BrokenGainConnectContext extends MockAudioContext {
  createGain() {
    const gain = super.createGain();
    gain.connect = () => { throw new Error('injected gain.connect failure'); };
    return gain;
  }
}
global.AudioContext = BrokenGainConnectContext;
const fallbackPreview = Object.create(Preview.prototype);
fallbackPreview.microphone = { node: { volume: 0.7 } };
fallbackPreview.status = '';
fallbackPreview.audioGainError = null;
fallbackPreview.onStatus = (status) => fallbackStatus.push(status);
fallbackPreview.setupMicrophoneAudio();
assert.equal(fallbackPreview.microphoneGain, null, '連接 GainNode 失敗後不得假稱增益可用');
assert.deepEqual(fallbackPreview.microphoneSource.connections, [fallbackPreview.audioContext.destination], '连接 GainNode 失败后应把已接管的媒体源直连输出');
assert.equal(fallbackPreview.microphone.node.volume, 1, '直连回退时保留媒体元素原始 100% 音量');
fallbackPreview.reportStatus();
assert.match(fallbackStatus.at(-1), /无法应用麦克风放大/ , '初始化期间缓存的增益错误应在 app 设置状态回调后显示');
fallbackPreview.setMicrophoneGain(0.42);
assert.equal(fallbackPreview.microphone.node.volume, 0.42, '直连回退仍支持 100% 以下的原有音量调整');
assert.equal(fallbackPreview.setMicrophoneGain(4), false, '直连回退不能静默吞掉 400% 增益');
assert.equal(fallbackPreview.microphone.node.volume, 1, '不支持的 400% 不得伪显示成元素100%已放大');

class BrokenCreateGainContext extends MockAudioContext {
  createGain() { throw new Error('injected createGain failure'); }
}
global.AudioContext = BrokenCreateGainContext;
const createGainFallback = Object.create(Preview.prototype);
createGainFallback.microphone = { node: { volume: 1 } };
createGainFallback.status = '';
createGainFallback.audioGainError = null;
createGainFallback.onStatus = () => {};
createGainFallback.setupMicrophoneAudio();
assert.deepEqual(createGainFallback.microphoneSource.connections, [createGainFallback.audioContext.destination], 'createGain失败后已接管媒体源应直接连接输出');
global.AudioContext = MockAudioContext;
const sourceCountAfterPreviewSetup = sourceCount;

const liveGainPreview = Object.create(Preview.prototype);
liveGainPreview.microphone = { node: { volume: 1 } };
liveGainPreview.microphoneGain = { gain: {
  value: 4,
  targets: [],
  setTargetAtTime(value) { this.targets.push(value); },
  cancelScheduledValues() {},
  setValueAtTime(value) { this.value = value; },
} };
liveGainPreview.audioContext = { currentTime: 1, state: 'running' };
liveGainPreview.playing = true;
liveGainPreview.lastMicrophoneGain = 0;
liveGainPreview.setMicrophoneGain(4);
assert.deepEqual(liveGainPreview.microphoneGain.gain.targets, [4], '播放中的非零增益变化应保留15ms平滑');
liveGainPreview.setMicrophoneGain(0);
assert.equal(liveGainPreview.microphoneGain.gain.value, 0, '400% 拖回静音必须立即归零');
assert.deepEqual(liveGainPreview.microphoneGain.gain.targets, [4], '归零不能继续排入非零渐变尾音');

const systemElement = {
  duration: 10,
  currentTime: 0,
  paused: true,
  seeking: false,
  playbackRate: 1,
  volume: 0,
  play() { this.paused = false; return Promise.resolve(); },
  pause() { this.paused = true; },
};
preview.store = { project: {
  timeline: { segments: [
    { sourceStart: 0, sourceEnd: 5, speed: 1, audio: { microphoneVolume: 0.42 } },
    { sourceStart: 5, sourceEnd: 10, speed: 1 },
  ] },
  audio: { microphoneVolume: 4, systemVolume: 4, isMicrophoneMuted: false, isSystemMuted: false },
  camera: { isHidden: false, timeOffset: 0 },
} };
preview.screen = null;
preview.camera = null;
preview.system = { node: systemElement, offset: 0, duration: 10 };
preview.time = 0;
preview.playing = false;
preview.syncMedia(true);
assert.equal(preview.microphoneGain.gain.value, 0.42, '片段麦克风覆盖优先于全局增益');
assert.equal(systemElement.volume, 1, '系统音量仍限制为 100%');

preview.time = 5;
preview.syncMedia(true);
assert.equal(preview.microphoneGain.gain.value, 4, '片段未覆盖麦克风音量时继承 400% 全局增益');

preview.store.project.timeline.segments[1].audio = { microphoneVolume: 4, isMicrophoneMuted: true };
preview.syncMedia(true);
assert.equal(preview.microphoneGain.gain.value, 0, '片段静音将 Web Audio 增益置零');
preview.store.project.timeline.segments[1].audio = { microphoneVolume: 0.42, isMicrophoneMuted: false };
preview.syncMedia(true);
assert.equal(preview.microphoneGain.gain.value, 0.42, '解除静音后恢复片段保存的增益');
assert.equal(sourceCount, sourceCountAfterPreviewSetup, '改变音量、静音和片段后仍复用原 MediaElementSource');

let editAudioTime = 4.7;
const editAudioNode = {
  duration: 10,
  paused: false,
  seeking: false,
  playbackRate: 1,
  volume: 1,
  seeks: 0,
  pauses: 0,
  get currentTime() { return editAudioTime; },
  set currentTime(value) { editAudioTime = value; this.seeks += 1; },
  play() { this.paused = false; return Promise.resolve(); },
  pause() { this.pauses += 1; this.paused = true; },
};
const editScreenNode = {
  duration: 10,
  currentTime: 5,
  paused: false,
  seeking: false,
  readyState: 4,
  playbackRate: 1,
  play() { this.paused = false; return Promise.resolve(); },
  pause() { this.paused = true; },
};
const volumeEditPreview = Object.create(Preview.prototype);
volumeEditPreview.store = { project: {
  timeline: { segments: [{ sourceStart: 0, sourceEnd: 10, speed: 1 }] },
  audio: { microphoneVolume: 0.42, systemVolume: 1, isMicrophoneMuted: false, isSystemMuted: false },
  camera: { isHidden: false, timeOffset: 0 },
} };
volumeEditPreview.microphone = { node: editAudioNode, offset: 0, duration: 10, inRange: true };
volumeEditPreview.microphoneGain = { gain: { value: 0.42, setTargetAtTime(value) { this.value = value; } } };
volumeEditPreview.audioContext = { currentTime: 0 };
volumeEditPreview.screen = { node: editScreenNode, offset: 0, duration: 10, inRange: true };
volumeEditPreview.camera = null;
volumeEditPreview.system = null;
volumeEditPreview.time = 5;
volumeEditPreview.playing = true;
volumeEditPreview.syncMedia(false);
assert.equal(editAudioNode.seeks, 0, '播放中调整音量不得 seek 麦克风轨');
assert.equal(editAudioNode.pauses, 0, '播放中调整音量不得暂停麦克风轨');
volumeEditPreview.microphone.pendingExplicitSeek = true;
editAudioNode.seeking = true;
volumeEditPreview.syncMedia(false);
assert.equal(volumeEditPreview.microphone.pendingExplicitSeek, true, '音量变更不得清除正在等待的显式 seek');

preview.time = 0;
preview.playing = false;
preview.screenFrame = null;
preview.lastTick = 0;
preview.onState = () => {};
const resumeCountBeforeMainPlayback = resumeCount;
preview.play();
assert.equal(resumeCount, resumeCountBeforeMainPlayback + 1, '播放入口恢复挂起的 AudioContext');

delete global.AudioContext;
const unsupportedElement = { volume: 1 };
const unsupported = Object.create(Preview.prototype);
unsupported.microphone = { node: unsupportedElement };
unsupported.audioGainError = null;
unsupported.status = '';
unsupported.onStatus = (status) => statuses.push(status);
unsupported.setMicrophoneGain(4);
assert.equal(unsupportedElement.volume, 1, '不支持 Web Audio 时不伪装成已应用 400%');
assert.match(unsupported.audioGainError, /无法应用麦克风放大/);
assert.match(statuses.at(-1), /无法应用麦克风放大/);

if (previousAudioContext === undefined) delete global.AudioContext;
else global.AudioContext = previousAudioContext;

console.log('Preview microphone gain regression passed: one source, clip inheritance, mute, 400%, resume, and explicit unsupported error.');
