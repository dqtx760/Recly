'use strict';

const API_PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    models: [
      { id: 'deepseek-flash', label: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    ],
    source: 'https://api-docs.deepseek.com/api/list-models/',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
    ],
    source: 'https://developers.openai.com/api/docs/models/gpt-5.4-mini',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    ],
    source: 'https://docs.anthropic.com/en/docs/about-claude/model-deprecations',
  },
  {
    id: 'aliyun-bailian',
    label: '阿里云百炼（北京）',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen3.7-plus', label: '通义千问 3.7 Plus' },
      { id: 'qwen3.8-flash', label: '通义千问 3.8 Flash' },
    ],
    source: 'https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions',
  },
  {
    id: 'kimi-cn',
    label: 'Kimi（月之暗面中国站）',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      { id: 'kimi-k2.6', label: 'Kimi K2.6' },
      { id: 'kimi-k2-thinking', label: 'Kimi K2 Thinking' },
    ],
    source: 'https://github.com/MoonshotAI/kimi-cli/blob/main/CHANGELOG.md',
  },
  {
    id: 'custom',
    label: '自定义兼容接口',
    protocol: 'openai',
    baseUrl: '',
    models: [],
    source: '',
  },
];

function normalizeProviderUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function findApiProvider(config = {}) {
  const protocol = String(config.protocol || '').trim().toLowerCase();
  const baseUrl = normalizeProviderUrl(config.baseUrl);
  if (!baseUrl) return API_PROVIDERS.find((provider) => provider.id === 'custom');

  return API_PROVIDERS.find((provider) => provider.id !== 'custom'
    && provider.protocol === protocol
    && normalizeProviderUrl(provider.baseUrl) === baseUrl)
    || API_PROVIDERS.find((provider) => provider.id === 'custom');
}

module.exports = { API_PROVIDERS, findApiProvider };
