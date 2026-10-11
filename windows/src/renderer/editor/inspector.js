'use strict';
// 右侧检查器：画面 / 运镜 / 光标 / 摄像头 / 声音。控件直接读写项目文档，拖动过程合并成一步撤销。

const path = require('node:path');
const { ipcRenderer } = require('electron');
const { element, fileUrl } = require('../common');
const { PATTERN_PRESETS, CAMERA_SHAPES, CLICK_EFFECTS, ZOOM_EASINGS, clamp } = require('../../core/model');
const { NormalizedCrop, ScreenFrameStyle, FRAME_DEFAULTS } = require('../../core/crop-frame');
const { MosaicClip, StickerClip } = require('../../core/opening-overlay');
const timeline = require('../../core/timeline');
const { planAutoZoom } = require('../../core/zoom');
const { isInside } = require('../../core/pointer');

const TABS = [
  { id: 'canvas', label: '画面', icon: 'canvas' },
  { id: 'motion', label: '运镜', icon: 'motion' },
  { id: 'opening', label: '开场', icon: 'wand' },
  { id: 'cursor', label: '光标', icon: 'cursor' },
  { id: 'camera', label: '摄像头', icon: 'camera' },
  { id: 'audio', label: '声音', icon: 'speaker' },
];

class Inspector {
  constructor(store, preview, root, title) {
    this.store = store;
    this.preview = preview;
    this.root = root;
    this.title = title;
    this.onToast = null;
    this.tab = 'canvas';
    this.canvasTab = 'background';
    this.motionMode = 'zoom';
    this.motionDisclosureOpen = false;
    this.scrollPositions = new Map();
    this.renderedContext = null;
    this.wallpapers = null;
    store.subscribe((reason) => {
      // 拖动滑块时只更新数值显示，不重建控件，否则正在拖的滑块会被换掉。
      if (reason === 'project' && store.gesture) this.refreshValues();
      else if (reason === 'project' || reason === 'selection' || reason === 'history') {
        if (reason === 'selection') {
          if (store.selection && ['sticker', 'mosaic'].includes(store.selection.type)) this.tab = 'overlays';
          else if (store.selectedScreenMotion) this.motionMode = 'screen3D';
          else if (store.selectedZoom) this.motionMode = 'zoom';
        }
        this.render();
      }
    });
    ipcRenderer.invoke('system:wallpapers').then((wallpapers) => {
      this.wallpapers = wallpapers;
      if (this.tab === 'canvas' && this.canvasTab === 'background') this.render();
    });
  }

  show(tab) {
    this.tab = tab;
    if (tab === 'motion') {
      if (this.store.selectedScreenMotion) this.motionMode = 'screen3D';
      else if (this.store.selectedZoom) this.motionMode = 'zoom';
    }
    this.render();
  }

  // ---------------------------------------------------------------- 控件

  section(title, ...children) {
    return element('div', { class: 'section' }, title ? element('h3', {}, title) : null, children);
  }

  slider(label, get, set, { min, max, step, format = (value) => String(value) }) {
    const value = element('span', { class: 'value' }, format(get()));
    const input = element('input', { type: 'range', min, max, step, value: get() });
    input.addEventListener('pointerdown', () => this.store.beginGesture());
    input.addEventListener('input', () => {
      this.store.beginGesture();
      this.store.mutate(() => set(Number(input.value)), { history: false });
    });
    // 只按下没拖动时不会有 change 事件，松手与失焦也要收尾。
    for (const type of ['change', 'pointerup', 'blur']) input.addEventListener(type, () => this.store.endGesture());
    this.refreshers.push(() => { value.textContent = format(get()); });
    return element('label', { class: 'field' }, element('span', {}, label), value, input);
  }

  toggle(label, get, set) {
    const button = element('button', { class: `switch${get() ? ' on' : ''}`, onclick: () => this.store.mutate(() => set(!get())) });
    return element('div', { class: 'field' }, element('span', {}, label), button);
  }

  select(label, options, get, set) {
    const input = element('select', {}, Object.entries(options).map(([value, text]) => element('option', { value, selected: value === String(get()) }, text)));
    input.addEventListener('change', () => this.store.mutate(() => set(input.value)));
    return element('div', { class: 'field' }, element('span', {}, label), input);
  }

  color(label, get, set) {
    const input = element('input', { type: 'color', value: get() });
    input.addEventListener('input', () => { this.store.beginGesture(); this.store.mutate(() => set(input.value.toUpperCase()), { history: false }); });
    input.addEventListener('change', () => this.store.endGesture());
    return element('div', { class: 'field' }, element('span', {}, label), input);
  }

  text(label, get, set, placeholder = '', stacked = false) {
    const input = element('input', { type: 'text', value: get() || '', placeholder });
    input.addEventListener('change', () => this.store.mutate(() => set(input.value)));
    return element('div', { class: `field${stacked ? ' field-stacked' : ''}` }, element('span', {}, label), input);
  }

  sourcePreviewBackground(sourceTime) {
    const thumbnails = this.store.project.media.thumbnails;
    if (!thumbnails) return '';
    const index = clamp(Math.floor(sourceTime / thumbnails.interval), 0, thumbnails.count - 1);
    const position = thumbnails.count > 1 ? (index / (thumbnails.count - 1)) * 100 : 0;
    return `background-image:url("${fileUrl(path.join(this.store.directory, thumbnails.file))}");background-size:${thumbnails.count * 100}% 100%;background-position:${position}% 0`;
  }

