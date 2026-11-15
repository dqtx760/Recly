'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const recorder = { isDestroyed: () => false, webContents: {} };
const sent = [];
const camera = { isDestroyed: () => false, webContents: { isLoading: () => false, send: (...args) => sent.push(args) } };
const context = {
  recorderWindow: recorder, cameraWindow: camera,
  cameraPreviewRequest: { visible: true, requestId: 7 },
  ipcMain: { on(channel, handler) { context.handler = handler; } },
};
const start = source.indexOf("  ipcMain.on('camera:preview-frame'");
const end = source.indexOf("  ipcMain.on('camera:status'", start);
assert.ok(start >= 0 && end > start);
vm.runInNewContext(source.slice(start, end), context);
const frame = { requestId: 7, dataUrl: 'data:image/jpeg;base64,AAAA' };
context.handler({ sender: {} }, frame);
context.handler({ sender: recorder.webContents }, { ...frame, requestId: 6 });
context.handler({ sender: recorder.webContents }, { ...frame, dataUrl: 'file:///private.jpg' });
context.handler({ sender: recorder.webContents }, { ...frame, dataUrl: frame.dataUrl + 'A'.repeat(256 * 1024) });
context.cameraPreviewRequest.visible = false;
context.handler({ sender: recorder.webContents }, frame);
assert.equal(sent.length, 0, '拒绝其他窗口、过期请求、非缩略图和关闭后的预览帧');
context.cameraPreviewRequest.visible = true;
context.handler({ sender: recorder.webContents }, frame);
assert.equal(sent.length, 1);
assert.equal(sent[0][0], 'camera:frame');
assert.equal(sent[0][1], frame);
console.log('Camera frame routing tests passed.');
