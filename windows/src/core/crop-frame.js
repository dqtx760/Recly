'use strict';
// 屏幕裁切与外框样式：归一化裁切区域、源像素裁切计算、外框样式及装饰布局。
// 移植自 Sources/RecorderCore/ProjectModel.swift、ScreenFrameDefaults.swift、
// CompositionScene.swift 与 FrameScene.swift。

/**
 * 归一化裁切矩形（基于源画面左上角坐标系统 [0, 1]）。
 * 保证裁切在改变画布比例或导出分辨率时保持稳定。
 */
class NormalizedCrop {
  constructor(x = 0, y = 0, width = 1, height = 1) {
    this.x = Number.isFinite(x) ? x : 0;
    this.y = Number.isFinite(y) ? y : 0;
    this.width = Number.isFinite(width) ? width : 1;
    this.height = Number.isFinite(height) ? height : 1;
  }

  static get full() {
    return new NormalizedCrop(0, 0, 1, 1);
  }

  static get DEFAULT() {
    return new NormalizedCrop(0, 0, 1, 1);
  }

  get left() {
    return this.x;
  }

  get top() {
    return this.y;
  }

  get right() {
    return 1 - this.x - this.width;
  }

  get bottom() {
    return 1 - this.y - this.height;
  }

  /**
   * 将裁切范围限制在有效 [0, 1] 空间内，保证最小宽高。
   * @param {Object} [crop]
   * @param {number} [minimumSize=0.02]
   * @returns {NormalizedCrop}
   */
  static clamped(crop = {}, minimumSize = 0.02) {
    const minSize = Math.min(Math.max(Number.isFinite(minimumSize) ? minimumSize : 0.02, 0.001), 1);
    const rawX = Number.isFinite(crop.x) ? crop.x : 0;
    const rawY = Number.isFinite(crop.y) ? crop.y : 0;
    const rawW = Number.isFinite(crop.width) ? crop.width : 1;
    const rawH = Number.isFinite(crop.height) ? crop.height : 1;

    const safeX = Math.min(Math.max(rawX, 0), 1 - minSize);
    const safeY = Math.min(Math.max(rawY, 0), 1 - minSize);
    const width = Math.min(Math.max(rawW, minSize), 1 - safeX);
    const height = Math.min(Math.max(rawH, minSize), 1 - safeY);

    return new NormalizedCrop(safeX, safeY, width, height);
  }

  clamped(minimumSize = 0.02) {
    return NormalizedCrop.clamped(this, minimumSize);
  }

  /**
   * 基于四边留白比率构建归一化裁切。
   * @param {number} left
   * @param {number} right
   * @param {number} top
   * @param {number} bottom
   * @param {number} [minimumSize=0.02]
   * @returns {NormalizedCrop}
   */
  static fromEdges(left = 0, right = 0, top = 0, bottom = 0, minimumSize = 0.02) {
    const minSize = Math.min(Math.max(Number.isFinite(minimumSize) ? minimumSize : 0.02, 0.001), 1);
    const safeLeft = Math.min(Math.max(Number.isFinite(left) ? left : 0, 0), 1 - minSize);
    const safeTop = Math.min(Math.max(Number.isFinite(top) ? top : 0, 0), 1 - minSize);
    const safeRight = Math.min(Math.max(Number.isFinite(right) ? right : 0, 0), 1 - safeLeft - minSize);
    const safeBottom = Math.min(Math.max(Number.isFinite(bottom) ? bottom : 0, 0), 1 - safeTop - minSize);

    return new NormalizedCrop(
      safeLeft,
      safeTop,
      Math.max(1 - safeLeft - safeRight, minSize),
      Math.max(1 - safeTop - safeBottom, minSize)
    );
  }

  /**
   * 转换为四边留白比率。
   * @param {Object} [crop]
   * @returns {{ left: number, right: number, top: number, bottom: number }}
   */
  static toEdges(crop) {
    const c = crop || { x: 0, y: 0, width: 1, height: 1 };
    const x = Number.isFinite(c.x) ? c.x : 0;
    const y = Number.isFinite(c.y) ? c.y : 0;
    const w = Number.isFinite(c.width) ? c.width : 1;
    const h = Number.isFinite(c.height) ? c.height : 1;
    return {
      left: x,
      top: y,
      right: 1 - x - w,
      bottom: 1 - y - h,
    };
  }

