'use strict';
// 场景预设 UI 单元测试与回归：状态追踪、预设应用、另存为、更新、默认设置与弹窗交互。
// 运行：node windows/test/presets-ui.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = require('../src/core/model');
const { getDefaultPresets, matchesPreset } = require('../src/core/presets');
const { PresetsUI, createDomElement } = require('../src/renderer/editor/presets-ui');

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

/**
 * 创建模拟 Store
 */
function createMockStore(initialProject) {
  return {
    project: JSON.parse(JSON.stringify(initialProject)),
    listeners: new Set(),
    undoStack: [],
    subscribe(fn) {
      this.listeners.add(fn);
    },
    emit(reason) {
      for (const fn of this.listeners) fn(reason);
    },
    mutate(change) {
      this.undoStack.push(JSON.stringify(this.project));
      change(this.project);
      this.emit('project');
    },
    undo() {
      if (!this.undoStack.length) return;
      this.project = JSON.parse(this.undoStack.pop());
      this.emit('project');
    },
  };
}

/**
 * 创建模拟 IPC
 */
function createMockIpc(initialPresets = getDefaultPresets()) {
  let presets = JSON.parse(JSON.stringify(initialPresets));
  const calls = [];

  return {
    calls,
    getPresets: () => presets,
    async invoke(channel, ...args) {
      calls.push({ channel, args });
      if (channel === 'presets:list') {
        return JSON.parse(JSON.stringify(presets));
      }
      if (channel === 'presets:save') {
        const [presetData] = args;
        const copy = JSON.parse(JSON.stringify(presetData));
        const idx = presets.findIndex((p) => p.id === copy.id);
        if (idx >= 0) {
          presets[idx] = { ...presets[idx], ...copy };
        } else {
          presets.push(copy);
        }
        return copy;
      }
      if (channel === 'presets:set-default') {
        const [id] = args;
        for (const p of presets) {
          p.isDefault = (p.id === id);
        }
        return true;
      }
      if (channel === 'presets:delete') {
        const [id] = args;
        presets = presets.filter((p) => p.id !== id);
        return true;
      }
      throw new Error(`Unknown channel: ${channel}`);
    },
  };
}

