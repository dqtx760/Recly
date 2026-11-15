'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { importAsset } = require('./asset-import');

const PAGE_SIZE = 20;
const REQUEST_TIMEOUT_MS = 20_000;
const API_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
const SETTINGS_FILE = 'materials-settings.json';
const MANIFEST_FILE = 'materials.json';

function providerName(provider) {
  if (provider === 'unsplash' || provider === 'pixabay') return provider;
  throw new Error('不支持的素材来源');
}

function readSettings(settingsPath) {
  try {
    const value = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return {
      ...(typeof value.unsplash === 'string' ? { unsplash: value.unsplash } : {}),
      ...(typeof value.pixabay === 'string' ? { pixabay: value.pixabay } : {}),
    };
  } catch {
    return {};
  }
}

function writeJsonAtomically(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

function readManifest(directory) {
  const file = path.join(directory, 'media', MANIFEST_FILE);
  try {
    const items = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(items)) return [];
    return items.filter((item) => {
      if (!item || typeof item !== 'object' || !/^[0-9a-f-]{36}$/i.test(item.id || '')) return false;
      if (typeof item.file !== 'string' || path.isAbsolute(item.file)) return false;
      const parts = item.file.replace(/\\/g, '/').split('/');
      const safeFile = parts[0] === 'media' && parts.length === 2 && !parts.some((part) => part === '.' || part === '..');
      if (!safeFile) return false;
      if (item.index != null) {
        if (typeof item.index !== 'string' || path.isAbsolute(item.index)) return false;
        const indexParts = item.index.replace(/\\/g, '/').split('/');
        if (indexParts[0] !== 'media' || indexParts.length !== 2 || indexParts.some((part) => part === '.' || part === '..')) return false;
      }
      if (item.provider != null && item.provider !== 'unsplash' && item.provider !== 'pixabay') return false;
      if (item.pageUrl != null) {
        try { validateHttpsUrl(item.pageUrl, ['unsplash.com', 'www.unsplash.com', 'pixabay.com']); } catch { return false; }
      }
      return true;
    }).map((item) => ({
      id: item.id,
      file: item.file.replace(/\\/g, '/'),
      index: typeof item.index === 'string' ? item.index : null,
      width: Number.isFinite(item.width) ? item.width : null,
      height: Number.isFinite(item.height) ? item.height : null,
      duration: Number.isFinite(item.duration) ? item.duration : null,
      kind: item.kind === 'video' ? 'video' : 'image',
      name: typeof item.name === 'string' ? item.name : '',
      ...(item.provider === 'unsplash' || item.provider === 'pixabay' ? { provider: item.provider } : {}),
      ...(typeof item.author === 'string' ? { author: item.author } : {}),
      ...(typeof item.pageUrl === 'string' ? { pageUrl: item.pageUrl } : {}),
    }));
  } catch {
    return [];
  }
}

function saveManifest(directory, items) {
  writeJsonAtomically(path.join(directory, 'media', MANIFEST_FILE), items);
}

function validateHttpsUrl(value, hosts, pathPattern) {
  let url;
  try { url = new URL(value); } catch { throw new Error('素材来源返回了无效地址'); }
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) {
    throw new Error('素材来源返回了不受支持的地址');
  }
  if (pathPattern && !pathPattern.test(url.pathname)) throw new Error('素材来源返回了不受支持的地址');
  return url.toString();
}

async function requestJson(fetchImpl, url, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'error' });
    if (!response?.ok) throw new Error('request failed');
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > API_RESPONSE_MAX_BYTES) throw new Error('response too large');
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > API_RESPONSE_MAX_BYTES) throw new Error('response too large');
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadToFile(fetchImpl, url, file, maxBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
    if (!response?.ok || !response.body) throw new Error('download failed');
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('asset too large');
    let size = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        callback(size > maxBytes ? new Error('asset too large') : null, size > maxBytes ? undefined : chunk);
      },
    });
    await pipeline(response.body, limit, fs.createWriteStream(file, { flags: 'wx' }), { signal: controller.signal });
    if (size === 0) throw new Error('empty asset');
  } finally {
    clearTimeout(timeout);
  }
}

