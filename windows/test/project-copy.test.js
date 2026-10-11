'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { copyProjectToFolder } = require('../src/main/project-copy');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsc-project-copy-'));
const source = path.join(root, 'Take.dogscproject');
const failedSource = path.join(root, 'Interrupted.dogscproject');
const destination = path.join(root, 'destination');
const existing = path.join(destination, 'Take.dogscproject');
const copy = path.join(destination, 'Take 2.dogscproject');

fs.mkdirSync(source);
fs.mkdirSync(path.join(source, 'media'));
fs.writeFileSync(path.join(source, 'project.json'), '{"name":"Take"}');
fs.writeFileSync(path.join(source, 'media', 'screen.mp4'), 'source-video');
fs.mkdirSync(destination);

fs.mkdirSync(existing);
fs.writeFileSync(path.join(existing, 'project.json'), '{"name":"older"}');

const copiedTo = copyProjectToFolder(source, destination);
assert.equal(copiedTo, copy);
assert.equal(fs.readFileSync(path.join(copy, 'media', 'screen.mp4'), 'utf8'), 'source-video');
assert.equal(JSON.parse(fs.readFileSync(path.join(existing, 'project.json'), 'utf8')).name, 'older');
assert.equal(fs.existsSync(path.join(source, 'project.json')), true, '另存保留原项目');
assert.throws(() => copyProjectToFolder(source, source), /另存位置不能位于当前项目文件夹内/);
console.log('  ok  项目副本完整复制且不会覆盖旧项目或删除原项目');

fs.mkdirSync(failedSource);
fs.mkdirSync(path.join(failedSource, 'media'));
fs.writeFileSync(path.join(failedSource, 'project.json'), '{"name":"Interrupted"}');
fs.writeFileSync(path.join(failedSource, 'media', 'screen.mp4'), 'interrupted-source-video');
const originalCpSync = fs.cpSync;
try {
  fs.cpSync = (_source, temporary) => {
    fs.mkdirSync(temporary);
    fs.writeFileSync(path.join(temporary, 'partial-media.bin'), 'partial-copy');
    throw new Error('模拟复制中断');
  };
  assert.throws(() => copyProjectToFolder(failedSource, destination), /模拟复制中断/);
} finally {
  fs.cpSync = originalCpSync;
}

const partialTargets = fs.readdirSync(destination).filter((name) => name.startsWith('.recly-copy-') && name.endsWith('.partial'));
assert.equal(partialTargets.length, 1, '复制失败的诊断残留只应是一个 .partial 目录');
assert.match(partialTargets[0], /^\.recly-copy-[0-9a-f-]+\.partial$/i);
assert.equal(fs.existsSync(path.join(destination, 'Interrupted.dogscproject')), false, '失败复制不能留下可打开的项目包');
assert.equal(fs.existsSync(path.join(failedSource, 'project.json')), true, '复制失败也不能改动原项目');
console.log(`  ok  失败副本保留为不可打开的 .partial 诊断目录：${path.join(destination, partialTargets[0])}`);
console.log(`诊断目录保留：${root}`);

console.log('全部 1 项项目另存测试通过。');
