'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { trashProjects, trashSelectedProjects, trashEditorProject } = require('../src/main/project-trash');

let passed = 0;
async function test(name, body) {
  await body();
  passed += 1;
  console.log(`  ok  ${name}`);
}

function mockEditorWindow(closeBehavior) {
  const editor = new EventEmitter();
  editor.webContents = new EventEmitter();
  let destroyed = false;
  editor.isDestroyed = () => destroyed;
  editor.close = () => closeBehavior({
    editor,
    webContents: editor.webContents,
    close() { destroyed = true; editor.emit('closed'); },
  });
  return editor;
}

(async () => {
  console.log('Testing project bulk trash operation...');

  await test('批量移入回收站会继续处理失败项目并返回汇总', async () => {
    const calls = [];
    const result = await trashProjects(['one.dogscproject', 'two.dogscproject', 'three.dogscproject'], async (directory) => {
      calls.push(directory);
      if (directory === 'two.dogscproject') throw new Error('模拟回收站失败');
    });

    assert.deepEqual(calls, ['one.dogscproject', 'two.dogscproject', 'three.dogscproject']);
    assert.deepEqual(result, {
      total: 3,
      moved: 2,
      failed: [{ directory: 'two.dogscproject', error: '模拟回收站失败' }],
    });
  });

  await test('空项目列表不会调用移入回收站操作', async () => {
    let called = false;
    const result = await trashProjects([], async () => { called = true; });
    assert.equal(called, false);
    assert.deepEqual(result, { total: 0, moved: 0, failed: [] });
  });

  await test('所选工程批量回收站只确认一次并汇总部分失败', async () => {
    const one = path.resolve('fixture-one.dogscproject');
    const two = path.resolve('fixture-two.dogscproject');
    let confirmations = 0;
    const calls = [];
    const result = await trashSelectedProjects({
      requestedDirectories: [one, two, one],
      availableDirectories: [one, two],
      confirm: async (total) => { confirmations += 1; assert.equal(total, 2); return true; },
      trashProject: async (directory) => {
        calls.push(directory);
        if (directory === two) throw new Error('模拟回收站失败');
      },
    });

    assert.equal(confirmations, 1);
    assert.deepEqual(calls, [one, two]);
    assert.deepEqual(result, {
      total: 2,
      moved: 1,
      failed: [{ directory: two, error: '模拟回收站失败' }],
      cancelled: false,
    });
  });

  await test('所选路径必须来自当前工程清单，清单外路径不会执行', async () => {
    const listed = path.resolve('safe-root', 'listed.dogscproject');
    const outside = path.resolve('outside-root', 'private.dogscproject');
    let confirmations = 0;
    const calls = [];
    const result = await trashSelectedProjects({
      requestedDirectories: [listed, outside],
      availableDirectories: [listed],
      confirm: async () => { confirmations += 1; return true; },
      trashProject: async (directory) => calls.push(directory),
    });

    assert.equal(confirmations, 1);
    assert.deepEqual(calls, [listed]);
    assert.equal(result.moved, 1);
    assert.deepEqual(result.failed, [{ directory: outside, error: '项目路径无效或已不在当前工程列表中' }]);
  });

  await test('取消确认时不会调用回收站操作', async () => {
    const directory = path.resolve('fixture-cancel.dogscproject');
    let confirmations = 0;
    let called = false;
    const result = await trashSelectedProjects({
      requestedDirectories: [directory],
      availableDirectories: [directory],
      confirm: async () => { confirmations += 1; return false; },
      trashProject: async () => { called = true; },
    });

    assert.equal(confirmations, 1);
    assert.equal(called, false);
    assert.deepEqual(result, { total: 1, moved: 0, failed: [], cancelled: true });
  });

  await test('编辑器阻止关闭时工程不会进入回收站', async () => {
    const editor = mockEditorWindow(({ webContents }) => webContents.emit('will-prevent-unload'));
    let trashed = false;
    await assert.rejects(
      trashEditorProject(editor, 'project', async () => { trashed = true; }),
      /尚未保存完成/,
    );
    assert.equal(trashed, false);
  });

  await test('延迟发出 closed 时先等待窗口关闭再移入回收站', async () => {
    const order = [];
    const editor = mockEditorWindow(({ close }) => {
      order.push('close-request');
      setTimeout(() => { order.push('closed'); close(); }, 5);
    });
    await trashEditorProject(editor, 'project', async () => { order.push('trash'); });
    assert.deepEqual(order, ['close-request', 'closed', 'trash']);
  });

  await test('某个编辑器关闭受阻时批量流程跳过它并继续后续项目', async () => {
    const first = mockEditorWindow(({ webContents }) => webContents.emit('will-prevent-unload'));
    const second = mockEditorWindow(({ close }) => close());
    const calls = [];
    const result = await trashProjects(['first', 'second'], async (directory) => {
      await trashEditorProject(directory === 'first' ? first : second, directory, async (projectDirectory) => calls.push(projectDirectory));
    });
    assert.deepEqual(calls, ['second']);
    assert.deepEqual(result, {
      total: 2,
      moved: 1,
      failed: [{ directory: 'first', error: '工程编辑器尚未保存完成，已跳过；请先保存并关闭编辑器后重试' }],
    });
  });

  console.log(`\n${passed} 项项目批量删除测试通过！`);
})().catch((error) => {
  console.error('测试失败:', error);
  process.exit(1);
});
