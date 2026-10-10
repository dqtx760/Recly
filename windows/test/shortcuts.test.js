'use strict';
// 全局快捷键模块单元测试：格式解析、校验、持久化序列化与 IPC 注册。
// 运行：node test/shortcuts.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  DEFAULT_SHORTCUTS,
  getShortcuts,
  setShortcuts,
  registerShortcuts,
  unregisterShortcuts,
  registerShortcutsIpc,
  parseAccelerator,
  validateShortcut,
  getStoragePath,
  setStoragePath,
  resetShortcuts,
} = require('../src/main/shortcuts');

let passed = 0;
const test = (name, body) => {
  return Promise.resolve(body()).then(() => {
    passed += 1;
    console.log(`  ok  ${name}`);
  });
};

function createMockGlobalShortcut() {
  const registered = new Map();
  return {
    registered,
    register(accelerator, callback) {
      if (registered.has(accelerator)) {
        return false;
      }
      registered.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      registered.delete(accelerator);
    },
    unregisterAll() {
      registered.clear();
    },
    isRegistered(accelerator) {
      return registered.has(accelerator);
    },
  };
}

function createMockIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) {
      if (handlers.has(channel)) {
        throw new Error(`Handler already registered: ${channel}`);
      }
      handlers.set(channel, fn);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    async invoke(channel, ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`No handler for channel: ${channel}`);
      return fn({ sender: null }, ...args);
    },
  };
}

