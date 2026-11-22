'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');
const { app, BrowserWindow, screen } = require('electron');
const { AgentClient } = require('../agent/client');
const { getProjectsRoot, getExportRoot } = require('../src/main/config');
const media = require('../src/main/ffmpeg');
const { RecordingSession } = require('../src/main/recording');
const { windowRects } = require('../src/main/pointer-recorder');

const isLabel = (value) => typeof value === 'string' && Boolean(value.trim());

function readOptions() {
  const args = process.argv.slice(2);
  const [address, output, planFile] = args[0] === '--' ? args.slice(1) : args;
  if (!address) throw new Error('用法：npm run record:website -- <网址> [输出.mp4] [分镜.json]');
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入不带凭据的网页地址');
  const fileName = `${url.hostname.replace(/[^a-z0-9.-]/gi, '-')}-${Date.now()}.mp4`;
  const outputRoot = getExportRoot() || path.join(app.getPath('videos'), 'Recly 网站演示');
  const outputFile = output ? path.resolve(output) : path.join(outputRoot, fileName);
  if (path.extname(outputFile).toLowerCase() !== '.mp4' || fs.existsSync(outputFile)) throw new Error('输出必须是尚不存在的 MP4 文件');
  const plan = planFile ? JSON.parse(fs.readFileSync(planFile, 'utf8').replace(/^\uFEFF/, '')) : null;
  if (plan && (!Array.isArray(plan) || !plan.length || plan.length > 8 || plan.some((shot) => (
    !shot || !isLabel(shot.caption) || shot.caption.length > 100
    || (shot.heading !== undefined && !isLabel(shot.heading))
    || (shot.click !== undefined && (!shot.click || !isLabel(shot.click.target) || !isLabel(shot.click.expect)
      || (shot.click.follow !== undefined && !isLabel(shot.click.follow))))
  )))) throw new Error('分镜须包含 1–8 项。caption 为分镜说明，click 须提供 target 和 expect');
  return { url, outputFile, plan };
}

function readPage(browser, expression) {
  return browser.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: expression }]);
}

async function pagePoint(browser, selector, mustHit) {
  return readPage(browser, `(() => {
    const elements = document.querySelectorAll(${JSON.stringify(selector)});
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth || getComputedStyle(element).visibility !== 'visible') continue;
      const x = Math.round((Math.max(rect.left, 0) + Math.min(rect.right, innerWidth)) / 2);
      const y = Math.round((Math.max(rect.top, 0) + Math.min(rect.bottom, innerHeight)) / 2);
      if (${mustHit} && (element.matches(':disabled,[aria-disabled="true"]') || !element.contains(document.elementFromPoint(x, y)))) continue;
      return { x, y, width: innerWidth, height: innerHeight };
    }
    return null;
  })()`);
}

function createDemoPointer(browser, client, getSource) {
  const events = [];
  let position;
  const record = ({ x, y, width, height }, kind) => {
    const source = getSource();
    events.push({ time: Date.now() / 1000, kind, cursor: 'pointingHand',
      x: (client.x - source.x + x * client.width / width) / source.width,
      y: (client.y - source.y + y * client.height / height) / source.height });
  };
  const send = (type, { x, y }, extra = {}) => {
    browser.webContents.sendInputEvent({ type, x, y, ...extra });
  };
  return {
    hasClickSupport: true,
    start() {},
    stop() { return events; },
    async move(target) {
      const from = position || { x: Math.round(target.width * 0.5), y: Math.round(target.height * 0.5) };
      for (let step = 0; step <= 14; step += 1) {
        const t = step / 14;
        const progress = t * t * (3 - 2 * t);
        const point = { ...target, x: Math.round(from.x + (target.x - from.x) * progress),
          y: Math.round(from.y + (target.y - from.y) * progress) };
        send('mouseMove', point);
        record(point, 'move');
        await wait(22);
      }
      position = target;
    },
    async click(target) {
      const details = { button: 'left', clickCount: 1 };
      send('mouseDown', target, details);
      record(target, 'leftClick');
      await wait(55);
      send('mouseUp', target, details);
    },
  };
}

