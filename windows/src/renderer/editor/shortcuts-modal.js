'use strict';
// 键盘快捷键交互式配置面板：查看、捕获按键录制、持久化与恢复默认。
// 适用于悬浮录制控制条与主编辑器。

let electronIpc = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object' && electron.ipcRenderer) {
    electronIpc = electron.ipcRenderer;
  }
} catch {
  // 非 Electron 环境优雅回退
}

// 默认快捷键映射
const DEFAULT_SHORTCUTS = Object.freeze({
  recordToggle: 'Control+Alt+R',
  recordPause: 'Control+Alt+P',
  recordMarker: 'Control+Alt+M',
  recordDiscard: 'Control+Alt+D',
  play: 'Space',
  split: 'S',
  delete: 'Delete',
  addZoom: 'Z',
  export: 'Control+E',
});

// 分类与操作定义
const SHORTCUT_CATEGORIES = Object.freeze([
  {
    id: 'recording',
    title: '录制控制',
    items: [
      { action: 'recordToggle', label: '开始 / 停止录制', default: 'Control+Alt+R' },
      { action: 'recordPause', label: '暂停 / 继续录制', default: 'Control+Alt+P' },
      { action: 'recordMarker', label: '标记', default: 'Control+Alt+M' },
      { action: 'recordDiscard', label: '放弃', default: 'Control+Alt+D' },
    ],
  },
  {
    id: 'editor',
    title: '编辑器快捷键',
    items: [
      { action: 'play', label: '播放 / 暂停', default: 'Space' },
      { action: 'split', label: '分割', default: 'S' },
      { action: 'delete', label: '删除', default: 'Delete' },
      { action: 'addZoom', label: '缩放', default: 'Z' },
      { action: 'export', label: '导出', default: 'Control+E' },
    ],
  },
]);

/**
 * 格式化 Electron Accelerator 为友好的界面显示文本
 * 例如：'Control+Alt+R' -> 'Ctrl + Alt + R'
 * @param {string} accelerator
 * @returns {string}
 */
function formatKeyDisplay(accelerator) {
  if (!accelerator || typeof accelerator !== 'string') return '';
  const parts = accelerator.split('+').map((p) => p.trim()).filter(Boolean);
  const formatted = parts.map((part) => {
    const lower = part.toLowerCase();
    if (lower === 'control' || lower === 'ctrl') return 'Ctrl';
    if (lower === 'commandorcontrol' || lower === 'cmdorctrl') return 'Ctrl';
    if (lower === 'command' || lower === 'cmd') return 'Cmd';
    if (lower === 'alt') return 'Alt';
    if (lower === 'shift') return 'Shift';
    if (lower === 'space') return 'Space';
    if (lower === 'return' || lower === 'enter') return 'Enter';
    if (lower === 'delete') return 'Delete';
    if (lower === 'backspace') return 'Backspace';
    if (lower === 'escape' || lower === 'esc') return 'Esc';
    if (lower === 'left' || lower === 'arrowleft') return 'Left';
    if (lower === 'right' || lower === 'arrowright') return 'Right';
    if (lower === 'up' || lower === 'arrowup') return 'Up';
    if (lower === 'down' || lower === 'arrowdown') return 'Down';
    if (/^[a-z]$/i.test(part)) return part.toUpperCase();
    return part;
  });
  return formatted.join(' + ');
}

/**
 * 解析 keydown 事件并生成 Electron Accelerator
 * @param {KeyboardEvent|object} event
 * @returns {{ isModifierOnly?: boolean, isCancel?: boolean, modifiers?: string[], key?: string, accelerator?: string }|null}
 */
