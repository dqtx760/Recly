'use strict';
// DogSC Windows 版自动更新模块：查询 GitHub Releases、语义化版本比对、优雅离线降级与安全外链。

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const DEFAULT_REPOSITORY = 'laogou717/dogsc';
const USER_AGENT = 'DogSC-Windows';

/**
 * 获取当前应用版本。
 * 优先读取 Electron app.getVersion()，未在 Electron 运行时回退至 package.json。
 */
function getCurrentVersion() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getVersion === 'function') {
      return app.getVersion();
    }
  } catch (_) {
    // 非 Electron 环境
  }
  try {
    const pkg = require('../../package.json');
    if (pkg && pkg.version) return pkg.version;
  } catch (_) {
    // 读取 package.json 失败
  }
  return '0.0.0';
}

/**
 * 解析 SemVer 语义化版本号。
 * 支持标准 3 段式 (x.y.z) 及缺省写法 (x 或 x.y)，支持前导 'v'/'V'，支持 prerelease 与 build 元数据。
 */
function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().replace(/^v/i, '');
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: match[2] !== undefined ? parseInt(match[2], 10) : 0,
    patch: match[3] !== undefined ? parseInt(match[3], 10) : 0,
    prerelease: match[4] ? match[4].split('.') : null,
    build: match[5] || null,
    raw: trimmed,
  };
}

/**
 * 比对两个语义化版本号。
 * 符合 SemVer 2.0.0 规范：
 * - 依次比对 major, minor, patch 数值。
 * - 当三者相等时，带 prerelease 的版本优先级低于正式版本（如 0.1.2-win.1 < 0.1.2）。
 * - 两个 prerelease 比对各标识符（数字按数值，文本按字典序）。
 * 返回值：a > b 返回 1，a < b 返回 -1，a === b 返回 0。
 */
function compareSemver(a, b) {
  const pA = parseSemver(a);
  const pB = parseSemver(b);
  if (!pA || !pB) {
    const sA = String(a || '').replace(/^v/i, '');
    const sB = String(b || '').replace(/^v/i, '');
    return sA.localeCompare(sB, undefined, { numeric: true });
  }

  if (pA.major !== pB.major) return pA.major > pB.major ? 1 : -1;
  if (pA.minor !== pB.minor) return pA.minor > pB.minor ? 1 : -1;
  if (pA.patch !== pB.patch) return pA.patch > pB.patch ? 1 : -1;

  // 正式版本优先级高于预发布版本
  if (!pA.prerelease && pB.prerelease) return 1;
  if (pA.prerelease && !pB.prerelease) return -1;
  if (!pA.prerelease && !pB.prerelease) return 0;

  const len = Math.max(pA.prerelease.length, pB.prerelease.length);
  for (let i = 0; i < len; i++) {
    const idA = pA.prerelease[i];
    const idB = pB.prerelease[i];
    if (idA === undefined) return -1; // 较短的标识符集优先级更低
    if (idB === undefined) return 1;
    if (idA === idB) continue;

    const numA = /^\d+$/.test(idA) ? parseInt(idA, 10) : null;
    const numB = /^\d+$/.test(idB) ? parseInt(idB, 10) : null;

    if (numA !== null && numB !== null) {
      return numA > numB ? 1 : -1;
    }
    if (numA !== null && numB === null) {
      return -1; // 数字标识符优先级低于非数字
    }
    if (numA === null && numB !== null) {
      return 1;
    }
    return idA > idB ? 1 : -1;
  }

  return 0;
}

/**
 * 支持重定向与超时的 HTTP/HTTPS GET 请求。
 */
