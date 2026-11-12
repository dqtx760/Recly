'use strict';

const { ipcRenderer } = require('electron');
const { element } = require('../common');
const { applyAssistantResult } = require('./assistant-plan');

function renderAssistantPanel(inspector) {
  if (inspector.assistantView) return [inspector.assistantView];
  if (!document.getElementById('assistant-panel-styles')) {
    document.head.append(element('link', { id: 'assistant-panel-styles', rel: 'stylesheet', href: 'editor/assistant-panel.css' }));
  }
  const store = inspector.store;
  const messages = [];
  let running = false;
  let apiReady = false;
  let configuring = false;
  let turn = 0;
  let pendingMessage = null;
  const forgetPending = () => {
    const index = messages.indexOf(pendingMessage);
    if (index >= 0) messages.splice(index, 1);
    pendingMessage = null;
  };
  const backend = element('select', { 'aria-label': '本机智能体' });
  const status = element('p', { class: 'note', role: 'status' }, '正在检测本机智能体…');
  const transcript = element('div', { class: 'assistant-messages', role: 'log', 'aria-label': '助手对话' });
  const input = element('textarea', { rows: 3, maxlength: 8000, 'aria-label': '发送给 AI 助手', placeholder: '描述剪辑要求，例如：讲述时人像全屏，演示时显示屏幕加摄像头' });
  const send = element('button', { type: 'submit', class: 'btn primary', disabled: true }, '发送');
  const stop = element('button', { type: 'button', class: 'btn', hidden: true }, '停止');
  const detect = element('button', { type: 'button', class: 'btn ghost' }, '重新检测');
  const protocol = element('select', { 'aria-label': 'API 协议' },
    element('option', { value: 'openai' }, 'OpenAI 兼容'), element('option', { value: 'anthropic' }, 'Anthropic'));
  const endpoint = element('input', { type: 'url', 'aria-label': 'API 地址', placeholder: 'https://api.example.com/v1' });
  const model = element('input', { type: 'text', 'aria-label': '模型名称', placeholder: '服务商提供的模型名称' });
  const key = element('input', { type: 'password', 'aria-label': 'API Key', autocomplete: 'new-password', placeholder: '输入 API Key' });
  const save = element('button', { type: 'button', class: 'btn' }, '保存配置');
  const clear = element('button', { type: 'button', class: 'btn ghost' }, '清除密钥');
  const apiStatus = element('p', { class: 'note', role: 'status' });
  const apiSettings = element('details', { class: 'assistant-api-settings', hidden: true }, element('summary', {}, 'API 设置'),
    element('label', {}, '协议', protocol), element('label', {}, '接口地址', endpoint),
    element('label', {}, '模型', model), element('label', {}, '密钥', key),
    element('div', { class: 'assistant-actions' }, save, clear), apiStatus);
  const storyboard = element('button', { type: 'button', class: 'btn' }, '分析全片并分镜');
  const bubble = (role, text) => {
    transcript.append(element('article', { class: `assistant-message ${role}` },
      element('b', {}, role === 'user' ? '你' : role === 'error' ? '提示' : 'AI 助手'), element('div', {}, text)));
    requestAnimationFrame(() => { transcript.scrollTop = transcript.scrollHeight; });
  };
  const refresh = () => {
    const ready = backend.value && (backend.value !== 'api' || apiReady);
    send.disabled = running || configuring || !ready || !input.value.trim();
    storyboard.disabled = running || configuring || !ready;
    backend.disabled = running || configuring;
    detect.disabled = running || configuring;
    stop.hidden = !running;
    input.disabled = running;
    for (const control of [protocol, endpoint, model, key, save, clear]) control.disabled = running || configuring;
    apiSettings.hidden = backend.value !== 'api';
  };
  const loadApi = async () => {
    configuring = true; refresh();
    try {
      const config = await ipcRenderer.invoke('assistant:api-config');
      protocol.value = config.protocol || 'openai';
      endpoint.value = config.baseUrl || '';
      model.value = config.model || '';
      key.value = '';
      apiReady = Boolean(config.hasKey && config.baseUrl && config.model);
      key.placeholder = config.hasKey ? '密钥已保存，留空保留原密钥' : '输入 API Key';
      apiStatus.textContent = apiReady ? '已保存，密钥在本机加密存储。' : '填写接口地址、模型和密钥后保存。';
      apiSettings.open = !apiReady;
    } catch { apiReady = false; apiStatus.textContent = '无法读取 API 配置，请重试。'; }
    finally { configuring = false; refresh(); }
  };
  const discover = async () => {
    detect.disabled = true;
    try {
      const choices = await ipcRenderer.invoke('assistant:detect');
      const previous = backend.value;
      backend.replaceChildren(...choices.filter((item) => item.available).map((item) => element('option', { value: item.id }, item.label)));
      if ([...backend.options].some((option) => option.value === previous)) backend.value = previous;
      status.textContent = backend.value ? '修改完成后可撤销。' : '未检测到本机智能体，可使用 API Key。';
      if (backend.value === 'api') await loadApi();
    } catch (error) { status.textContent = `检测失败：${error.message}`; }
    refresh();
  };
  const submit = async (event) => {
    event?.preventDefault();
    if (running || configuring || !backend.value || (backend.value === 'api' && !apiReady) || !input.value.trim()) return;
    const message = input.value.trim();
    const history = messages.slice(-12);
    const revision = store.revision;
    const current = ++turn;
    bubble('user', message);
    pendingMessage = { role: 'user', content: message };
    messages.push(pendingMessage);
    input.value = '';
    running = true;
    status.textContent = '智能体正在处理，可点击停止…';
    refresh();
    try {
      const result = await ipcRenderer.invoke('assistant:send', {
        directory: store.directory, backend: backend.value, message, history,
        project: JSON.parse(JSON.stringify(store.project)), playhead: inspector.preview.time, selection: store.selection,
      });
      if (current !== turn) return;
      const changed = applyAssistantResult(store, result, revision, Boolean(window.reclyEditor?.agentBridge?.activeExportId));
      const text = `${result.reply}${changed ? '\n\n修改已应用，可通过撤销恢复。' : ''}`;
      bubble('assistant', text);
      messages.push({ role: 'assistant', content: text });
      pendingMessage = null;
      if (messages.length > 24) messages.splice(0, messages.length - 24);
      status.textContent = changed ? '修改已应用。' : '回复完成。';
    } catch (error) {
      if (current !== turn) return;
      forgetPending();
      bubble('error', `未执行修改：${error.message || error}`);
      input.value = message;
      status.textContent = '本次未执行修改，可调整要求后重试。';
    } finally {
      if (current === turn) { running = false; refresh(); input.focus(); }
    }
  };
  const cancel = async () => {
    if (!running) return;
    ++turn;
    forgetPending();
    status.textContent = '正在停止…';
    try { await ipcRenderer.invoke('assistant:cancel'); }
    catch (error) { bubble('error', `停止失败：${error.message}`); }
    running = false;
    status.textContent = '已停止，本次未执行修改。';
    refresh();
    input.focus();
  };
  stop.addEventListener('click', cancel);
  window.addEventListener('keydown', (event) => {
    if (inspector.tab === 'assistant' && running && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
    }
  }, true);
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) submit(event);
  });
  backend.addEventListener('change', () => { refresh(); if (backend.value === 'api') loadApi(); });
  for (const control of [protocol, endpoint, model, key]) control.addEventListener('input', () => {
    apiReady = false;
    apiStatus.textContent = '配置有修改，请保存后发送。';
    refresh();
  });
  save.addEventListener('click', async () => {
    configuring = true; refresh();
    try {
      await ipcRenderer.invoke('assistant:api-save', { protocol: protocol.value, baseUrl: endpoint.value.trim(), model: model.value.trim(), apiKey: key.value.trim() });
      key.value = '';
      await loadApi();
    } catch (error) { apiReady = false; apiStatus.textContent = error.message || '保存失败'; }
    finally { configuring = false; refresh(); }
  });
  clear.addEventListener('click', async () => {
    configuring = true; refresh();
    try { await ipcRenderer.invoke('assistant:api-clear'); await loadApi(); }
    catch { apiStatus.textContent = '清除失败，请重试。'; }
    finally { configuring = false; refresh(); }
  });
  storyboard.addEventListener('click', () => {
    if (!store.project.subtitles?.cues?.length) { bubble('error', '请先到字幕页面识别字幕，再按讲述内容分析全片。'); return; }
    input.value = '请基于全片字幕分析讲述与演示内容，用一条scene_plan分割并安排整个成片：讲述、开场和总结可用人像全屏（portrait）；操作演示用屏幕加摄像头（presenter）；少量重点展示可用屏幕3D（screen3d）。保持全部视频和原音轨，不删除内容，避免频繁切换，每段尽量至少3秒。回复按成片时间逐段列出模式和理由，并明确说明依据是字幕而非实际观看视频画面。';
    submit();
  });
  detect.addEventListener('click', discover);
  const composer = element('form', { class: 'assistant-composer', onsubmit: submit }, input,
    element('div', { class: 'assistant-actions' }, send, stop));
  const controls = document.getElementById('assistant-controls');
  if (controls) {
    controls.replaceChildren(backend, detect);
    controls.hidden = false;
    inspector.assistantControls = controls;
  }
  const panel = element('div', { class: 'assistant-panel' },
    controls ? null : element('div', { class: 'assistant-actions' }, backend, detect),
    apiSettings,
    element('div', { class: 'assistant-actions' }, storyboard),
    element('p', { class: 'note' }, '分镜依据字幕内容，支持人像全屏、屏幕加摄像头、屏幕 3D。'),
    status, transcript, composer);
  inspector.assistantView = panel;
  discover();
  return [panel];
}

module.exports = { renderAssistantPanel };