function registerMaterialsIpc({ ipcMain, app, safeStorage, dialog, BrowserWindow, nativeImage, media, editorDirectoryForSender, fetchImpl = globalThis.fetch }) {
  const resultsBySender = new WeakMap();
  const settingsPath = path.join(app.getPath('userData'), SETTINGS_FILE);

  function ownerDirectory(sender) {
    const directory = editorDirectoryForSender(sender);
    if (!directory || !fs.existsSync(path.join(directory, 'project.json'))) throw new Error('请求必须来自已打开的工程编辑器');
    return path.resolve(directory);
  }

  function configuredKey(provider) {
    const encrypted = readSettings(settingsPath)[provider];
    if (typeof encrypted !== 'string' || !encrypted) return '';
    try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); } catch { return ''; }
  }

  function remember(sender, results) {
    let items = resultsBySender.get(sender);
    if (!items) {
      items = new Map();
      resultsBySender.set(sender, items);
    }
    for (const result of results) items.set(result.id, result);
    while (items.size > 500) items.delete(items.keys().next().value);
  }

  async function addImported(directory, kind, file, name, source = {}) {
    const imported = await importAsset({ directory, kind, file }, media, nativeImage);
    const item = {
      id: randomUUID(),
      file: imported.file,
      index: imported.index || null,
      width: imported.width,
      height: imported.height,
      duration: imported.duration ?? null,
      kind,
      name,
      ...(source.provider === 'unsplash' || source.provider === 'pixabay' ? { provider: source.provider } : {}),
      ...(typeof source.author === 'string' ? { author: source.author } : {}),
      ...(typeof source.pageUrl === 'string' ? { pageUrl: source.pageUrl } : {}),
    };
    const items = readManifest(directory);
    items.push(item);
    saveManifest(directory, items);
    return item;
  }

  ipcMain.handle('materials:list', (event) => readManifest(ownerDirectory(event.sender)));

  ipcMain.handle('materials:import-local', async (event, payload = {}) => {
    const directory = ownerDirectory(event.sender);
    const kind = payload?.kind;
    if (kind !== 'image' && kind !== 'video') throw new Error('只支持导入图片或视频');
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: kind === 'video' ? '选择视频素材' : '选择图片素材',
      properties: ['openFile'],
      filters: [{ name: kind === 'video' ? '视频' : '图片', extensions: kind === 'video' ? ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'] : ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
    };
    const selection = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (selection.canceled || !selection.filePaths?.[0]) return null;
    const file = selection.filePaths[0];
    return addImported(directory, kind, file, path.basename(file));
  });

  ipcMain.handle('materials:settings-get', (event) => {
    ownerDirectory(event.sender);
    return {
      unsplashConfigured: Boolean(readSettings(settingsPath).unsplash),
      pixabayConfigured: Boolean(readSettings(settingsPath).pixabay),
    };
  });

  ipcMain.handle('materials:settings-save', (event, payload = {}) => {
    ownerDirectory(event.sender);
    const provider = providerName(payload?.provider);
    if (typeof payload?.key !== 'string' || payload.key.length > 4096) throw new Error('API Key 无效');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密服务暂不可用');
    const settings = readSettings(settingsPath);
    const key = payload.key.trim();
    if (key) {
      try { settings[provider] = safeStorage.encryptString(key).toString('base64'); } catch { throw new Error('API Key 加密失败'); }
    }
    else delete settings[provider];
    writeJsonAtomically(settingsPath, settings);
    return {
      unsplashConfigured: Boolean(settings.unsplash),
      pixabayConfigured: Boolean(settings.pixabay),
    };
  });

  ipcMain.handle('materials:search', async (event, payload = {}) => {
    ownerDirectory(event.sender);
    const provider = providerName(payload?.provider);
    const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
    const page = payload?.page === undefined ? 1 : payload.page;
    if (!query || query.length > 200 || !Number.isInteger(page) || page < 1 || page > 500) throw new Error('搜索词或页码无效');
    const key = configuredKey(provider);
    if (!key) throw new Error('请先配置此素材来源的 API Key');

    try {
      let json;
      let entries;
      let hasMore;
      if (provider === 'unsplash') {
        const url = new URL('https://api.unsplash.com/search/photos');
        url.search = new URLSearchParams({ query, page: String(page), per_page: String(PAGE_SIZE) }).toString();
        json = await requestJson(fetchImpl, url.toString(), { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' });
        entries = (json.results || []).flatMap((photo) => {
          try {
            const previewUrl = validateHttpsUrl(photo.urls?.small, ['images.unsplash.com']);
            const assetUrl = validateHttpsUrl(photo.urls?.regular, ['images.unsplash.com']);
            const downloadLocation = validateHttpsUrl(photo.links?.download_location, ['api.unsplash.com'], /^\/photos\/[^/]+\/download$/);
            const pageUrl = validateHttpsUrl(photo.links?.html, ['unsplash.com', 'www.unsplash.com']);
            const item = { id: randomUUID(), previewUrl, author: String(photo.user?.name || 'Unsplash 作者'), pageUrl, duration: null, provider, kind: 'image' };
            return [{ ...item, assetUrl, downloadLocation, sourceName: String(photo.alt_description || photo.description || 'Unsplash 图片') }];
          } catch { return []; }
        });
        hasMore = Number(json.total_pages) > page;
      } else {
        const url = new URL('https://pixabay.com/api/videos/');
        url.search = new URLSearchParams({ key, q: query, page: String(page), per_page: String(PAGE_SIZE) }).toString();
        json = await requestJson(fetchImpl, url.toString());
        entries = (json.hits || []).flatMap((hit) => {
          try {
            const medium = hit.videos?.medium;
            const assetUrl = validateHttpsUrl(medium?.url, ['cdn.pixabay.com'], /^\/video\/.+\.mp4$/);
            const previewUrl = validateHttpsUrl(medium?.thumbnail, ['cdn.pixabay.com'], /^\/video\/.+\.(jpg|jpeg|png|webp)$/i);
            const pageUrl = validateHttpsUrl(hit.pageURL, ['pixabay.com'], /^\/videos\//);
            const item = { id: randomUUID(), previewUrl, author: String(hit.user || 'Pixabay 作者'), pageUrl, duration: Number.isFinite(hit.duration) ? hit.duration : null, provider, kind: 'video' };
            return [{ ...item, assetUrl, sourceName: String(hit.tags || `Pixabay 视频 ${hit.id || ''}`) }];
          } catch { return []; }
        });
        hasMore = Number(json.totalHits) > page * PAGE_SIZE;
      }
      remember(event.sender, entries);
      return { items: entries.map(({ id, previewUrl, author, pageUrl, duration, provider: source, kind }) => ({ id, previewUrl, author, pageUrl, duration, provider: source, kind })), hasMore };
    } catch {
      throw new Error('素材搜索失败，请检查网络和 API Key');
    }
  });

  ipcMain.handle('materials:download', async (event, payload = {}) => {
    const directory = ownerDirectory(event.sender);
    const result = resultsBySender.get(event.sender)?.get(payload?.id);
    if (!result) throw new Error('素材已失效，请重新搜索后下载');
    let url = result.assetUrl;
    let kind = result.kind;
    const maxBytes = kind === 'video' ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
    if (result.provider === 'unsplash') {
      try {
        const trackingUrl = validateHttpsUrl(result.downloadLocation, ['api.unsplash.com'], /^\/photos\/[^/]+\/download$/);
        const key = configuredKey('unsplash');
        if (!key) throw new Error('missing key');
        await requestJson(fetchImpl, trackingUrl, { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' });
      } catch {
        throw new Error('素材下载失败，请稍后重试');
      }
    }
    const allowedHosts = result.provider === 'unsplash' ? ['images.unsplash.com'] : ['cdn.pixabay.com'];
    const pathPattern = result.provider === 'pixabay' ? /^\/video\/.+\.mp4$/ : undefined;
    url = validateHttpsUrl(url, allowedHosts, pathPattern);
    const temporary = path.join(os.tmpdir(), `recly-material-${randomUUID()}${kind === 'video' ? '.mp4' : '.image'}`);
    try {
      await downloadToFile(fetchImpl, url, temporary, maxBytes);
      return await addImported(directory, kind, temporary, result.sourceName, result);
    } catch {
      throw new Error('素材下载或导入失败，请稍后重试');
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  });
}

module.exports = { registerMaterialsIpc };
