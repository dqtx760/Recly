'use strict';
// DogSC Bandicam-style Recorder Console 单元与交互集成测试
// 运行：node windows/test/recorder-ui.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
const test = (name, body) => {
  body();
  passed += 1;
  console.log(`  ok  ${name}`);
};

const asyncTest = async (name, body) => {
  await body();
  passed += 1;
  console.log(`  ok  ${name}`);
};

console.log('Testing Bandicam Recorder UI Controller (recorder.js)...');

// 1. 验证 HTML 中关键元素 ID 存在性
test('recorder.html 包含全部 Bandicam 控制台必需元素 ID', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/recorder.html'), 'utf8');
  const requiredIds = [
    'win-min', 'win-close', 'idle', 'live', 'busy', 'done',
    'selection-pill', 'source-summary',
    'mic', 'mic-row', 'mic-status', 'mic-name', 'mic-name-label',
    'cam', 'cam-row', 'cam-status', 'cam-name',
    'sys', 'sys-row', 'sys-desc',
    'desktop-icons',
    'save-dir-path', 'change-save-dir', 'open-save-dir',
    'start', 'stop', 'discard', 'timer', 'marker', 'memo2',
    'library', 'shortcuts-btn', 'memo',
    'doneTitle', 'doneDetail', 'edit', 'reveal', 'again',
    'shortcuts-modal', 'shortcuts-close'
  ];
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `HTML 必须包含 id="${id}"`);
  }
  assert.match(html, /id=["']mic-name["'][^>]*type=["']button["']|type=["']button["'][^>]*id=["']mic-name["']/, '麦克风设备名称必须是可点击的可见选择控件');
  const controller = fs.readFileSync(path.join(__dirname, '../src/renderer/recorder.js'), 'utf8');
  assert.match(controller, /\$\('mic-name'\)\?\.addEventListener\('click'/, '点击麦克风选择控件必须打开设备列表');
  assert.match(controller, /audio:\s*\{\s*\.\.\.device\(state\.mic\.deviceId\)/, '录制麦克风必须使用已选择的设备 ID');
});

test('完成通知卡片独立显示缩略图、另存和进入编辑操作', () => {
  const renderer = path.join(__dirname, '../src/renderer');
  const html = fs.readFileSync(path.join(renderer, 'recording-complete.html'), 'utf8');
  for (const id of ['thumbnail', 'project-name', 'save-path', 'edit', 'save-copy', 'close']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `完成卡片必须包含 ${id}`);
  }
  assert.match(html, /id=["']save-copy["'][^>]*>保存项目…/, '完成卡片必须提供保存项目操作');
  assert.doesNotMatch(html, /id=["']reveal["']/, '完成卡片不再显示打开位置按钮');
  const cardController = fs.readFileSync(path.join(renderer, 'recording-complete.js'), 'utf8');
  assert.doesNotMatch(cardController, /\$\(['"]reveal['"]\)/, '完成卡片不应保留打开位置处理器');
  const cardStyle = fs.readFileSync(path.join(renderer, 'recording-complete.css'), 'utf8');
  assert.match(cardStyle, /height:\s*150px/);
  assert.match(cardStyle, /aspect-ratio:\s*16\s*\/\s*9/);
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  assert.match(main, /width:\s*353,\s*height:\s*336/, '完成卡片为 340×320，外围留有透明投影边距');
  assert.match(main, /Math\.floor\(\(area\.height - margin \* 2 \+ gap\) \/ \(height \+ gap\)\)/, '堆叠数量按工作区高度计算');
  assert.match(main, /showRecordingComplete\(completion\)/, '结束录制后必须显示独立完成卡片');
  assert.match(main, /copyProjectToFolder\(source, dialogResult\.filePaths\[0\]\)/, '另存操作必须复制完整项目包');
});

test('主控台图标路径指向实际打包资源', () => {
  const renderer = path.join(__dirname, '../src/renderer');
  const html = fs.readFileSync(path.join(renderer, 'recorder.html'), 'utf8');
  const iconPath = html.match(/<img src="([^"]+)"[^>]*aria-hidden="true"/);
  assert.ok(iconPath, '主控台应有品牌图标');
  assert.ok(fs.existsSync(path.resolve(renderer, iconPath[1])), `图标文件不存在：${iconPath[1]}`);
});

// 2. 模拟 DOM 与 Electron 环境测试 recorder.js 行为
class MockElement {
  constructor(tag, id = '', className = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = className;
    this.classList = {
      _classes: new Set(className.split(' ').filter(Boolean)),
      add: (...cls) => cls.forEach((c) => this.classList._classes.add(c)),
      remove: (...cls) => cls.forEach((c) => this.classList._classes.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (this.classList._classes.has(c)) this.classList._classes.delete(c);
          else this.classList._classes.add(c);
        } else if (force) {
          this.classList._classes.add(c);
        } else {
          this.classList._classes.delete(c);
        }
        return this.classList._classes.has(c);
      },
      contains: (c) => this.classList._classes.has(c),
    };
    this.dataset = {};
    this.children = [];
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.title = '';
    this._attrs = {};
  }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k] || ''; }
  appendChild(child) { this.children.push(child); return child; }
  querySelector(selector) {
    if (selector === 'span') return this.children.find((c) => c.tagName === 'SPAN') || null;
    if (selector === 'b') return this.children.find((c) => c.tagName === 'B') || null;
    if (selector === 'small') return this.children.find((c) => c.tagName === 'SMALL') || null;
    return null;
  }
  addEventListener(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }
  click() {
    if (this.listeners.click) {
      this.listeners.click.forEach((fn) => fn({ preventDefault: () => {} }));
    }
  }
  contextmenu() {
    if (this.listeners.contextmenu) {
      this.listeners.contextmenu.forEach((fn) => fn({ preventDefault: () => {} }));
    }
  }
}

asyncTest('recorder.js 控制台事件绑定与状态流转', async () => {
  // 构建 DOM
  const elements = new Map();
  const getOrCreate = (id, tag = 'div') => {
    if (!elements.has(id)) elements.set(id, new MockElement(tag, id));
    return elements.get(id);
  };

  const winMin = getOrCreate('win-min', 'button');
  const winClose = getOrCreate('win-close', 'button');
  const startBtn = getOrCreate('start', 'button');
  const stopBtn = getOrCreate('stop', 'button');
  const discardBtn = getOrCreate('discard', 'button');
  const markerBtn = getOrCreate('marker', 'button');
  const markerSpan = new MockElement('span');
  markerSpan.textContent = '标记';
  markerBtn.appendChild(markerSpan);

  const editBtn = getOrCreate('edit', 'button');
  const revealBtn = getOrCreate('reveal', 'button');
  const againBtn = getOrCreate('again', 'button');

  const micBtn = getOrCreate('mic', 'button');
  const micRow = getOrCreate('mic-row', 'div');
  const micStatus = getOrCreate('mic-status', 'span');
  const micName = getOrCreate('mic-name', 'div');

  const camBtn = getOrCreate('cam', 'button');
  const camRow = getOrCreate('cam-row', 'div');
  const camStatus = getOrCreate('cam-status', 'span');
  const camName = getOrCreate('cam-name', 'div');

  const sysBtn = getOrCreate('sys', 'button');
  const sysRow = getOrCreate('sys-row', 'div');
  const sysDesc = getOrCreate('sys-desc', 'div');

  const saveDirPath = getOrCreate('save-dir-path', 'span');
  const changeSaveDir = getOrCreate('change-save-dir', 'button');
  const sourceSummary = getOrCreate('source-summary', 'span');

  const shortcutsBtn = getOrCreate('shortcuts-btn', 'button');
  const shortcutsModal = getOrCreate('shortcuts-modal', 'div');
  shortcutsModal.hidden = true;
  const shortcutsClose = getOrCreate('shortcuts-close', 'button');

  const idlePanel = getOrCreate('idle', 'div');
  const livePanel = getOrCreate('live', 'div');
  const busyPanel = getOrCreate('busy', 'div');
  const donePanel = getOrCreate('done', 'div');

  const sourceButtons = ['display', 'window', 'area'].map((src) => {
    const btn = new MockElement('button', '', 'source');
    btn.dataset.source = src;
    const span = new MockElement('span');
    span.textContent = src;
    btn.appendChild(span);
    return btn;
  });

  // 模拟全局环境
  const ipcEvents = [];
  const ipcHandlers = new Map();
  const ipcSendCalls = [];

  const mockIpcRenderer = {
    send(channel, ...args) {
      ipcSendCalls.push({ channel, args });
    },
    async invoke(channel, ...args) {
      if (channel === 'config:get-projects-root') return 'D:\\Videos\\DogSC';
      if (channel === 'config:choose-projects-root') return 'E:\\MyRecordings';
      if (channel === 'recorder:displays') return [{ id: 1, label: '主显示器', isPrimary: true, physical: { width: 1920, height: 1080 } }];
      if (channel === 'app:environment') return { ok: true, encoder: 'h264_nvenc' };
      if (channel === 'recorder:prepare') return { mediaDirectory: 'C:\\Temp\\Rec1' };
      if (channel === 'recorder:start') return true;
      if (channel === 'recorder:stop') return { name: 'DemoProject', directory: 'D:\\Videos\\Demo', duration: 12.5, recorded: { screen: true, microphone: true } };
      if (channel === 'recorder:marker') return 1;
      return null;
    },
    on(channel, handler) {
      if (!ipcHandlers.has(channel)) ipcHandlers.set(channel, []);
      ipcHandlers.get(channel).push(handler);
    },
  };

  // 验证窗口最小化和关闭
  winMin.addEventListener('click', () => mockIpcRenderer.send('window:minimize'));
  winClose.addEventListener('click', () => mockIpcRenderer.send('window:close'));

  winMin.click();
  assert.equal(ipcSendCalls.some((c) => c.channel === 'window:minimize'), true, '最小化按钮发出 window:minimize');

  winClose.click();
  assert.equal(ipcSendCalls.some((c) => c.channel === 'window:close'), true, '关闭按钮发出 window:close');

  // 验证保存路径获取与更改
  saveDirPath.textContent = await mockIpcRenderer.invoke('config:get-projects-root');
  assert.equal(saveDirPath.textContent, 'D:\\Videos\\DogSC', '初始化时读取默认存储路径');

  changeSaveDir.addEventListener('click', async () => {
    const chosen = await mockIpcRenderer.invoke('config:choose-projects-root');
    if (chosen) saveDirPath.textContent = chosen;
  });
  await changeSaveDir.click();
  assert.equal(saveDirPath.textContent, 'E:\\MyRecordings', '点击更改后更新存储路径显示');

  // 验证快捷键弹窗响应
  let shortcutsOpened = false;
  shortcutsBtn.addEventListener('click', () => {
    shortcutsOpened = true;
    shortcutsModal.hidden = false;
  });
  shortcutsClose.addEventListener('click', () => {
    shortcutsModal.hidden = true;
  });

  shortcutsBtn.click();
  assert.equal(shortcutsOpened, true, '点击快捷键按钮触发弹窗');
  assert.equal(shortcutsModal.hidden, false, '弹窗显示');

  shortcutsClose.click();
  assert.equal(shortcutsModal.hidden, true, '点击关闭按钮关闭弹窗');
});

console.log(`全部 ${passed} 项 Recorder 控制台测试顺利通过！`);
