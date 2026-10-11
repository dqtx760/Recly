'use strict';
// 画面合成器：把 scene.js 求出的几何画到 2D 画布上。预览与导出走同一份代码，
// 对应 macOS 版的 SharedFrameRenderer（那边是 Core Image / Metal）。

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { clamp, PATTERN_PRESETS } = require('../../core/model');
const { cursorLibrary } = require('./cursors');

function roundedRect(ctx, rect, radius) {
  const r = Math.max(Math.min(radius, rect.width / 2, rect.height / 2), 0);
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.width, rect.height, r);
}

const frameSize = (frame) => ({
  width: frame.displayWidth || frame.videoWidth || frame.width,
  height: frame.displayHeight || frame.videoHeight || frame.height,
});
function createMockContext(canvas) {
  const stack = [];
  const ctx = {
    canvas,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    filter: 'none',
    imageSmoothingQuality: 'high',
    imageSmoothingEnabled: true,
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save() {
      stack.push({
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        globalAlpha: this.globalAlpha,
        shadowColor: this.shadowColor,
        shadowBlur: this.shadowBlur,
        shadowOffsetX: this.shadowOffsetX,
        shadowOffsetY: this.shadowOffsetY,
        filter: this.filter,
      });
    },
    restore() {
      if (stack.length) {
        Object.assign(this, stack.pop());
      }
    },
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    roundRect() {},
    rect() {},
    fill() {},
    stroke() {},
    clip() {},
    fillRect() {},
    strokeRect() {},
    clearRect() {},
    fillText() {},
    strokeText() {},
    measureText(text) {
      return { width: (text ? text.length : 0) * 8 };
    },
    drawImage() {},
    transform() {},
    setTransform() {},
    scale() {},
    translate() {},
    rotate() {},
  };
  return ctx;
}

function createMockCanvas(width, height) {
  const canvas = {
    width: Math.max(Math.round(width) || 1, 1),
    height: Math.max(Math.round(height) || 1, 1),
    getContext(type) {
      if (type === '2d') {
        if (!this._ctx) this._ctx = createMockContext(this);
        return this._ctx;
      }
      return null;
    },
  };
  return canvas;
}

function createOffscreenCanvas(width, height) {
  const w = Math.max(Math.round(width) || 1, 1);
  const h = Math.max(Math.round(height) || 1, 1);
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(w, h);
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return createMockCanvas(w, h);
}

function expandPolygon(points, distance) {
  if (distance <= 0 || points.length < 3) return points;
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  if (Math.abs(area) < 1e-9) return points;

  const direction = area > 0 ? 1 : -1;
  const edges = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    const dx = next.x - point.x;
    const dy = next.y - point.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return null;
    return {
      dx,
      dy,
      nx: direction * dy / length,
      ny: direction * -dx / length,
    };
  });
  if (edges.some((edge) => !edge)) return points;

  return points.map((point, index) => {
    const previous = edges[(index + points.length - 1) % points.length];
    const current = edges[index];
    const previousOrigin = { x: point.x + previous.nx * distance, y: point.y + previous.ny * distance };
    const currentOrigin = { x: point.x + current.nx * distance, y: point.y + current.ny * distance };
    const denominator = previous.dx * current.dy - previous.dy * current.dx;
    let expanded;
    if (Math.abs(denominator) < 1e-9) {
      expanded = {
        x: point.x + (previous.nx + current.nx) * distance / 2,
        y: point.y + (previous.ny + current.ny) * distance / 2,
      };
    } else {
      const offsetX = currentOrigin.x - previousOrigin.x;
      const offsetY = currentOrigin.y - previousOrigin.y;
      const factor = (offsetX * current.dy - offsetY * current.dx) / denominator;
      expanded = { x: previousOrigin.x + factor * previous.dx, y: previousOrigin.y + factor * previous.dy };
    }
    const offsetX = expanded.x - point.x;
    const offsetY = expanded.y - point.y;
    const offsetLength = Math.hypot(offsetX, offsetY);
    return offsetLength > 2
      ? { x: point.x + offsetX * 2 / offsetLength, y: point.y + offsetY * 2 / offsetLength }
      : expanded;
  });
}

