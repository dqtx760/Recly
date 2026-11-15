'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/ffmpeg.js'), 'utf8');
const body = source.slice(source.indexOf('const previewJobs ='), source.indexOf('async function checkAvailable'));
async function scenario({ cached = false, failures = 0 } = {}) {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const context = { path, Map, Promise, fs: {
    statSync(file) { if (file === 'screen.mp4') return { mtimeMs: 10 }; if (cached) return { size: 2048, mtimeMs: 11 }; throw Error('missing'); },
    rmSync() {}, renameSync() {},
  }, detectEncoder: async () => ({ name: 'h264_nvenc', format: 'nv12' }),
  ffmpeg: async args => { calls.push(args); await gate; if (calls.length <= failures) throw Error('driver refused'); },
  };
  vm.runInNewContext(body + '\nglobalThis.prepare = ensurePreview;', context);
  const first = context.prepare('screen.mp4', 'preview.mp4');
  const second = context.prepare('screen.mp4', 'preview.mp4');
  release();
  assert.deepEqual(await Promise.all([first, second]), ['preview.mp4', 'preview.mp4']);
  return calls;
}
(async () => {
  assert.equal((await scenario({ cached: true })).length, 0, '新鲜代理直接复用');
  const cuda = await scenario();
  assert.equal(cuda.length, 1, '并发打开只生成一份代理');
  assert.ok(cuda[0].includes('cuda'), '优先硬件解码和缩放');
  const cpuScale = await scenario({ failures: 1 });
  assert.equal(cpuScale.length, 2, 'CUDA不可用时退回普通解码与硬编码');
  const software = await scenario({ failures: 2 });
  assert.equal(software.length, 3, '硬件均失败时仍可使用软件编码');
  assert.ok(software[2].includes('libx264'));
  assert.ok(software[2].includes('ultrafast'));
  console.log('代理缓存、并发去重、GPU失败与软件回退测试通过。');
})().catch(error => { console.error(error); process.exitCode = 1; });
