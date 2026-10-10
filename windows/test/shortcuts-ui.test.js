'use strict';
// 键盘快捷键交互式配置 UI 单元测试与交互验证。
// 运行：node windows/test/shortcuts-ui.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  openShortcutsModal,
  closeShortcutsModal,
  formatKeyDisplay,
  parseKeyCombination,
  createDomElement,
  DEFAULT_SHORTCUTS,
  SHORTCUT_CATEGORIES,
} = require('../src/renderer/editor/shortcuts-modal');

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
 * 创建模拟 IPC 实例
 */
function createMockIpc(initialShortcuts = {}) {
  let shortcuts = { ...DEFAULT_SHORTCUTS, ...initialShortcuts };
  const calls = [];

  return {
    calls,
    getShortcuts: () => ({ ...shortcuts }),
    async invoke(channel, payload) {
      calls.push({ channel, payload });
      if (channel === 'shortcuts:get') {
        return { ...shortcuts };
      }
      if (channel === 'shortcuts:set') {
        const newMap = (payload && typeof payload === 'object' && payload.shortcuts) ? payload.shortcuts : payload;
        // 冲突检测
        const seen = new Map();
        for (const [action, acc] of Object.entries(newMap)) {
          if (seen.has(acc)) {
            throw new Error(`快捷键冲突: "${acc}" 同时分配给了 "${seen.get(acc)}" 和 "${action}"`);
          }
          seen.set(acc, action);
        }
        shortcuts = { ...shortcuts, ...newMap };
        return { ...shortcuts };
      }
      if (channel === 'shortcuts:reset') {
        shortcuts = { ...DEFAULT_SHORTCUTS };
        return { ...shortcuts };
      }
      throw new Error(`Unhandled channel: ${channel}`);
    },
  };
}