async function runTests() {
  console.log('Testing Scene Presets UI & State Tracking...');

  // 1. editor.html 检查
  test('editor.html 顶栏包含 #scene-preset 按钮', () => {
    const htmlPath = path.join(__dirname, '..', 'src', 'renderer', 'editor.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('id="scene-preset"'), 'editor.html 必须包含 id="scene-preset"');
    assert.ok(html.includes('场景预设'), 'editor.html 必须包含“场景预设”文字');
  });

  // 2. 初始化与默认匹配
  await asyncTest('PresetsUI 初始化：拉取预设并自动匹配当前项目', async () => {
    const project = model.makeProject({ name: 'Demo', media: { screen: { duration: 10 } }, capture: {} });
    const store = createMockStore(project);
    const ipc = createMockIpc();
    const button = createDomElement('button', { id: 'scene-preset' });
    const modal = createDomElement('div', { id: 'modal', hidden: true });

    const ui = new PresetsUI({ store, button, modal, ipc });
    await ui.init();

    assert.equal(ui.presets.length, 3, '应加载 3 个默认预设');
    assert.equal(ui.getActivePreset().name, '黑曜石网格', '初始项目应匹配默认预设“黑曜石网格”');
    assert.equal(ui.isModified, false, '初始状态不应标记为已修改');
    assert.equal(button.textContent, '黑曜石网格 ▾', '按钮文字应显示激活预设名称');
  });

  // 3. 应用预设
  await asyncTest('应用预设：更新 Store 项目属性与激活状态', async () => {
    const project = model.makeProject({ name: 'Demo', media: { screen: { duration: 10 } }, capture: {} });
    const store = createMockStore(project);
    const ipc = createMockIpc();
    const button = createDomElement('button', { id: 'scene-preset' });
    const modal = createDomElement('div', { id: 'modal', hidden: true });

    const ui = new PresetsUI({ store, button, modal, ipc });
    await ui.init();

    const minimalist = ui.presets.find((p) => p.name === '极简纯色');
    assert.ok(minimalist, '必须存在极简纯色预设');

    ui.applyPreset(minimalist);

    assert.equal(store.project.canvas.padding, 60, '应用极简预设后内边距应为 60');
    assert.equal(store.project.camera.shape, 'circle', '应用极简预设后摄像头应为圆形');
    assert.equal(ui.getActivePreset().name, '极简纯色', '激活预设应更新为极简纯色');
    assert.equal(ui.isModified, false, '刚应用预设时修改标记为 false');
    assert.equal(button.textContent, '极简纯色 ▾', '按钮文字应更新为“极简纯色 ▾”');
  });

  // 4. 修改检测与更新按钮可见性
  await asyncTest('修改状态追踪：项目外观被修改时标记 isModified，并在弹窗显示“更新此预设”', async () => {
    const project = model.makeProject({ name: 'Demo', media: { screen: { duration: 10 } }, capture: {} });
    const store = createMockStore(project);
    const ipc = createMockIpc();
    const button = createDomElement('button', { id: 'scene-preset' });
    const modal = createDomElement('div', { id: 'modal', hidden: true });

    const ui = new PresetsUI({ store, button, modal, ipc });
    await ui.init();

    ui.openModal();
    let updateBtn = modal.querySelector('#preset-update-active');
    assert.equal(updateBtn, null, '未修改时“更新此预设”按钮不应出现');

    // 修改画布内边距
    store.mutate((draft) => {
      draft.canvas.padding = 150;
    });

    assert.equal(ui.isModified, true, '外观变动后 isModified 应为 true');
    updateBtn = modal.querySelector('#preset-update-active');
    assert.ok(updateBtn, '修改后弹窗中必须出现“更新此预设”按钮');
    assert.equal(updateBtn.textContent, '更新此预设');

    // 撤销变动
    store.undo();
    assert.equal(ui.isModified, false, '恢复后 isModified 应还原为 false');
    updateBtn = modal.querySelector('#preset-update-active');
    assert.equal(updateBtn, null, '恢复后“更新此预设”按钮应消失');
  });

  // 5. 更新此预设
  await asyncTest('“更新此预设”保存改动到当前激活预设并清除修改标记', async () => {
    const project = model.makeProject({ name: 'Demo', media: { screen: { duration: 10 } }, capture: {} });
    const store = createMockStore(project);
    const ipc = createMockIpc();
    const button = createDomElement('button', { id: 'scene-preset' });
    const modal = createDomElement('div', { id: 'modal', hidden: true });

    const ui = new PresetsUI({ store, button, modal, ipc });
    await ui.init();
    ui.openModal();

    // 修改圆角与阴影
    store.mutate((draft) => {
      draft.canvas.borderRadius = 40;
      draft.canvas.shadow = 0.8;
    });
    assert.equal(ui.isModified, true);

    const saved = await ui.updateActivePreset();
    assert.ok(saved);
    assert.equal(saved.canvas.borderRadius, 40);
    assert.equal(ui.isModified, false, '更新预设后修改状态应重置');

    const updateCalls = ipc.calls.filter((c) => c.channel === 'presets:save');
    assert.ok(updateCalls.length > 0, '必须向主进程调用 presets:save');

    const updateBtn = modal.querySelector('#preset-update-active');
    assert.equal(updateBtn, null, '更新完成后“更新此预设”按钮应隐藏');
  });

  // 6. 另存为新预设
  await asyncTest('“另存为新预设”捕获当前项目外观并调用 presets:save', async () => {
    const project = model.makeProject({ name: 'Demo', media: { screen: { duration: 10 } }, capture: {} });
    const store = createMockStore(project);
    const ipc = createMockIpc();
    const button = createDomElement('button', { id: 'scene-preset' });
    const modal = createDomElement('div', { id: 'modal', hidden: true });

    const ui = new PresetsUI({
      store,
      button,
      modal,
      ipc,
      prompt: () => '我的酷炫风格',
    });
    await ui.init();

    store.mutate((draft) => {
      draft.canvas.padding = 99;
      draft.camera.size = 0.45;
    });

    const newPreset = await ui.saveAsNewPreset();
    assert.ok(newPreset);
    assert.equal(newPreset.name, '我的酷炫风格');
    assert.equal(newPreset.canvas.padding, 99);
    assert.equal(newPreset.camera.size, 0.45);

    assert.equal(ui.getActivePreset().id, newPreset.id, '新预设应成为当前激活预设');
    assert.equal(button.textContent, '我的酷炫风格 ▾', '按钮文字应更新为新预设名称');
    assert.equal(ui.isModified, false);
    assert.equal(ui.presets.length, 4, '预设总数应变为 4');
  });

  // 7. 设为新录制默认
  await asyncTest('“设为新录制默认”调用 presets:set-default 并更新状态', async () => {
    const project = model.makeProject({ name: 'Demo', media: { screen: { duration: 10 } }, capture: {} });
    const store = createMockStore(project);
    const ipc = createMockIpc();
    const button = createDomElement('button', { id: 'scene-preset' });
    const modal = createDomElement('div', { id: 'modal', hidden: true });

    const ui = new PresetsUI({ store, button, modal, ipc });
    await ui.init();

    const desktopPreset = ui.presets.find((p) => p.name === 'Mac 桌面');
    assert.ok(desktopPreset);

    await ui.setDefault(desktopPreset.id);

    const setDefaultCalls = ipc.calls.filter((c) => c.channel === 'presets:set-default');
    assert.equal(setDefaultCalls.length, 1);
    assert.equal(setDefaultCalls[0].args[0], desktopPreset.id);

    const updatedDesktop = ui.presets.find((p) => p.id === desktopPreset.id);
    assert.equal(updatedDesktop.isDefault, true, 'Mac 桌面应被标记为默认');
  });

  // 8. 删除预设
  await asyncTest('“删除”预设调用 presets:delete，删除激活预设后重置激活状态', async () => {
    const project = model.makeProject({ name: 'Demo', media: { screen: { duration: 10 } }, capture: {} });
    const store = createMockStore(project);
    const ipc = createMockIpc();
    const button = createDomElement('button', { id: 'scene-preset' });
    const modal = createDomElement('div', { id: 'modal', hidden: true });

    const ui = new PresetsUI({
      store,
      button,
      modal,
      ipc,
      confirm: () => true,
    });
    await ui.init();

    const activeId = ui.activePresetId;
    assert.ok(activeId);

    const deleted = await ui.deletePreset(activeId);
    assert.equal(deleted, true);

    const deleteCalls = ipc.calls.filter((c) => c.channel === 'presets:delete');
    assert.equal(deleteCalls.length, 1);
    assert.equal(deleteCalls[0].args[0], activeId);

    assert.equal(ui.presets.length, 2, '预设数量应减少为 2');
    assert.equal(ui.activePresetId, null, '删除激活预设后激活 ID 应被清空');
    assert.equal(button.textContent, '场景预设 ▾', '按钮文字应回退到“场景预设 ▾”');
  });

  // 9. 弹窗 DOM 结构与对号 ✓ 检查
  await asyncTest('弹窗内显示预设列表与激活对号 ✓', async () => {
    const project = model.makeProject({ name: 'Demo', media: { screen: { duration: 10 } }, capture: {} });
    const store = createMockStore(project);
    const ipc = createMockIpc();
    const button = createDomElement('button', { id: 'scene-preset' });
    const modal = createDomElement('div', { id: 'modal', hidden: true });

    const ui = new PresetsUI({ store, button, modal, ipc });
    await ui.init();

    ui.openModal();
    assert.equal(modal.hidden, false, 'openModal 后 modal 不应为 hidden');

    const items = modal.querySelectorAll('.preset-item');
    assert.equal(items.length, 3, '应渲染 3 个预设选项卡片');

    const activeItem = modal.querySelector('.preset-item.active');
    assert.ok(activeItem, '应有高亮的预设项');
    const checkEl = activeItem.querySelector('.preset-check');
    assert.equal(checkEl.textContent, '✓', '激活项必须显示对号 ✓');

    // 点击另一个预设条目
    const nonActiveItems = items.filter((item) => !item.className.includes('active'));
    assert.ok(nonActiveItems.length > 0);
    nonActiveItems[0].click();

    // 重新检查激活状态
    const newActiveItem = modal.querySelector('.preset-item.active');
    assert.equal(newActiveItem.querySelector('.preset-check').textContent, '✓');

    // 背景点击关闭弹窗
    modal.dispatchEvent({ type: 'click', target: modal });
    assert.equal(modal.hidden, true, '点击遮罩层应关闭弹窗');
  });

  // 10. 窗口显隐流程（Window visibility flow）验证
  test('Window visibility flow：main.js 实现录制器隐藏与最后一个编辑器关闭时恢复显示', () => {
    const mainJsPath = path.join(__dirname, '..', 'src', 'main', 'main.js');
    const mainJs = fs.readFileSync(mainJsPath, 'utf8');
    assert.ok(mainJs.includes('recorderWindow.hide()'), 'main.js 必须包含 recorderWindow.hide()');
    assert.ok(mainJs.includes('recorderWindow.show()'), 'main.js 必须包含 recorderWindow.show()');
    assert.ok(mainJs.includes('editorWindows.size === 0'), 'main.js 必须在 editorWindows 全部关闭时恢复录制器');

    // 模拟状态机测试
    let recorderVisible = true;
    let destroyed = false;
    const recorderWindowMock = {
      isDestroyed: () => destroyed,
      hide: () => { recorderVisible = false; },
      show: () => { recorderVisible = true; },
    };

    const editorWindowsMock = new Map();
    const openEditorMock = (dir) => {
      if (recorderWindowMock && !recorderWindowMock.isDestroyed()) {
        recorderWindowMock.hide();
      }
      const win = {
        id: dir,
        callbacks: {},
        on(event, cb) { this.callbacks[event] = cb; },
        close() {
          editorWindowsMock.delete(dir);
          if (this.callbacks.closed) this.callbacks.closed();
          if (editorWindowsMock.size === 0 && recorderWindowMock && !recorderWindowMock.isDestroyed()) {
            recorderWindowMock.show();
          }
        },
      };
      editorWindowsMock.set(dir, win);
      return win;
    };

    // 打开第 1 个编辑器窗口 -> 录制器隐藏
    const win1 = openEditorMock('project-1');
    assert.equal(recorderVisible, false, '打开编辑器窗口时录制器应隐藏');
    assert.equal(editorWindowsMock.size, 1);

    // 打开第 2 个编辑器窗口 -> 录制器保持隐藏
    const win2 = openEditorMock('project-2');
    assert.equal(recorderVisible, false);
    assert.equal(editorWindowsMock.size, 2);

    // 关闭第 1 个窗口 -> 还有第 2 个窗口，录制器仍隐藏
    win1.close();
    assert.equal(recorderVisible, false);
    assert.equal(editorWindowsMock.size, 1);

    // 关闭最后一个窗口 -> 录制器恢复显示
    win2.close();
    assert.equal(recorderVisible, true, '全部编辑器窗口关闭后录制器应恢复显示');
    assert.equal(editorWindowsMock.size, 0);
  });

  console.log(`\n${passed} 项测试全部通过 100%`);
}

runTests().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
