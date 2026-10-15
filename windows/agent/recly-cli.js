'use strict';

const fs = require('node:fs');
const { AgentClient } = require('./client');
const { METHODS } = require('./api');

function usage() {
  process.stdout.write('Recly 本机命令行\n\n用法：\n  node recly-cli.js <接口名> [JSON 参数]\n  node recly-cli.js <接口名> @params.json\n  node recly-cli.js <接口名> --params-file params.json\n\n示例：\n  node recly-cli.js project.list\n  node recly-cli.js project.get --params-file request.json\n\n接口：\n');
  for (const method of METHODS) process.stdout.write(`  ${method.name}  ${method.description}\n`);
}

function parseParameters(parts) {
  if (!parts.length) return {};
  let file = null;
  if (parts[0] === '--params-file') {
    if (!parts[1] || parts.length !== 2) throw new Error('--params-file 后面必须是一个文件路径');
    file = parts[1];
  } else if (parts.length === 1 && parts[0].startsWith('@')) file = parts[0].slice(1);
  const source = file
    ? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    : parts.join(' ');
  const value = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是 JSON 对象');
  return value;
}

async function main(argv = process.argv.slice(2)) {
  const [method, ...parts] = argv;
  if (!method || method === '--help' || method === '-h') { usage(); return; }
  let params;
  try { params = parseParameters(parts); } catch (error) {
    process.stderr.write(`参数必须是一个 UTF-8 JSON 对象：${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const client = new AgentClient();
  try {
    const result = await client.call(method, params);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'AGENT_ERROR'}: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

if (require.main === module) void main();

module.exports = { main, parseParameters, usage };
