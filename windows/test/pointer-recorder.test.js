'use strict';
const assert = require('node:assert/strict');
const { PointerRecorder, loadNative } = require('../src/main/pointer-recorder');

if (process.platform === 'win32') {
  // 开始录制时任务栏模块会先注册 RECT，鼠标记录必须复用它。
  const koffi = require('koffi');
  koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  assert.ok(loadNative(), 'Windows user32 binding must load for pointer capture');
  const recorder = new PointerRecorder(() => ({ x: 0, y: 0, width: 1920, height: 1080 }));
  assert.equal(recorder.hasClickSupport, true, 'pointer recorder must retain mouse-button capture support');
  console.log('ok Windows 指针记录保留鼠标按键捕获');
} else {
  console.log('skip Windows 指针记录回归（非 Windows）');
}
