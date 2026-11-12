'use strict';

const assert = require('node:assert/strict');
const { API_PROVIDERS, findApiProvider } = require('../src/renderer/editor/assistant-providers');
const { endpointUrl } = require('../src/main/assistant-api');

assert.equal(new Set(API_PROVIDERS.map(item => item.id)).size, API_PROVIDERS.length);
assert.equal(API_PROVIDERS[0].id, 'deepseek');
for (const preset of API_PROVIDERS.filter(item => item.id !== 'custom')) {
  assert.equal(new URL(preset.baseUrl).protocol, 'https:');
  assert.ok(preset.models.length && preset.models.every(item => item.id && item.label));
  assert.equal(findApiProvider({ protocol: preset.protocol, baseUrl: preset.baseUrl + '/' }).id, preset.id);
  const request = new URL(endpointUrl(preset));
  assert.equal(request.origin, new URL(preset.baseUrl).origin, '服务商地址不得跳到其它站点');
  assert.ok(request.pathname.endsWith(preset.protocol === 'anthropic' ? '/v1/messages' : '/chat/completions'));
}
assert.equal(findApiProvider({ protocol: 'openai', baseUrl: 'https://custom.example/v1' }).id, 'custom');
assert.equal(findApiProvider({ protocol: 'anthropic', baseUrl: 'https://api.deepseek.com' }).id, 'custom');
assert.equal(findApiProvider({ protocol: 'openai', baseUrl: 'https://api.deepseek.com/chat/completions' }).id, 'custom', '完整路由不能冒充接口前缀');
assert.equal(findApiProvider().id, 'custom');
console.log('API 服务商预设、协议路由与自定义地址匹配检查通过');
