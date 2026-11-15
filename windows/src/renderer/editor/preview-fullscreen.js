'use strict';

const FULLSCREEN_ICON = '<svg class="icon" viewBox="0 0 24 24"><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/></svg>';
const EXIT_FULLSCREEN_ICON = '<svg class="icon" viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
const FULLSCREEN_STATE_ATTRIBUTE = 'data-preview-fullscreen';

function attachPreviewFullscreen({ stage, button, onToast }) {
  if (!stage || !button) return null;
  button.innerHTML = FULLSCREEN_ICON;
  stage.setAttribute(FULLSCREEN_STATE_ATTRIBUTE, 'false');
  const sync = () => {
    const active = document.fullscreenElement === stage;
    stage.setAttribute(FULLSCREEN_STATE_ATTRIBUTE, String(active));
    button.innerHTML = active ? EXIT_FULLSCREEN_ICON : FULLSCREEN_ICON;
    button.title = active ? '退出全屏观看（Esc）' : '全屏观看（Esc 退出）';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(active));
  };
  const toggle = async () => {
    if (document.fullscreenElement === stage) await document.exitFullscreen();
    else await stage.requestFullscreen();
  };
  const enter = async () => {
    try {
      await toggle();
    } catch {
      onToast?.('无法进入全屏观看');
    }
  };
  button.addEventListener('click', () => { void enter(); });
  document.addEventListener('fullscreenchange', sync);
  sync();
  return { toggle, enter, sync, isActive: () => document.fullscreenElement === stage };
}

module.exports = { attachPreviewFullscreen, FULLSCREEN_STATE_ATTRIBUTE };
