'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const configured = require('../package.json').scripts.test.split(' && ').map(command => command.replace(/^node /, ''));
const extra = ['test/camera-frame-routing.test.js', 'test/camera-recording-handoff.test.js', 'test/inline-camera-preview.test.js', 'test/capture-protection.test.js', 'test/recorder-compact.test.js', 'test/editor-window-show.test.js', 'test/window-close-tracker.test.js', 'test/memo-mouse-through.test.js', 'test/preview-fullscreen.test.js', 'test/timeline-multi-select.test.js', 'test/preview-preparation.test.js'];
const report = [];
for (const file of [...new Set([...configured, ...extra])].filter(file => fs.existsSync(path.join(root, file)))) {
  const result = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  report.push({ file, passed: result.status === 0, status: result.status, output: `${result.stdout || ''}${result.stderr || ''}`, error: result.error?.message });
  console.log(`${result.status === 0 ? '通过' : '失败'} ${file}`);
}
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'regressions.json'), JSON.stringify(report, null, 2));
const failures = report.filter(result => !result.passed);
console.log(JSON.stringify({ total: report.length, passed: report.length - failures.length, failures: failures.map(result => ({file: result.file, error: result.output.slice(-2000)})) }, null, 2));
process.exitCode = failures.length ? 1 : 0;