async function runTests() {
  console.log('Testing Interactive Shortcuts Modal UI & Logic...');

  // --- 模块定义与默认配置 ---
  console.log('\n--- 1. 默认快捷键映射与分类定义 ---');
  test('DEFAULT_SHORTCUTS 包含录制控制与编辑器全部 9 项快捷键', () => {
    assert.equal(DEFAULT_SHORTCUTS.recordToggle, 'Control+Alt+R');
    assert.equal(DEFAULT_SHORTCUTS.recordPause, 'Control+Alt+P');
    assert.equal(DEFAULT_SHORTCUTS.recordMarker, 'Control+Alt+M');
    assert.equal(DEFAULT_SHORTCUTS.recordDiscard, 'Control+Alt+D');
    assert.equal(DEFAULT_SHORTCUTS.play, 'Space');
    assert.equal(DEFAULT_SHORTCUTS.split, 'S');
    assert.equal(DEFAULT_SHORTCUTS.delete, 'Delete');
    assert.equal(DEFAULT_SHORTCUTS.addZoom, 'Z');
    assert.equal(DEFAULT_SHORTCUTS.export, 'Control+E');
  });

  test('SHORTCUT_CATEGORIES 准确定义录制控制与编辑器两大分类', () => {
    assert.equal(SHORTCUT_CATEGORIES.length, 2);
    const [rec, edit] = SHORTCUT_CATEGORIES;
    assert.equal(rec.id, 'recording');
    assert.equal(rec.title, '录制控制');
    assert.deepEqual(rec.items.map((i) => i.action), ['recordToggle', 'recordPause', 'recordMarker', 'recordDiscard']);

    assert.equal(edit.id, 'editor');
    assert.equal(edit.title, '编辑器快捷键');
    assert.deepEqual(edit.items.map((i) => i.action), ['play', 'split', 'delete', 'addZoom', 'export']);
  });

  // --- 按键格式化 ---
  console.log('\n--- 2. 按键显示格式化 (formatKeyDisplay) ---');
  test('修饰键与字母组合转换为友好格式', () => {
    assert.equal(formatKeyDisplay('Control+Alt+R'), 'Ctrl + Alt + R');
    assert.equal(formatKeyDisplay('Control+Shift+E'), 'Ctrl + Shift + E');
    assert.equal(formatKeyDisplay('CommandOrControl+Alt+D'), 'Ctrl + Alt + D');
  });

  test('特殊键与单键格式化', () => {
    assert.equal(formatKeyDisplay('Space'), 'Space');
    assert.equal(formatKeyDisplay('Delete'), 'Delete');
    assert.equal(formatKeyDisplay('S'), 'S');
    assert.equal(formatKeyDisplay('Z'), 'Z');
    assert.equal(formatKeyDisplay('Control+E'), 'Ctrl + E');
    assert.equal(formatKeyDisplay(''), '');
    assert.equal(formatKeyDisplay(null), '');
  });

  // --- 按键解析捕获 ---
  console.log('\n--- 3. 按键事件解析与捕获 (parseKeyCombination) ---');
  test('纯修饰键按下时标记为 isModifierOnly', () => {
    assert.deepEqual(parseKeyCombination({ key: 'Control' }), { isModifierOnly: true });
    assert.deepEqual(parseKeyCombination({ key: 'Alt' }), { isModifierOnly: true });
    assert.deepEqual(parseKeyCombination({ key: 'Shift' }), { isModifierOnly: true });
  });

  test('单独按下 Escape 标记为 isCancel', () => {
    const res = parseKeyCombination({ key: 'Escape', ctrlKey: false, altKey: false, shiftKey: false });
    assert.equal(res.isCancel, true);
  });

  test('捕获修饰键组合键', () => {
    const res1 = parseKeyCombination({ key: 'r', ctrlKey: true, altKey: true, shiftKey: false });
    assert.equal(res1.accelerator, 'Control+Alt+R');
    assert.deepEqual(res1.modifiers, ['Control', 'Alt']);
    assert.equal(res1.key, 'R');

    const res2 = parseKeyCombination({ key: 'F9', ctrlKey: true, altKey: false, shiftKey: true });
    assert.equal(res2.accelerator, 'Control+Shift+F9');
    assert.equal(res2.key, 'F9');
  });

  test('捕获单键（空格、删除、字母）', () => {
    const spaceRes = parseKeyCombination({ key: ' ' });
    assert.equal(spaceRes.accelerator, 'Space');

    const delRes = parseKeyCombination({ key: 'Delete' });
    assert.equal(delRes.accelerator, 'Delete');

    const sRes = parseKeyCombination({ key: 's' });
    assert.equal(sRes.accelerator, 'S');
  });

  // --- 弹窗渲染 ---
  console.log('\n--- 4. 弹窗打开与 DOM 结构渲染 (openShortcutsModal) ---');
  await asyncTest('正确拉取快捷键并完整渲染两类快捷键列表', async () => {
    const mockIpc = createMockIpc();
    const container = createDomElement('div', { id: 'modal', hidden: true });

    const modal = await openShortcutsModal(container, { ipcRenderer: mockIpc });
    assert.equal(container.hidden, false, '容器应被设置为可见');

    // 检查分类标题
    const categoryTitles = container.querySelectorAll('.shortcuts-category-title');
    assert.equal(categoryTitles.length, 2);
    assert.equal(categoryTitles[0].textContent, '录制控制');
    assert.equal(categoryTitles[1].textContent, '编辑器快捷键');

    // 检查快捷键按钮数量与默认键位文本
    const buttons = container.querySelectorAll('.shortcut-key-btn');
    assert.equal(buttons.length, 9, '应渲染全部 9 个快捷键项');

    const toggleBtn = container.querySelector('[data-action="recordToggle"]');
    assert.ok(toggleBtn);
    assert.equal(toggleBtn.textContent, 'Ctrl + Alt + R');

    const playBtn = container.querySelector('[data-action="play"]');
    assert.ok(playBtn);
    assert.equal(playBtn.textContent, 'Space');

    modal.close();
    assert.equal(container.hidden, true, '关闭后容器应隐藏');
  });

  // --- 交互式重绑定按键流程 ---
  console.log('\n--- 5. 交互式录制与改键持久化 ---');
  await asyncTest('点击按键进入监听模式，按下新按键后立即更新文本并保存', async () => {
    const mockIpc = createMockIpc();
    const container = createDomElement('div', { id: 'modal', hidden: true });
    let savedData = null;

    const modal = await openShortcutsModal(container, {
      ipcRenderer: mockIpc,
      onSave: (map) => { savedData = map; },
    });

    const toggleBtn = container.querySelector('[data-action="recordToggle"]');
    assert.equal(toggleBtn.textContent, 'Ctrl + Alt + R');

    // 1. 点击按钮进入监听模式
    toggleBtn.click();
    assert.equal(toggleBtn.textContent, '按下新按键...');
    assert.ok(toggleBtn.className.includes('listening'));

    // 2. 模拟按下修饰键（不应结束监听）
    await modal.dispatchKey({ key: 'Control', ctrlKey: true });
    assert.equal(toggleBtn.textContent, '按下新按键...');

    // 3. 模拟按下完整的 Ctrl + Alt + F8
    await modal.dispatchKey({ key: 'F8', ctrlKey: true, altKey: true, shiftKey: false });

    // 4. 验证按钮文本立即更新
    assert.equal(toggleBtn.textContent, 'Ctrl + Alt + F8');
    assert.ok(!toggleBtn.className.includes('listening'));

    // 5. 验证持久化调用
    assert.equal(mockIpc.getShortcuts().recordToggle, 'Control+Alt+F8');
    assert.ok(savedData);
    assert.equal(savedData.recordToggle, 'Control+Alt+F8');

    modal.close();
  });

  await asyncTest('监听模式下按 Escape 取消录制，恢复原本快捷键', async () => {
    const mockIpc = createMockIpc();
    const container = createDomElement('div', { id: 'modal', hidden: true });

    const modal = await openShortcutsModal(container, { ipcRenderer: mockIpc });
    const pauseBtn = container.querySelector('[data-action="recordPause"]');
    assert.equal(pauseBtn.textContent, 'Ctrl + Alt + P');

    // 按 Escape 取消
    await modal.dispatchKey({ key: 'Escape', ctrlKey: false, altKey: false, shiftKey: false });
    assert.equal(pauseBtn.textContent, 'Ctrl + Alt + P');
    assert.ok(!pauseBtn.className.includes('listening'));

    // 验证没有写入新配置
    assert.equal(mockIpc.getShortcuts().recordPause, 'Control+Alt+P');

    modal.close();
  });

  await asyncTest('按键冲突时显示错误信息并回滚按钮文本', async () => {
    const mockIpc = createMockIpc();
    const container = createDomElement('div', { id: 'modal', hidden: true });

    const modal = await openShortcutsModal(container, { ipcRenderer: mockIpc });
    const errorEl = container.querySelector('.shortcuts-error');
    assert.equal(errorEl.hidden, true);

    const markerBtn = container.querySelector('[data-action="recordMarker"]');
    markerBtn.click();
    assert.equal(markerBtn.textContent, '按下新按键...');

    // 尝试绑定为已存在的 recordToggle (Ctrl + Alt + R)
    await modal.dispatchKey({ key: 'r', ctrlKey: true, altKey: true });
    // 应捕获冲突错误并回滚
    assert.equal(markerBtn.textContent, 'Ctrl + Alt + M');
    assert.equal(errorEl.hidden, false);
    assert.ok(errorEl.textContent.includes('快捷键冲突'));

    modal.close();
  });

  // --- 恢复默认 ---
  console.log('\n--- 6. 恢复默认设置 ---');
  await asyncTest('点击“恢复默认”重置全部快捷键并更新界面所有按钮', async () => {
    // 初始状态包含自定义修改
    const mockIpc = createMockIpc({
      recordToggle: 'Control+Shift+T',
      play: 'K',
    });
    const container = createDomElement('div', { id: 'modal', hidden: true });

    const modal = await openShortcutsModal(container, { ipcRenderer: mockIpc });
    const toggleBtn = container.querySelector('[data-action="recordToggle"]');
    const playBtn = container.querySelector('[data-action="play"]');

    assert.equal(toggleBtn.textContent, 'Ctrl + Shift + T');
    assert.equal(playBtn.textContent, 'K');

    // 点击恢复默认
    const resetBtn = container.querySelector('.shortcuts-reset');
    assert.ok(resetBtn);
    await modal.resetToDefaults();

    // 验证已全部恢复为默认
    assert.equal(toggleBtn.textContent, 'Ctrl + Alt + R');
    assert.equal(playBtn.textContent, 'Space');
    assert.equal(mockIpc.getShortcuts().recordToggle, 'Control+Alt+R');
    assert.equal(mockIpc.getShortcuts().play, 'Space');

    modal.close();
  });

  // --- HTML 与调用文件挂载验证 ---
  console.log('\n--- 7. 项目文件集成挂载检查 ---');
  test('windows/src/renderer/editor.html 包含 #shortcuts 按钮与 #modal 容器', () => {
    const editorHtml = fs.readFileSync(path.join(__dirname, '../src/renderer/editor.html'), 'utf8');
    assert.ok(editorHtml.includes('id="shortcuts"'), 'editor.html 必须包含 id="shortcuts"');
    assert.ok(editorHtml.includes('id="modal"'), 'editor.html 必须包含 id="modal"');
  });

  test('windows/src/renderer/editor/app.js 引入并绑定 openShortcutsModal', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '../src/renderer/editor/app.js'), 'utf8');
    assert.ok(appJs.includes("require('./shortcuts-modal')"), 'app.js 必须引入 shortcuts-modal');
    assert.ok(appJs.includes("openShortcutsModal($('modal'))"), 'app.js 必须在点击 #shortcuts 时调用 openShortcutsModal');
  });

  test('windows/src/renderer/recorder.html 包含 #shortcuts-btn 按钮与 #shortcuts-modal 容器', () => {
    const recHtml = fs.readFileSync(path.join(__dirname, '../src/renderer/recorder.html'), 'utf8');
    assert.ok(recHtml.includes('id="shortcuts-btn"'), 'recorder.html 必须包含 id="shortcuts-btn"');
    assert.ok(recHtml.includes('id="shortcuts-modal"'), 'recorder.html 必须包含 id="shortcuts-modal"');
  });

  console.log(`\n全部 ${passed} 项测试通过！100% SUCCESS.`);
}

runTests().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
