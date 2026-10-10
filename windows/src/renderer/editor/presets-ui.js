'use strict';
// 编辑器场景预设 UI 管理：预设列表弹窗、预设切换、另存为预设、更新预设与默认预设配置。
// 对齐 macOS 版 EditorScenePresets.swift / EditorStylePresetStore.swift。

const {
  getDefaultPresets,
  createPresetFromProject,
  applyPresetToProject,
  matchesPreset,
} = require('../../core/presets');

let electronIpc = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object' && electron.ipcRenderer) {
    electronIpc = electron.ipcRenderer;
  }
} catch {
  // 非 Electron 环境优雅回退
}

/**
 * 轻量 DOM 元素构建助手，兼容真实 DOM 与纯 Node 测试环境
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

  // 纯 Node.js 测试环境下的模拟 DOM
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
    hidden: false,
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
      const evObj = typeof event === 'string' ? { type: event, target: this, stopPropagation: () => {} } : { target: this, stopPropagation: () => {}, ...event };
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
      } else {
        match = child.tagName && child.tagName.toLowerCase() === selector.toLowerCase();
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

class PresetsUI {
  /**
   * @param {Object} options
   * @param {Object} options.store 编辑器 Store 实例
   * @param {HTMLElement} [options.button] 顶栏场景预设按钮
   * @param {HTMLElement} [options.modal] 弹窗容器元素
   * @param {Object} [options.ipc] IPC 通信对象 (默认使用 electron.ipcRenderer)
   * @param {Function} [options.prompt] 预设命名提示函数
   * @param {Function} [options.confirm] 操作确认提示函数
   * @param {Function} [options.toast] 提示信息显示函数
   */
  constructor(options = {}) {
    this.store = options.store;
    this.button = options.button || null;
    this.modal = options.modal || null;
    this.ipc = options.ipc !== undefined ? options.ipc : electronIpc;
    this.prompt = options.prompt || ((msg, def) => {
      if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
        return window.prompt(msg, def);
      }
      return def;
    });
    this.confirm = options.confirm || ((msg) => {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        return window.confirm(msg);
      }
      return true;
    });
    this.toast = options.toast || (() => {});

    this.presets = [];
    this.activePresetId = null;
    this.isModified = false;
    this.isOpen = false;
    this.onBackdropClick = (event) => {
      if (event.target === this.modal) {
        this.closeModal();
      }
    };
  }

  /**
   * 初始化预设组件：绑定按钮事件、订阅 Store 状态、拉取预设列表
   */
  async init() {
    if (this.button) {
      this.button.addEventListener('click', () => this.toggleModal());
    }

    if (this.store && typeof this.store.subscribe === 'function') {
      this.store.subscribe((reason) => {
        if (reason === 'project' || reason === 'history' || !reason) {
          this.syncActiveState();
        }
      });
    }

    await this.loadPresets();
    this.syncActiveState();
    return this;
  }

  /**
   * 从主进程读取预设列表
   */
  async loadPresets() {
    if (this.ipc && typeof this.ipc.invoke === 'function') {
      try {
        const list = await this.ipc.invoke('presets:list');
        if (Array.isArray(list) && list.length > 0) {
          this.presets = list;
          return this.presets;
        }
      } catch (err) {
        // 出错时回退到默认预设
      }
    }
    if (!this.presets || this.presets.length === 0) {
      this.presets = getDefaultPresets();
    }
    return this.presets;
  }

  /**
   * 同步当前激活预设与修改状态
   */
  syncActiveState() {
    if (!this.store || !this.store.project) return;

    if (this.activePresetId) {
      const activePreset = this.presets.find((p) => p.id === this.activePresetId);
      if (activePreset) {
        this.isModified = !matchesPreset(activePreset, this.store.project);
      } else {
        this.activePresetId = null;
        this.isModified = false;
      }
    }

    if (!this.activePresetId) {
      const matched = this.presets.find((p) => matchesPreset(p, this.store.project));
      if (matched) {
        this.activePresetId = matched.id;
        this.isModified = false;
      } else {
        this.isModified = false;
      }
    }

    this.updateButtonText();
    if (this.isOpen) {
      this.renderModal();
    }
  }

  /**
   * 获取当前激活的预设对象
   */
  getActivePreset() {
    if (!this.activePresetId) return null;
    return this.presets.find((p) => p.id === this.activePresetId) || null;
  }

  /**
   * 更新顶栏预设按钮的显示文本
   */
  updateButtonText() {
    if (!this.button) return;
    const activePreset = this.getActivePreset();
    if (activePreset) {
      this.button.textContent = `${activePreset.name} ▾`;
      this.button.title = `场景预设：${activePreset.name}${this.isModified ? '（已修改）' : ''}`;
    } else {
      this.button.textContent = '场景预设 ▾';
      this.button.title = '场景预设';
    }
  }

  /**
   * 打开/关闭弹窗切换
   */
  toggleModal() {
    if (this.isOpen) {
      this.closeModal();
    } else {
      this.openModal();
    }
  }

  /**
   * 打开预设管理弹窗
   */
  openModal() {
    if (!this.modal) return;
    this.isOpen = true;
    this.modal.hidden = false;
    this.modal.addEventListener('click', this.onBackdropClick);
    this.renderModal();
  }

  /**
   * 关闭预设管理弹窗
   */
  closeModal() {
    this.isOpen = false;
    if (this.modal) {
      this.modal.removeEventListener('click', this.onBackdropClick);
      this.modal.hidden = true;
      this.modal.replaceChildren();
    }
  }

  /**
   * 应用选中的预设到当前项目
   */
  applyPreset(presetOrId) {
    const preset = typeof presetOrId === 'string'
      ? this.presets.find((p) => p.id === presetOrId)
      : presetOrId;

    if (!preset || !this.store) return;

    this.activePresetId = preset.id;
    this.isModified = false;

    this.store.mutate((draft) => {
      const updated = applyPresetToProject(preset, draft);
      draft.canvas = updated.canvas;
      draft.camera = updated.camera;
      draft.cursorStyle = updated.cursorStyle;
      draft.motion = updated.motion;
    });

    this.updateButtonText();
    if (this.isOpen) {
      this.renderModal();
    }
    this.toast(`已应用预设 “${preset.name}”`);
  }

  /**
   * 另存为新预设
   */
  async saveAsNewPreset(customName = null) {
    if (!this.store || !this.store.project) return null;

    let name = customName;
    if (!name) {
      name = await this.prompt('请输入新预设名称：', '我的场景预设');
    }
    if (!name || !name.trim()) return null;

    const presetData = createPresetFromProject({
      name: name.trim(),
      project: this.store.project,
    });

    if (this.ipc && typeof this.ipc.invoke === 'function') {
      try {
        const saved = await this.ipc.invoke('presets:save', presetData);
        if (saved && saved.id) {
          presetData.id = saved.id;
        }
      } catch (err) {
        console.error('保存预设失败:', err);
      }
    } else {
      const idx = this.presets.findIndex((p) => p.id === presetData.id);
      if (idx >= 0) this.presets[idx] = presetData;
      else this.presets.push(presetData);
    }

    this.activePresetId = presetData.id;
    this.isModified = false;
    await this.loadPresets();
    this.syncActiveState();

    this.toast(`已保存预设 “${presetData.name}”`);
    return presetData;
  }

  /**
   * 更新当前激活的预设（当项目外观被修改时）
   */
  async updateActivePreset() {
    if (!this.store || !this.store.project || !this.activePresetId) return null;
    const activePreset = this.getActivePreset();
    if (!activePreset) return null;

    const updatedData = createPresetFromProject({
      id: activePreset.id,
      name: activePreset.name,
      project: this.store.project,
      isDefault: activePreset.isDefault,
    });

    if (this.ipc && typeof this.ipc.invoke === 'function') {
      try {
        await this.ipc.invoke('presets:save', updatedData);
      } catch (err) {
        console.error('更新预设失败:', err);
      }
    } else {
      const idx = this.presets.findIndex((p) => p.id === activePreset.id);
      if (idx >= 0) this.presets[idx] = updatedData;
    }

    this.isModified = false;
    await this.loadPresets();
    this.syncActiveState();

    this.toast(`已更新预设 “${activePreset.name}”`);
    return updatedData;
  }

  /**
   * 设为新录制默认预设
   */
  async setDefault(presetId) {
    if (!presetId) return false;
    const target = this.presets.find((p) => p.id === presetId);
    if (!target) return false;

    if (this.ipc && typeof this.ipc.invoke === 'function') {
      try {
        await this.ipc.invoke('presets:set-default', presetId);
      } catch (err) {
        console.error('设置默认预设失败:', err);
      }
    } else {
      for (const p of this.presets) {
        p.isDefault = p.id === presetId;
      }
    }

    await this.loadPresets();
    this.syncActiveState();
    this.toast(`已将 “${target.name}” 设为新录制默认`);
    return true;
  }

  /**
   * 删除预设
   */
  async deletePreset(presetId) {
    if (!presetId) return false;
    const target = this.presets.find((p) => p.id === presetId);
    if (!target) return false;

    const confirmed = await this.confirm(`确定要删除预设 “${target.name}” 吗？`);
    if (!confirmed) return false;

    if (this.ipc && typeof this.ipc.invoke === 'function') {
      try {
        await this.ipc.invoke('presets:delete', presetId);
      } catch (err) {
        console.error('删除预设失败:', err);
      }
    } else {
      const idx = this.presets.findIndex((p) => p.id === presetId);
      if (idx >= 0) this.presets.splice(idx, 1);
    }

    if (this.activePresetId === presetId) {
      this.activePresetId = null;
      this.isModified = false;
    }

    await this.loadPresets();
    this.syncActiveState();
    this.toast(`已删除预设 “${target.name}”`);
    return true;
  }

  /**
   * 渲染预设弹窗界面
   */
  renderModal() {
    if (!this.modal) return;

    const header = createDomElement('div', { class: 'preset-topbar' },
      createDomElement('h2', { style: 'margin:0;font-size:18px' }, '场景预设'),
      createDomElement('div', { class: 'preset-top-actions' },
        createDomElement('button', {
          class: 'btn',
          id: 'preset-save-as',
          onclick: () => this.saveAsNewPreset(),
        }, '➕ 另存为新预设'),
        this.activePresetId && this.isModified
          ? createDomElement('button', {
            class: 'btn primary',
            id: 'preset-update-active',
            onclick: () => this.updateActivePreset(),
          }, '更新此预设')
          : null
      )
    );

    const presetItems = this.presets.map((preset) => {
      const isActive = preset.id === this.activePresetId;
      const isDefault = Boolean(preset.isDefault);

      const checkmark = createDomElement('span', { class: 'preset-check' }, isActive ? '✓' : '');
      const title = createDomElement('span', { class: 'preset-title', title: '点击应用预设' }, preset.name);
      const defaultBadge = isDefault ? createDomElement('span', { class: 'preset-badge' }, '默认') : null;

      const setDefaultBtn = createDomElement('button', {
        class: 'btn ghost set-default-btn',
        title: isDefault ? '已是默认预设' : '设为新录制默认',
        disabled: isDefault,
        onclick: (e) => {
          e.stopPropagation();
          this.setDefault(preset.id);
        },
      }, isDefault ? '默认' : '设为新录制默认');

      const deleteBtn = createDomElement('button', {
        class: 'btn ghost danger delete-btn',
        title: '删除',
        onclick: (e) => {
          e.stopPropagation();
          this.deletePreset(preset.id);
        },
      }, '删除');

      const actions = createDomElement('div', { class: 'preset-actions' }, setDefaultBtn, deleteBtn);

      const item = createDomElement('div', {
        class: `preset-item ${isActive ? 'active' : ''}`,
        onclick: () => this.applyPreset(preset),
      }, checkmark, title, defaultBadge, actions);

      return item;
    });

    const list = createDomElement('div', { class: 'preset-list' }, ...presetItems);

    const closeBtn = createDomElement('button', {
      class: 'btn ghost',
      onclick: () => this.closeModal(),
    }, '关闭');

    const footer = createDomElement('div', { class: 'actions' }, closeBtn);

    const dialog = createDomElement('div', { class: 'dialog card preset-dialog' },
      header,
      list,
      footer
    );

    this.modal.replaceChildren(dialog);
  }
}

/**
 * 工厂初始化函数
 */
async function initPresetsUI(options) {
  const ui = new PresetsUI(options);
  await ui.init();
  return ui;
}

module.exports = {
  PresetsUI,
  initPresetsUI,
  createDomElement,
  createMockElement,
};