  toEdges() {
    return NormalizedCrop.toEdges(this);
  }

  /**
   * 将归一化裁切转换为视频/源图像素源区域 { sx, sy, sw, sh }。
   * @param {Object} crop
   * @param {number|{ width: number, height: number }} sourceWidth
   * @param {number} [sourceHeight]
   * @returns {{ sx: number, sy: number, sw: number, sh: number }}
   */
  static cropSourceRect(crop, sourceWidth, sourceHeight) {
    let sw = sourceWidth;
    let sh = sourceHeight;
    if (typeof sourceWidth === 'object' && sourceWidth !== null) {
      sh = sourceWidth.height;
      sw = sourceWidth.width;
    }
    const safeCrop = NormalizedCrop.clamped(crop);
    const width = Number.isFinite(sw) && sw > 0 ? sw : 1;
    const height = Number.isFinite(sh) && sh > 0 ? sh : 1;

    return {
      sx: safeCrop.x * width,
      sy: safeCrop.y * height,
      sw: safeCrop.width * width,
      sh: safeCrop.height * height,
    };
  }

  cropSourceRect(sourceWidth, sourceHeight) {
    return NormalizedCrop.cropSourceRect(this, sourceWidth, sourceHeight);
  }
}

/**
 * 屏幕外框样式常量。
 */
const ScreenFrameStyle = Object.freeze({
  none: 'none',
  windowLight: 'windowLight',
  windowDark: 'windowDark',
  browserLight: 'browserLight',
  browserDark: 'browserDark',
  devicePhone: 'devicePhone',

  NONE: 'none',
  WINDOW_LIGHT: 'windowLight',
  WINDOW_DARK: 'windowDark',
  BROWSER_LIGHT: 'browserLight',
  BROWSER_DARK: 'browserDark',
  DEVICE_PHONE: 'devicePhone',

  ALL: Object.freeze(['none', 'windowLight', 'windowDark', 'browserLight', 'browserDark', 'devicePhone']),

  isDevice(style) {
    return style === 'devicePhone' || style === 'deviceTablet'
      || style === 'devicePhonePortrait' || style === 'devicePhoneLandscape'
      || style === 'deviceTabletPortrait' || style === 'deviceTabletLandscape';
  },

  isBrowser(style) {
    return style === 'browserLight' || style === 'browserDark';
  },

  isWindow(style) {
    return style === 'windowLight' || style === 'windowDark';
  },

  isValid(style) {
    return (
      style === 'none' ||
      style === 'windowLight' ||
      style === 'windowDark' ||
      style === 'browserLight' ||
      style === 'browserDark' ||
      style === 'devicePhone'
    );
  },
});

/**
 * 外框样式设计默认尺寸及参数。
 */
const FRAME_DEFAULTS = Object.freeze({
  none: Object.freeze({
    frameScale: 1.0,
    toolbarScale: 1.0,
    outerRadius: 24,
    contentRadius: 24,
    shadowStrength: 0.28,
    borderWidth: 0,
    borderColor: '#ffffff',
    toolbarHeight: 0,
    bezelWidth: 0,
  }),
  windowLight: Object.freeze({
    frameScale: 1.0,
    toolbarScale: 0.90,
    outerRadius: 18,
    contentRadius: 0,
    shadowStrength: 0.22,
    borderWidth: 0,
    borderColor: '#ffffff',
    toolbarHeight: 38,
    bezelWidth: 0,
  }),
  windowDark: Object.freeze({
    frameScale: 1.0,
    toolbarScale: 0.90,
    outerRadius: 18,
    contentRadius: 0,
    shadowStrength: 0.24,
    borderWidth: 0,
    borderColor: '#ffffff',
    toolbarHeight: 38,
    bezelWidth: 0,
  }),
  browserLight: Object.freeze({
    frameScale: 1.0,
    toolbarScale: 0.88,
    outerRadius: 16,
    contentRadius: 0,
    shadowStrength: 0.20,
    borderWidth: 0,
    borderColor: '#ffffff',
    toolbarHeight: 46,
    bezelWidth: 0,
  }),
  browserDark: Object.freeze({
    frameScale: 1.0,
    toolbarScale: 0.88,
    outerRadius: 16,
    contentRadius: 0,
    shadowStrength: 0.22,
    borderWidth: 0,
    borderColor: '#ffffff',
    toolbarHeight: 46,
    bezelWidth: 0,
  }),
  devicePhone: Object.freeze({
    frameScale: 1.0,
    toolbarScale: 1.0,
    outerRadius: 44,
    contentRadius: 36,
    shadowStrength: 0.32,
    borderWidth: 0,
    borderColor: '#ffffff',
    toolbarHeight: 0,
    bezelWidth: 14,
  }),
});

