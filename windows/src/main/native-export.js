'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const WORKER_FLAG = '--recly-native-export-worker';
const WORKER_TIMEOUT = 30000;

async function supportsNativeExport() {
  if (process.platform !== 'win32') return false;
  try {
    require.resolve('node-av-lgpl/api');
    const gpu = await app.getGPUInfo('basic');
    return gpu.gpuDevice?.some((device) => device.vendorId === 0x10de) ?? false;
  } catch {
    return false;
  }
}

function runNativeExport(job, { onProgress, onSpawn }) {
  const args = ['--force-device-scale-factor=1'];
  if (!app.isPackaged) args.push(path.resolve(__dirname, '../..'));
  const profile = path.join(app.getPath('userData'), 'native-export-worker');
  const jobFile = path.join(app.getPath('temp'), `recly-export-${randomUUID()}.json`);
  const cancelFile = `${jobFile}.cancel`;
  fs.writeFileSync(jobFile, JSON.stringify(job), { flag: 'wx' });
  args.push('--', WORKER_FLAG, '--recly-export-profile=' + profile, '--recly-export-job=' + jobFile);

  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const messages = readline.createInterface({ input: worker.stdout });
    let result, detail, stderr = '', timer, forceExit, stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      try { fs.writeFileSync(cancelFile, ''); } catch { worker.kill(); }
      forceExit = setTimeout(() => worker.kill(), 2000);
    };
    const armWatchdog = () => {
      clearTimeout(timer);
      if (stopped) return;
      timer = setTimeout(() => {
        detail = '硬件导出进程超过 30 秒没有响应';
        stop();
      }, WORKER_TIMEOUT);
    };
    onSpawn({ kill: stop });
    worker.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    messages.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      armWatchdog();
      if (message.progress && !stopped) onProgress(message.progress);
      if (message.result) result = message.result;
      if (message.error) detail = message.error;
    });
    worker.once('error', (error) => { detail ||= error.message; });
    worker.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(forceExit);
      messages.close();
      try { fs.unlinkSync(jobFile); } catch { /* 文件已清理 */ }
      if (stopped) {
        try { fs.unlinkSync(cancelFile); } catch { /* 取消标记未写入 */ }
      }
      if (code === 0 && result && !stopped) resolve(result);
      else reject(new Error(detail || stderr.trim() || '硬件导出进程已退出'));
    });
    armWatchdog();
  });
}

module.exports = { WORKER_FLAG, supportsNativeExport, runNativeExport };