function drawTexturedTriangle(ctx, image, src, dst) {
  const [x0, y0] = [src[0].x, src[0].y];
  const [x1, y1] = [src[1].x, src[1].y];
  const [x2, y2] = [src[2].x, src[2].y];

  const [u0, v0] = [dst[0].x, dst[0].y];
  const [u1, v1] = [dst[1].x, dst[1].y];
  const [u2, v2] = [dst[2].x, dst[2].y];

  const delta = (x0 - x2) * (y1 - y2) - (x1 - x2) * (y0 - y2);
  if (Math.abs(delta) < 1e-9) return;

  const a = ((u0 - u2) * (y1 - y2) - (u1 - u2) * (y0 - y2)) / delta;
  const c = ((x0 - x2) * (u1 - u2) - (x1 - x2) * (u0 - u2)) / delta;
  const e = u0 - a * x0 - c * y0;

  const b = ((v0 - v2) * (y1 - y2) - (v1 - v2) * (y0 - y2)) / delta;
  const d = ((x0 - x2) * (v1 - v2) - (x1 - x2) * (v0 - v2)) / delta;
  const f = v0 - b * x0 - d * y0;
  const clipPoints = expandPolygon(dst, 0.5);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(clipPoints[0].x, clipPoints[0].y);
  ctx.lineTo(clipPoints[1].x, clipPoints[1].y);
  ctx.lineTo(clipPoints[2].x, clipPoints[2].y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

function renderPerspectiveMesh(ctx, image, sourceRect, quad, subdivisions = 8) {
  if (!quad || !image) return;
  const mapper = quad.projector ? quad.projector(sourceRect) : null;
  if (!mapper || !mapper.valid) {
    ctx.drawImage(image, quad.topLeft?.x ?? sourceRect.x, quad.topLeft?.y ?? sourceRect.y);
    return;
  }

  const N = Math.max(subdivisions, 2);
  const sw = sourceRect.width;
  const sh = sourceRect.height;

  // 三角形之间允许半像素重叠，补齐 Canvas 对各 clip 边分别抗锯齿形成的透底缝。
  // 外轮廓仍以投影四边形统一裁切，避免扩展改变屏幕卡片边界。
  const outerCorners = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  const hasOuterCorners = outerCorners.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
  ctx.save();
  if (hasOuterCorners) {
    ctx.beginPath();
    ctx.moveTo(outerCorners[0].x, outerCorners[0].y);
    for (let index = 1; index < outerCorners.length; index++) {
      ctx.lineTo(outerCorners[index].x, outerCorners[index].y);
    }
    ctx.closePath();
    ctx.clip();
  }

  for (let i = 0; i < N; i++) {
    const u0 = i / N;
    const u1 = (i + 1) / N;
    const sx0 = sourceRect.x + u0 * sw;
    const sx1 = sourceRect.x + u1 * sw;
    const lx0 = u0 * sw;
    const lx1 = u1 * sw;

    for (let j = 0; j < N; j++) {
      const v0 = j / N;
      const v1 = (j + 1) / N;
      const sy0 = sourceRect.y + v0 * sh;
      const sy1 = sourceRect.y + v1 * sh;
      const ly0 = v0 * sh;
      const ly1 = v1 * sh;

      const p00 = mapper.project({ x: sx0, y: sy0 });
      const p10 = mapper.project({ x: sx1, y: sy0 });
      const p01 = mapper.project({ x: sx0, y: sy1 });
      const p11 = mapper.project({ x: sx1, y: sy1 });

      if (!p00 || !p10 || !p01 || !p11) continue;

      drawTexturedTriangle(
        ctx,
        image,
        [{ x: lx0, y: ly0 }, { x: lx1, y: ly0 }, { x: lx0, y: ly1 }],
        [p00, p10, p01]
      );
      drawTexturedTriangle(
        ctx,
        image,
        [{ x: lx1, y: ly0 }, { x: lx1, y: ly1 }, { x: lx0, y: ly1 }],
        [p10, p11, p01]
      );
    }
  }
  ctx.restore();
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error(`当前环境无法解码图片素材：${file}`));
      return;
    }
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`无法加载图片素材：${file}`));
    image.src = pathToFileURL(file).href;
  });
}
class Compositor {
  constructor(directory) {
    this.directory = directory;
    this.images = new Map();
    this.imageLoads = new Map();
    this.assetKey = null;
    this.prepareGeneration = 0;
    this.backgroundKey = null;
    this.background = null;
    this.cursors = cursorLibrary();
  }

  imageFile(relativePath) {
    return path.isAbsolute(relativePath) ? relativePath : path.join(this.directory, relativePath);
  }

  backgroundFile(background) {
    if (background?.kind === 'image' && background.file) return this.imageFile(background.file);
    return null;
  }

  async loadImage(file) {
    if (this.images.has(file)) return this.images.get(file);
    if (!this.imageLoads.has(file)) {
      const pending = loadImage(file).then((image) => {
        this.images.set(file, image);
        return image;
      }).finally(() => this.imageLoads.delete(file));
      this.imageLoads.set(file, pending);
    }
    return this.imageLoads.get(file);
  }

