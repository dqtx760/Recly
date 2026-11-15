'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../src/main/main.js'),'utf8');
const icons = [], overlays = [];
function image(bitmap = Buffer.alloc(64 * 64 * 4)) {
  return { bitmap, isEmpty: () => false, resize() { return this; }, toBitmap() { return bitmap; }, crop() { return this; } };
}
const original = image();
const context = {
  Buffer, Math, process: { platform:'win32' }, windowsIconPath:'icon.png',
  defaultRecorderIcon:null, recordingRecorderIcon:null, recordingOverlayIcon:null,
  nativeImage: { createFromPath:()=>original, createFromBitmap:bitmap=>image(bitmap) },
  recording:null, startingRecording:null,
  recorderWindow: { isDestroyed:()=>false, setIcon:icon=>icons.push(icon), setOverlayIcon:(...args)=>overlays.push(args) },
};
vm.runInNewContext(source.slice(source.indexOf('function getRecorderIcon('),source.indexOf('function createWindow(')), context);
context.updateRecorderTaskbarIcon();
assert.equal(icons.at(-1),original);
assert.deepEqual(overlays.at(-1),[null,'']);
context.startingRecording = {};
context.updateRecorderTaskbarIcon();
assert.equal(overlays.at(-1)[0],null,'首帧尚未到达不能显示正在录制');
context.recording = {};
context.startingRecording = null;
context.updateRecorderTaskbarIcon();
assert.notEqual(icons.at(-1),original,'录制时普通图标必须带右上红点');
assert.ok(overlays.at(-1)[0],'录制时必须使用Windows任务栏专用角标');
assert.equal(overlays.at(-1)[1],'正在录制');
const offset=(12*64+52)*4;
assert.ok(icons.at(-1).bitmap[offset+2]>240 && icons.at(-1).bitmap[offset+1]<80,'右上红点像素应为红色');
context.recording=null;
context.updateRecorderTaskbarIcon();
assert.equal(icons.at(-1),original);
assert.deepEqual(overlays.at(-1),[null,''],'停止/失败恢复后清除角标');
context.recorderWindow=null;
context.updateRecorderTaskbarIcon();
console.log('任务栏录制红点状态与像素测试通过。');
