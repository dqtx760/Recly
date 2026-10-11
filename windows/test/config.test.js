'use strict';
// 配置存储与项目目录管理测试：验证持久化、回退默认值、更新及 IPC 交互。
// 运行：node windows/test/config.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  getProjectsRoot,
  setProjectsRoot,
  getHideDesktopIconsDuringRecording,
  setHideDesktopIconsDuringRecording,
  registerConfigIpc,
  getConfigPath,
  setConfigPath,
  resetConfigPath,
  getDefaultProjectsRoot,
  loadConfig,
  saveConfig,
} = require('../src/main/config');

let passed = 0;
const test = (name, body) => {
  return Promise.resolve(body()).then(() => {
    passed += 1;
    console.log(`  ok  ${name}`);
  });
};

const tmpDir = path.join(os.tmpdir(), `dogsc-config-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

async function runTests() {
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log('--- 测试默认配置路径与回退默认值 ---');

  await test('getConfigPath 默认返回包含 DogSC/config.json 的路径', () => {
    resetConfigPath();
    const configPath = getConfigPath();
    assert.ok(typeof configPath === 'string' && configPath.length > 0);
    assert.ok(configPath.endsWith(path.join('DogSC', 'config.json')));
  });

  await test('getDefaultProjectsRoot 返回包含 DogSC 的视频目录路径', () => {
    const defaultRoot = getDefaultProjectsRoot();
    assert.ok(typeof defaultRoot === 'string' && defaultRoot.length > 0);
    assert.ok(defaultRoot.endsWith('DogSC'));
  });

  await test('未设置配置时，getProjectsRoot 回退到默认项目根目录', () => {
    const testConfigFile = path.join(tmpDir, 'empty-config.json');
    setConfigPath(testConfigFile);
    assert.equal(getProjectsRoot(), getDefaultProjectsRoot());
  });

  console.log('--- 测试配置更新与持久化 ---');

  await test('setProjectsRoot 保存项目路径并写入配置文件', () => {
    const testConfigFile = path.join(tmpDir, 'save-config.json');
    setConfigPath(testConfigFile);

    const customDir = path.join(tmpDir, 'MyCustomProjects');
    const returned = setProjectsRoot(customDir);

    assert.equal(returned, path.resolve(customDir));
    assert.equal(getProjectsRoot(), path.resolve(customDir));

    // 验证文件持久化存在且内容正确
    assert.ok(fs.existsSync(testConfigFile));
    const content = JSON.parse(fs.readFileSync(testConfigFile, 'utf8'));
    assert.equal(content.projectsRoot, path.resolve(customDir));
  });

  await test('setProjectsRoot 保持已有的其他配置项不变', () => {
    const testConfigFile = path.join(tmpDir, 'preserve-config.json');
    setConfigPath(testConfigFile);

    // 预写入其他配置
    fs.writeFileSync(testConfigFile, JSON.stringify({ someKey: 'value123', count: 42 }), 'utf8');

    const newDir = path.join(tmpDir, 'AnotherProjects');
    setProjectsRoot(newDir);

    const content = JSON.parse(fs.readFileSync(testConfigFile, 'utf8'));
    assert.equal(content.someKey, 'value123');
    assert.equal(content.count, 42);
    assert.equal(content.projectsRoot, path.resolve(newDir));
  });

  await test('setProjectsRoot(null) 清除自定义路径并回退到默认', () => {
    const testConfigFile = path.join(tmpDir, 'reset-config.json');
    setConfigPath(testConfigFile);

    setProjectsRoot(path.join(tmpDir, 'TempDir'));
    assert.notEqual(getProjectsRoot(), getDefaultProjectsRoot());

    const fallback = setProjectsRoot(null);
    assert.equal(fallback, getDefaultProjectsRoot());
    assert.equal(getProjectsRoot(), getDefaultProjectsRoot());

    const content = JSON.parse(fs.readFileSync(testConfigFile, 'utf8'));
    assert.equal(content.projectsRoot, undefined);
  });

  await test('setProjectsRoot 校验非法输入', () => {
    assert.throws(() => setProjectsRoot(''), /Invalid projects directory path/);
    assert.throws(() => setProjectsRoot('   '), /Invalid projects directory path/);
    assert.throws(() => setProjectsRoot(123), /Invalid projects directory path/);
    assert.throws(() => setProjectsRoot({}), /Invalid projects directory path/);
  });

  await test('桌面图标录制选项默认关闭，并且保留其他配置项', () => {
    const testConfigFile = path.join(tmpDir, 'desktop-icons-config.json');
    setConfigPath(testConfigFile);
    fs.writeFileSync(testConfigFile, JSON.stringify({ projectsRoot: 'D:/Projects', keep: 17 }), 'utf8');
    assert.equal(getHideDesktopIconsDuringRecording(), false);
    assert.equal(setHideDesktopIconsDuringRecording(true), true);
    assert.equal(getHideDesktopIconsDuringRecording(), true);
    const content = JSON.parse(fs.readFileSync(testConfigFile, 'utf8'));
    assert.equal(content.keep, 17);
    assert.equal(content.projectsRoot, 'D:/Projects');
    assert.equal(setHideDesktopIconsDuringRecording(false), false);
    assert.equal(getHideDesktopIconsDuringRecording(), false);
    assert.throws(() => setHideDesktopIconsDuringRecording('true'), /Invalid desktop icon visibility setting/);
  });

  await test('配置文件损坏时优雅回退而不崩溃', () => {
    const testConfigFile = path.join(tmpDir, 'corrupt-config.json');
    setConfigPath(testConfigFile);

    fs.writeFileSync(testConfigFile, '{ invalid json string ...', 'utf8');
    assert.equal(getProjectsRoot(), getDefaultProjectsRoot());
  });

  console.log('--- 测试 IPC 接口注册与调用 ---');

  await test('registerConfigIpc 正确注册并响应 config:get-projects-root 与 config:set-projects-root', async () => {
    const testConfigFile = path.join(tmpDir, 'ipc-config.json');
    setConfigPath(testConfigFile);

    const handlers = new Map();
    const mockIpc = {
      handle: (channel, fn) => handlers.set(channel, fn),
    };

    registerConfigIpc(mockIpc);

    assert.ok(handlers.has('config:get-projects-root'));
    assert.ok(handlers.has('config:set-projects-root'));
    assert.ok(handlers.has('config:choose-projects-root'));
    assert.ok(handlers.has('config:get-hide-desktop-icons'));
    assert.ok(handlers.has('config:set-hide-desktop-icons'));

    // 测试 get
    const initial = await handlers.get('config:get-projects-root')();
    assert.equal(initial, getDefaultProjectsRoot());

    // 测试 set
    const updateDir = path.join(tmpDir, 'IpcProjects');
    const updated = await handlers.get('config:set-projects-root')(null, updateDir);
    assert.equal(updated, path.resolve(updateDir));
    assert.equal(getProjectsRoot(), path.resolve(updateDir));
    assert.equal(await handlers.get('config:get-hide-desktop-icons')(), false);
    assert.equal(await handlers.get('config:set-hide-desktop-icons')(null, true), true);
    assert.equal(getHideDesktopIconsDuringRecording(), true);
  });

  await test('config:choose-projects-root: 用户选中目录时保存并返回新路径', async () => {
    const testConfigFile = path.join(tmpDir, 'ipc-dialog-config.json');
    setConfigPath(testConfigFile);

    const handlers = new Map();
    const mockIpc = {
      handle: (channel, fn) => handlers.set(channel, fn),
    };

    const chosenFolder = path.join(tmpDir, 'SelectedByDialog');
    let dialogCallArgs = null;
    const mockDialog = {
      showOpenDialog: async (...args) => {
        dialogCallArgs = args;
        const [options] = args;
        return { canceled: false, filePaths: [chosenFolder] };
      },
    };

    registerConfigIpc(mockIpc, mockDialog);

    const result = await handlers.get('config:choose-projects-root')({});
    assert.equal(result, path.resolve(chosenFolder));
    assert.equal(getProjectsRoot(), path.resolve(chosenFolder));

    assert.ok(dialogCallArgs);
    assert.equal(dialogCallArgs.length, 1, '目录选择器不绑定可能拦截交互的录制窗口');
    assert.deepEqual(dialogCallArgs[0].properties, ['openDirectory', 'createDirectory']);
  });

  await test('config:choose-projects-root: 用户取消选择时返回 null 且不修改配置', async () => {
    const testConfigFile = path.join(tmpDir, 'ipc-dialog-cancel-config.json');
    setConfigPath(testConfigFile);

    const initialDir = path.join(tmpDir, 'OriginalDir');
    setProjectsRoot(initialDir);

    const handlers = new Map();
    const mockIpc = {
      handle: (channel, fn) => handlers.set(channel, fn),
    };

    const mockDialog = {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    };

    registerConfigIpc(mockIpc, mockDialog);

    const result = await handlers.get('config:choose-projects-root')({});
    assert.equal(result, null);
    assert.equal(getProjectsRoot(), path.resolve(initialDir));
  });

  // 清理临时测试目录
  resetConfigPath();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  console.log(`\n${passed} 项 config 测试全部通过！`);
}

runTests().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