function requestWithRedirects(targetUrl, options, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error('重定向次数过多（超过 5 次）'));
    }
    const urlObj = new URL(targetUrl);
    const client = urlObj.protocol === 'http:' ? http : https;
    const reqOptions = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 10000,
    };

    const requestFn = options.requestFn || client.request;
    const req = requestFn(reqOptions, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const nextUrl = new URL(res.headers.location, targetUrl).href;
        res.resume();
        return resolve(requestWithRedirects(nextUrl, options, redirectCount + 1));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy(new Error(`网络请求超时（超过 ${options.timeout || 10000}ms）`));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 检查应用更新。
 * 查询 GitHub 最新 Release，若离线或请求失败则优雅降级返回错误对象，不抛出异常。
 *
 * @param {object} [options]
 * @param {string} [options.repository] GitHub 仓库名称，例如 'laogou717/dogsc'
 * @param {string} [options.currentVersion] 当前版本号
 * @param {number} [options.timeout] 超时时间（毫秒），默认 10000
 * @param {function} [options.requestFn] 自定义请求函数（供单测使用）
 * @returns {Promise<{
 *   updateAvailable: boolean,
 *   currentVersion: string,
 *   latestVersion: string | null,
 *   tagName: string | null,
 *   releaseUrl: string,
 *   releaseNotes: string,
 *   publishedAt: string | null,
 *   name: string,
 *   error: string | null,
 * }>}
 */
async function checkUpdate(options = {}) {
  const repository = options.repository || process.env.DOGSC_UPDATE_REPO || DEFAULT_REPOSITORY;
  const currentVersion = options.currentVersion || getCurrentVersion();
  const timeout = typeof options.timeout === 'number' ? options.timeout : 10000;
  const fallbackUrl = `https://github.com/${repository}/releases`;
  const targetUrl = options.url || `https://api.github.com/repos/${repository}/releases/latest`;

  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/vnd.github.v3+json',
    ...(options.headers || {}),
  };

  try {
    const res = await requestWithRedirects(targetUrl, {
      method: 'GET',
      headers,
      timeout,
      requestFn: options.requestFn,
    });

    if (res.statusCode === 404) {
      return {
        updateAvailable: false,
        currentVersion,
        latestVersion: null,
        tagName: null,
        releaseUrl: fallbackUrl,
        releaseNotes: '',
        publishedAt: null,
        name: '',
        error: `未找到发布版本（404 Not Found：${repository} 暂无 Release）`,
      };
    }

    if (res.statusCode === 403) {
      return {
        updateAvailable: false,
        currentVersion,
        latestVersion: null,
        tagName: null,
        releaseUrl: fallbackUrl,
        releaseNotes: '',
        publishedAt: null,
        name: '',
        error: 'GitHub API 请求频次受限（403 Forbidden），请稍后再试',
      };
    }

    if (res.statusCode !== 200) {
      return {
        updateAvailable: false,
        currentVersion,
        latestVersion: null,
        tagName: null,
        releaseUrl: fallbackUrl,
        releaseNotes: '',
        publishedAt: null,
        name: '',
        error: `GitHub API 返回异常状态码 ${res.statusCode}`,
      };
    }

    let release;
    try {
      release = JSON.parse(res.body);
    } catch (parseError) {
      return {
        updateAvailable: false,
        currentVersion,
        latestVersion: null,
        tagName: null,
        releaseUrl: fallbackUrl,
        releaseNotes: '',
        publishedAt: null,
        name: '',
        error: `解析发布信息失败：${parseError.message}`,
      };
    }

    const tagName = release.tag_name || '';
    const latestVersion = tagName.replace(/^v/i, '') || release.name || '';
    const releaseUrl = release.html_url || fallbackUrl;
    const releaseNotes = release.body || '';
    const publishedAt = release.published_at || release.created_at || null;
    const name = release.name || tagName;

    const updateAvailable = Boolean(latestVersion && compareSemver(latestVersion, currentVersion) > 0);

    return {
      updateAvailable,
      currentVersion,
      latestVersion,
      tagName,
      releaseUrl,
      releaseNotes,
      publishedAt,
      name,
      error: null,
    };
  } catch (err) {
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: null,
      tagName: null,
      releaseUrl: fallbackUrl,
      releaseNotes: '',
      publishedAt: null,
      name: '',
      error: err.message || String(err),
    };
  }
}

/**
 * 注册自动更新与安全外链相关的 IPC 处理程序。
 *
 * @param {object} [ipc] Electron ipcMain 实例，默认为 require('electron').ipcMain
 * @param {object} [shellModule] Electron shell 实例，默认为 require('electron').shell
 */
function registerUpdaterIpc(ipc, shellModule) {
  let targetIpc = ipc;
  let targetShell = shellModule;

  if (!targetIpc || !targetShell) {
    try {
      const electron = require('electron');
      targetIpc = targetIpc || electron.ipcMain;
      targetShell = targetShell || electron.shell;
    } catch (_) {
      // 非 Electron 环境测试跳过
    }
  }

  if (!targetIpc) return;

  targetIpc.handle('app:check-update', async (_event, options) => {
    return checkUpdate(options);
  });

  const handleOpenUrl = async (_event, targetUrl) => {
    if (typeof targetUrl !== 'string') {
      throw new Error('无效的 URL 参数');
    }
    const trimmed = targetUrl.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new Error('仅允许打开 HTTP 或 HTTPS 链接');
    }
    if (targetShell && typeof targetShell.openExternal === 'function') {
      await targetShell.openExternal(trimmed);
      return { ok: true };
    }
    return { ok: false, error: '当前环境无可用 shell 模块' };
  };

  targetIpc.handle('app:open-url', handleOpenUrl);
  if (typeof targetIpc.on === 'function') {
    targetIpc.on('app:open-url', handleOpenUrl);
  }
}

module.exports = {
  DEFAULT_REPOSITORY,
  USER_AGENT,
  getCurrentVersion,
  parseSemver,
  compareSemver,
  checkUpdate,
  registerUpdaterIpc,
};
