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
  const input = element('textarea', { rows: 3, maxlength: 8000, 'aria-label': '发送给 AI 助手', placeholder: '例如：把麦克风音量设为120%，将前2秒剪掉' });
  const send = element('button', { type: 'submit', class: 'btn primary', disabled: true }, '发送');
  const stop = element('button', { type: 'button', class: 'btn', hidden: true }, '停止');
  const detect = element('button', { type: 'button', class: 'btn ghost' }, '重新检测');
  const bubble = (role, text) => {
    transcript.append(element('article', { class: `assistant-message ${role}` },
      element('b', {}, role === 'user' ? '你' : role === 'error' ? '提示' : 'AI 助手'), element('div', {}, text)));
    requestAnimationFrame(() => { transcript.scrollTop = transcript.scrollHeight; });
  };
  const refresh = () => {
    send.disabled = running || !backend.value || !input.value.trim();
    backend.disabled = running;
    detect.disabled = running;
    stop.hidden = !running;
    input.disabled = running;
  };
  const discover = async () => {
    detect.disabled = true;
    try {
      const choices = await ipcRenderer.invoke('assistant:detect');
      const previous = backend.value;
      backend.replaceChildren(...choices.filter((item) => item.available).map((item) => element('option', { value: item.id }, item.label)));
      if ([...backend.options].some((option) => option.value === previous)) backend.value = previous;
      status.textContent = backend.value ? '沿用本机登录与默认模型。修改完成后可撤销。' : '未检测到 Codex 或 Claude，请安装并在终端登录后重新检测。';
    } catch (error) { status.textContent = `检测失败：${error.message}`; }
    refresh();
  };
  const submit = async (event) => {
    event?.preventDefault();
    if (running || !backend.value || !input.value.trim()) return;
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
  stop.addEventListener('click', async () => {
    ++turn;
    forgetPending();
    status.textContent = '正在停止…';
    try { await ipcRenderer.invoke('assistant:cancel'); }
    catch (error) { bubble('error', `停止失败：${error.message}`); }
    running = false;
    status.textContent = '已停止，本次未执行修改。';
    refresh();
  });
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit(event);
  });
  detect.addEventListener('click', discover);
  const composer = element('form', { class: 'assistant-composer', onsubmit: submit }, input,
    element('div', { class: 'assistant-actions' }, send, stop, element('span', { class: 'note' }, 'Ctrl+Enter 发送')));
  const panel = element('div', { class: 'assistant-panel' },
    element('div', { class: 'assistant-actions' }, backend, detect),
    element('p', { class: 'note' }, '发送当前工程参数与字幕给所选智能体，支持剪辑、画面、声音和字幕编辑。'),
    status, transcript, composer);
  inspector.assistantView = panel;
  discover();
  return [panel];
}

module.exports = { renderAssistantPanel };