  sourceRectEditor(get, set, { title, minimumSize = 0.02 } = {}) {
    const source = this.store.project.media.screen;
    const frame = element('div', { class: 'source-frame', style: `aspect-ratio:${source.width} / ${source.height};${this.sourcePreviewBackground(this.preview.sourceTime || 0)}` });
    const windowNode = element('div', { class: 'source-rect' });
    const modes = ['top', 'right', 'bottom', 'left'];
    const handles = modes.map((mode) => element('i', { class: `source-handle ${mode}`, title: `拖动${mode === 'top' ? '上' : mode === 'right' ? '右' : mode === 'bottom' ? '下' : '左'}边` }));
    windowNode.append(...handles);
    frame.append(windowNode);

    const place = () => {
      const rect = NormalizedCrop.clamped(get(), minimumSize);
      Object.assign(windowNode.style, {
        left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`,
      });
    };
    const begin = (event, mode) => {
      event.preventDefault();
      event.stopPropagation();
      this.store.beginGesture();
      const start = NormalizedCrop.clamped(get(), minimumSize);
      const bounds = frame.getBoundingClientRect();
      const move = (moveEvent) => {
        const dx = (moveEvent.clientX - event.clientX) / bounds.width;
        const dy = (moveEvent.clientY - event.clientY) / bounds.height;
        let next = { ...start };
        if (mode === 'move') {
          next.x += dx;
          next.y += dy;
        } else if (mode === 'left') {
          next.x += dx;
          next.width -= dx;
        } else if (mode === 'right') next.width += dx;
        else if (mode === 'top') {
          next.y += dy;
          next.height -= dy;
        } else if (mode === 'bottom') next.height += dy;
        next = NormalizedCrop.clamped(next, minimumSize);
        this.store.mutate(() => set({ x: next.x, y: next.y, width: next.width, height: next.height }), { history: false });
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        this.store.endGesture();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end, { once: true });
    };
    windowNode.addEventListener('pointerdown', (event) => {
      if (event.target === windowNode) begin(event, 'move');
    });
    handles.forEach((handle, index) => handle.addEventListener('pointerdown', (event) => begin(event, modes[index])));
    this.refreshers.push(place);
    place();
    return element('div', { class: 'source-editor' }, title ? element('p', { class: 'note' }, title) : null, frame, element('p', { class: 'note' }, '在录屏源画面中拖动边缘调整范围。'));
  }

  chips(options, get, set) {
    return element('div', { class: 'chips' }, Object.entries(options).map(([value, text]) =>
      element('button', { class: value === String(get()) ? 'active' : '', onclick: () => this.store.mutate(() => set(value)) }, text)));
  }

  button(label, onClick, kind = '') {
    return element('button', { class: `btn ${kind}`, onclick: onClick }, label);
  }

  /// 二维定位板：在 0…1 的方框里拖动一个点。
  pad(get, set, { aspect, background, backgroundStyle = '', viewport }) {
    const dot = element('i');
    const view = viewport ? element('div', { class: 'view' }) : null;
    const node = element('div', { class: 'pad', style: `aspect-ratio:${aspect};${background ? `background-image:url("${background}")` : ''}${backgroundStyle}` }, view, dot);
    const place = () => {
      const point = get();
      dot.style.left = `${point.x * 100}%`;
      dot.style.top = `${point.y * 100}%`;
      if (view) {
        const rect = viewport();
        Object.assign(view.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` });
      }
    };
    const update = (event) => {
      const bounds = node.getBoundingClientRect();
      const point = { x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1), y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) };
      this.store.mutate(() => set(point), { history: false });
    };
    node.addEventListener('pointerdown', (event) => {
      node.setPointerCapture(event.pointerId);
      this.store.beginGesture();
      update(event);
      const move = (moveEvent) => update(moveEvent);
      const up = () => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        this.store.endGesture();
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
    });
    this.refreshers.push(place);
    place();
    return node;
  }

  pairedValues(title, get, set, axes) {
    return element('div', { class: 'paired-values', 'aria-label': title }, axes.map((axis) => {
      const inputScale = axis.inputScale || 1;
      const value = get()[axis.key];
      const input = element('input', {
        type: 'number', min: axis.min * inputScale, max: axis.max * inputScale,
        step: axis.step * inputScale, value: (value * inputScale).toFixed(axis.precision ?? 2),
        'aria-label': `${title} ${axis.label}`,
      });
      input.addEventListener('change', () => {
        if (input.value.trim() === '') return;
        const parsed = Number(input.value);
        if (!Number.isFinite(parsed)) return;
        const nextValue = clamp(parsed / inputScale, axis.min, axis.max);
        this.store.mutate(() => set({ ...get(), [axis.key]: nextValue }));
      });
      this.refreshers.push(() => {
        input.value = (get()[axis.key] * inputScale).toFixed(axis.precision ?? 2);
      });
      return element('label', { class: 'paired-value' },
        element('span', {}, axis.label), input,
        axis.unit ? element('span', { class: 'unit' }, axis.unit) : null);
    }));
  }

  tiltPad(get, set, { maxX = 28, maxY = 32 } = {}) {
    const surface = element('div', { class: 'tilt-surface' });
    const marker = element('i', { class: 'tilt-marker' });
    const node = element('div', { class: 'tilt-pad', role: 'img', 'aria-label': '拖动调节屏幕 3D 倾斜：上下控制 X，左右控制 Y' }, surface, marker);
    const place = () => {
      const { x, y } = get();
      const safeX = clamp(x, -maxX, maxX);
      const safeY = clamp(y, -maxY, maxY);
      marker.style.left = `${50 + safeY / maxY * 50}%`;
      marker.style.top = `${50 - safeX / maxX * 50}%`;
      surface.style.transform = `perspective(420px) rotateX(${safeX * 0.55}deg) rotateY(${safeY * 0.55}deg)`;
    };
    const update = (event) => {
      const bounds = node.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const pointX = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
      const pointY = clamp((event.clientY - bounds.top) / bounds.height, 0, 1);
      const next = { x: (0.5 - pointY) * maxX * 2, y: (pointX - 0.5) * maxY * 2 };
      this.store.mutate(() => set(next), { history: false });
      place();
    };
    node.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (node.setPointerCapture) node.setPointerCapture(event.pointerId);
      this.store.beginGesture();
      update(event);
      const move = (moveEvent) => update(moveEvent);
      const end = () => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', end);
        node.removeEventListener('pointercancel', end);
        this.store.endGesture();
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', end, { once: true });
      node.addEventListener('pointercancel', end, { once: true });
    });
    this.refreshers.push(place);
    place();
    return node;
  }

  refreshValues() { for (const refresh of this.refreshers) refresh(); }

  render() {
    this.refreshers = [];
    const tab = TABS.find((item) => item.id === this.tab) || { label: this.tab === 'overlays' ? '画面效果' : this.tab };
    this.title.textContent = tab.label;
    const context = this.tab === 'canvas' ? `canvas:${this.canvasTab}` : this.tab;
    if (this.renderedContext) this.scrollPositions.set(this.renderedContext, this.root.scrollTop);
    const scroll = context === this.renderedContext ? this.root.scrollTop : (this.scrollPositions.get(context) || 0);
    this.root.replaceChildren(...this[`${this.tab}Panel`]());
    this.root.scrollTop = scroll;
    this.renderedContext = context;
  }

  // ---------------------------------------------------------------- 面板

  canvasPanel() {
    const tabs = [
      { id: 'background', label: '背景' },
      { id: 'layout', label: '布局' },
      { id: 'mockup', label: '样机' },
    ];
    const selectTab = (id, focus = false) => {
      this.canvasTab = id;
      this.render();
      if (focus) this.root.querySelector(`[data-frame-tab="${id}"]`)?.focus();
    };
    const navigation = element('div', { class: 'frame-tabs', role: 'tablist', 'aria-label': '画面设置' }, tabs.map((tab, index) => {
      const selected = this.canvasTab === tab.id;
      return element('button', {
        class: selected ? 'active' : '', type: 'button', role: 'tab',
        id: `frame-tab-${tab.id}`, 'data-frame-tab': tab.id,
        'aria-controls': 'frame-tab-panel', 'aria-selected': selected ? 'true' : 'false',
        tabindex: selected ? '0' : '-1',
        onclick: () => selectTab(tab.id),
        onkeydown: (event) => {
          const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + offset + tabs.length) % tabs.length;
          if (offset || event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            selectTab(tabs[next].id, true);
          }
        },
      }, tab.label);
    }));
    const activeTab = tabs.find((tab) => tab.id === this.canvasTab) || tabs[0];
    const panel = element('div', {
      class: 'frame-tab-panel', id: 'frame-tab-panel', role: 'tabpanel',
      'aria-labelledby': `frame-tab-${activeTab.id}`,
    }, this[`${activeTab.id}CanvasPanel`]());
    return [navigation, panel];
  }

  backgroundCanvasPanel() {
    const { project } = this.store;
    const canvas = project.canvas;
    const background = canvas.background;
    const setBackground = (value) => this.store.mutate((draft) => { draft.canvas.background = value; });
    const patterns = Object.entries(PATTERN_PRESETS).map(([id, preset]) => element('button', {
      class: background.kind === 'pattern' && background.preset === id ? 'active' : '', title: preset.label,
      style: `background:${preset.background};background-image:${preset.kind === 'dots'
        ? `radial-gradient(${preset.dot} 1px, transparent 1.4px)` : `linear-gradient(${preset.stroke} 1px, transparent 1px), linear-gradient(90deg, ${preset.stroke} 1px, transparent 1px)`};background-size:9px 9px`,
      onclick: () => setBackground({ kind: 'pattern', preset: id }),
    }));
    const files = this.wallpapers ? [this.wallpapers.current, ...this.wallpapers.files].filter(Boolean) : [];
    const wallpapers = files.slice(0, 8).map((file, index) => element('button', {
      class: background.kind === 'image' && background.file === file ? 'active' : '', title: index === 0 && this.wallpapers.current ? '当前桌面壁纸' : path.basename(file),
      style: `background-image:url("${fileUrl(file)}")`, onclick: () => setBackground({ kind: 'image', file }),
    }));
    const pickImage = async () => {
      try {
        const asset = await ipcRenderer.invoke('project:import-asset', { directory: this.store.directory, kind: 'image' });
        if (asset) setBackground({ kind: 'image', file: asset.file, stamp: Date.now() });
      } catch (error) { if (this.onToast) this.onToast(error.message || '图片导入失败'); }
    };
    const pickVideo = async () => {
      try {
        const asset = await ipcRenderer.invoke('project:import-asset', { directory: this.store.directory, kind: 'video' });
        if (asset) setBackground({ kind: 'video', ...asset, isLooping: true });
      } catch (error) { if (this.onToast) this.onToast(error.message || '视频背景导入失败'); }
    };
    return [
      this.section('背景',
        element('div', { class: 'swatches' }, patterns),
        files.length ? element('p', { class: 'note' }, 'Windows 壁纸') : null,
        files.length ? element('div', { class: 'swatches' }, wallpapers) : null,
        element('div', { class: 'row' },
          this.button('选择图片…', pickImage),
          this.button('动态背景…', pickVideo),
          this.button('纯色', () => setBackground({ kind: 'color', color: background.color || '#1F2A44' }))),
        background.kind === 'color' ? this.color('颜色', () => background.color, (value) => { canvas.background = { kind: 'color', color: value }; }) : null,
        background.kind === 'video' ? this.toggle('循环播放', () => background.isLooping !== false, (on) => { canvas.background = { ...background, isLooping: on }; }) : null,
        background.kind === 'image' ? this.slider('背景模糊', () => canvas.backgroundBlur, (value) => { canvas.backgroundBlur = value; }, { min: 0, max: 60, step: 1 }) : null,
        background.kind === 'pattern' ? this.slider('图案大小', () => canvas.patternScale, (value) => { canvas.patternScale = value; }, { min: 0.4, max: 4, step: 0.05, format: (value) => `${value.toFixed(2)}×` }) : null,
        background.kind === 'pattern' ? this.slider('动态速度', () => canvas.patternMotion || 0, (value) => { canvas.patternMotion = value; }, { min: 0, max: 2, step: 0.05, format: (value) => value === 0 ? '关闭' : `${value.toFixed(2)}×` }) : null),
    ];
  }

  layoutCanvasPanel() {
    const { project } = this.store;
    const canvas = project.canvas;
    return [
      this.section('录屏裁切',
        this.sourceRectEditor(() => canvas.crop || NormalizedCrop.full, (value) => { canvas.crop = { ...value }; }, { title: '坐标取自录屏原画面，外框、缩放和导出比例不会改变裁切参照。' }),
        this.button('恢复完整画面', () => this.store.mutate((draft) => { draft.canvas.crop = { x: 0, y: 0, width: 1, height: 1 }; }))),
      this.section('画面留白',
        this.slider('边距', () => canvas.padding, (value) => { canvas.padding = value; }, { min: 0, max: 360, step: 2 })),
      this.section('位置与大小',
        this.pad(() => canvas.contentPosition, (point) => { canvas.contentPosition = point; }, { aspect: '16 / 9' }),
        this.slider('素材缩放', () => canvas.contentScale, (value) => { canvas.contentScale = value; }, { min: 0.25, max: 4, step: 0.01, format: (value) => `${value.toFixed(2)}×` }),
        element('div', { class: 'row' }, this.button('恢复位置与大小', () => this.store.mutate((draft) => { draft.canvas.contentPosition = { x: 0.5, y: 0.5 }; draft.canvas.contentScale = 1; })))),
      this.section('圆角、描边与阴影',
        this.slider(canvas.screenFrame && canvas.screenFrame !== 'none' ? '样机内容圆角' : '画面圆角',
          () => canvas.screenFrame && canvas.screenFrame !== 'none'
            ? (canvas.screenFrameContentCornerRadius ?? FRAME_DEFAULTS[canvas.screenFrame]?.contentRadius ?? 0)
            : canvas.cornerRadius,
          (value) => {
            if (canvas.screenFrame && canvas.screenFrame !== 'none') canvas.screenFrameContentCornerRadius = value;
            else canvas.cornerRadius = value;
          }, { min: 0, max: 160, step: 1 }),
        this.slider('外描边', () => canvas.borderWidth, (value) => { canvas.borderWidth = value; }, { min: 0, max: 40, step: 0.5 }),
        canvas.borderWidth > 0 ? this.color('描边颜色', () => canvas.borderColor, (value) => { canvas.borderColor = value; }) : null,
        this.slider('阴影', () => canvas.shadowStrength, (value) => { canvas.shadowStrength = value; }, { min: 0, max: 1, step: 0.01, format: (value) => `${Math.round(value * 100)}%` })),
    ];
  }

  mockupCanvasPanel() {
    const canvas = this.store.project.canvas;
    const current = canvas.screenFrame || 'none';
    const labels = {
      none: '无样机', windowLight: '浅色窗口', windowDark: '深色窗口',
      browserLight: '浅色浏览器', browserDark: '深色浏览器', devicePhone: '手机',
    };
    const isWindow = ScreenFrameStyle.isWindow(current);
    const isBrowser = ScreenFrameStyle.isBrowser(current);
    const hasToolbar = isWindow || isBrowser;
    const setFrame = (value) => this.store.mutate((draft) => {
      const target = draft.canvas;
      if ((target.screenFrame || 'none') === value) return;
      const styleDefaults = FRAME_DEFAULTS[value] || FRAME_DEFAULTS.none;
      target.screenFrame = value;
      target.screenFrameScale = styleDefaults.frameScale;
      target.screenFrameToolbarScale = styleDefaults.toolbarScale;
      target.screenFrameOuterCornerRadius = styleDefaults.outerRadius;
      target.screenFrameContentCornerRadius = styleDefaults.contentRadius;
      target.cornerRadius = styleDefaults.contentRadius;
      target.borderWidth = styleDefaults.borderWidth;
      target.borderColor = styleDefaults.borderColor;
      target.shadowStrength = styleDefaults.shadowStrength;
    });
    const cards = ScreenFrameStyle.ALL.map((style) => {
      const visualStyle = style.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      const browser = ScreenFrameStyle.isBrowser(style);
      const visual = element('span', { class: `mockup-visual ${visualStyle}`, 'aria-hidden': 'true' },
        element('span', { class: 'mockup-device' },
          element('span', { class: 'mockup-toolbar' },
            element('span', { class: 'mockup-dots' }, element('i'), element('i'), element('i')),
            browser ? element('span', { class: 'mockup-address-pill' }) : null),
          element('span', { class: 'mockup-content' })));
      return element('button', {
        type: 'button', class: `mockup-option${style === current ? ' active' : ''}`,
        'aria-pressed': style === current ? 'true' : 'false', 'aria-label': labels[style], title: labels[style],
        onclick: () => setFrame(style),
      }, visual, element('span', { class: 'mockup-label' }, labels[style]));
    });
    const defaults = FRAME_DEFAULTS[current] || FRAME_DEFAULTS.none;
    return [
      this.section('样机',
        element('p', { class: 'note' }, '选择外框样式；样机内容会沿用当前录屏画面。'),
        element('div', { class: 'mockup-grid' }, cards),
        isBrowser ? this.text('浏览器地址', () => canvas.screenFrameBrowserAddress, (value) => { canvas.screenFrameBrowserAddress = value; }, 'https://example.com', true) : null,
        isWindow || isBrowser ? this.text('窗口标题', () => canvas.screenFrameTitle, (value) => { canvas.screenFrameTitle = value; }, '项目演示', true) : null,
        current !== 'none' ? this.slider('框体比例', () => canvas.screenFrameScale ?? defaults.frameScale, (value) => { canvas.screenFrameScale = value; }, { min: 0.6, max: 1.6, step: 0.01, format: (value) => `${value.toFixed(2)}×` }) : null,
        current !== 'none' && hasToolbar ? this.slider('顶栏高度', () => canvas.screenFrameToolbarScale ?? defaults.toolbarScale, (value) => { canvas.screenFrameToolbarScale = value; }, { min: 0.65, max: 1.6, step: 0.01, format: (value) => `${value.toFixed(2)}×` }) : null,
        current !== 'none' ? this.slider('框体外圆角', () => canvas.screenFrameOuterCornerRadius ?? defaults.outerRadius, (value) => { canvas.screenFrameOuterCornerRadius = value; }, { min: 0, max: 160, step: 1 }) : null)
    ];
  }

  openingPanel() {
    const project = this.store.project;
    const sequence = project.openingSequence;
    const presets = { converge: '聚拢', sideSlide: '侧滑', light3D: '轻 3D' };
    const curves = { swift: '利落', smooth: '平滑', gentle: '柔和' };
    const elements = { screen: '屏幕', camera: '摄像头', stickers: '贴图' };
    const included = new Set(sequence.includedElements || []);
    return [
      this.section('全局开场',
        element('p', { class: 'note' }, '开场从成片的 0 秒开始，剪掉录屏前段后也会保持在成片开头。'),
        this.toggle('启用开场', () => sequence.isEnabled, (on) => { sequence.isEnabled = on; }),
        sequence.isEnabled ? this.chips(presets, () => sequence.preset, (value) => { sequence.preset = value; }) : null,
        sequence.isEnabled ? this.select('动效曲线', curves, () => sequence.motionCurve, (value) => { sequence.motionCurve = value; }) : null,
        sequence.isEnabled ? this.slider('开场时长', () => sequence.duration, (value) => { sequence.duration = value; sequence.stagger = Math.min(sequence.stagger, Math.max(0, sequence.duration - 0.18)); }, { min: 0.4, max: 8, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }) : null,
        sequence.isEnabled ? this.slider('元素错开', () => sequence.stagger, (value) => { sequence.stagger = clamp(value, 0, Math.min(1.2, Math.max(0, sequence.duration - 0.18))); }, { min: 0, max: 1.2, step: 0.02, format: (value) => `${value.toFixed(2)} 秒` }) : null,
        sequence.isEnabled ? element('div', { class: 'chips' }, Object.entries(elements).map(([value, label]) => element('button', {
          class: included.has(value) ? 'active' : '', onclick: () => {
            this.store.mutate((draft) => {
              const next = new Set(draft.openingSequence.includedElements || []);
              if (next.has(value)) next.delete(value); else next.add(value);
              draft.openingSequence.includedElements = [...next];
              draft.openingSequence.stagger = Math.min(draft.openingSequence.stagger, Math.max(0, draft.openingSequence.duration - 0.18));
            });
          },
        }, label))) : null),
    ];
  }

  requestEffect(kind) {
    if (this.timelineView && typeof this.timelineView.onAddEffect === 'function') return this.timelineView.onAddEffect(kind, this.preview.time);
  }

  async importSticker(kind, filePath = null) {
    const located = timeline.locate(this.store.project.timeline.segments, this.preview.time);
    const startTime = located ? located.sourceTime : 0;
    const duration = Math.min(3, this.store.project.media.screen.duration - startTime);
    if (duration < 0.1) {
      if (this.onToast) this.onToast('播放头离素材末尾太近，无法添加贴图');
      return;
    }
    let asset;
    const request = { directory: this.store.directory, kind };
    if (filePath) request.file = filePath;
    try { asset = await ipcRenderer.invoke('project:import-asset', request); }
    catch (error) { if (this.onToast) this.onToast(error.message || '贴图导入失败'); return; }
    if (!asset) return;
    const clip = new StickerClip({
      relativePath: asset.file,
      aspectRatio: asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 1,
      timing: { startTime, duration },
    });
    this.store.mutate((draft) => { draft.timeline.stickerClips.push(JSON.parse(JSON.stringify(clip))); });
    this.store.select({ type: 'sticker', id: clip.id });
    this.show('overlays');
    try {
      await this.preview.compositor.prepare(this.store.project);
      this.preview.invalidate();
    } catch (error) { if (this.onToast) this.onToast(error.message || '贴图预载失败'); }
  }

  overlaysPanel() {
    const mosaic = this.store.selectedMosaic;
    const sticker = this.store.selectedSticker;
    const curves = { swift: '利落', smooth: '平滑', gentle: '柔和' };
    const sourceTime = (clip) => clip?.timing?.startTime ?? 0;
    const clipActions = (kind, clip) => element('div', { class: 'row' },
      element('button', {
        class: 'btn', title: 'Ctrl+C 复制；Ctrl+V 粘贴片段；Ctrl+Shift+V 粘贴属性',
        onclick: () => this.onCopyClip && this.onCopyClip(kind, clip),
      }, '复制效果'),
      this.button('删除效果', () => {
        this.store.mutate((draft) => { draft.timeline[`${kind}Clips`] = draft.timeline[`${kind}Clips`].filter((item) => item.id !== clip.id); });
        this.store.select(null);
      }, 'danger'));
    const sections = [];
    if (mosaic) {
      sections.unshift(this.section('选中的区域效果',
        this.chips({ blur: '柔化', spotlight: '聚光' }, () => mosaic.style, (value) => { mosaic.style = value; }),
        this.sourceRectEditor(() => mosaic.sourceRect, (value) => { mosaic.sourceRect = { ...value }; }, { title: '区域以录屏源画面为参照，适用于柔化与聚光。' }),
        this.slider('区域圆角', () => mosaic.cornerRadius, (value) => { mosaic.cornerRadius = value; }, { min: 0, max: 0.5, step: 0.01, format: (value) => `${Math.round(value * 100)}%` }),
        mosaic.style === 'blur' ? this.slider('柔化强度', () => mosaic.intensity, (value) => { mosaic.intensity = value; }, { min: 0, max: 1, step: 0.01, format: (value) => `${Math.round(value * 100)}%` }) : null,
        mosaic.style === 'spotlight' ? this.slider('周围压暗', () => mosaic.spotlightDimming, (value) => { mosaic.spotlightDimming = value; }, { min: 0, max: 0.85, step: 0.01, format: (value) => `${Math.round(value * 100)}%` }) : null,
        this.select('过渡曲线', { none: '立即显示', linear: '线性', smooth: '柔和' }, () => mosaic.transitionStyle || (mosaic.style === 'spotlight' ? 'smooth' : 'none'), (value) => { mosaic.transitionStyle = value; }),
        this.slider('进入过渡', () => mosaic.transitionInDuration, (value) => { mosaic.transitionInDuration = value; }, { min: 0, max: 1.5, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
        this.slider('退出过渡', () => mosaic.transitionOutDuration, (value) => { mosaic.transitionOutDuration = value; }, { min: 0, max: 1.5, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
        this.slider('播放时长', () => mosaic.timing.duration, (value) => { mosaic.timing.duration = value; }, { min: 0.1, max: Math.max(0.1, this.store.project.media.screen.duration - sourceTime(mosaic)), step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
        clipActions('mosaic', mosaic)));
    }
    if (sticker) {
      const stickerAnimations = {
        none: '无', fade: '淡入', pop: '弹入', slideLeft: '从左滑入', slideRight: '从右滑入',
        slideUp: '从下滑入', slideDown: '从上滑入', slideTopLeft: '从左上滑入', slideTopRight: '从右上滑入',
        slideBottomLeft: '从左下滑入', slideBottomRight: '从右下滑入',
      };
      const exitAnimations = { automatic: '跟随入场', ...stickerAnimations };
      sections.unshift(this.section('选中的贴图',
        element('p', { class: 'note' }, sticker.relativePath || '贴图文件缺失'),
        this.slider('录屏虚化', () => sticker.backdropBlur ?? 20, (value) => { sticker.backdropBlur = value; }, { min: 0, max: 60, step: 1, format: (value) => `${Math.round(value)}` }),
        this.toggle('仅作背景', () => sticker.hidesScreen, (on) => { sticker.hidesScreen = on; }),
        (sticker.backdropBlur ?? 20) > 0.01 ? this.toggle('同时虚化摄像头', () => sticker.backdropBlurIncludesCamera, (on) => { sticker.backdropBlurIncludesCamera = on; }) : null,
        this.pad(() => sticker.position, (point) => { sticker.position = point; }, {
          aspect: `${this.store.project.canvas.aspectRatio === 'portrait' ? 9 : 16} / ${this.store.project.canvas.aspectRatio === 'portrait' ? 16 : 9}`,
          backgroundStyle: this.sourcePreviewBackground(sourceTime(sticker)),
        }),
        this.slider('宽度', () => sticker.width, (value) => { sticker.width = value; }, { min: 0.05, max: 0.95, step: 0.01, format: (value) => `${Math.round(value * 100)}%` }),
        this.slider('旋转', () => sticker.rotationDegrees, (value) => { sticker.rotationDegrees = value; }, { min: -180, max: 180, step: 1, format: (value) => `${Math.round(value)}°` }),
        this.slider('不透明度', () => sticker.opacity, (value) => { sticker.opacity = value; }, { min: 0.05, max: 1, step: 0.01, format: (value) => `${Math.round(value * 100)}%` }),
        this.select('入场方式', stickerAnimations, () => sticker.animation || 'pop', (value) => { sticker.animation = value; }),
        this.select('退场方式', exitAnimations, () => sticker.exitAnimation || 'automatic', (value) => { sticker.exitAnimation = value === 'automatic' ? null : value; }),
        this.select('缓动', curves, () => sticker.animationCurve || 'swift', (value) => { sticker.animationCurve = value; }),
        this.slider('进入过渡', () => sticker.enterDuration, (value) => { sticker.enterDuration = value; }, { min: 0, max: 2, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
        this.slider('退出过渡', () => sticker.exitDuration, (value) => { sticker.exitDuration = value; }, { min: 0, max: 2, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
        this.slider('播放时长', () => sticker.timing.duration, (value) => { sticker.timing.duration = value; }, { min: 0.1, max: Math.max(0.1, this.store.project.media.screen.duration - sourceTime(sticker)), step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
        this.toggle('遮住摄像头', () => sticker.hidesCamera, (on) => { sticker.hidesCamera = on; }),
        clipActions('sticker', sticker)));
    }
    if (!sections.length) sections.push(this.section('', element('p', { class: 'note' }, '从时间线选中一段贴图或柔化效果后，可在这里编辑。通过预览区左上角的“+”添加画面效果。')));
    return sections;
  }

  motionModeSelector() {
    const options = [{ id: 'zoom', label: '缩放' }, { id: 'screen3D', label: '屏幕 3D' }];
    return element('div', { class: 'chips motion-mode', role: 'group', 'aria-label': '运镜类型' }, options.map((option) => {
      const selected = this.motionMode === option.id;
      return element('button', {
        type: 'button', class: selected ? 'active' : '', 'aria-pressed': selected ? 'true' : 'false',
        onclick: () => {
          if (this.motionMode === option.id) return;
          this.motionMode = option.id;
          const selection = this.store.selection;
          const switchesSelectedClip = (option.id === 'screen3D' && selection?.type === 'zoom')
            || (option.id === 'zoom' && selection?.type === 'screen');
          if (switchesSelectedClip) this.store.select(null);
          else this.render();
        },
      }, option.label);
    }));
  }

  motionPanel() {
    const { project, pointerTrack } = this.store;
    const motion = project.motion;
    const modeSelector = this.motionModeSelector();

    if (this.motionMode === 'screen3D') {
      const screenMotion = this.store.selectedScreenMotion;
      if (!screenMotion) {
        const count = project.timeline.screenMotionClips.length;
        return [modeSelector, this.section('屏幕 3D',
          element('p', { class: 'note' }, count
            ? `时间线上已有 ${count} 段屏幕 3D 动画。选中片段后可调整构图、倾斜和透视。`
            : '在时间线「屏幕 3D」轨双击添加一段动画，再设置目标构图与姿态。'),
          this.button('在播放头添加屏幕 3D', () => this.requestEffect('screen')))];
      }

      const target = screenMotion.target;
      const timing = screenMotion.timing;
      const source = project.media.screen;
      const position = () => target.position || { x: 0.5, y: 0.5 };
      const planeDisclosure = element('details', { class: 'disclosure', open: this.motionDisclosureOpen },
        element('summary', {}, '平面旋转与透视'),
        this.slider('平面旋转', () => target.rotationZ ?? 0, (value) => { target.rotationZ = value; }, { min: -30, max: 30, step: 0.1, format: (value) => `${value.toFixed(1)}°` }),
        this.slider('透视强度', () => target.perspective ?? 0.65, (value) => { target.perspective = value; }, { min: 0, max: 2, step: 0.01, format: (value) => value.toFixed(2) }));
      planeDisclosure.addEventListener('toggle', () => { this.motionDisclosureOpen = planeDisclosure.open; });
      return [
        modeSelector,
        this.section('构图锚点',
          element('p', { class: 'note' }, '放大时画面从锚点向外展开；缩小时向锚点收拢。拖动设置位置，也可输入 X / Y。'),
          this.pad(position, (point) => { target.position = { ...point }; }, {
            aspect: `${source.width} / ${source.height}`,
            backgroundStyle: this.sourcePreviewBackground(timing.startTime),
          }),
          this.pairedValues('构图锚点', position, (point) => { target.position = { ...point }; }, [
            { key: 'x', label: 'X', min: 0, max: 1, step: 0.01, inputScale: 100, precision: 0, unit: '%' },
            { key: 'y', label: 'Y', min: 0, max: 1, step: 0.01, inputScale: 100, precision: 0, unit: '%' },
          ]),
          this.slider('目标大小', () => target.scale ?? 1, (value) => { target.scale = value; }, { min: 0.25, max: 4, step: 0.01, format: (value) => `${value.toFixed(2)}×` })),
        this.section('3D 倾斜',
          element('div', { class: 'tilt-editor' },
            element('div', { class: 'tilt-editor-head' },
              element('span', {}, '上下控制 X · 左右控制 Y'),
              this.button('归零', () => this.store.mutate(() => { target.rotationX = 0; target.rotationY = 0; }))),
            this.tiltPad(() => ({ x: target.rotationX ?? 0, y: target.rotationY ?? 0 }), (angles) => {
              target.rotationX = angles.x;
              target.rotationY = angles.y;
            }),
            this.pairedValues('3D 倾斜角度', () => ({ x: target.rotationX ?? 0, y: target.rotationY ?? 0 }), (angles) => {
              target.rotationX = angles.x;
              target.rotationY = angles.y;
            }, [
              { key: 'x', label: 'X', min: -28, max: 28, step: 0.1, precision: 1, unit: '°' },
              { key: 'y', label: 'Y', min: -32, max: 32, step: 0.1, precision: 1, unit: '°' },
            ]))),
        planeDisclosure,
        this.section('动画时间',
          this.slider('源时间', () => timing.startTime, (value) => { timing.startTime = value; }, { min: 0, max: source.duration, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
          this.slider('动效时长', () => timing.duration, (value) => { timing.duration = value; }, { min: 0.1, max: Math.max(0.1, source.duration - timing.startTime), step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
          this.slider('进入过渡', () => timing.leadInDuration ?? timing.duration, (value) => { timing.leadInDuration = value; timing.enterDuration = value; }, { min: 0, max: 5, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
          this.slider('退出过渡', () => timing.returnDuration ?? 0, (value) => { timing.returnDuration = value; timing.exitDuration = value; }, { min: 0, max: 5, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
          this.select('缓动', ZOOM_EASINGS, () => timing.easing || 'cubic', (value) => { timing.easing = value; }),
          this.button('删除屏幕 3D 动画', () => {
            this.store.mutate((draft) => { draft.timeline.screenMotionClips = draft.timeline.screenMotionClips.filter((item) => item.id !== screenMotion.id); });
            this.store.select(null);
          }, 'danger')),
      ];
    }

    const clip = this.store.selectedZoom;
    const clicks = pointerTrack ? pointerTrack.clicks.filter(isInside).length : 0;
    const regenerate = () => this.store.mutate((draft) => {
      const manual = draft.zoomAnimations.filter((item) => item.origin === 'manual');
      const automatic = planAutoZoom(pointerTrack.events.filter(isInside), {
        zoomScale: draft.motion.defaultZoomScale, easing: draft.motion.defaultZoomEasing,
        transitionDuration: draft.motion.defaultZoomTransitionDuration, duration: draft.media.screen.duration,
      // 手动缩放优先：与手动片段重叠的自动片段不生成。
      }).filter((item) => !manual.some((other) => item.startTime < other.endTime + other.exitDuration && other.startTime < item.endTime + item.exitDuration));
      draft.zoomAnimations = [...manual, ...automatic];
    });
    const sections = [modeSelector];
    if (clip) {
      const source = project.media.screen;
      const thumbnails = project.media.thumbnails;
      const clipSection = this.section(`选中的缩放 · ${clip.origin === 'automatic' ? '自动跟随' : '手动'}`,
        this.slider('放大倍率', () => clip.scale, (value) => { clip.scale = value; }, { min: 1.1, max: 4, step: 0.05, format: (value) => `${value.toFixed(2)}×` }),
        element('p', { class: 'note' }, clip.origin === 'automatic' ? '自动缩放会跟随指针。在下面的画面里点一下，可改成固定构图。' : '点击或拖动下面的画面，指定镜头对准的位置。'),
        this.pad(() => clip.focus, (point) => { clip.focus = point; clip.origin = 'manual'; }, {
          aspect: `${source.width} / ${source.height}`,
          background: null,
          viewport: () => {
            const span = 1 / clip.scale;
            return { x: clamp(clip.focus.x - span / 2, 0, 1 - span), y: clamp(clip.focus.y - span / 2, 0, 1 - span), width: span, height: span };
          },
        }),
        this.pairedValues('缩放焦点', () => clip.focus, (point) => { clip.focus = point; clip.origin = 'manual'; }, [
          { key: 'x', label: 'X', min: 0, max: 1, step: 0.01, inputScale: 100, precision: 0, unit: '%' },
          { key: 'y', label: 'Y', min: 0, max: 1, step: 0.01, inputScale: 100, precision: 0, unit: '%' },
        ]),
        this.select('缓动', ZOOM_EASINGS, () => clip.easing, (value) => { clip.easing = value; }),
        this.slider('进入时长', () => clip.enterDuration, (value) => { clip.enterDuration = value; }, { min: 0, max: 2, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
        this.slider('退出时长', () => clip.exitDuration, (value) => { clip.exitDuration = value; }, { min: 0, max: 2, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
        element('div', { class: 'row' },
          clip.origin === 'manual' && pointerTrack ? this.button('改回自动跟随', () => this.store.mutate(() => { clip.origin = 'automatic'; })) : null,
          this.button('删除这段缩放', () => { this.store.mutate((draft) => { draft.zoomAnimations = draft.zoomAnimations.filter((item) => item.id !== clip.id); }); this.store.select(null); }, 'danger')));
      sections.push(clipSection);
      if (thumbnails) {
        const index = clamp(Math.floor(clip.startTime / thumbnails.interval), 0, thumbnails.count - 1);
        const pad = clipSection.querySelector('.pad');
        pad.style.backgroundImage = `url("${fileUrl(path.join(this.store.directory, thumbnails.file))}")`;
        pad.style.backgroundSize = `${thumbnails.count * 100}% 100%`;
        pad.style.backgroundPosition = `${thumbnails.count > 1 ? (index / (thumbnails.count - 1)) * 100 : 0}% 0`;
      }
    } else {
      sections.push(this.section('缩放', element('p', { class: 'note' }, '在时间线「缩放」轨上点选片段后编辑；双击轨道空白处或按 Z，在播放头位置添加手动缩放。')));
    }
    sections.push(this.section('自动缩放',
      element('p', { class: 'note' }, pointerTrack
        ? `这次录制记录到 ${clicks} 次点击。自动缩放会在点击处放大，并在连续操作时保持、跟随指针。`
        : '这个项目没有指针记录，无法自动生成缩放，可以手动添加。'),
      this.slider('默认放大倍率', () => motion.defaultZoomScale, (value) => { motion.defaultZoomScale = value; }, { min: 1.1, max: 3, step: 0.05, format: (value) => `${value.toFixed(2)}×` }),
      this.slider('过渡时长', () => motion.defaultZoomTransitionDuration, (value) => { motion.defaultZoomTransitionDuration = value; }, { min: 0.1, max: 2, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
      this.select('缓动', ZOOM_EASINGS, () => motion.defaultZoomEasing, (value) => { motion.defaultZoomEasing = value; }),
      element('div', { class: 'row' },
        pointerTrack && clicks ? this.button('按点击重新生成', regenerate) : null,
        project.zoomAnimations.length ? this.button('清除全部缩放', () => { this.store.mutate((draft) => { draft.zoomAnimations = []; }); this.store.select(null); }, 'danger') : null)));
    return sections;
  }

  cursorPanel() {
    const { project, pointerTrack } = this.store;
    const style = project.cursorStyle;
    if (!pointerTrack) return [this.section('光标', element('p', { class: 'note' }, '这个项目没有指针记录。'))];
    return [
      this.section('样式',
        this.chips({ automatic: '跟随录制', arrow: '箭头', pointingHand: '手型', hidden: '隐藏' }, () => style.appearance, (value) => { style.appearance = value; }),
        this.slider('大小', () => style.size, (value) => { style.size = value; }, { min: 0.5, max: 4, step: 0.05, format: (value) => `${value.toFixed(2)}×` }),
        this.toggle('移动平滑', () => project.motion.cursor === 'smooth', (on) => { project.motion.cursor = on ? 'smooth' : 'none'; }),
        this.toggle('静止后隐藏', () => style.hideWhenIdle, (on) => { style.hideWhenIdle = on; }),
        style.hideWhenIdle ? this.slider('静止多久后隐藏', () => style.idleDelay, (value) => { style.idleDelay = value; }, { min: 0.2, max: 5, step: 0.1, format: (value) => `${value.toFixed(1)} 秒` }) : null),
      this.section('点击反馈',
        this.select('效果', Object.fromEntries(Object.entries(CLICK_EFFECTS).map(([id, effect]) => [id, effect.label])), () => style.clickEffectStyle, (value) => { style.clickEffectStyle = value; }),
        style.clickEffectStyle !== 'none' ? this.color('颜色', () => style.clickColor || '#FFFFFF', (value) => { style.clickColor = value; }) : null,
        style.clickEffectStyle !== 'none' ? this.slider('不透明度', () => style.clickOpacity, (value) => { style.clickOpacity = value; }, { min: 0.05, max: 1, step: 0.01, format: (value) => `${Math.round(value * 100)}%` }) : null,
        style.clickEffectStyle !== 'none' ? this.slider('大小', () => style.clickScale, (value) => { style.clickScale = value; }, { min: 0.4, max: 3, step: 0.05, format: (value) => `${value.toFixed(2)}×` }) : null),
      this.section('时间校准',
        element('p', { class: 'note' }, '光标比画面早或晚时在这里微调，不影响移动平滑。正值让光标更早出现。'),
        this.slider('光标时间', () => style.timeOffset, (value) => { style.timeOffset = value; }, { min: -0.5, max: 0.5, step: 0.005, format: (value) => `${value > 0 ? '+' : ''}${Math.round(value * 1000)} 毫秒` })),
    ];
  }

  cameraPanel() {
    const { project } = this.store;
    const camera = project.camera;
    if (!project.media.camera) return [this.section('摄像头', element('p', { class: 'note' }, '这次录制没有开摄像头。在录制条上打开摄像头后再录，摄像头画面会作为单独一轨进入项目。'))];
    const cameraMotion = this.store.selectedCameraMotion;
    const sections = [];
    if (cameraMotion) {
      const target = cameraMotion.target;
      const timing = cameraMotion.timing;
      sections.push(this.section('选中的摄像头动效',
        this.select('目标布局', { shape: '画中画', fullscreen: '全屏' }, () => target.layout || 'shape', (value) => { target.layout = value; }),
        this.chips(Object.fromEntries(Object.entries(CAMERA_SHAPES).map(([id, shape]) => [id, shape.label])), () => target.shape, (value) => { target.layout = 'shape'; target.shape = value; }),
        this.pad(() => target.position, (point) => { target.position = point; }, { aspect: `${project.media.camera.width} / ${project.media.camera.height}` }),
        this.slider('目标大小', () => target.size, (value) => { target.size = value; }, { min: 0.08, max: 1, step: 0.01, format: (value) => `${Math.round(value * 100)}%` }),
        this.slider('源时间', () => timing.startTime, (value) => { timing.startTime = value; }, { min: 0, max: project.media.screen.duration, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
        this.slider('动效时长', () => timing.duration, (value) => { timing.duration = value; }, { min: 0.1, max: Math.max(0.1, project.media.screen.duration - timing.startTime), step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
        this.slider('进入过渡', () => timing.leadInDuration, (value) => { timing.leadInDuration = value; timing.enterDuration = value; }, { min: 0, max: 5, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
        this.slider('退出过渡', () => timing.returnDuration, (value) => { timing.returnDuration = value; timing.exitDuration = value; }, { min: 0, max: 5, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
        this.select('缓动', ZOOM_EASINGS, () => timing.easing || 'cubic', (value) => { timing.easing = value; }),
        this.button('删除摄像头动效', () => { this.store.mutate((draft) => { draft.timeline.cameraMotionClips = draft.timeline.cameraMotionClips.filter((item) => item.id !== cameraMotion.id); }); this.store.select(null); }, 'danger')));
    }
    sections.push(
      this.section('显示',
        this.toggle('显示摄像头', () => !camera.isHidden, (on) => { camera.isHidden = !on; }),
        this.toggle('镜像', () => camera.isMirrored, (on) => { camera.isMirrored = on; })),
      this.section('形状与大小',
        this.chips(Object.fromEntries(Object.entries(CAMERA_SHAPES).map(([id, shape]) => [id, shape.label])), () => camera.shape, (value) => { camera.shape = value; }),
        this.slider('大小', () => camera.size, (value) => { camera.size = value; }, { min: 0.1, max: 1, step: 0.01, format: (value) => `${Math.round(value * 100)}%` }),
        camera.shape !== 'circle' ? this.slider('圆角', () => camera.roundness, (value) => { camera.roundness = value; }, { min: 0, max: 1, step: 0.01, format: (value) => `${Math.round(value * 100)}%` }) : null,
        this.slider('屏幕放大时', () => camera.scaleDuringZoom, (value) => { camera.scaleDuringZoom = value; }, { min: 0.3, max: 1, step: 0.01, format: (value) => `缩到 ${Math.round(value * 100)}%` })),
      this.section('位置',
        this.pad(() => camera.position, (point) => { camera.position = point; }, { aspect: '16 / 9' }),
        this.chips({ 'tl': '左上', 'tr': '右上', 'bl': '左下', 'br': '右下' }, () => '', (value) => {
          camera.position = { x: value[1] === 'l' ? 0.04 : 0.96, y: value[0] === 't' ? 0.06 : 0.94 };
        })),
      this.section('描边与阴影',
        this.slider('描边', () => camera.borderWidth, (value) => { camera.borderWidth = value; }, { min: 0, max: 18, step: 0.5 }),
        this.slider('阴影', () => camera.shadowStrength, (value) => { camera.shadowStrength = value; }, { min: 0, max: 1, step: 0.01, format: (value) => `${Math.round(value * 100)}%` })),
      this.section('摄像头内部取景',
        element('p', { class: 'note' }, '调整摄像画面在外框中的缩放与中心位置，不会移动外框。'),
        this.pad(() => camera.contentPosition || { x: 0.5, y: 0.5 }, (point) => { camera.contentPosition = { ...point }; }, { aspect: `${project.media.camera.width} / ${project.media.camera.height}` }),
        this.slider('画面缩放', () => camera.contentScale ?? 1, (value) => { camera.contentScale = value; }, { min: 0.5, max: 2, step: 0.01, format: (value) => `${value.toFixed(2)}×` }),
        this.button('恢复内部取景', () => this.store.mutate((draft) => { draft.camera.contentPosition = { x: 0.5, y: 0.5 }; draft.camera.contentScale = 1; }))),
      this.section('摄像头动效轨',
        element('p', { class: 'note' }, '在时间线「摄像运镜」轨双击添加一段动效。'),
        this.button('在播放头添加摄像头动效', () => this.requestEffect('camera'))));
    return sections;
  }

  audioPanel() {
    const { project } = this.store;
    const audio = project.audio;
    const percent = (value) => `${Math.round(value * 100)}%`;
    const track = (title, present, mutedKey, volumeKey, missing) => this.section(title, ...(present ? [
      this.toggle('静音', () => audio[mutedKey], (on) => { audio[mutedKey] = on; }),
      this.slider('音量', () => audio[volumeKey], (value) => { audio[volumeKey] = value; }, { min: 0, max: 1, step: 0.01, format: percent }),
    ] : [element('p', { class: 'note' }, missing)]));
    const sections = [
      track('麦克风', project.media.microphone, 'isMicrophoneMuted', 'microphoneVolume', '这次录制没有录麦克风。'),
      track('系统声音', project.media.systemAudio, 'isSystemMuted', 'systemVolume', '这次录制没有录系统声音。'),
    ];
    const segment = this.store.selectedSegment;
    if (segment) {
      const effective = (key) => Object.prototype.hasOwnProperty.call(segment.audio || {}, key) ? segment.audio[key] : project.audio[key];
      const status = (keys) => {
        const node = element('span', { class: 'note' });
        const refresh = () => {
          const current = this.store.selectedSegment?.audio || {};
          node.textContent = keys.some((key) => Object.prototype.hasOwnProperty.call(current, key)) ? '片段独立' : '继承全局';
        };
        this.refreshers.push(refresh);
        refresh();
        return node;
      };
      const writeOverride = (key, value) => this.store.mutate((draft) => {
        const target = draft.timeline.segments.find((item) => item.id === segment.id);
        if (target) target.audio = { ...(target.audio || {}), [key]: value };
      });
      sections.push(this.section('选中片段的独立音量',
        element('p', { class: 'note' }, '只影响当前录屏片段；未覆盖的项目会继续继承全局声音设置。'),
        project.media.microphone ? element('div', { class: 'audio-override' },
          element('b', {}, '麦克风'),
          status(['microphoneVolume', 'isMicrophoneMuted']),
          this.toggle('静音', () => Boolean(effective('isMicrophoneMuted')), (on) => writeOverride('isMicrophoneMuted', on)),
          this.slider('音量', () => effective('microphoneVolume'), (value) => writeOverride('microphoneVolume', value), { min: 0, max: 1, step: 0.01, format: percent })) : null,
        project.media.systemAudio ? element('div', { class: 'audio-override' },
          element('b', {}, '系统声音'),
          status(['systemVolume', 'isSystemMuted']),
          this.toggle('静音', () => Boolean(effective('isSystemMuted')), (on) => writeOverride('isSystemMuted', on)),
          this.slider('音量', () => effective('systemVolume'), (value) => writeOverride('systemVolume', value), { min: 0, max: 1, step: 0.01, format: percent })) : null,
        this.button('恢复继承全局设置', () => this.store.mutate((draft) => {
          const target = draft.timeline.segments.find((item) => item.id === segment.id);
          if (target) delete target.audio;
        }))));
    } else {
      sections.push(this.section('片段音量', element('p', { class: 'note' }, '在时间线上选中一段录屏后，可单独调整该段麦克风和系统声音。')));
    }
    return sections;
  }
}

module.exports = { Inspector, TABS };