async function runTests() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsc-shortcuts-test-'));
  const testStoragePath = path.join(tempDir, 'shortcuts.json');

  try {
    console.log('--- 测试 1: 默认快捷键定义与路径 ---');
    await test('默认快捷键键位符合规范', () => {
      assert.equal(DEFAULT_SHORTCUTS.recordToggle, 'Control+Alt+R');
      assert.equal(DEFAULT_SHORTCUTS.recordPause, 'Control+Alt+P');
      assert.equal(DEFAULT_SHORTCUTS.recordMarker, 'Control+Alt+M');
      assert.equal(DEFAULT_SHORTCUTS.recordDiscard, 'Control+Alt+D');
    });

    await test('默认存储路径包含 DogSC/shortcuts.json', () => {
      resetShortcuts();
      const storagePath = getStoragePath();
      assert.match(storagePath, /DogSC[\\/]shortcuts\.json$/);
    });

    console.log('--- 测试 2: Electron Accelerator 格式解析与规范化 ---');
    await test('标准组合键解析', () => {
      const res = parseAccelerator('Control+Alt+R');
      assert.equal(res.valid, true);
      assert.deepEqual(res.modifiers, ['Control', 'Alt']);
      assert.equal(res.key, 'R');
      assert.equal(res.normalized, 'Control+Alt+R');
    });

    await test('修饰键别名与大小写标准化', () => {
      const r1 = parseAccelerator('ctrl+alt+r');
      assert.equal(r1.valid, true);
      assert.equal(r1.normalized, 'Control+Alt+R');

      const r2 = parseAccelerator('CmdOrCtrl+Shift+p');
      assert.equal(r2.valid, true);
      assert.equal(r2.normalized, 'CommandOrControl+Shift+P');

      const r3 = parseAccelerator('Option+Command+k');
      assert.equal(r3.valid, true);
      assert.equal(r3.normalized, 'Command+Alt+K');
    });

    await test('修饰键规范排序', () => {
      // Shift 应该在 Alt 后面，Alt 应该在 Control 后面
      const res = parseAccelerator('Shift+Alt+Ctrl+D');
      assert.equal(res.valid, true);
      assert.equal(res.normalized, 'Control+Alt+Shift+D');
    });

    await test('功能键 F1-F24', () => {
      const f1 = parseAccelerator('Control+f5');
      assert.equal(f1.valid, true);
      assert.equal(f1.normalized, 'Control+F5');

      const f12 = parseAccelerator('Alt+F12');
      assert.equal(f12.valid, true);
      assert.equal(f12.normalized, 'Alt+F12');
    });

    await test('特殊命名键与数字键', () => {
      const space = parseAccelerator('Control+space');
      assert.equal(space.valid, true);
      assert.equal(space.normalized, 'Control+Space');

      const esc = parseAccelerator('Alt+esc');
      assert.equal(esc.valid, true);
      assert.equal(esc.normalized, 'Alt+Escape');

      const num = parseAccelerator('Control+Alt+9');
      assert.equal(num.valid, true);
      assert.equal(num.normalized, 'Control+Alt+9');
    });

    await test('加号键 "+" 解析', () => {
      const p1 = parseAccelerator('Control+Alt++');
      assert.equal(p1.valid, true);
      assert.equal(p1.normalized, 'Control+Alt+Plus');

      const p2 = parseAccelerator('Control+Alt+Plus');
      assert.equal(p2.valid, true);
      assert.equal(p2.normalized, 'Control+Alt+Plus');
    });

    console.log('--- 测试 3: 快捷键合法性校验与错误提示 ---');
    await test('非法输入被拒绝', () => {
      assert.equal(validateShortcut('').valid, false);
      assert.equal(validateShortcut(null).valid, false);
      assert.equal(validateShortcut(12345).valid, false);
      assert.equal(validateShortcut('Control+').valid, false);
      assert.equal(validateShortcut('Control+Alt').valid, false);
      assert.equal(validateShortcut('Control+Alt+UnknownKey123').valid, false);
      assert.equal(validateShortcut('Ctrl+Alt+A+B').valid, false);
    });

    console.log('--- 测试 4: 本地序列化与读取持久化 ---');
    await test('初始化读取返回默认快捷键', () => {
      resetShortcuts();
      setStoragePath(testStoragePath);
      const current = getShortcuts();
      assert.deepEqual(current, DEFAULT_SHORTCUTS);
    });

    await test('更新快捷键并持久化到文件', () => {
      resetShortcuts();
      setStoragePath(testStoragePath);

      const updated = setShortcuts({
        recordToggle: 'Control+Shift+R',
      });

      assert.equal(updated.recordToggle, 'Control+Shift+R');
      assert.equal(updated.recordPause, DEFAULT_SHORTCUTS.recordPause);

      // 验证磁盘文件内容
      assert.equal(fs.existsSync(testStoragePath), true);
      const raw = JSON.parse(fs.readFileSync(testStoragePath, 'utf8'));
      assert.equal(raw.recordToggle, 'Control+Shift+R');

      // 重新读取也应一致
      resetShortcuts();
      setStoragePath(testStoragePath);
      const reloaded = getShortcuts();
      assert.equal(reloaded.recordToggle, 'Control+Shift+R');
    });

    await test('快捷键冲突检测', () => {
      resetShortcuts();
      setStoragePath(testStoragePath);

      assert.throws(() => {
        setShortcuts({
          recordPause: 'Control+Shift+R', // 与 recordToggle 冲突
        });
      }, /快捷键冲突/);
    });

    await test('损坏的 JSON 文件安全降级到默认', () => {
      resetShortcuts();
      setStoragePath(testStoragePath);
      fs.writeFileSync(testStoragePath, 'INVALID JSON!!!');

      const fallback = getShortcuts();
      assert.deepEqual(fallback, DEFAULT_SHORTCUTS);
    });

    console.log('--- 测试 5: 全局快捷键注册与动态更新 ---');
    await test('使用 mock globalShortcut 注册快捷键', () => {
      resetShortcuts();
      setStoragePath(testStoragePath);
      fs.rmSync(testStoragePath, { force: true });

      const mockGs = createMockGlobalShortcut();
      let toggleCount = 0;
      let markerCount = 0;

      const callbacks = {
        recordToggle: () => { toggleCount++; },
        recordMarker: () => { markerCount++; },
      };

      const ok = registerShortcuts(callbacks, mockGs);
      assert.equal(ok, true);

      assert.equal(mockGs.isRegistered('Control+Alt+R'), true);
      assert.equal(mockGs.isRegistered('Control+Alt+M'), true);
      assert.equal(mockGs.isRegistered('Control+Alt+P'), false);

      // 触发回调
      mockGs.registered.get('Control+Alt+R')();
      assert.equal(toggleCount, 1);
      mockGs.registered.get('Control+Alt+M')();
      assert.equal(markerCount, 1);
    });

    await test('setShortcuts 自动重新注册全局快捷键', () => {
      resetShortcuts();
      setStoragePath(testStoragePath);
      fs.rmSync(testStoragePath, { force: true });

      const mockGs = createMockGlobalShortcut();
      let toggleFired = false;

      registerShortcuts({
        recordToggle: () => { toggleFired = true; },
      }, mockGs);

      assert.equal(mockGs.isRegistered('Control+Alt+R'), true);

      // 修改为 Ctrl+Shift+F9
      setShortcuts({
        recordToggle: 'Control+Shift+F9',
      });

      // 原键位已注销，新键位已注册
      assert.equal(mockGs.isRegistered('Control+Alt+R'), false);
      assert.equal(mockGs.isRegistered('Control+Shift+F9'), true);

      mockGs.registered.get('Control+Shift+F9')();
      assert.equal(toggleFired, true);

      unregisterShortcuts(mockGs);
      assert.equal(mockGs.isRegistered('Control+Shift+F9'), false);
    });

    console.log('--- 测试 6: IPC 接口 shortcuts:get 与 shortcuts:set ---');
    await test('IPC 交互与获取', async () => {
      resetShortcuts();
      setStoragePath(testStoragePath);
      fs.rmSync(testStoragePath, { force: true });

      const mockIpc = createMockIpc();
      registerShortcutsIpc(mockIpc);

      const shortcuts = await mockIpc.invoke('shortcuts:get');
      assert.deepEqual(shortcuts, DEFAULT_SHORTCUTS);

      const modified = await mockIpc.invoke('shortcuts:set', {
        recordDiscard: 'Control+Alt+Shift+X',
      });
      assert.equal(modified.recordDiscard, 'Control+Alt+Shift+X');

      const reCheck = await mockIpc.invoke('shortcuts:get');
      assert.equal(reCheck.recordDiscard, 'Control+Alt+Shift+X');
    });

    console.log(`\n全部 ${passed} 项测试通过！`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    resetShortcuts();
  }
}

runTests().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