/**
 * 计算屏幕外框在画布上的留白/装饰边距（像素）。
 * 移植自 CompositionScene.swift ScreenFrameGeometry.decorationInsetsAtScaleOne。
 *
 * @param {Object} options
 * @param {string} [options.style='none']
 * @param {number} [options.frameScale=1]
 * @param {number} [options.toolbarScale]
 * @param {number} [options.fittedWidth]
 * @param {number} [options.fittedHeight]
 * @param {number} [options.styleScale=1]
 * @returns {{ top: number, right: number, bottom: number, left: number }}
 */
function decorationInsets({
  style = 'none',
  frameScale = 1,
  toolbarScale,
  fittedWidth,
  fittedHeight,
  styleScale = 1,
} = {}) {
  if (style === 'none' || !style) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  const defaults = FRAME_DEFAULTS[style] || FRAME_DEFAULTS.none;
  const safeStyleScale = Math.max(Number.isFinite(styleScale) ? styleScale : 1, 0.0001);
  const rawFrameScale = Number.isFinite(frameScale) ? frameScale : 1;
  const authoredFrameScale = Math.min(Math.max(rawFrameScale, 0.6), 1.6);

  const effectiveToolbarScale = toolbarScale != null && Number.isFinite(toolbarScale)
    ? toolbarScale
    : (defaults.toolbarScale != null ? defaults.toolbarScale : 1);
  const authoredToolbarScale = Math.min(Math.max(effectiveToolbarScale, 0.65), 1.6);
  const visualScale = safeStyleScale * authoredFrameScale;

  if (
    style === 'windowLight' ||
    style === 'windowDark' ||
    style === 'browserLight' ||
    style === 'browserDark'
  ) {
    const baseHeight = defaults.toolbarHeight || 46;
    const idealHeight = baseHeight * visualScale * authoredToolbarScale;
    let top = Math.max(idealHeight, 4 * safeStyleScale);
    if (Number.isFinite(fittedHeight) && fittedHeight > 0) {
      top = Math.min(top, Math.max(fittedHeight * 0.25, 4 * safeStyleScale));
    }
    return { top, right: 0, bottom: 0, left: 0 };
  }

  if (style === 'devicePhone' || ScreenFrameStyle.isDevice(style)) {
    let bezel;
    if (Number.isFinite(fittedWidth) && Number.isFinite(fittedHeight) && fittedWidth > 0 && fittedHeight > 0) {
      const shortEdge = Math.max(Math.min(fittedWidth, fittedHeight), 1);
      bezel = Math.min(
        Math.max(shortEdge * 0.026 * authoredFrameScale, 2 * safeStyleScale),
        shortEdge * 0.07
      );
    } else if (Number.isFinite(fittedWidth) && fittedWidth > 0 && (!Number.isFinite(fittedHeight) || fittedHeight <= 0)) {
      const shortEdge = Math.max(fittedWidth, 1);
      bezel = Math.min(
        Math.max(shortEdge * 0.026 * authoredFrameScale, 2 * safeStyleScale),
        shortEdge * 0.07
      );
    } else {
      const baseBezel = defaults.bezelWidth || 14;
      bezel = baseBezel * visualScale;
    }
    return { top: bezel, right: bezel, bottom: bezel, left: bezel };
  }

  return { top: 0, right: 0, bottom: 0, left: 0 };
}