function parseKeyCombination(event) {
  if (!event || typeof event !== 'object') return null;

  const rawKey = event.key || '';
  const lower = rawKey.toLowerCase();

  // 纯修饰键按下时（如单独按下 Ctrl 或 Alt），不作为最终按键触发
  if (['control', 'ctrl', 'alt', 'shift', 'meta'].includes(lower)) {
    return { isModifierOnly: true };
  }

  // 单独按 Escape 表示取消监听
  if (lower === 'escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
    return { isCancel: true };
  }

  // 收集修饰键
  const modifiers = [];
  if (event.ctrlKey || event.metaKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');

  // 解析主按键
  let primaryKey = null;
  if (rawKey === ' ' || rawKey === 'Space') {
    primaryKey = 'Space';
  } else if (rawKey === 'Enter') {
    primaryKey = 'Return';
  } else if (rawKey === 'ArrowUp') {
    primaryKey = 'Up';
  } else if (rawKey === 'ArrowDown') {
    primaryKey = 'Down';
  } else if (rawKey === 'ArrowLeft') {
    primaryKey = 'Left';
  } else if (rawKey === 'ArrowRight') {
    primaryKey = 'Right';
  } else if (rawKey === 'Escape') {
    primaryKey = 'Escape';
  } else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(rawKey)) {
    primaryKey = rawKey.toUpperCase();
  } else if (/^[a-zA-Z]$/.test(rawKey)) {
    primaryKey = rawKey.toUpperCase();
  } else if (/^[0-9]$/.test(rawKey)) {
    primaryKey = rawKey;
  } else if (['Delete', 'Backspace', 'Tab', 'Home', 'End', 'PageUp', 'PageDown', 'Insert'].includes(rawKey)) {
    primaryKey = rawKey;
  } else if (rawKey.length === 1) {
    primaryKey = rawKey;
  }

  if (!primaryKey) {
    return null;
  }

  const accelerator = modifiers.length > 0 ? `${modifiers.join('+')}+${primaryKey}` : primaryKey;
  return {
    isModifierOnly: false,
    isCancel: false,
    modifiers,
    key: primaryKey,
    accelerator,
  };
}

/**
 * DOM 元素创建助手（兼容浏览器真实 DOM 与纯 Node.js 测试环境）
 */
function createDomElement(tag, attrs = {}, ...children) {
  if (typeof document !== 'undefined' && document.createElement) {
    const el = document.createElement(tag);
    for (const [key, val] of Object.entries(attrs)) {
      if (key === 'class') {
        el.className = val;
      } else if (key === 'html') {
        el.innerHTML = val;
      } else if (key === 'style') {
        el.style.cssText = val;
      } else if (key.startsWith('on')) {
        el.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (key === 'disabled') {
        el.disabled = Boolean(val);
      } else if (key === 'hidden') {
        el.hidden = Boolean(val);
      } else if (val !== false && val !== null && val !== undefined) {
        el.setAttribute(key, val === true ? '' : String(val));
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // 纯 Node.js 模拟 DOM
  return createMockElement(tag, attrs, ...children);
}

function createMockElement(tag, attrs = {}, ...children) {
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(),
    className: attrs.class || '',
    style: { cssText: attrs.style || '' },
    attributes: {},
    children: [],
    textContent: '',
    disabled: Boolean(attrs.disabled),
    hidden: Boolean(attrs.hidden),
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    },
    getAttribute(k) {
      return this.attributes[k];
    },
    addEventListener(event, handler) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    },
    removeEventListener(event, handler) {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter((h) => h !== handler);
    },
    dispatchEvent(event) {
      const type = typeof event === 'string' ? event : event.type;
      const list = listeners[type] || [];
      const evObj = typeof event === 'string' ? { type: event, target: this, stopPropagation: () => {}, preventDefault: () => {} } : { target: this, stopPropagation: () => {}, preventDefault: () => {}, ...event };
      for (const h of list) h(evObj);
    },
    click() {
      this.dispatchEvent({ type: 'click', target: this });
    },
    append(...newChildren) {
      for (const child of newChildren.flat()) {
        if (!child && child !== 0) continue;
        if (typeof child === 'string' || typeof child === 'number') {
          this.children.push({ textContent: String(child), nodeType: 3 });
          this.textContent += String(child);
        } else {
          this.children.push(child);
          this.textContent += child.textContent || '';
        }
      }
    },
    replaceChildren(...newChildren) {
      this.children = [];
      this.textContent = '';
      this.append(...newChildren);
    },
    querySelector(selector) {
      return queryMock(this, selector, false);
    },
    querySelectorAll(selector) {
      return queryMock(this, selector, true);
    },
  };

  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k !== 'class' && k !== 'style' && k !== 'disabled') {
      el.setAttribute(k, v);
    }
  }

  el.append(...children);
  return el;
}