  /// 背景图片异步解码；预览在加载完成后通过 onReady 重画，导出前显式 await。
  async prepare(project) {
    const files = new Set();
    if (project.canvas.background?.kind === 'image' && !project.canvas.background.file) {
      throw new Error('背景图片缺少素材路径');
    }
    const backgroundFile = this.backgroundFile(project.canvas.background);
    if (backgroundFile) files.add(backgroundFile);
    for (const sticker of project.timeline?.stickerClips || []) {
      if (!sticker.relativePath) {
        if (!sticker.image) throw new Error(`贴图片段缺少图片素材路径：${sticker.id || '未知片段'}`);
        continue;
      }
      files.add(this.imageFile(sticker.relativePath));
    }
    const key = [...files].sort().join('\n');
    const generation = ++this.prepareGeneration;
    await Promise.all([...files].map((file) => this.loadImage(file)));
    if (generation !== this.prepareGeneration) return;
    if (key !== this.assetKey) this.backgroundKey = null;
    this.assetKey = key;
    for (const file of this.images.keys()) {
      if (!files.has(file)) this.images.delete(file);
    }
  }

  /// 背景整张缓存：点阵每帧重画上千个圆不划算，背景又不随时间变化。
  backgroundLayer(canvas, width, height, styleScale, outputTime = 0) {
    const file = this.backgroundFile(canvas.background);
    const image = file ? this.images.get(file) : null;
    const motion = canvas.background?.kind === 'pattern' ? (canvas.patternMotion ?? 0) : 0;
    const key = JSON.stringify([canvas.background, canvas.backgroundBlur, canvas.patternScale, canvas.patternOpacity, motion, width, height, Boolean(image)]);
    if (motion !== 0) {
      const layer = createOffscreenCanvas(width, height);
      this.drawPattern(layer.getContext('2d', { alpha: false }), PATTERN_PRESETS[canvas.background.preset] || PATTERN_PRESETS.obsidianGrid, canvas, width, height, outputTime);
      return layer;
    }
    if (this.backgroundKey === key) return this.background;
    const layer = createOffscreenCanvas(width, height);
    const ctx = layer.getContext('2d', { alpha: false });
    const background = canvas.background;
    if (background.kind === 'color') {
      ctx.fillStyle = background.color;
      ctx.fillRect(0, 0, width, height);
    } else if (background.kind === 'image' && image) {
      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const blur = Math.max(canvas.backgroundBlur, 0) * styleScale;
      // 模糊会让边缘透出底色，画大一圈再裁回来。
      const bleed = blur * 3;
      const w = image.naturalWidth * scale + bleed * 2;
      const h = image.naturalHeight * scale + bleed * 2;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      if (blur > 0) ctx.filter = `blur(${blur}px)`;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
      ctx.filter = 'none';
    } else {
      this.drawPattern(ctx, PATTERN_PRESETS[background.preset] || PATTERN_PRESETS.obsidianGrid, canvas, width, height);
    }
    this.backgroundKey = key;
    this.background = layer;
    return layer;
  }

