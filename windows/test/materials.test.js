'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const { registerMaterialsIpc } = require('../src/main/materials');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recly-materials-test-'));
  const userData = path.join(root, 'user-data');
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const localImage = path.join(root, 'local.png');
  for (const directory of [projectA, projectB]) {
    fs.mkdirSync(path.join(directory, 'media'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'project.json'), '{}');
  }
  fs.writeFileSync(localImage, Buffer.from('local image fixture'));

  const senderA = {};
  const senderB = {};
  const directories = new Map([[senderA, projectA], [senderB, projectB]]);
  const handlers = new Map();
  const fetchCalls = [];
  let selectedLocalFile = localImage;
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`cipher:${value}`, 'utf8'),
    decryptString: (bytes) => bytes.toString('utf8').replace(/^cipher:/, ''),
  };
  const nativeImage = {
    createFromPath(file) {
      const bytes = fs.readFileSync(file);
      return { isEmpty: () => bytes.length === 0, getSize: () => ({ width: 640, height: 360 }), toPNG: () => Buffer.from(`png:${bytes.toString('utf8')}`) };
    },
  };
  const media = {
    async finalizeCamera(source, target) {
      fs.copyFileSync(source, target);
      return { video: { width: 1280, height: 720 }, duration: 4.5 };
    },
    async buildVideoIndex() { return { frames: [] }; },
  };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    fetchCalls.push({ url, options });
    assert.equal(options.redirect, 'error', '网络请求禁止跟随重定向');
    if (url.hostname === 'api.unsplash.com' && url.pathname === '/search/photos') {
      assert.equal(options.headers.Authorization, 'Client-ID test-unsplash-secret');
      assert.equal(url.searchParams.get('per_page'), '20');
      if (url.searchParams.get('query') === 'large-response') {
        return { ok: true, headers: { get: (name) => name === 'content-length' ? String(2 * 1024 * 1024 + 1) : null }, body: Readable.from([Buffer.from('{}')]) };
      }
      return jsonResponse({
        total_pages: 2,
        results: [{
          id: 'photo-1',
          urls: { small: 'https://images.unsplash.com/photo-small.jpg', regular: 'https://images.unsplash.com/photo-regular.jpg' },
          links: { download_location: 'https://api.unsplash.com/photos/photo-1/download', html: 'https://unsplash.com/photos/photo-1' },
          user: { name: '摄影师 A' },
          alt_description: '海边日落',
        }],
      });
    }
    if (url.hostname === 'api.unsplash.com' && url.pathname === '/photos/photo-1/download') {
      assert.equal(options.headers.Authorization, 'Client-ID test-unsplash-secret');
      return jsonResponse({ url: 'https://images.unsplash.com/photo-tracked.jpg' });
    }
    if (url.hostname === 'images.unsplash.com') {
      return streamResponse(Buffer.from('remote image fixture'));
    }
    if (url.hostname === 'pixabay.com' && url.pathname === '/api/videos/') {
      assert.equal(url.searchParams.get('key'), 'test-pixabay-secret');
      assert.equal(url.searchParams.get('per_page'), '20');
      return jsonResponse({ totalHits: 41, hits: [{
        id: 45,
        pageURL: 'https://pixabay.com/videos/id-45/',
        duration: 4.5,
        user: 'video author',
        tags: 'forest, river',
        videos: { medium: {
          url: 'https://cdn.pixabay.com/video/forest-medium.mp4',
          thumbnail: 'https://cdn.pixabay.com/video/forest-medium.jpg',
          size: 1234,
        } },
      }, {
        id: 46,
        pageURL: 'https://pixabay.com/videos/id-46/',
        duration: 8,
        user: 'large author',
        tags: 'too large',
        videos: { medium: {
          url: 'https://cdn.pixabay.com/video/too-large.mp4',
          thumbnail: 'https://cdn.pixabay.com/video/too-large.jpg',
        } },
      }, {
        id: 47,
        pageURL: 'https://pixabay.com/videos/id-47/',
        duration: 2,
        user: 'untrusted CDN',
        tags: 'should be ignored',
        videos: { medium: {
          url: 'https://attacker.invalid/video.mp4',
          thumbnail: 'https://cdn.pixabay.com/video/unsafe.jpg',
        } },
      }] });
    }
    if (url.hostname === 'cdn.pixabay.com') {
      if (url.pathname.includes('too-large')) return streamResponse(Buffer.from('x'), VIDEO_MAX_BYTES + 1);
      return streamResponse(Buffer.from('remote video fixture'));
    }
    throw new Error(`Unexpected outbound URL: ${url.origin}${url.pathname}`);
  };

  registerMaterialsIpc({
    ipcMain,
    app: { getPath: (name) => { assert.equal(name, 'userData'); return userData; } },
    safeStorage,
    dialog: { showOpenDialog: async (...args) => {
      const options = args.at(-1);
      assert.deepEqual(options.properties, ['openFile']);
      return { canceled: false, filePaths: [selectedLocalFile] };
    } },
    BrowserWindow: { fromWebContents: () => null },
    nativeImage,
    media,
    editorDirectoryForSender: (sender) => directories.get(sender),
    fetchImpl,
  });

  const invoke = (channel, sender, payload) => handlers.get(channel)({ sender }, payload);
  assert.deepEqual(await invoke('materials:list', senderA), [], '无素材清单时返回空数组');
  const local = await invoke('materials:import-local', senderA, { kind: 'image', directory: projectB, file: 'attacker-path.png' });
  assert.equal(local.name, 'local.png', '本地导入仅使用主进程对话框选择的文件');
  assert.equal(fs.readFileSync(path.join(projectA, local.file), 'utf8'), 'png:local image fixture');
  assert.equal(fs.existsSync(path.join(projectB, local.file)), false, 'renderer 不能指定写入的工程目录');
  assert.equal(JSON.parse(fs.readFileSync(path.join(projectA, 'project.json'), 'utf8')).media, undefined, '素材清单不写入 project.json');
  assert.equal((await invoke('materials:list', senderA)).length, 1);
  assert.deepEqual(await invoke('materials:list', senderB), [], '清单按 renderer 所属工程隔离');

  assert.deepEqual(await invoke('materials:settings-save', senderA, { provider: 'unsplash', key: 'test-unsplash-secret' }), { unsplashConfigured: true, pixabayConfigured: false });
  assert.deepEqual(await invoke('materials:settings-save', senderA, { provider: 'pixabay', key: 'test-pixabay-secret' }), { unsplashConfigured: true, pixabayConfigured: true });
  const settingsFile = path.join(userData, 'materials-settings.json');
  const persistedSettings = fs.readFileSync(settingsFile, 'utf8');
  assert.equal(persistedSettings.includes('test-unsplash-secret'), false, 'API Key 不以明文保存');
  assert.equal(persistedSettings.includes('test-pixabay-secret'), false, 'API Key 不以明文保存');
  assert.deepEqual(await invoke('materials:settings-get', senderA), { unsplashConfigured: true, pixabayConfigured: true });

  const unsplash = await invoke('materials:search', senderA, { provider: 'unsplash', query: 'sunset', page: 1 });
  assert.equal(unsplash.items.length, 1);
  assert.deepEqual({ provider: unsplash.items[0].provider, kind: unsplash.items[0].kind, duration: unsplash.items[0].duration }, { provider: 'unsplash', kind: 'image', duration: null });
  assert.equal(unsplash.hasMore, true);
  await assert.rejects(invoke('materials:search', senderA, { provider: 'unsplash', query: 'large-response', page: 1 }), /素材搜索失败/);
  await assert.rejects(invoke('materials:download', senderB, { id: unsplash.items[0].id }), /素材已失效/, '搜索结果不能跨 renderer 下载');
  const imageAsset = await invoke('materials:download', senderA, { id: unsplash.items[0].id });
  assert.equal(imageAsset.kind, 'image');
  assert.equal(fs.readFileSync(path.join(projectA, imageAsset.file), 'utf8'), 'png:remote image fixture');
  assert.ok(fetchCalls.some(({ url }) => url.pathname === '/photos/photo-1/download'), 'Unsplash 下载前发送官方 tracking 请求');
  assert.ok(fetchCalls.some(({ url }) => url.hostname === 'images.unsplash.com' && url.pathname === '/photo-regular.jpg'), 'Unsplash 下载使用官方 regular URL');
  assert.equal(imageAsset.provider, 'unsplash');
  assert.equal(imageAsset.author, '摄影师 A');
  assert.equal(imageAsset.pageUrl, 'https://unsplash.com/photos/photo-1');

  const pixabay = await invoke('materials:search', senderA, { provider: 'pixabay', query: 'forest', page: 1 });
  assert.equal(pixabay.hasMore, true);
  assert.equal(pixabay.items.length, 2, '不可信 Pixabay CDN 地址不会进入 renderer 结果');
  assert.equal(pixabay.items[0].previewUrl, 'https://cdn.pixabay.com/video/forest-medium.jpg');
  assert.equal(pixabay.items[0].kind, 'video');
  const videoAsset = await invoke('materials:download', senderA, { id: pixabay.items[0].id });
  assert.equal(videoAsset.kind, 'video');
  assert.equal(videoAsset.duration, 4.5);
  assert.equal(videoAsset.provider, 'pixabay');
  assert.equal(videoAsset.author, 'video author');
  assert.equal(videoAsset.pageUrl, 'https://pixabay.com/videos/id-45/');
  assert.equal(fs.readFileSync(path.join(projectA, videoAsset.file), 'utf8'), 'remote video fixture');
  await assert.rejects(invoke('materials:download', senderA, { id: pixabay.items[1].id }), /素材下载或导入失败/);
  const manifest = await invoke('materials:list', senderA);
  assert.equal(manifest.length, 3, '导入和远程下载都追加到独立素材清单');
  assert.deepEqual(
    manifest.find((item) => item.id === imageAsset.id),
    imageAsset,
    '素材清单读回时保留 provider、author、pageUrl 来源信息',
  );
  assert.equal(fetchCalls.some(({ url }) => url.hostname === 'attacker.invalid'), false, '不可信 CDN 不会产生出站请求');

  assert.equal(fetchCalls.every(({ options }) => options.redirect === 'error'), true);
  assert.equal(fetchCalls.some(({ url }) => url.protocol !== 'https:'), false, '所有出站请求都使用 HTTPS');
  assert.equal(fetchCalls.some(({ url }) => url.hostname === 'api.unsplash.com' && url.searchParams.has('key')), false, 'Unsplash Key 不拼入 URL');
  await assert.rejects(invoke('materials:download', senderA, { id: 'https://attacker.invalid/asset.mp4' }), /素材已失效/, '下载只接受本 renderer 搜索记录中的 id');
  console.log('素材库后端通过：工程隔离、加密配置、官方 API 搜索与跟踪、受限下载及 manifest。');
}

function jsonResponse(value) {
  const body = Buffer.from(JSON.stringify(value));
  return { ok: true, headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(body.length) : null }, body: Readable.from([body]) };
}

function streamResponse(bytes, contentLength = bytes.length) {
  return {
    ok: true,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(contentLength) : null },
    body: Readable.from([bytes]),
  };
}

const VIDEO_MAX_BYTES = 100 * 1024 * 1024;

main().catch((error) => { console.error(error); process.exitCode = 1; });