function queryMock(root, selector, all = false) {
  const results = [];
  const walk = (node) => {
    if (!node || !node.children) return;
    for (const child of node.children) {
      if (!child || child.nodeType === 3) continue;
      let match = false;
      if (selector.startsWith('#')) {
        match = child.attributes && child.attributes.id === selector.slice(1);
      } else if (selector.startsWith('.')) {
        const classes = selector.split('.').filter(Boolean);
        const nodeClasses = (child.className || '').split(/\s+/).filter(Boolean);
        match = classes.every((cls) => nodeClasses.includes(cls));
      } else if (selector.startsWith('[') && selector.endsWith(']')) {
        const inner = selector.slice(1, -1);
        const [attr, expectedVal] = inner.split('=');
        if (expectedVal) {
          const cleanVal = expectedVal.replace(/^["']|["']$/g, '');
          match = child.attributes && child.attributes[attr] === cleanVal;
        } else {
          match = Boolean(child.attributes && child.attributes[attr]);
        }
      } else if (child.tagName === selector.toUpperCase()) {
        match = true;
      }

      if (match) {
        results.push(child);
        if (!all) return;
      }
      walk(child);
      if (!all && results.length > 0) return;
    }
  };
  walk(root);
  return all ? results : (results[0] || null);
}

// 活动的弹窗引用与清理函数
let currentActiveModal = null;

/**
 * 关闭当前开启的快捷键弹窗
 */
function closeShortcutsModal() {
  if (currentActiveModal && typeof currentActiveModal.close === 'function') {
    currentActiveModal.close();
  }
}

/**
 * 打开快捷键设置弹窗
 * @param {HTMLElement|object} [containerElement] 弹窗容器节点（如 #modal 或 #shortcuts-modal）
 * @param {object} [options]
 * @param {object} [options.ipcRenderer] 可注入的 IPC 实例
 * @param {Function} [options.onSave] 保存成功回调 (updatedMap) => void
 * @param {Function} [options.onClose] 关闭弹窗回调 () => void
 * @returns {Promise<{ close: Function, container: HTMLElement|object }>}
 */
async function openShortcutsModal(containerElement = null, options = {}) {
  // 如果之前有正在显示的弹窗，先清理关闭
  closeShortcutsModal();

  // 1. 解析容器节点
  let container = containerElement;
  if (!container && typeof document !== 'undefined') {
    container = document.getElementById('shortcuts-modal') ||
      document.getElementById('modal');
    if (!container) {
      container = document.getElementById('shortcuts-modal-standalone');
      if (!container) {
        container = createDomElement('div', {
          id: 'shortcuts-modal-standalone',
          class: 'modal',
          hidden: true,
        });
        document.body.append(container);
      }
    }
  }

  if (!container) {
    container = createDomElement('div', { class: 'modal', hidden: true });
  }

  // 显示容器
  container.hidden = false;

  // 2. 解析 IPC 并加载当前快捷键
  const ipc = options.ipcRenderer || electronIpc;
  let currentShortcuts = { ...DEFAULT_SHORTCUTS };

  if (ipc && typeof ipc.invoke === 'function') {
    try {
      const fetched = await ipc.invoke('shortcuts:get');
      if (fetched && typeof fetched === 'object') {
        currentShortcuts = { ...DEFAULT_SHORTCUTS, ...fetched };
      }
    } catch (err) {
      console.warn('[shortcuts-modal] 读取快捷键失败，使用默认配置:', err);
    }
  }

  // 3. 构建弹窗 UI
  const dialog = createDomElement('div', { class: 'dialog card shortcuts-dialog' });

  // 顶栏
  const header = createDomElement('div', { class: 'shortcuts-header' },
    createDomElement('h2', {}, '键盘快捷键'),
    createDomElement('button', {
      class: 'btn ghost icon-only shortcuts-close',
      title: '关闭',
      onclick: () => close(),
    }, '×')
  );

  // 主体
  const body = createDomElement('div', { class: 'shortcuts-body' });

  // 状态追踪
  let activeListening = null; // { action, buttonEl, previousKey }

  function hideError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function showError(msg) {
    errorEl.hidden = false;
    errorEl.textContent = msg;
  }

  function cancelListening() {
    if (activeListening) {
      const { buttonEl, previousKey } = activeListening;
      buttonEl.textContent = formatKeyDisplay(previousKey);
      if (buttonEl.classList && typeof buttonEl.classList.remove === 'function') {
        buttonEl.classList.remove('listening');
      } else if (buttonEl.className) {
        buttonEl.className = buttonEl.className.replace(/\blistening\b/g, '').trim();
      }
      activeListening = null;
    }
  }

  function enterListening(action, buttonEl) {
    if (activeListening && activeListening.buttonEl === buttonEl) {
      // 再次点击取消
      cancelListening();
      return;
    }
    // 取消之前的监听项
    cancelListening();
    hideError();

    const previousKey = currentShortcuts[action] || DEFAULT_SHORTCUTS[action];
    activeListening = { action, buttonEl, previousKey };

    if (buttonEl.classList && typeof buttonEl.classList.add === 'function') {
      buttonEl.classList.add('listening');
    } else {
      buttonEl.className = `${buttonEl.className || ''} listening`.trim();
    }
    buttonEl.textContent = '按下新按键...';
  }

  // 渲染分类与行
  for (const category of SHORTCUT_CATEGORIES) {
    const section = createDomElement('section', { class: 'shortcuts-section' },
      createDomElement('h3', { class: 'shortcuts-category-title' }, category.title)
    );
    const list = createDomElement('div', { class: 'shortcuts-list' });

    for (const item of category.items) {
      const currentKey = currentShortcuts[item.action] || item.default;
      const keyBtn = createDomElement('button', {
        class: 'btn shortcut-key-btn',
        'data-action': item.action,
        title: '点击后按下新的快捷键组合',
      }, formatKeyDisplay(currentKey));

      keyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        enterListening(item.action, keyBtn);
      });

      const row = createDomElement('div', { class: 'shortcut-row' },
        createDomElement('span', { class: 'shortcut-label' }, item.label),
        keyBtn
      );
      list.append(row);
    }

    section.append(list);
    body.append(section);
  }

  // 错误消息容器
  const errorEl = createDomElement('div', { class: 'shortcuts-error', hidden: true });
  body.append(errorEl);

  // 底栏操作
  const footer = createDomElement('div', { class: 'shortcuts-footer' },
    createDomElement('button', {
      class: 'btn ghost shortcuts-reset',
      title: '重置所有快捷键为默认键位',
      onclick: () => resetToDefaults(),
    }, '恢复默认'),
    createDomElement('div', { class: 'shortcuts-footer-right' },
      createDomElement('button', {
        class: 'btn primary shortcuts-done',
        onclick: () => close(),
      }, '完成')
    )
  );

  dialog.append(header, body, footer);

  // 清空容器并挂载
  container.replaceChildren(dialog);

  // 保存与更新
  async function saveShortcuts(updatedMap, action, previousKey, buttonEl) {
    try {
      hideError();
      if (ipc && typeof ipc.invoke === 'function') {
        await ipc.invoke('shortcuts:set', updatedMap);
      }
      if (typeof options.onSave === 'function') {
        options.onSave(updatedMap);
      }
    } catch (err) {
      showError(err && err.message ? err.message : '快捷键保存失败，可能存在冲突');
      // 还原状态
      currentShortcuts[action] = previousKey;
      buttonEl.textContent = formatKeyDisplay(previousKey);
    }
  }

  // 恢复默认
  async function resetToDefaults() {
    cancelListening();
    hideError();
    const defaults = { ...DEFAULT_SHORTCUTS };
    try {
      if (ipc && typeof ipc.invoke === 'function') {
        await ipc.invoke('shortcuts:set', defaults);
      }
      currentShortcuts = { ...defaults };
      // 刷新所有按钮文本
      for (const cat of SHORTCUT_CATEGORIES) {
        for (const item of cat.items) {
          const btn = dialog.querySelector(`[data-action="${item.action}"]`);
          if (btn) {
            btn.textContent = formatKeyDisplay(defaults[item.action]);
            if (btn.classList && typeof btn.classList.remove === 'function') {
              btn.classList.remove('listening');
            } else if (btn.className) {
              btn.className = btn.className.replace(/\blistening\b/g, '').trim();
            }
          }
        }
      }
      if (typeof options.onSave === 'function') {
        options.onSave(defaults);
      }
    } catch (err) {
      showError(err && err.message ? err.message : '恢复默认快捷键失败');
    }
  }

  // 按键监听处理
  function onKeyDown(event) {
    if (!activeListening) {
      if (event.key === 'Escape') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        close();
      }
      return;
    }

    const parsed = parseKeyCombination(event);
    if (!parsed) return;

    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();

    // 仅按下修饰键时不结束监听
    if (parsed.isModifierOnly) {
      return;
    }

    // 单独按 Escape 取消本次录制
    if (parsed.isCancel) {
      cancelListening();
      return;
    }

    // 成功捕获有效组合键
    const { action, buttonEl, previousKey } = activeListening;
    const newAccelerator = parsed.accelerator;

    buttonEl.textContent = formatKeyDisplay(newAccelerator);
    if (buttonEl.classList && typeof buttonEl.classList.remove === 'function') {
      buttonEl.classList.remove('listening');
    } else if (buttonEl.className) {
      buttonEl.className = buttonEl.className.replace(/\blistening\b/g, '').trim();
    }

    currentShortcuts[action] = newAccelerator;
    activeListening = null;

    return saveShortcuts(currentShortcuts, action, previousKey, buttonEl);
  }

  // 注册全局/窗口 keydown
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('keydown', onKeyDown, true);
  } else if (container.addEventListener) {
    container.addEventListener('keydown', onKeyDown);
  }

  // 点击背景关闭
  const onBackdropClick = (ev) => {
    if (ev.target === container) {
      close();
    }
  };
  container.addEventListener('click', onBackdropClick);

  function close() {
    cancelListening();
    container.hidden = true;
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('keydown', onKeyDown, true);
    } else if (container.removeEventListener) {
      container.removeEventListener('keydown', onKeyDown);
    }
    container.removeEventListener('click', onBackdropClick);
    currentActiveModal = null;
    if (typeof options.onClose === 'function') {
      options.onClose();
    }
  }

  const modalInstance = {
    close,
    container,
    dialog,
    getShortcuts: () => ({ ...currentShortcuts }),
    getActiveListening: () => activeListening,
    dispatchKey: (event) => onKeyDown(event),
    resetToDefaults,
  };

  currentActiveModal = modalInstance;
  return modalInstance;
}

module.exports = {
  openShortcutsModal,
  closeShortcutsModal,
  formatKeyDisplay,
  parseKeyCombination,
  createDomElement,
  DEFAULT_SHORTCUTS,
  SHORTCUT_CATEGORIES,
};