/**
 * 完整外框装饰场景几何布局与色彩计算。
 * 移植自 FrameScene.swift screenDecoration。
 *
 * @param {Object} options
 * @param {string} [options.style='none'] 外框样式
 * @param {number} [options.frameScale] 缩放
 * @param {number} [options.toolbarScale] 工具栏缩放
 * @param {number} [options.outerCornerRadius] 外圆角
 * @param {number} [options.contentCornerRadius] 内容圆角
 * @param {string} [options.title=''] 窗口标题
 * @param {string} [options.browserAddress=''] 浏览器地址栏文本
 * @param {Object} [options.geometry] 屏幕场景几何（ScreenSceneEvaluation 或 Rect）
 * @param {number} [options.styleScale=1] 画布相对 1080p 标准比例
 * @returns {Object} 装饰几何、工具栏、控制点布局、标题、地址栏等
 */
function screenDecoration({
  style = 'none',
  frameScale,
  toolbarScale,
  outerCornerRadius,
  contentCornerRadius,
  title = '',
  browserAddress = '',
  geometry = { x: 0, y: 0, width: 1920, height: 1080 },
  styleScale = 1,
} = {}) {
  const defaults = FRAME_DEFAULTS[style] || FRAME_DEFAULTS.none;
  const isDark =
    style === 'windowDark' ||
    style === 'browserDark' ||
    style === 'devicePhone';

  const kind =
    style === 'browserLight' || style === 'browserDark'
      ? 'browser'
      : (style === 'devicePhone' || ScreenFrameStyle.isDevice(style)
          ? 'devicePhone'
          : (style === 'none' ? 'none' : 'window'));

  const finalRect = geometry && geometry.finalRect
    ? geometry.finalRect
    : (geometry && Number.isFinite(geometry.x)
        ? { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height }
        : { x: 0, y: 0, width: 1920, height: 1080 });

  const fittedRect = geometry && geometry.fittedRect
    ? geometry.fittedRect
    : finalRect;

  const manualScale = geometry && Number.isFinite(geometry.manualScale) ? geometry.manualScale : 1;
  const viewportScale = geometry && geometry.viewport && Number.isFinite(geometry.viewport.scale)
    ? geometry.viewport.scale
    : 1;
  const motionScale = Math.max(manualScale * viewportScale, 0.0001);

  const rawFrameScale = frameScale != null && Number.isFinite(frameScale)
    ? frameScale
    : (defaults.frameScale != null ? defaults.frameScale : 1);
  const authoredFrameScale = Math.min(Math.max(rawFrameScale, 0.6), 1.6);

  const safeStyleScale = Math.max(Number.isFinite(styleScale) ? styleScale : 1, 0.0001);
  const scale = Math.max(safeStyleScale * motionScale * authoredFrameScale, 0.0001);

  const authoredInsets = decorationInsets({
    style,
    frameScale: authoredFrameScale,
    toolbarScale,
    fittedWidth: fittedRect.width,
    fittedHeight: fittedRect.height,
    styleScale: safeStyleScale,
  });

  const topInset = authoredInsets.top * motionScale;
  const rightInset = authoredInsets.right * motionScale;
  const bottomInset = authoredInsets.bottom * motionScale;
  const leftInset = authoredInsets.left * motionScale;

  const outerRect = {
    x: finalRect.x - leftInset,
    y: finalRect.y - topInset,
    width: finalRect.width + leftInset + rightInset,
    height: finalRect.height + topInset + bottomInset,
  };

  const toolbarHeight = topInset > 0
    ? topInset + Math.min(2 * scale, topInset * 0.08)
    : 0;

  const toolbarRect = {
    x: outerRect.x,
    y: outerRect.y,
    width: outerRect.width,
    height: toolbarHeight,
  };

  // 尺寸限定与圆角
  const authoredOuterRadius = Math.min(
    Math.max(
      outerCornerRadius != null && Number.isFinite(outerCornerRadius)
        ? outerCornerRadius
        : defaults.outerRadius,
      0
    ),
    160
  );
  const finalOuterRadius = Math.min(
    authoredOuterRadius * scale,
    Math.min(outerRect.width, outerRect.height) / 2
  );

  const authoredContentRadius = Math.min(
    Math.max(
      contentCornerRadius != null && Number.isFinite(contentCornerRadius)
        ? contentCornerRadius
        : defaults.contentRadius,
      0
    ),
    160
  );
  const finalContentRadius = Math.min(
    authoredContentRadius * scale,
    Math.min(finalRect.width, finalRect.height) / 2
  );

  // 控制点按钮布局
  let controls;
  if (toolbarHeight > 0 && (kind === 'window' || kind === 'browser')) {
    const controlDiameter = Math.min(
      Math.max(toolbarHeight * 0.23, 1.5),
      toolbarHeight * 0.32
    );
    const controlMargin = Math.max(toolbarHeight * 0.31, controlDiameter);
    const controlSpacing = controlDiameter * 1.62;
    const controlColors = ['#ff5f57', '#febc2e', '#28c840'];
    const buttons = controlColors.map((color, index) => ({
      x: toolbarRect.x + controlMargin + index * controlSpacing,
      y: toolbarRect.y + (toolbarHeight - controlDiameter) / 2,
      width: controlDiameter,
      height: controlDiameter,
      radius: controlDiameter / 2,
      color,
    }));
    const controlsEnd = toolbarRect.x + controlMargin + controlSpacing * 2 + controlDiameter;
    controls = {
      diameter: controlDiameter,
      margin: controlMargin,
      spacing: controlSpacing,
      endX: controlsEnd,
      buttons,
    };
  } else {
    controls = {
      diameter: 0,
      margin: 0,
      spacing: 0,
      endX: outerRect.x,
      buttons: [],
    };
  }

  // 标题与地址栏规范
  const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 120) : '';
  const cleanAddress = typeof browserAddress === 'string' ? browserAddress.trim().slice(0, 240) : '';

  // 浏览器地址栏区域布局
  let addressFieldRect = null;
  if (kind === 'browser' && toolbarHeight > 0) {
    const fieldMargin = Math.max(toolbarHeight * 0.28, 2);
    const availableMinX = controls.endX + fieldMargin;
    const availableMaxX = toolbarRect.x + toolbarRect.width - fieldMargin;
    const availableWidth = Math.max(availableMaxX - availableMinX, 2);
    const fieldHeight = Math.max(toolbarHeight * 0.44, 2);
    const fieldWidth = Math.min(availableWidth, Math.max(fieldHeight * 3, 160 * scale));
    const midX = toolbarRect.x + toolbarRect.width / 2;
    const fieldCenterX = Math.min(
      Math.max(midX, availableMinX + fieldWidth / 2),
      availableMaxX - fieldWidth / 2
    );
    addressFieldRect = {
      x: fieldCenterX - fieldWidth / 2,
      y: toolbarRect.y + (toolbarHeight - fieldHeight) / 2,
      width: fieldWidth,
      height: fieldHeight,
    };
  }

  const surfaceColor = isDark ? '#222327' : '#ecedf0';
  const toolbarColor = isDark ? '#313238' : '#f4f4f6';
  const separatorColor = isDark ? '#4b4d55' : '#c9cace';
  const fieldColor = isDark ? '#1b1c20' : '#ffffff';
  const glyphColor = isDark ? '#a9abb3' : '#7a7c84';

  return {
    style,
    kind,
    isDark,
    outerRect,
    outerDecorationRect: outerRect,
    toolbarRect,
    contentRect: finalRect,
    outerCornerRadius: finalOuterRadius,
    contentCornerRadius: finalContentRadius,
    controls,
    controlsLayout: controls,
    title: cleanTitle,
    browserAddress: cleanAddress,
    addressFieldRect,
    surfaceColor,
    toolbarColor,
    separatorColor,
    fieldColor,
    glyphColor,
    shadowStrength: defaults.shadowStrength || 0.24,
  };
}

module.exports = {
  NormalizedCrop,
  ScreenFrameStyle,
  FRAME_DEFAULTS,
  ScreenFrameDefaults: FRAME_DEFAULTS,
  decorationInsets,
  screenDecoration,
};