async function captureClick(browser, pointer, { target, expect, follow }) {
  const point = await pagePoint(browser, target, true);
  if (!point) throw new Error(`未找到可点击控件：${target}`);
  await pointer.move(point);
  await wait(180);
  const confirmed = await pagePoint(browser, target, true);
  if (!confirmed || confirmed.x !== point.x || confirmed.y !== point.y) throw new Error(`点击前控件位置发生变化：${target}`);
  await pointer.click(point);
  const deadline = Date.now() + 3000;
  while (!await pagePoint(browser, expect, false)) {
    if (Date.now() >= deadline) throw new Error(`点击后未看到预期结果：${expect}`);
    await wait(80);
  }
  if (follow) {
    await wait(620);
    const next = await pagePoint(browser, follow, true);
    if (!next) throw new Error(`未找到鼠标要跟随的控件：${follow}`);
    await pointer.move(next);
  }
}

async function captureWebsite(url, plan) {
  const { workArea, scaleFactor } = screen.getPrimaryDisplay();
  const width = Math.floor(Math.min(workArea.width, workArea.height * 16 / 9, 1920 / scaleFactor));
  const height = Math.floor(width * 9 / 16);
  const browser = new BrowserWindow({
    width, height, frame: false, show: false, resizable: false, movable: false, minimizable: false,
    alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#ffffff',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const contents = browser.webContents;
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.on('will-download', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());

  let capture;
  let captureClosed = false;
  try {
    const loadTimeout = new AbortController();
    try {
      await Promise.race([
        browser.loadURL(url.href),
        wait(30000, null, { signal: loadTimeout.signal }).then(() => { throw new Error('打开网页超时'); }),
      ]);
    } finally {
      loadTimeout.abort();
    }
    browser.show();
    const { headings, sections, pageTitle } = await readPage(browser, `(() => {
      const labels = selector => Array.from(document.querySelectorAll(selector), el => el.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean);
      const sections = Array.from(document.querySelectorAll('h2'), element => {
        const heading = element.innerText.trim();
        const id = element.closest('section[id]')?.id;
        const target = id && /^[\\w-]+$/.test(id) && 'header a[href="#' + id + '"]';
        const caption = heading.slice(0, 100);
        if (target && document.querySelector(target)) return { caption, click: { target, expect: '#' + CSS.escape(id) + ' h2' } };
        return { caption, heading };
      }).filter(shot => shot.caption);
      return { headings: labels('h1,h2,h3'), sections, pageTitle: labels('h1')[0] || document.title };
    })()`);
    const title = (pageTitle || url.hostname).slice(0, 85);
    const shots = plan || [{ caption: title }, ...sections.slice(0, 3)];
    for (const { heading } of shots) {
      if (heading && !headings.some((value) => value.replace(/\s/g, '') === heading.replace(/\s/g, ''))) throw new Error(`网页上未找到分镜标题：${heading}`);
    }
    const hwnd = Number(browser.getNativeWindowHandle().readBigUInt64LE());
    const { client } = windowRects(hwnd) || {};
    if (!client) throw new Error('无法读取网页录制区域');
    const pointer = createDemoPointer(browser, client, () => capture.source.getRect());
    capture = new RecordingSession({ projectsRoot: getProjectsRoot(), name: `网站演示 ${url.hostname} B-roll`,
      frameRate: 30, selection: { kind: 'window', hwnd, title }, pointerRecorder: pointer });
    await capture.start();
    capture.capture.closed.then(() => { captureClosed = true; });
    capture.commitStart();
    console.log(`正在采集 ${shots.length} 个网页段落`);
    const ranges = [];
    for (const { heading, caption, click } of shots) {
      await readPage(browser, `(async () => {
        const heading = ${JSON.stringify(heading || '')};
        const normalized = value => value.replace(/\\s/g, '');
        const target = heading && Array.from(document.querySelectorAll('h1,h2,h3')).find(el => normalized(el.innerText) === normalized(heading));
        if (heading && !target) throw new Error('分镜标题已离开页面');
        const top = target ? target.getBoundingClientRect().top + scrollY - 104 : 0;
        window.scrollTo({ top, behavior: 'instant' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const visible = Array.from(document.images).filter(img => {
          const rect = img.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < innerHeight;
        });
        const decoded = visible.map(img => { img.loading = 'eager'; return img.decode(); });
        await Promise.race([Promise.allSettled(decoded), new Promise(resolve => setTimeout(resolve, 1800))]);
      })()`);
      await wait(380);
      if (!browser.isVisible() || captureClosed) throw new Error('网页窗口或屏幕采集提前结束');
      const start = capture.addMarker().time;
      if (click) {
        browser.focus();
        await wait(220);
        await captureClick(browser, pointer, click);
      }
      await wait(click ? 3500 : Math.max(3200, Math.min(5500, caption.length * 140)));
      ranges.push({ start, end: capture.addMarker().time });
    }
    await wait(300);
    const result = await capture.finish([]);
    await result.mediaReady;
    const screenTrack = result.project.media.screen;
    return { directory: result.directory, screenTrack, ranges: ranges.map(({ start, end }) => (
      { start: Math.max(capture.officialStartOffset, start), end: Math.min(screenTrack.duration, end) }
    )) };
  } finally {
    try {
      if (capture?.capture && !captureClosed) {
        capture.pointer.stop();
        await capture.capture.stop();
      }
    } finally {
      if (!browser.isDestroyed()) browser.destroy();
    }
  }
}

async function editAndExport(agent, { directory, screenTrack, ranges }, outputFile) {
  const call = (method, params) => agent.call(method, { directory, ...params });
  await call('project.open');
  // Windows 窗口边框会让采集尺寸产生几个像素的误差。先裁到精确比例，
  // 让 Recly 的满幅运镜限制能识别该画面，靠边点击时也不露出背景。
  const sourceAspect = screenTrack.width / screenTrack.height;
  const width = Math.min(1, (16 / 9) / sourceAspect);
  const height = Math.min(1, sourceAspect / (16 / 9));
  const operations = [
    { type: 'keep_ranges', ranges: ranges.map(({ start, end }) => ({ sourceStart: start, sourceEnd: end })) },
    { type: 'canvas', patch: { aspectRatio: 'landscape', padding: 0, contentScale: 1, cornerRadius: 0, borderWidth: 0, shadowStrength: 0,
      crop: { x: (1 - width) / 2, y: (1 - height) / 2, width, height } } },
  ];
  const preview = await call('edit.preview', { operations });
  const { revision, duration } = await call('edit.apply', { expectedRevision: preview.revision, requestId: randomUUID(), planId: preview.planId });
  await call('project.save', { expectedRevision: revision, requestId: randomUUID() });
  const { jobId } = await call('export.start', { expectedRevision: revision, requestId: randomUUID(),
    outputFile, kind: 'video', resolution: 'fullHD', frameRate: 30 });
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    const job = await call('jobs.get', { jobId });
    if (job.status === 'completed') {
      if ((await media.probe(outputFile)).hasAudio) {
        const videoOnly = path.join(path.dirname(outputFile), `.recly-video-${randomUUID()}.mp4`);
        await media.ffmpeg(['-i', outputFile, '-map', '0:v:0', '-c:v', 'copy', '-movflags', '+faststart', videoOnly]);
        fs.renameSync(videoOnly, outputFile);
      }
      return { directory, outputFile, duration };
    }
    if (['failed', 'cancelled'].includes(job.status)) throw new Error(job.error?.message || `Recly 导出结束：${job.status}`);
    await wait(1000);
  }
  throw new Error(`等待 Recly 导出超时，工程已保存，导出任务编号：${jobId}`);
}

async function main() {
  const { url, outputFile, plan } = readOptions();
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'recly-website-')));
  app.on('window-all-closed', () => {});
  await app.whenReady();
  media.resolveBinaries(null);
  const agent = new AgentClient();
  try {
    await agent.connect();
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    const recording = await captureWebsite(url, plan);
    console.log(`原始工程：${recording.directory}`);
    console.log(JSON.stringify(await editAndExport(agent, recording, outputFile), null, 2));
  } finally {
    agent.close();
  }
}

main().then(() => app.exit(0)).catch((error) => { console.error(error.message); app.exit(1); });
