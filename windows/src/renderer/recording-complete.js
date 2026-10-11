'use strict';

const path = require('node:path');
const { ipcRenderer } = require('electron');

const $ = (id) => document.getElementById(id);
const state = { directory: '', originalDirectory: '', name: '' };

function displayLocation(directory, copied = false) {
  const label = copied ? '副本保存到：' : '已自动保存在：';
  const element = $('save-path');
  element.textContent = `${label}${directory}`;
  element.title = directory;
}

function setThumbnail(url) {
  const image = $('thumbnail');
  if (!url || !image) return;
  image.onload = () => {
    image.hidden = false;
    $('thumbnail-placeholder').hidden = true;
  };
  image.onerror = () => {
    image.hidden = true;
    $('thumbnail-placeholder').textContent = '缩略图暂不可用';
    $('thumbnail-placeholder').hidden = false;
  };
  image.src = url;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function showMessage(message, isError = false) {
  const element = $('message');
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.hidden = false;
}

ipcRenderer.on('recording-complete:data', (event, result) => {
  state.directory = result.directory;
  state.originalDirectory = result.directory;
  state.name = result.name;
  $('project-name').textContent = result.name || path.basename(result.directory);
  $('project-name').title = state.name;
  $('duration').textContent = formatDuration(result.duration);
  displayLocation(state.directory);
  setThumbnail(result.thumbnailUrl);
});

ipcRenderer.on('recording-complete:thumbnail', (event, url) => setThumbnail(url));

$('close')?.addEventListener('click', () => ipcRenderer.send('window:close'));
$('edit')?.addEventListener('click', async () => {
  if (!state.directory) return;
  try {
    await ipcRenderer.invoke('project:open', state.directory);
    ipcRenderer.send('window:close');
  } catch (error) {
    showMessage(String(error.message || error), true);
  }
});
$('save-copy')?.addEventListener('click', async () => {
  if (!state.originalDirectory) return;
  const button = $('save-copy');
  button.disabled = true;
  button.textContent = '正在复制…';
  $('message').hidden = true;
  try {
    const target = await ipcRenderer.invoke('recording-complete:save-copy', state.originalDirectory);
    if (target) {
      state.directory = target;
      displayLocation(target, true);
      button.textContent = '再次保存项目…';
      showMessage('原项目仍保留，副本已保存。');
    } else {
      button.textContent = '保存项目…';
    }
  } catch (error) {
    button.textContent = '保存项目…';
    showMessage(String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
  } finally {
    button.disabled = false;
  }
});
