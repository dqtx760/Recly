'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rendererRoot = path.join(__dirname, '../src/renderer');
const html = fs.readFileSync(path.join(rendererRoot, 'editor.html'), 'utf8');
const css = fs.readFileSync(path.join(rendererRoot, 'editor.css'), 'utf8');
const app = fs.readFileSync(path.join(rendererRoot, 'editor/app.js'), 'utf8');

assert.match(html, /<div class="stage-controls">[\s\S]*id="preview-fullscreen"[^>]*title="全屏观看（Esc 退出）"[\s\S]*<\/div>/, '全屏观看按钮应位于原预览质量按钮所在的舞台控制区');
assert.doesNotMatch(html, /id="quality"|id="preview-add-button"|id="preview-add-menu"/, '移除原画预览切换和左侧加号菜单');
assert.match(css, /#stage:fullscreen \{[^}]*width: 100vw; height: 100vh/, '全屏时预览区应占满窗口');
assert.match(css, /#stage\[data-preview-fullscreen="true"\] \{[^}]*position: fixed/, '全屏状态应同时用属性标记保证画面铺满');
assert.match(css, /#stage:fullscreen \.stage-controls > :not\(\.preview-fullscreen-button\)[\s\S]*display: none/, '全屏观看时只保留可退出的全屏按钮');
assert.match(app, /attachPreviewFullscreen\(\{ stage: \$\('stage'\), button: \$\('preview-fullscreen'\)/, '编辑器入口应挂载全屏观看控制');

const source = fs.readFileSync(path.join(rendererRoot, 'editor/preview-fullscreen.js'), 'utf8');
const stage = { requestFullscreen: null, exitFullscreen: null };
stage.setAttribute = (name, value) => { stage.attributes[name] = value; };
stage.attributes = {};
const button = {
  innerHTML: '', title: '', attributes: {},
  listeners: {},
  addEventListener(name, handler) { this.listeners[name] = handler; },
  setAttribute(name, value) { this.attributes[name] = value; },
  click() { this.listeners.click(); },
};
const documentListeners = {};
let fullscreenElement = null;
let entered = 0;
let exited = 0;
let toast = '';
const documentRef = {
  get fullscreenElement() { return fullscreenElement; },
  addEventListener(name, handler) { documentListeners[name] = handler; },
  async exitFullscreen() { fullscreenElement = null; exited += 1; documentListeners.fullscreenchange(); },
};
const moduleRef = { exports: {} };
vm.runInNewContext(source, { module: moduleRef, document: documentRef });
const fullscreen = moduleRef.exports.attachPreviewFullscreen({ stage, button, onToast: message => { toast = message; } });
assert.ok(button.innerHTML.includes('M4 9V5h4'), '默认显示进入全屏图标');
assert.equal(button.attributes['aria-pressed'], 'false');
assert.equal(stage.attributes['data-preview-fullscreen'], 'false');

stage.requestFullscreen = async () => { fullscreenElement = stage; entered += 1; documentListeners.fullscreenchange(); };
button.click();
setImmediate(() => {
  assert.equal(entered, 1, '点击应进入真实 DOM 全屏');
  assert.equal(fullscreen.isActive(), true);
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(stage.attributes['data-preview-fullscreen'], 'true');
  assert.match(button.title, /退出全屏观看/);
  button.click();
  setImmediate(() => {
    assert.equal(exited, 1, '再次点击应退出全屏');
    assert.equal(fullscreen.isActive(), false);
    assert.equal(button.attributes['aria-pressed'], 'false');
    assert.equal(stage.attributes['data-preview-fullscreen'], 'false');
    assert.equal(toast, '');
    console.log('预览全屏观看按钮测试通过：进入、退出、图标与状态同步。');
  });
});
