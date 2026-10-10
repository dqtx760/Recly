'use strict';
// 自动更新模块测试：语义化版本比对、Release 获取与优雅离线/异常处理。运行：node test/updater.test.js

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const {
  parseSemver,
  compareSemver,
  checkUpdate,
  registerUpdaterIpc,
  getCurrentVersion,
  DEFAULT_REPOSITORY,
} = require('../src/main/updater');

let passed = 0;
const test = (name, body) => {
  return Promise.resolve(body()).then(() => {
    passed += 1;
    console.log(`  ok  ${name}`);
  });
};

// 模拟网络请求辅助类
function createMockRequest(responder) {
  return function mockRequest(options, callback) {
    const req = new EventEmitter();
    req.destroy = (err) => {
      setImmediate(() => req.emit('error', err || new Error('Destroyed')));
    };
    req.end = () => {
      setImmediate(() => {
        try {
          responder(options, callback, req);
        } catch (err) {
          req.emit('error', err);
        }
      });
    };
    return req;
  };
}

function mockResponse(statusCode, body, headers = {}) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = headers;
  res.resume = () => {};
  setImmediate(() => {
    if (body) {
      res.emit('data', Buffer.from(body));
    }
    res.emit('end');
  });
  return res;
}

async function runTests() {
  console.log('--- 测试 SemVer 版本解析 ---');
  await test('解析常规版本号', () => {
    const v = parseSemver('0.1.2');
    assert.deepEqual(v, { major: 0, minor: 1, patch: 2, prerelease: null, build: null, raw: '0.1.2' });
  });

  await test('解析带前导 v 与预发布标识的版本号', () => {
    const v = parseSemver('v0.1.2-win.1');
    assert.deepEqual(v, { major: 0, minor: 1, patch: 2, prerelease: ['win', '1'], build: null, raw: '0.1.2-win.1' });
  });

  await test('解析包含 build 元数据的版本', () => {
    const v = parseSemver('1.2.3-alpha.1+build.42');
    assert.equal(v.major, 1);
    assert.equal(v.minor, 2);
    assert.equal(v.patch, 3);
    assert.deepEqual(v.prerelease, ['alpha', '1']);
    assert.equal(v.build, 'build.42');
  });

  await test('无效版本号返回 null', () => {
    assert.equal(parseSemver('invalid-version'), null);
    assert.equal(parseSemver(null), null);
    assert.equal(parseSemver(''), null);
  });

  console.log('--- 测试 SemVer 版本比对逻辑 ---');
  await test('0.1.2-win.1 对比 v0.1.3 -> v0.1.3 更高', () => {
    assert.equal(compareSemver('0.1.2-win.1', 'v0.1.3'), -1);
    assert.equal(compareSemver('v0.1.3', '0.1.2-win.1'), 1);
  });

  await test('预发布版本优先级低于正式版本：0.1.2-win.1 < 0.1.2', () => {
    assert.equal(compareSemver('0.1.2-win.1', '0.1.2'), -1);
    assert.equal(compareSemver('0.1.2', '0.1.2-win.1'), 1);
  });

  await test('同级预发布版本数字比对：0.1.2-win.1 < 0.1.2-win.2', () => {
    assert.equal(compareSemver('0.1.2-win.1', '0.1.2-win.2'), -1);
    assert.equal(compareSemver('0.1.2-win.2', '0.1.2-win.1'), 1);
  });

  await test('相同版本返回 0', () => {
    assert.equal(compareSemver('0.1.2-win.1', '0.1.2-win.1'), 0);
    assert.equal(compareSemver('v0.1.2-win.1', '0.1.2-win.1'), 0);
  });

  await test('预发布标识符数量不同：1.0.0-alpha < 1.0.0-alpha.1', () => {
    assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1);
    assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha'), 1);
  });

  console.log('--- 测试 checkUpdate 场景 ---');
  await test('发现新版本：返回 updateAvailable: true 及完整发布信息', async () => {
    const fakeRelease = {
      tag_name: 'v0.1.3',
      name: 'DogSC 0.1.3 升级',
      html_url: 'https://github.com/laogou717/dogsc/releases/tag/v0.1.3',
      body: '新增波形显示与画幅预设',
      published_at: '2026-10-09T12:00:00Z',
    };

    const mockReq = createMockRequest((opts, cb) => {
      assert.equal(opts.headers['User-Agent'], 'DogSC-Windows');
      cb(mockResponse(200, JSON.stringify(fakeRelease)));
    });

    const result = await checkUpdate({
      currentVersion: '0.1.2-win.1',
      requestFn: mockReq,
    });

    assert.equal(result.updateAvailable, true);
    assert.equal(result.currentVersion, '0.1.2-win.1');
    assert.equal(result.latestVersion, '0.1.3');
    assert.equal(result.tagName, 'v0.1.3');
    assert.equal(result.releaseUrl, fakeRelease.html_url);
    assert.equal(result.releaseNotes, fakeRelease.body);
    assert.equal(result.publishedAt, fakeRelease.published_at);
    assert.equal(result.error, null);
  });

  await test('当前已是最新或更高版本：updateAvailable: false', async () => {
    const fakeRelease = {
      tag_name: 'v0.1.2',
      html_url: 'https://github.com/laogou717/dogsc/releases/tag/v0.1.2',
      body: '旧版本说明',
    };

    const mockReq = createMockRequest((opts, cb) => {
      cb(mockResponse(200, JSON.stringify(fakeRelease)));
    });

    const result = await checkUpdate({
      currentVersion: '0.1.3',
      requestFn: mockReq,
    });

    assert.equal(result.updateAvailable, false);
    assert.equal(result.latestVersion, '0.1.2');
    assert.equal(result.error, null);
  });

  await test('处理 302 重定向', async () => {
    const redirectedRelease = {
      tag_name: 'v0.2.0',
      html_url: 'https://github.com/laogou717/dogsc/releases/tag/v0.2.0',
      body: '大版本更新',
    };

    const mockReq = createMockRequest((opts, cb) => {
      if (opts.path && opts.path.includes('latest')) {
        cb(mockResponse(302, '', { location: 'https://api.github.com/repos/laogou717/dogsc/releases/12345' }));
      } else {
        cb(mockResponse(200, JSON.stringify(redirectedRelease)));
      }
    });

    const result = await checkUpdate({
      currentVersion: '0.1.2-win.1',
      requestFn: mockReq,
    });

    assert.equal(result.updateAvailable, true);
    assert.equal(result.latestVersion, '0.2.0');
  });

  await test('404 Not Found：优雅处理无发布，不崩溃', async () => {
    const mockReq = createMockRequest((opts, cb) => {
      cb(mockResponse(404, '{"message":"Not Found"}'));
    });

    const result = await checkUpdate({
      repository: 'nonexistent/repo',
      currentVersion: '0.1.2-win.1',
      requestFn: mockReq,
    });

    assert.equal(result.updateAvailable, false);
    assert.ok(result.error && result.error.includes('404'));
  });

  await test('403 Forbidden（API 频次受限）：优雅处理', async () => {
    const mockReq = createMockRequest((opts, cb) => {
      cb(mockResponse(403, '{"message":"API rate limit exceeded"}'));
    });

    const result = await checkUpdate({
      currentVersion: '0.1.2-win.1',
      requestFn: mockReq,
    });

    assert.equal(result.updateAvailable, false);
    assert.ok(result.error && result.error.includes('403'));
  });

  await test('离线或网络断开（ENOTFOUND）：返回友好错误对象且不抛出未捕获异常', async () => {
    const mockReq = createMockRequest((opts, cb, req) => {
      const netErr = new Error('getaddrinfo ENOTFOUND api.github.com');
      netErr.code = 'ENOTFOUND';
      req.emit('error', netErr);
    });

    const result = await checkUpdate({
      currentVersion: '0.1.2-win.1',
      requestFn: mockReq,
    });

    assert.equal(result.updateAvailable, false);
    assert.ok(result.error && result.error.includes('ENOTFOUND'));
  });

  await test('请求超时：返回超时错误且不挂起', async () => {
    const mockReq = createMockRequest((opts, cb, req) => {
      req.emit('timeout');
    });

    const result = await checkUpdate({
      currentVersion: '0.1.2-win.1',
      timeout: 100,
      requestFn: mockReq,
    });

    assert.equal(result.updateAvailable, false);
    assert.ok(result.error && result.error.includes('超时'));
  });

  await test('损坏的 JSON 响应：优雅处理', async () => {
    const mockReq = createMockRequest((opts, cb) => {
      cb(mockResponse(200, 'Invalid JSON body <html...'));
    });

    const result = await checkUpdate({
      currentVersion: '0.1.2-win.1',
      requestFn: mockReq,
    });

    assert.equal(result.updateAvailable, false);
    assert.ok(result.error && result.error.includes('解析发布信息失败'));
  });

  console.log('--- 测试 registerUpdaterIpc ---');
  await test('正确注册 app:check-update 与 app:open-url', async () => {
    const handlers = new Map();
    const listeners = new Map();
    const mockIpc = {
      handle: (channel, fn) => handlers.set(channel, fn),
      on: (channel, fn) => listeners.set(channel, fn),
    };
    let openedUrl = null;
    const mockShell = {
      openExternal: async (url) => { openedUrl = url; return true; },
    };

    registerUpdaterIpc(mockIpc, mockShell);

    assert.ok(handlers.has('app:check-update'));
    assert.ok(handlers.has('app:open-url'));
    assert.ok(listeners.has('app:open-url'));

    // 测试 app:open-url 正常打开 HTTP/HTTPS 链接
    const openRes = await handlers.get('app:open-url')(null, 'https://github.com/laogou717/dogsc/releases');
    assert.deepEqual(openRes, { ok: true });
    assert.equal(openedUrl, 'https://github.com/laogou717/dogsc/releases');

    // 测试 app:open-url 拒绝非法协议（安全防御）
    await assert.rejects(async () => {
      await handlers.get('app:open-url')(null, 'file:///C:/Windows/System32/cmd.exe');
    }, /仅允许打开 HTTP 或 HTTPS 链接/);

    await assert.rejects(async () => {
      await handlers.get('app:open-url')(null, 12345);
    }, /无效的 URL 参数/);
  });

  console.log(`\n${passed} 项 updater 测试全部通过！`);
}

runTests().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
