'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseParameters } = require('../agent/recly-cli');
const { dispatchRequest, toolResult } = require('../agent/recly-mcp');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recly-cli-test-'));
  const paramsFile = path.join(directory, 'params.json');
  try {
    fs.writeFileSync(paramsFile, '\uFEFF{"directory":"D:\\\\录屏工程"}', 'utf8');
    assert.deepEqual(parseParameters(['--params-file', paramsFile]), { directory: 'D:\\录屏工程' });
    assert.deepEqual(parseParameters([`@${paramsFile}`]), { directory: 'D:\\录屏工程' });
    assert.throws(() => parseParameters(['--params-file']), /必须/);

    const calls = [];
    const client = { call: async (name, args) => { calls.push({ name, args }); return [{ directory: 'D:\\工程' }]; } };
    const initialized = await dispatchRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, client);
    assert.equal(initialized.result.capabilities.tools !== undefined, true);
    assert.deepEqual((await dispatchRequest({ jsonrpc: '2.0', id: 2, method: 'ping' }, client)).result, {});
    const tools = await dispatchRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, client);
    assert.ok(tools.result.tools.some((tool) => tool.name === 'media.frame'));
    const called = await dispatchRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'project.list', arguments: { filter: 'all' } } }, client);
    assert.deepEqual(calls, [{ name: 'project.list', args: { filter: 'all' } }]);
    assert.deepEqual(called.result.structuredContent, { result: [{ directory: 'D:\\工程' }] });
    assert.deepEqual(called.result.content, [{ type: 'text', text: '[\n  {\n    "directory": "D:\\\\工程"\n  }\n]' }]);
    assert.equal(await dispatchRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, client), null);

    const image = toolResult({ mimeType: 'image/png', base64: 'aGVsbG8=', path: 'frame.png', time: 1 });
    assert.deepEqual(image.content[0], { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
    assert.deepEqual(image.structuredContent, { mimeType: 'image/png', path: 'frame.png', time: 1 });
    assert.deepEqual(toolResult(null).structuredContent, { result: null });
    process.stdout.write('CLI UTF-8 参数文件与 MCP initialize/ping/tools、image 和结构化结果通过。\n');
  } finally {
    fs.unlinkSync(paramsFile);
    fs.rmdirSync(directory);
  }
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
