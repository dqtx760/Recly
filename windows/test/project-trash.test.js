'use strict';

const assert = require('node:assert/strict');
const { trashProjects } = require('../src/main/project-trash');

let passed = 0;
async function test(name, body) {
  await body();
  passed += 1;
  console.log(`  ok  ${name}`);
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

  console.log(`\n${passed} 项项目批量删除测试通过！`);
})().catch((error) => {
  console.error('测试失败:', error);
  process.exit(1);
});
