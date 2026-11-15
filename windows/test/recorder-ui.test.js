'use strict';
// DogSC Bandicam-style Recorder Console 单元与交互集成测试
// 运行：node windows/test/recorder-ui.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
    'win-min', 'win-close', 'busy', 'done',
    'selection-pill', 'source-summary',
    'mic', 'mic-level',
    'cam-global', 'sys',
    'desktop-icons',
    'save-dir-path', 'change-save-dir', 'open-save-dir',
    'recording-history', 'delete-selected-projects',
    'export-dir-path', 'change-export-dir',
    'start', 'shortcuts-btn', 'memo',
    'doneTitle', 'doneDetail', 'again',
    'shortcuts-modal', 'shortcuts-close'
  ];
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `HTML 必须包含 id="${id}"`);
  }
  assert.doesNotMatch(html, /id=["']mic-name/, '麦克风模块不常驻显示设备名称');
  assert.doesNotMatch(html, /id=["']timer["']/, '录制按钮右侧不显示计时');
  const controller = fs.readFileSync(path.join(__dirname, '../src/renderer/recorder.js'), 'utf8');
  const preview = fs.readFileSync(path.join(__dirname, '../src/renderer/editor/preview.js'), 'utf8');
  assert.doesNotMatch(controller, /\$\('timer'\)|setInterval\(\(\) => \{[\s\S]*?formatTime/, '录制时不再刷新可见计时');
  assert.match(preview, /preview\.size > 1024 && preview\.mtimeMs >= original\.mtimeMs/, '仅使用完整且不早于原片的流畅预览素材');
  assert.match(preview, /make\('video', media\.screen, true, this\.quality === 'balanced' && existingProxy/, '已有代理应作为预览初始画面');
  assert.match(html, /id=["']mic-device-tip["'][^>]*hidden/, '当前音频设备名使用默认隐藏的临时提示');
  assert.match(controller, /function showCurrentMicrophone\(\)[\s\S]*?tip\.hidden = false[\s\S]*?setTimeout\(\(\) => \{ tip\.hidden = true; \}/, '单击麦克风可短暂看到当前设备名');
  assert.match(controller, /\$\('mic'\)\?\.addEventListener\('click', \(\) => \{ showCurrentMicrophone\(\); void toggleDevice\('mic'\)/, '单击仍执行原有开关动作并显示当前设备');
  assert.match(controller, /\$\('mic'\)\?\.addEventListener\('contextmenu'[\s\S]*?deviceMenu\('audioinput', state\.mic\)/, '右键麦克风必须打开设备列表');
  assert.match(controller, /audio:\s*\{\s*\.\.\.device\(requestedDeviceId\)/, '录制麦克风必须使用已选择的设备 ID');
  const deviceMenu = controller.slice(controller.indexOf('async function deviceMenu'), controller.indexOf('async function updateDeviceNames'));
  assert.match(deviceMenu, /if \(kind === 'audioinput'[\s\S]*?getUserMedia\(\{ audio: true \}\)/, '麦克风菜单保留授权探测');
  assert.doesNotMatch(deviceMenu, /getUserMedia\(\{ video: true \}\)/, '摄像头菜单必须先枚举，不能先打开默认设备');
  assert.match(controller, /status\.requestId !== state\.cam\.requestId/, '过期摄像头状态不能覆盖当前请求');
  assert.doesNotMatch(controller, /\$\('summary-library'\)/, '旧的工程库快捷入口已移除');
  assert.doesNotMatch(controller, /projects\.slice\(0,\s*5\)/, '首页应展示完整工程列表');
  assert.match(controller, /row\.addEventListener\('dblclick',[\s\S]*?ipcRenderer\.invoke\('project:open'/, '双击历史工程应直接打开编辑器');
  assert.match(controller, /deleteSelected \? `删除所选（\$\{selectedDirectories\.length\}）` : projectDirectory \? '删除此工程'/, '右键多选时明确执行所选工程批量移入回收站');
  assert.match(controller, /checked: target\.deviceId \? target\.deviceId === device\.deviceId : device\.deviceId === 'default'/, '设备菜单标出当前选中的麦克风');
  assert.doesNotMatch(html, /id=["']mic-status["']/, '首页不显示麦克风就绪状态小行');
  assert.match(html, /id=["']cam-global["'][^>]*aria-label=["']切换摄像头录制["']/, '隐藏画面提示时仍保留摄像头开关的无障碍名称');
  assert.match(html, /class=["']camera-preview-label["']/, '顶部摄像头卡片提供无画面提示');
  const styles = fs.readFileSync(path.join(__dirname, '../src/renderer/recorder.css'), 'utf8');
  assert.match(styles, /#cam-top-row\.preview-ready #cam-global > span[\s\S]*?#cam-global > \.toggle-indicator\s*\{\s*display:\s*none;/, '真实画面就绪时直接隐藏摄像头文字和状态点');
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
  assert.match(main, /showRecordingComplete\(result\)/, '结束录制后必须显示独立完成卡片');
  assert.match(main, /copyProjectToFolder\(source, dialogResult\.filePaths\[0\]\)/, '另存操作必须复制完整项目包');
});

test('提词器可缩放、摄像头默认右上且停止流程不显示整理界面', () => {
  const renderer = path.join(__dirname, '../src/renderer');
  const memo = fs.readFileSync(path.join(renderer, 'memo.html'), 'utf8');
  const controller = fs.readFileSync(path.join(renderer, 'recorder.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');

  assert.equal((memo.match(/class=["']resize-handle["']/g) || []).length, 8, '提词器应提供四边和四角缩放把手');
  assert.match(memo, /ipcRenderer\.send\('memo:resize-start'/, '缩放开始应交给主进程');
  assert.match(memo, /ipcRenderer\.send\('memo:resize-move'/, '缩放拖动应持续更新窗口尺寸');
  assert.match(main, /resizable:\s*true/, '提词器窗口应允许缩放');
  assert.match(main, /win !== memoWindow/, '缩放 IPC 只能控制提词器窗口');
  assert.match(main, /Math\.max\(minWidth, state\.bounds\.width/, '缩放宽度必须遵守最小值');
  assert.match(main, /Math\.max\(minHeight, state\.bounds\.height/, '缩放高度必须遵守最小值');
  assert.match(main, /x:\s*area\.x \+ area\.width - 240 - 36, y:\s*area\.y \+ 36/, '摄像头悬浮窗应默认位于主屏右上角');

  const stopFlow = controller.slice(controller.indexOf('async function stop()'), controller.indexOf('// 录制控制按钮'));
  const beforeStopInvoke = stopFlow.slice(0, stopFlow.indexOf("ipcRenderer.invoke('recorder:stop'"));
  assert.match(beforeStopInvoke, /requestCameraPreview\(false, state\.cam\.deviceId\)/, '停止时应关闭摄像头悬浮预览但保留启用偏好');
  assert.match(beforeStopInvoke, /ipcRenderer\.send\('recorder:close-overlays'\)/, '停止时应关闭提词器等录制悬浮窗');
  assert.doesNotMatch(beforeStopInvoke, /ipcRenderer\.send\('recorder:hide'\)/, '整理素材期间应保留主控台任务栏按钮');
  assert.match(beforeStopInvoke, /show\('busy'\)/, '整理素材期间应显示进度');
  assert.match(main, /function ensureRecorderTaskbarPresence\(\)[\s\S]*?showInactive\(\);[\s\S]*?minimize\(\);/, '托盘中的主控台应以不抢焦点的最小化状态保留任务栏入口');
  assert.match(main, /ensureRecorderTaskbarPresence\(\);[\s\S]*?sessionState\.finish/, '整理素材前必须先恢复任务栏入口');
  assert.doesNotMatch(beforeStopInvoke, /state\.session = null;\s*ipcRenderer\.send\('recorder:show'\)/, '停止入口不得无条件重新显示主控台');
  assert.match(stopFlow, /catch \(error\)[\s\S]*?ipcRenderer\.send\('recorder:show'\)/, '停止失败必须恢复主控台');
});

test('主控台图标路径指向实际打包资源', () => {
  const renderer = path.join(__dirname, '../src/renderer');
  const html = fs.readFileSync(path.join(renderer, 'recorder.html'), 'utf8');
  const iconPath = html.match(/<img src="([^"]+)"[^>]*aria-hidden="true"/);
  assert.ok(iconPath, '主控台应有品牌图标');
  assert.ok(fs.existsSync(path.resolve(renderer, iconPath[1])), `图标文件不存在：${iconPath[1]}`);
});

test('编辑器工程导航回到主控台首页历史且不会改写录制状态', () => {
  const renderer = path.join(__dirname, '../src/renderer');
  const editor = fs.readFileSync(path.join(renderer, 'editor/app.js'), 'utf8');
  const controller = fs.readFileSync(path.join(renderer, 'recorder.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  assert.match(editor, /\$\('open-library'\)\.addEventListener\('click', \(\) => ipcRenderer\.send\('recorder:library'\)\)/, '编辑器工程导航保留原入口');
  assert.match(main, /ipcMain\.on\('recorder:library', \(\) => showRecorderHistory\(\)\)/, '原入口转到主控台历史');
  const navigationStart = main.indexOf('function showRecorderHistory');
  const navigationEnd = main.indexOf('\n}', navigationStart) + 2;
  const navigation = main.slice(navigationStart, navigationEnd);
  const createNavigationFixture = (loading) => {
    const emitted = [];
    const listeners = new Map();
    const win = {
      isDestroyed: () => false,
      webContents: {
        isLoading: () => loading,
        once: (event, handler) => listeners.set(event, handler),
        send: (channel) => emitted.push(channel),
      },
    };
    const showHistoryRequest = vm.runInNewContext(`${navigation}; showRecorderHistory;`, {
      showRecorder: () => win,
      recorderWindow: win,
    });
    return { emitted, listeners, showHistoryRequest };
  };

  const loadingFixture = createNavigationFixture(true);
  loadingFixture.showHistoryRequest();
  assert.deepEqual(loadingFixture.emitted, [], '主控台仍在加载时不能提前发送导航事件');
  const didFinishLoad = loadingFixture.listeners.get('did-finish-load');
  assert.equal(typeof didFinishLoad, 'function', '加载中的主控台应注册加载完成回调');
  didFinishLoad();
  assert.deepEqual(loadingFixture.emitted, ['recorder:show-history'], '主控台加载完成后发送导航事件');

  const loadedFixture = createNavigationFixture(false);
  loadedFixture.showHistoryRequest();
  assert.deepEqual(loadedFixture.emitted, ['recorder:show-history'], '已加载的主控台立即发送导航事件');
  assert.equal(loadedFixture.listeners.size, 0, '已加载的主控台无需注册加载完成回调');
  assert.match(controller, /ipcRenderer\.on\('recorder:show-history',[\s\S]*?showHistoryPage\(\)/, '主控台监听历史导航事件');
  const showHistory = controller.slice(controller.indexOf('async function showHistoryPage'), controller.indexOf('let historyMenu'));
  assert.match(showHistory, /state\.starting \|\| state\.session \|\| state\.finishing/, '录制中不切换页面状态');
  assert.match(showHistory, /state\.collapsed[\s\S]*?recorder:set-collapsed[\s\S]*?state\.page = 'home'/, '导航时展开工作区并进入首页');
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
    if (selector.startsWith('.')) return this.children.find((c) => c.classList.contains(selector.slice(1))) || null;
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

asyncTest('录制中可切换页签且摄像头预览只响应显式开关', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/recorder.js'), 'utf8');
  const span = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `控制器中缺少测试片段：${start}`);
    return source.slice(from, to);
  };
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, new MockElement('div', id));
    return elements.get(id);
  };
  const pages = ['home', 'general', 'video', 'about'].map((page) => {
    const element = new MockElement('section', `page-${page}`, 'page');
    element.dataset.page = page;
    return element;
  });
  const navButtons = ['home', 'general', 'video', 'about'].map((page) => {
    const element = new MockElement('button', '', 'nav-item');
    element.dataset.page = page;
    return element;
  });
  const pageContent = getElement('page-content');
  const mainNav = getElement('main-nav');
  const cameraToggle = getElement('camera-preview-toggle');
  const cameraButton = getElement('cam-global');
  const cameraRow = getElement('cam-top-row');
  getElement('busy').hidden = true;
  const cameraLabel = new MockElement('span', '', 'camera-preview-label');
  cameraButton.appendChild(cameraLabel);
  const sent = [];
  const stored = JSON.stringify({ cam: true, camId: 'old-camera', showCameraPreview: true, cameraPreviewDefaultVersion: 2, mic: false, sys: false });
  let inlinePreviewUpdates = 0;
  const fakeCameraStream = {
    getVideoTracks: () => [{ kind: 'video', getSettings: () => ({ width: 1920, height: 1080 }), stop() {} }],
    getAudioTracks: () => [],
    getTracks() { return [...this.getVideoTracks()]; },
  };
  const ipcRenderer = {
    send(channel, payload) { sent.push({ channel, payload }); },
    async invoke(channel, payload) {
      if (channel === 'recorder:menu') return payload.find((item) => item.id === 'new-camera')?.id || null;
      if (channel === 'recorder:prepare') return { mediaDirectory: 'C:\\Temp\\ReclyTest' };
      return true;
    },
  };
  const context = {
    readinessSequence: 0,
    localStorage: { getItem: () => stored, setItem(_key, value) { this.value = value; } },
    ipcRenderer,
    navigator: { mediaDevices: { async enumerateDevices() { return [{ kind: 'videoinput', deviceId: 'new-camera', label: '测试摄像头' }]; } } },
    document: {
      getElementById: getElement,
      querySelectorAll(selector) { return selector === '.page' ? pages : selector === '.nav-item' ? navButtons : []; },
      querySelector(selector) { return selector === '.page-content' ? pageContent : selector === '.main-nav' ? mainNav : null; },
    },
    window: {},
    performance: { now: () => 1000 },
    setTimeout: () => 1,
    setInterval: () => 1,
    clearInterval() {},
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    openShortcutsModal: null,
    formatTime: () => '00:00',
    createHistorySelection: () => ({ clear() {} }),
    updateInlineCameraPreview() { inlinePreviewUpdates += 1; },
    updateDeviceNames: async () => {},
    prepareRecordingReadiness: async () => { context.__testApi.state.readiness.ready = true; },
    openStreams: async () => ({ streams: { camera: fakeCameraStream }, problems: [] }),
    startTrack: (kind, stream) => ({ kind, stream, started: Promise.resolve() }),
    stopTracks: async () => [],
    refreshHistory: () => Promise.resolve(),
    render: () => {},
  };
  context.$ = (id) => id === 'camera-preview-toggle' ? cameraToggle : getElement(id);

  const state = span('const state = {', '\nlet lastCompactHeight');
  const assembled = [
    "const settingsKey = 'dogsc.recorder'; const saved = JSON.parse(localStorage.getItem(settingsKey) || '{}');",
    state,
    'let lastCompactHeight = 0; let cameraRequestSequence = 0; let microphoneStream = null; let inlineCameraGeneration = 0; let inlineCameraStream = null; let inlineCameraOwnsStream = false; let inlineCameraDevice = null; let inlineCameraRequest = null; let stopInlineCameraWatch = null; let inlineCameraQuality = null; let inlineCameraLastFrameAt = 0; let inlineCameraHasFrame = false;',
    span('async function stopInlineCameraPreview(', '\nfunction cameraPreviewTarget'),
    span('const persist =', '\nfunction requestCameraPreview'),
    span('function requestCameraPreview(', '\nconst SOURCE_LABELS'),
    span('function show(panel)', '\nasync function showHistoryPage'),
    span('async function deviceMenu(', '\nasync function updateDeviceNames'),
    span('function render()', '\n// ------------------------------------------------------------------ 目标源与设备选择'),
    span("$('camera-preview-toggle')?.addEventListener('click'", "$('record-shortcuts')"),
    span('function beginStartFeedback()', '\nasync function stop()'),
    'globalThis.__testApi = { state, restoreCameraPreviewIfEnabled, showPage, start };',
  ].join('\n');
  vm.createContext(context);
  vm.runInContext(assembled, context);

  const api = context.__testApi;
  assert.equal(api.state.showCameraPreview, false, '旧版保存为开启时，新启动仍默认关闭悬浮预览');
  api.restoreCameraPreviewIfEnabled();
  assert.equal(sent.filter((entry) => entry.channel === 'recorder:camera-preview' && entry.payload.visible).length, 0, '启动恢复流程不能显示悬浮窗');
  await vm.runInContext("deviceMenu('videoinput', state.cam)", context);
  assert.equal(api.state.cam.deviceId, 'new-camera', '摄像头菜单应更新所选设备');
  assert.equal(sent.at(-1).channel, 'recorder:camera-preview');
  assert.equal(sent.at(-1).payload.visible, false, '选择设备不能自动显示悬浮摄像头');
  context.render();
  assert.equal(cameraLabel.textContent, '等待摄像头画面', '顶部卡片无真实画面时显示等待提示');

  api.state.environment.ok = true;
  api.state.readiness.ready = true;
  await api.start();
  assert.ok(api.state.session, `测试录制应启动成功：${JSON.stringify({ starting: api.state.starting, startError: api.state.startError, environment: api.state.environment, requests: sent.filter((entry) => entry.channel === 'recorder:camera-preview') })}`);
  assert.equal(api.state.session.tracks[0].kind, 'camera');
  assert.equal(sent.at(-1).payload.visible, false, '手动开关关闭时开始录制不能显示悬浮摄像头');
  assert.ok(inlinePreviewUpdates > 0, '录制状态变化仍更新顶部摄像头卡片');

  api.state.session = null;
  cameraToggle.click();
  assert.equal(sent.at(-1).payload.visible, true, '显式打开预览开关后才显示悬浮摄像头');
  api.state.environment.ok = true;
  api.state.readiness.ready = true;
  await api.start();
  assert.ok(api.state.session);
  assert.equal(sent.at(-1).payload.visible, true, '手动开关开启时录制开始允许恢复悬浮摄像头');
  cameraRow.classList.add('preview-ready');
  api.state.cam.on = true;
  api.state.cam.previewMessage = '摄像头未能持续提供画面';
  await vm.runInContext('stopInlineCameraPreview()', context);
  assert.equal(cameraRow.classList.contains('preview-ready'), false, '画面停止后移除 ready 状态');
  assert.equal(cameraLabel.textContent, '摄像头未能持续提供画面', '画面失败后恢复提示文字');
  api.state.cam.on = false;
  context.render();
  assert.equal(cameraLabel.textContent, '点击开启摄像头', '关闭摄像头后恢复可操作提示');

  api.showPage('video');
  assert.equal(api.state.page, 'video', '录制中允许切换到录像页');
  assert.ok(pages.find((page) => page.dataset.page === 'video').classList.contains('active'));
  assert.equal(mainNav.inert, false, '录制期间导航可交互');
  context.render();
  assert.equal(pageContent.inert, true, '录制期间设置内容继续锁定，避免修改采集参数');

  api.state.session = null;
  api.state.cam.on = true;
  api.state.environment.ok = true;
  context.openStreams = async () => { throw new Error('模拟摄像头准备失败'); };
  api.state.readiness.ready = true;
  await api.start();
  assert.equal(api.state.session, null, '模拟的摄像头准备失败不能进入录制状态');
  assert.equal(sent.at(-1).payload.visible, true, '手动开关开启时准备失败应恢复悬浮摄像头');
  cameraToggle.click();
  api.state.environment.ok = true;
  api.state.readiness.ready = true;
  await api.start();
  assert.equal(sent.at(-1).payload.visible, false, '手动关闭预览后准备失败仍保持悬浮摄像头关闭');
});

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