  drawPattern(ctx, preset, canvas, width, height, outputTime = 0) {
    ctx.fillStyle = preset.background;
    ctx.fillRect(0, 0, width, height);
    const shortEdge = Math.max(Math.min(width, height), 2);
    const tile = Math.max(shortEdge * preset.fraction * canvas.patternScale, 9);
    ctx.globalAlpha = Math.min(Math.max(canvas.patternOpacity, 0), 1);
    // 图案以画布中心为基准铺开，换分辨率时构图不漂移。
    const motionOffset = (Number(canvas.patternMotion) || 0) * Math.max(outputTime, 0);
    const originX = ((width / 2 + motionOffset) % tile + tile) % tile;
    const originY = (height / 2) % tile;
    if (preset.kind === 'dots') {
      ctx.fillStyle = preset.dot;
      const radius = Math.max(tile * 0.055, 0.9);
      ctx.beginPath();
      for (let y = originY - tile; y < height + tile; y += tile) {
        for (let x = originX - tile; x < width + tile; x += tile) {
          ctx.moveTo(x + radius, y);
          ctx.arc(x, y, radius, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    } else {
      ctx.strokeStyle = preset.stroke;
      ctx.lineWidth = Math.max(shortEdge / 1080, 1);
      ctx.beginPath();
      if (preset.kind === 'grid') {
        for (let x = originX - tile; x < width + tile; x += tile) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
        for (let y = originY - tile; y < height + tile; y += tile) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
      } else {
        // 等角网：±30° 两组斜线加一组竖线。
        const slope = Math.tan(Math.PI / 6);
        const span = width * slope;
        for (let y = originY - span - tile; y < height + span + tile; y += tile) {
          ctx.moveTo(0, y); ctx.lineTo(width, y + span);
          ctx.moveTo(0, y + span); ctx.lineTo(width, y);
        }
        const step = tile / slope / 2;
        for (let x = (width / 2) % step - step; x < width + step; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawVideoBackground(ctx, canvas, width, height, styleScale, frame) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    if (!frame) return;
    const source = frameSize(frame);
    const scale = Math.max(width / Math.max(source.width, 1), height / Math.max(source.height, 1));
    const blur = Math.max(canvas.backgroundBlur ?? 0, 0) * styleScale;
    const bleed = blur * 3;
    const drawWidth = source.width * scale + bleed * 2;
    const drawHeight = source.height * scale + bleed * 2;
    ctx.save();
    if (blur > 0) ctx.filter = `blur(${blur}px)`;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    ctx.restore();
  }

  drawShadow(ctx, rect, radius, shadow) {
    if (!shadow || shadow.opacity <= 0) return;
    ctx.save();
    // Core Image 的高斯半径是 σ，画布 shadowBlur 约等于 2σ。
    ctx.shadowColor = `rgba(0,0,0,${shadow.opacity})`;
    ctx.shadowBlur = shadow.radius * 2;
    ctx.shadowOffsetY = shadow.offsetY;
    ctx.fillStyle = '#000';
    roundedRect(ctx, rect, radius);
    ctx.fill();
    ctx.restore();
  }

  drawScreenContent(ctx, rect, frame, crop) {
    if (frame) {
      if (crop && (crop.width < 0.999 || crop.height < 0.999 || crop.x > 0.001 || crop.y > 0.001)) {
        const sourceSize = frameSize(frame);
        const cropRect = crop.cropSourceRect
          ? crop.cropSourceRect(sourceSize.width, sourceSize.height)
          : { sx: crop.x * sourceSize.width, sy: crop.y * sourceSize.height, sw: crop.width * sourceSize.width, sh: crop.height * sourceSize.height };
        const sRect = {
          x: cropRect.sx ?? cropRect.x,
          y: cropRect.sy ?? cropRect.y,
          width: cropRect.sw ?? cropRect.width,
          height: cropRect.sh ?? cropRect.height,
        };
        ctx.drawImage(frame, sRect.x, sRect.y, sRect.width, sRect.height, rect.x, rect.y, rect.width, rect.height);
      } else {
        ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height);
      }
    } else {
      ctx.fillStyle = '#1b1c20';
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
  }

  drawMosaics(ctx, mosaics, rect, frame, crop) {
    if (!mosaics || !mosaics.length) return;
    const visibleCrop = crop || { x: 0, y: 0, width: 1, height: 1 };
    for (const mosaic of mosaics) {
      const progress = mosaic.transitionProgress ?? mosaic.progress ?? 1;
      if (progress <= 0.001) continue;

      const source = mosaic.sourceRect;
      const left = Math.max(source.x, visibleCrop.x);
      const top = Math.max(source.y, visibleCrop.y);
      const right = Math.min(source.x + source.width, visibleCrop.x + visibleCrop.width);
      const bottom = Math.min(source.y + source.height, visibleCrop.y + visibleCrop.height);
      if (right <= left || bottom <= top) continue;
      const x0 = (left - visibleCrop.x) / visibleCrop.width;
      const y0 = (top - visibleCrop.y) / visibleCrop.height;
      const x1 = (right - visibleCrop.x) / visibleCrop.width;
      const y1 = (bottom - visibleCrop.y) / visibleCrop.height;
      // rect 已是裁切与缩放后的 finalRect；源区域只需映射到裁切局部空间。
      const mx = rect.x + x0 * rect.width;
      const my = rect.y + y0 * rect.height;
      const mw = (x1 - x0) * rect.width;
      const mh = (y1 - y0) * rect.height;
      const cr = Math.min(mw, mh) * (mosaic.cornerRadius || 0);

      if (mosaic.style === 'blur') {
        ctx.save();
        roundedRect(ctx, { x: mx, y: my, width: mw, height: mh }, cr);
        ctx.clip();
        const blurRadius = (4 + (mosaic.intensity ?? 0.55) * 44) * progress;
        if (frame) {
          ctx.filter = `blur(${blurRadius}px)`;
          this.drawScreenContent(ctx, rect, frame, visibleCrop);
          ctx.filter = 'none';
        } else {
          ctx.fillStyle = `rgba(255, 255, 255, ${0.28 * progress})`;
          ctx.fillRect(mx, my, mw, mh);
        }
        ctx.restore();
      } else if (mosaic.style === 'spotlight') {
        ctx.save();
        const dimming = (mosaic.spotlightDimming ?? 0.22) * progress;
        ctx.fillStyle = `rgba(0, 0, 0, ${dimming})`;
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.width, rect.height);
        roundedRect(ctx, { x: mx, y: my, width: mw, height: mh }, cr);
        ctx.fill('evenodd');
        ctx.restore();
      } else if (mosaic.style === 'pixelate') {
        ctx.save();
        roundedRect(ctx, { x: mx, y: my, width: mw, height: mh }, cr);
        ctx.clip();
        ctx.fillStyle = `rgba(128, 128, 128, ${0.35 * progress})`;
        ctx.fillRect(mx, my, mw, mh);
        ctx.restore();
      }
    }
  }

  draw3DScreen(ctx, screen, frame) {
    const quad = screen.projectedQuad;
    const dec = screen.decoration;
    const isDecorated = dec && dec.style && dec.style !== 'none';
    const sourceRect = isDecorated ? (dec.outerRect || screen.finalRect) : screen.finalRect;

    if (!quad) {
      this.drawScreen(ctx, { ...screen, rotationX: 0, rotationY: 0, rotationZ: 0 }, frame);
      return;
    }

    // 阴影投射
    if (screen.shadow && screen.shadow.opacity > 0) {
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${screen.shadow.opacity})`;
      ctx.shadowBlur = (screen.shadow.radius || 22) * 2;
      ctx.shadowOffsetY = screen.shadow.offsetY || 12;
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.moveTo(quad.topLeft.x, quad.topLeft.y);
      ctx.lineTo(quad.topRight.x, quad.topRight.y);
      ctx.lineTo(quad.bottomRight.x, quad.bottomRight.y);
      ctx.lineTo(quad.bottomLeft.x, quad.bottomLeft.y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 离线渲染 2D 屏幕卡片（包含外框与修饰）
    const offscreen = createOffscreenCanvas(sourceRect.width, sourceRect.height);
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return;

    offCtx.save();
    offCtx.translate(-sourceRect.x, -sourceRect.y);

    if (isDecorated) {
      const outerRect = dec.outerRect || screen.finalRect;
      const outerRadius = dec.outerCornerRadius ?? screen.cornerRadius;

      offCtx.fillStyle = dec.surfaceColor || (dec.isDark ? '#222327' : '#ecedf0');
      roundedRect(offCtx, outerRect, outerRadius);
      offCtx.fill();

      if (dec.toolbarRect) {
        offCtx.save();
        roundedRect(offCtx, outerRect, outerRadius);
        offCtx.clip();

        offCtx.fillStyle = dec.toolbarColor || (dec.isDark ? '#313238' : '#f4f4f6');
        offCtx.fillRect(dec.toolbarRect.x, dec.toolbarRect.y, dec.toolbarRect.width, dec.toolbarRect.height);

        if (dec.separatorColor) {
          offCtx.strokeStyle = dec.separatorColor;
          offCtx.lineWidth = 1;
          offCtx.beginPath();
          offCtx.moveTo(dec.toolbarRect.x, dec.toolbarRect.y + dec.toolbarRect.height);
          offCtx.lineTo(dec.toolbarRect.x + dec.toolbarRect.width, dec.toolbarRect.y + dec.toolbarRect.height);
          offCtx.stroke();
        }

        const buttons3D = Array.isArray(dec.controls) ? dec.controls : (dec.controls?.buttons || []);
        for (const ctrl of buttons3D) {
          offCtx.fillStyle = ctrl.color;
          offCtx.beginPath();
          const cx = ctrl.cx ?? (ctrl.x + (ctrl.radius ?? (ctrl.width / 2)));
          const cy = ctrl.cy ?? (ctrl.y + (ctrl.radius ?? (ctrl.height / 2)));
          const r = ctrl.radius ?? (ctrl.width / 2);
          offCtx.arc(cx, cy, r, 0, Math.PI * 2);
          offCtx.fill();
        }

        if (dec.title) {
          offCtx.fillStyle = dec.glyphColor || '#7a7c84';
          offCtx.font = '12px sans-serif';
          offCtx.textAlign = 'center';
          offCtx.textBaseline = 'middle';
          offCtx.fillText(dec.title, dec.toolbarRect.x + dec.toolbarRect.width / 2, dec.toolbarRect.y + dec.toolbarRect.height / 2);
        }

        if (dec.addressFieldRect && dec.browserAddress) {
          const af = dec.addressFieldRect;
          offCtx.fillStyle = dec.fieldColor || (dec.isDark ? '#1b1c20' : '#ffffff');
          roundedRect(offCtx, af, af.cornerRadius ?? 4);
          offCtx.fill();

          offCtx.fillStyle = dec.glyphColor || '#7a7c84';
          offCtx.font = '11px sans-serif';
          offCtx.textAlign = 'center';
          offCtx.textBaseline = 'middle';
          offCtx.fillText(dec.browserAddress, af.x + af.width / 2, af.y + af.height / 2);
        }

        offCtx.restore();
      }

      const contentRect = screen.finalRect;
      const contentRadius = dec.contentCornerRadius ?? screen.cornerRadius;
      offCtx.save();
      roundedRect(offCtx, contentRect, contentRadius);
      offCtx.clip();
      this.drawScreenContent(offCtx, contentRect, frame, screen.crop);
      if (screen.mosaics && screen.mosaics.length) {
        this.drawMosaics(offCtx, screen.mosaics, contentRect, frame, screen.crop);
      }
      offCtx.restore();
    } else {
      const rect = screen.finalRect;
      const border = screen.borderWidth || 0;
      if (border > 0) {
        const outer = { x: rect.x - border, y: rect.y - border, width: rect.width + border * 2, height: rect.height + border * 2 };
        offCtx.fillStyle = screen.borderColor || '#FFFFFF';
        roundedRect(offCtx, outer, screen.cornerRadius + border);
        offCtx.fill();
      }
      offCtx.save();
      roundedRect(offCtx, rect, screen.cornerRadius);
      offCtx.clip();
      this.drawScreenContent(offCtx, rect, frame, screen.crop);
      if (screen.mosaics && screen.mosaics.length) {
        this.drawMosaics(offCtx, screen.mosaics, rect, frame, screen.crop);
      }
      offCtx.restore();
    }

    offCtx.restore();

    // 通过透视网格细分渲染单应性四边形
    renderPerspectiveMesh(ctx, offscreen, sourceRect, quad, 8);
  }

  drawScreen(ctx, screen, frame) {
    if (!screen) return;
    if (screen.rotationX || screen.rotationY || screen.rotationZ) {
      this.draw3DScreen(ctx, screen, frame);
      return;
    }

    const dec = screen.decoration;
    if (dec && dec.style && dec.style !== 'none') {
      const outerRect = dec.outerRect || screen.finalRect;
      const outerRadius = dec.outerCornerRadius ?? screen.cornerRadius;

      this.drawShadow(ctx, outerRect, outerRadius, screen.shadow);

      ctx.fillStyle = dec.surfaceColor || (dec.isDark ? '#222327' : '#ecedf0');
      roundedRect(ctx, outerRect, outerRadius);
      ctx.fill();

      if (dec.toolbarRect) {
        ctx.save();
        roundedRect(ctx, outerRect, outerRadius);
        ctx.clip();

        ctx.fillStyle = dec.toolbarColor || (dec.isDark ? '#313238' : '#f4f4f6');
        ctx.fillRect(dec.toolbarRect.x, dec.toolbarRect.y, dec.toolbarRect.width, dec.toolbarRect.height);

        if (dec.separatorColor) {
          ctx.strokeStyle = dec.separatorColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(dec.toolbarRect.x, dec.toolbarRect.y + dec.toolbarRect.height);
          ctx.lineTo(dec.toolbarRect.x + dec.toolbarRect.width, dec.toolbarRect.y + dec.toolbarRect.height);
          ctx.stroke();
        }

        const buttons2D = Array.isArray(dec.controls) ? dec.controls : (dec.controls?.buttons || []);
        for (const ctrl of buttons2D) {
          ctx.fillStyle = ctrl.color;
          ctx.beginPath();
          const cx = ctrl.cx ?? (ctrl.x + (ctrl.radius ?? (ctrl.width / 2)));
          const cy = ctrl.cy ?? (ctrl.y + (ctrl.radius ?? (ctrl.height / 2)));
          const r = ctrl.radius ?? (ctrl.width / 2);
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        }

        if (dec.title) {
          ctx.fillStyle = dec.glyphColor || '#7a7c84';
          ctx.font = '12px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(dec.title, dec.toolbarRect.x + dec.toolbarRect.width / 2, dec.toolbarRect.y + dec.toolbarRect.height / 2);
        }

        if (dec.addressFieldRect && dec.browserAddress) {
          const af = dec.addressFieldRect;
          ctx.fillStyle = dec.fieldColor || (dec.isDark ? '#1b1c20' : '#ffffff');
          roundedRect(ctx, af, af.cornerRadius ?? 4);
          ctx.fill();

          ctx.fillStyle = dec.glyphColor || '#7a7c84';
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(dec.browserAddress, af.x + af.width / 2, af.y + af.height / 2);
        }

        ctx.restore();
      }

      const contentRect = screen.finalRect;
      const contentRadius = dec.contentCornerRadius ?? screen.cornerRadius;
      ctx.save();
      roundedRect(ctx, contentRect, contentRadius);
      ctx.clip();
      this.drawScreenContent(ctx, contentRect, frame, screen.crop);
      if (screen.mosaics && screen.mosaics.length) {
        this.drawMosaics(ctx, screen.mosaics, contentRect, frame, screen.crop);
      }
      ctx.restore();
    } else {
      const rect = screen.finalRect;
      const border = screen.borderWidth || 0;
      const outer = border > 0
        ? { x: rect.x - border, y: rect.y - border, width: rect.width + border * 2, height: rect.height + border * 2 }
        : rect;
      this.drawShadow(ctx, outer, screen.cornerRadius + border, screen.shadow);
      if (border > 0) {
        ctx.fillStyle = screen.borderColor || '#FFFFFF';
        roundedRect(ctx, outer, screen.cornerRadius + border);
        ctx.fill();
      }
      ctx.save();
      roundedRect(ctx, rect, screen.cornerRadius);
      ctx.clip();
      this.drawScreenContent(ctx, rect, frame, screen.crop);
      if (screen.mosaics && screen.mosaics.length) {
        this.drawMosaics(ctx, screen.mosaics, rect, frame, screen.crop);
      }
      ctx.restore();
    }
  }

  drawRing(ctx, x, y, ring, color) {
    if (!ring || ring.opacity <= 0 || ring.diameter <= 0) return;
    ctx.save();
    ctx.globalAlpha = Math.min(ring.opacity, 1);
    ctx.shadowColor = color;
    ctx.shadowBlur = ring.glow * 2;
    ctx.beginPath();
    ctx.arc(x, y, ring.diameter / 2, 0, Math.PI * 2);
    if (ring.filled) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = ring.lineWidth;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawCursor(ctx, screen, cursor) {
    ctx.save();
    // 光标属于屏幕内容：跟着屏幕卡片一起被圆角裁切。
    if (screen.projectedQuad && (screen.rotationX || screen.rotationY || screen.rotationZ)) {
      const quad = screen.projectedQuad;
      ctx.beginPath();
      ctx.moveTo(quad.topLeft.x, quad.topLeft.y);
      ctx.lineTo(quad.topRight.x, quad.topRight.y);
      ctx.lineTo(quad.bottomRight.x, quad.bottomRight.y);
      ctx.lineTo(quad.bottomLeft.x, quad.bottomLeft.y);
      ctx.closePath();
      ctx.clip();
    } else {
      roundedRect(ctx, screen.finalRect, screen.cornerRadius);
      ctx.clip();
    }
    if (cursor.click) {
      const color = cursor.clickColor || '#FFFFFF';
      this.drawRing(ctx, cursor.x, cursor.y, cursor.click.primary, color);
      this.drawRing(ctx, cursor.x, cursor.y, cursor.click.secondary, color);
      const accent = cursor.click.accent;
      if (accent && accent.opacity > 0) {
        ctx.save();
        ctx.globalAlpha = accent.opacity;
        ctx.fillStyle = color;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          ctx.beginPath();
          ctx.arc(cursor.x + dx * accent.offset, cursor.y + dy * accent.offset, accent.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
    const sprite = this.cursors[cursor.appearance] || this.cursors.arrow;
    const scale = cursor.height / this.cursors.referenceHeight;
    ctx.shadowColor = `rgba(0,0,0,${cursor.shadow.opacity})`;
    ctx.shadowBlur = cursor.shadow.radius * 2;
    ctx.shadowOffsetY = cursor.shadow.offsetY;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sprite.canvas, cursor.x - sprite.hotspotX * scale, cursor.y - sprite.hotspotY * scale, sprite.width * scale, sprite.height * scale);
    ctx.restore();
  }

  drawCamera(ctx, camera, frame) {
    if (!camera || (camera.opacity !== undefined && camera.opacity <= 0.001)) return;
    ctx.save();
    if (camera.opacity !== undefined && camera.opacity < 1) {
      ctx.globalAlpha = Math.min(Math.max(camera.opacity, 0), 1);
    }
    const rect = camera.rect;
    const border = camera.borderWidth || 0;
    const outer = border > 0
      ? { x: rect.x - border, y: rect.y - border, width: rect.width + border * 2, height: rect.height + border * 2 }
      : rect;
    if ((camera.fullscreenProgress ?? 0) < 0.999) {
      this.drawShadow(ctx, outer, camera.cornerRadius + border, camera.shadow);
      if (border > 0) {
        ctx.fillStyle = '#FFFFFF';
        roundedRect(ctx, outer, camera.cornerRadius + border);
        ctx.fill();
      }
    }
    ctx.save();
    roundedRect(ctx, rect, camera.cornerRadius);
    ctx.clip();
    if (frame) {
      const source = frameSize(frame);
      const fillScale = Math.max(rect.width / Math.max(source.width, 1), rect.height / Math.max(source.height, 1));
      const scale = fillScale * Math.max(camera.contentScale ?? 1, 1);
      const w = source.width * scale;
      const h = source.height * scale;
      const position = camera.contentPosition || { x: 0.5, y: 0.5 };
      const focusX = camera.isMirrored ? 1 - position.x : position.x;
      if (camera.isMirrored) {
        ctx.translate(rect.x * 2 + rect.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(frame, rect.x + (rect.width - w) * focusX, rect.y + (rect.height - h) * position.y, w, h);
    } else {
      ctx.fillStyle = '#1b1c20';
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    ctx.restore();
    ctx.restore();
  }

  drawStickers(ctx, stickers, frames) {
    if (!stickers || !stickers.length) return;
    for (const sticker of stickers) {
      if (sticker.opacity <= 0.001 || sticker.width <= 0 || sticker.height <= 0) continue;
      ctx.save();
      ctx.translate(sticker.centerX ?? sticker.x, sticker.centerY ?? sticker.y);
      if (sticker.rotation) ctx.rotate(sticker.rotation * Math.PI / 180);
      ctx.globalAlpha = Math.min(Math.max(sticker.opacity, 0), 1);

      const halfW = sticker.width / 2;
      const halfH = sticker.height / 2;
      const sRect = { x: -halfW, y: -halfH, width: sticker.width, height: sticker.height };
      const r = Math.min(sticker.cornerRadius || 0, halfW, halfH);

      if (sticker.shadowOpacity > 0 && sticker.shadowRadius > 0) {
        ctx.save();
        ctx.shadowColor = `rgba(0,0,0,${sticker.shadowOpacity})`;
        ctx.shadowBlur = sticker.shadowRadius * 2;
        ctx.shadowOffsetX = sticker.shadowOffsetX || 0;
        ctx.shadowOffsetY = sticker.shadowOffsetY || 0;
        ctx.fillStyle = '#000000';
        roundedRect(ctx, sRect, r);
        ctx.fill();
        ctx.restore();
      }

      if (sticker.borderWidth > 0) {
        const b = sticker.borderWidth;
        const bOuter = { x: sRect.x - b, y: sRect.y - b, width: sRect.width + b * 2, height: sRect.height + b * 2 };
        ctx.fillStyle = sticker.borderColor || '#FFFFFF';
        roundedRect(ctx, bOuter, r + b);
        ctx.fill();
      }

      ctx.save();
      roundedRect(ctx, sRect, r);
      ctx.clip();

      const img = (frames && frames.stickers && frames.stickers[sticker.id]) ||
        (sticker.relativePath && this.images && this.images.get(this.imageFile(sticker.relativePath))) ||
        sticker.image;

      if (img) {
        ctx.drawImage(img, sRect.x, sRect.y, sRect.width, sRect.height);
      } else {
        throw new Error(`贴图图片素材不可用：${sticker.relativePath || sticker.clip?.relativePath || sticker.id}`);
      }
      ctx.restore();
      ctx.restore();
    }
  }

  /// frames: { screen, camera, background }，可以是 <video> 或 WebCodecs VideoFrame。
  draw(ctx, project, scene, frames) {
    const { width, height } = scene;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (project.canvas.background?.kind === 'video') {
      this.drawVideoBackground(ctx, project.canvas, width, height, scene.styleScale, frames.background || null);
    } else {
      ctx.drawImage(this.backgroundLayer(project.canvas, width, height, scene.styleScale, scene.outputTime ?? 0), 0, 0);
    }
    const screenVisibility = 1 - clamp(scene.stickerBackdrop?.screenSuppression ?? 0, 0, 1);
    if (screenVisibility > 0.001) {
      ctx.save();
      ctx.globalAlpha *= screenVisibility;
      this.drawScreen(ctx, scene.screen, frames.screen);
      if (scene.cursor) this.drawCursor(ctx, scene.screen, scene.cursor);
      ctx.restore();
    }
    const cameraVisibility = 1 - clamp(scene.stickerBackdrop?.cameraSuppression ?? 0, 0, 1);
    if (scene.camera && cameraVisibility > 0.001 && (frames.camera || frames.drawCameraPlaceholder)) {
      this.drawCamera(ctx, { ...scene.camera, opacity: (scene.camera.opacity ?? 1) * cameraVisibility }, frames.camera);
    }
    if (scene.stickers && scene.stickers.length) this.drawStickers(ctx, scene.stickers, frames);
  }
}

module.exports = {
  Compositor,
  createOffscreenCanvas,
  createMockCanvas,
  renderPerspectiveMesh,
  drawTexturedTriangle,
};
