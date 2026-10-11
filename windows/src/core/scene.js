'use strict';
// 一帧画面的几何求值：屏幕卡片、摄像头、光标。预览与导出共用同一份结果。
// 移植自 RecorderCore/CompositionScene.swift、FrameScene.swift、CursorRenderGeometry.swift。

const { clamp, CAMERA_SHAPES } = require('./model');
const { sampleZoom, viewportTransform, activeClipIndex, adjacentPreviousClip } = require('./zoom');
const { NormalizedCrop, decorationInsets, screenDecoration } = require('./crop-frame');
const { ScreenProjection } = require('./projection');
const { openingSample, evaluateMosaics, evaluateStickers, evaluateStickerBackdrop } = require('./opening-overlay');
const { evaluateCameraMotion, resolveCameraState } = require('./camera-motion');
const { evaluateScreenMotionLayout } = require('./screen-motion');
const CURSOR_CANONICAL_HEIGHT = 44;
const CANONICAL_SHORT_EDGE = 1080;

/// 项目里的视觉尺寸按 1080 短边设计，随输出短边等比缩放，
/// 这样留白、圆角、阴影在 1080p、4K 和任意预览尺寸下构图一致。
const canonicalStyleScale = (width, height) => Math.max(Math.min(width, height), 1) / CANONICAL_SHORT_EDGE;

function aspectFit(aspectRatio, width, height) {
  const aspect = Math.max(aspectRatio, 0.01);
  return width / Math.max(height, 1) > aspect
    ? { width: height * aspect, height }
    : { width, height: width / aspect };
}

function evaluateScreen(project, time, width, height, sourceAspect, zoomClips, pointerTrack, screenMotionClips, motionStyle) {
  const canvas = project.canvas || {};
  const scale = canonicalStyleScale(width, height);
  const padding = clamp((canvas.padding ?? 100) * scale, 0, Math.min(width, height) * 0.42);
  const rawCrop = canvas.crop;
  const crop = rawCrop
    ? (rawCrop instanceof NormalizedCrop ? rawCrop.clamped() : new NormalizedCrop(rawCrop.x, rawCrop.y, rawCrop.width, rawCrop.height).clamped())
    : new NormalizedCrop();
  const croppedAspect = Math.max((sourceAspect || 16 / 9) * crop.width / Math.max(crop.height, 0.0001), 0.01);
  const fitted = aspectFit(croppedAspect, Math.max(width - padding * 2, 2), Math.max(height - padding * 2, 2));
  const fittedRect = { x: (width - fitted.width) / 2, y: (height - fitted.height) / 2, width: fitted.width, height: fitted.height };

  const borderWidthAtScaleOne = clamp(canvas.borderWidth ?? 0, 0, 60) * scale;
  const insetsAtScaleOne = decorationInsets({
    style: canvas.screenFrame || 'none',
    frameScale: canvas.screenFrameScale,
    toolbarScale: canvas.screenFrameToolbarScale,
    fittedWidth: fittedRect.width,
    fittedHeight: fittedRect.height,
    styleScale: scale,
  });
  const screenMotionSample = evaluateScreenMotionLayout(
    screenMotionClips,
    time,
    {
      position: canvas.contentPosition,
      scale: canvas.contentScale,
      rotationX: canvas.rotationX,
      rotationY: canvas.rotationY,
      rotationZ: canvas.rotationZ,
      perspective: canvas.perspective,
    },
    motionStyle,
    {
      canvasWidth: width,
      canvasHeight: height,
      fittedWidth: fittedRect.width,
      fittedHeight: fittedRect.height,
      borderWidthAtScaleOne,
      decorationTopAtScaleOne: insetsAtScaleOne.top,
      decorationRightAtScaleOne: insetsAtScaleOne.right,
      decorationBottomAtScaleOne: insetsAtScaleOne.bottom,
      decorationLeftAtScaleOne: insetsAtScaleOne.left,
    }
  );
  const screenMotion = screenMotionSample.state;
  const manualScale = clamp(screenMotion.scale, 0.2, 4);
  const baseBorderWidth = clamp(canvas.borderWidth ?? 0, 0, 60) * scale * manualScale;
  const scaledWidth = fittedRect.width * manualScale;
  const scaledHeight = fittedRect.height * manualScale;
  const contentPos = screenMotion.position || canvas.contentPosition || { x: 0.5, y: 0.5 };
  // 定位的是带外描边的完整卡片：贴边时描边仍留在画布内。
  const offsetX = screenMotionSample.manualOffset?.x
    ?? (contentPos.x - 0.5) * (width - (scaledWidth + baseBorderWidth * 2));
  const offsetY = screenMotionSample.manualOffset?.y
    ?? (contentPos.y - 0.5) * (height - (scaledHeight + baseBorderWidth * 2));
  const baseRect = {
    x: fittedRect.x + fittedRect.width / 2 - scaledWidth / 2 + offsetX,
    y: fittedRect.y + fittedRect.height / 2 - scaledHeight / 2 + offsetY,
    width: scaledWidth,
    height: scaledHeight,
  };

  // 自动缩放段的镜头跟随指针：当前段取此刻的跟随位置，相接的前一段取它结束时的位置。
  const sampleTime = Math.max(time, 0);
  let automaticFocus = null;
  let inheritedAutomaticFocus = null;
  const activeIndex = pointerTrack ? activeClipIndex(zoomClips, sampleTime) : -1;
  if (activeIndex >= 0) {
    const active = zoomClips[activeIndex];
    if (active.origin === 'automatic') automaticFocus = pointerTrack.automaticCameraFocus(sampleTime, active, project.motion);
    const previous = adjacentPreviousClip(zoomClips, activeIndex);
    if (previous && previous.origin === 'automatic') inheritedAutomaticFocus = pointerTrack.automaticCameraFocus(previous.endTime, previous, project.motion);
  }
  const zoom = sampleZoom(zoomClips, sampleTime, project.motion, automaticFocus, inheritedAutomaticFocus);
  // 素材已铺满画布时在该视口内缩放，不露出画布边缘。
  const tolerance = Math.max(width, height) * 1e-9;
  const keepsCanvasCovered = (canvas.screenFrame || 'none') === 'none'
    && !screenMotionSample.isActive
    && baseRect.x <= tolerance && baseRect.y <= tolerance
    && baseRect.x + baseRect.width >= width - tolerance
    && baseRect.y + baseRect.height >= height - tolerance;
  const visibleRect = keepsCanvasCovered
    ? { x: -baseRect.x / baseRect.width, y: -baseRect.y / baseRect.height, width: width / baseRect.width, height: height / baseRect.height }
    : null;
  const viewport = viewportTransform(zoom, visibleRect);
  const decorationGrowth = manualScale * (viewport.scale - 1) / 2;
  const finalRect = {
    x: baseRect.x + baseRect.width / 2 - baseRect.width * viewport.scale / 2
      + viewport.translation.x * baseRect.width
      + (insetsAtScaleOne.left - insetsAtScaleOne.right) * decorationGrowth,
    y: baseRect.y + baseRect.height / 2 - baseRect.height * viewport.scale / 2
      + viewport.translation.y * baseRect.height
      + (insetsAtScaleOne.top - insetsAtScaleOne.bottom) * decorationGrowth,
    width: baseRect.width * viewport.scale,
    height: baseRect.height * viewport.scale,
  };
  const magnification = scale * manualScale * viewport.scale;
  return {
    crop,
    screenMotion,
    projectionAnchor: screenMotionSample.projectionAnchor,
    fittedRect,
    baseRect,
    manualOffset: { x: offsetX, y: offsetY },
    finalRect,
    zoom,
    viewport,
    cornerRadius: keepsCanvasCovered ? 0 : Math.max(canvas.cornerRadius ?? 24, 0) * magnification,
    borderWidth: baseBorderWidth * viewport.scale,
    borderColor: canvas.borderColor || '#FFFFFF',
    shadow: (canvas.shadowStrength ?? 0.28) > 0 && !keepsCanvasCovered
      ? { opacity: canvas.shadowStrength ?? 0.28, radius: 22 * magnification, offsetY: 12 * magnification }
      : null,
  };
}

function openingRect(rect, sample) {
  if (!sample || (sample.scale === 1 && (!sample.offset || (sample.offset.x === 0 && sample.offset.y === 0)))) {
    return { ...rect };
  }
  const width = rect.width * (sample.scale ?? 1);
  const height = rect.height * (sample.scale ?? 1);
  const offX = sample.offset?.x ?? 0;
  const offY = sample.offset?.y ?? 0;
  return {
    x: rect.x + rect.width / 2 - width / 2 + offX,
    y: rect.y + rect.height / 2 - height / 2 + offY,
    width,
    height,
  };
}

function evaluateCamera(style, cameraAspect, screenZoomScale, width, height, cameraMotionSample, cameraOpening) {
  const styleScale = canonicalStyleScale(width, height);
  const base = Math.min(width, height);
  const sample = cameraMotionSample || resolveCameraState(style, cameraAspect, width / height);

  const zoomProgress = clamp((screenZoomScale - 1) / 0.565, 0, 1);
  const zoomScale = 1 + ((style.scaleDuringZoom ?? 0.7) - 1) * zoomProgress;
  const preferredHeight = Math.min(
    Math.max(base * (sample.size ?? 0.29) * zoomScale, 72 * styleScale),
    base * 1.2
  );
  const preferredWidth = preferredHeight * Math.max(sample.aspectRatio ?? 1, 0.01);
  const fitScale = Math.min(
    1,
    width * 1.2 / Math.max(preferredWidth, 0.0001),
    height * 1.2 / Math.max(preferredHeight, 0.0001)
  );
  const cameraWidth = preferredWidth * fitScale;
  const cameraHeight = preferredHeight * fitScale;
  const posX = clamp(sample.position?.x ?? 0.96, 0, 1);
  const posY = clamp(sample.position?.y ?? 0.47, 0, 1);
  const shapedRect = {
    x: posX * (width - cameraWidth),
    y: posY * (height - cameraHeight),
    width: cameraWidth,
    height: cameraHeight,
  };
  const fullscreenProgress = clamp(sample.fullscreenProgress ?? 0, 0, 1);
  const baseRect = {
    x: shapedRect.x + (0 - shapedRect.x) * fullscreenProgress,
    y: shapedRect.y + (0 - shapedRect.y) * fullscreenProgress,
    width: shapedRect.width + (width - shapedRect.width) * fullscreenProgress,
    height: shapedRect.height + (height - shapedRect.height) * fullscreenProgress,
  };

  const rect = cameraOpening ? openingRect(baseRect, cameraOpening) : baseRect;
  const cornerFraction = clamp(sample.cornerFraction ?? 0.25, 0, 0.5);
  const openingScale = cameraOpening?.scale ?? 1;
  const openingOpacity = cameraOpening?.opacity ?? 1;
  const radius = Math.min(rect.width, rect.height) * cornerFraction * (1 - fullscreenProgress);

  return {
    rect,
    cornerRadius: radius * openingScale,
    borderWidth: clamp(style.borderWidth ?? 3, 0, 18) * styleScale * (1 - fullscreenProgress) * openingScale,
    shadow: (style.shadowStrength ?? 0.25) > 0 && fullscreenProgress < 0.99
      ? {
          opacity: (style.shadowStrength ?? 0.25) * openingOpacity,
          radius: 14 * styleScale * openingScale,
          offsetY: 8 * styleScale * openingScale,
        }
      : null,
    isMirrored: Boolean(style.isMirrored),
    contentScale: clamp(style.contentScale ?? 1, 1, 4),
    contentPosition: {
      x: clamp(style.contentPosition?.x ?? 0.5, 0, 1),
      y: clamp(style.contentPosition?.y ?? 0.5, 0, 1),
    },
    opacity: clamp(sample.opacity ?? 1, 0, 1) * openingOpacity,
    fullscreenProgress,
  };
}

/// 对应 CursorRenderGeometry.clickGeometry：返回主环、副环与（聚焦微闪的）四个强调点。
function clickGeometry(style, progress, baseHeight, opacityMultiplier, scaleMultiplier) {
  if (style === 'none' || !(progress >= 0 && progress <= 1) || baseHeight <= 0) return null;
  const opacity = clamp(opacityMultiplier, 0.05, 1);
  const h = baseHeight * clamp(scaleMultiplier, 0.4, 3);
  const ring = (diameter, lineWidth, alpha, filled, glow) => ({ diameter, lineWidth, opacity: Math.max(alpha, 0), filled, glow });
  const none = ring(0, 0, 0, false, 0);
  if (style === 'ripple') {
    const e = 1 - (1 - progress) ** 3;
    const dot = progress / 0.35;
    return {
      primary: ring(h * (0.45 + 1.45 * e), Math.max(h * (0.075 - 0.04 * progress), 1.2), opacity * 0.95 * (1 - progress ** 1.3), false, h * 0.10 * (1 - progress)),
      secondary: progress < 0.35 ? ring(h * 0.28 * (1 - dot), 0, opacity * 0.85 * (1 - dot), true, h * 0.08 * (1 - dot)) : none,
    };
  }
  if (style === 'glow') {
    let diameter;
    let alpha;
    if (progress < 0.18) {
      const bloom = progress / 0.18;
      diameter = h * (0.75 + 0.50 * (1 - (1 - bloom) ** 2));
      alpha = opacity * 0.78 * bloom;
    } else {
      const fade = (progress - 0.18) / 0.82;
      diameter = h * (1.25 + 0.55 * fade);
      alpha = opacity * 0.78 * (1 - fade ** 1.4);
    }
    return { primary: ring(diameter, 0, alpha, true, h * 0.30), secondary: ring(diameter * 0.5, 0, alpha * 0.75, true, h * 0.18) };
  }
  if (style === 'pulse') {
    const e = 1 - (1 - progress) ** 2.5;
    const inner = progress / 0.55;
    return {
      primary: ring(h * (0.50 + 1.25 * e), Math.max(h * 0.065, 1.2), opacity * 0.90 * (1 - progress), false, h * 0.10 * (1 - progress)),
      secondary: progress <= 0.55
        ? ring(h * (0.25 + 0.45 * Math.sin(inner * Math.PI)), 0, opacity * 0.55 * (1 - inner), true, h * 0.12 * (1 - inner))
        : none,
    };
  }
  // burst
  const burst = 1 - (1 - progress) ** 2;
  return {
    primary: ring(Math.max(h * (0.35 - 0.18 * progress), 1), 0, opacity * 0.95 * (1 - progress ** 2), true, h * 0.14 * (1 - progress)),
    secondary: ring(h * (0.45 + 0.55 * progress), Math.max(h * 0.035, 1), opacity * 0.55 * (1 - progress), false, h * 0.08 * (1 - progress)),
    accent: { offset: h * (0.28 + 0.38 * burst), size: Math.max(h * 0.075 * (1 - progress), 1.2), opacity: Math.max(opacity * 0.85 * (1 - progress), 0) },
  };
}

function evaluateCursor(project, time, screen, width, height, pointerTrack) {
  if (!pointerTrack) return null;
  const style = project.cursorStyle;
  const sample = pointerTrack.evaluation(time + (style.timeOffset || 0), project.motion, style).cursor;
  if (!sample) return null;
  const { x, y } = sample.location;
  const crop = screen.crop || { x: 0, y: 0, width: 1, height: 1 };
  if (x < crop.x || x > crop.x + crop.width || y < crop.y || y > crop.y + crop.height) return null;
  const localX = (x - crop.x) / crop.width;
  const localY = (y - crop.y) / crop.height;
  const shortEdge = Math.min(width, height);
  // 光标大小只跟画布短边走，不随屏幕缩放放大。
  const referenceHeight = Math.max(shortEdge * CURSOR_CANONICAL_HEIGHT / CANONICAL_SHORT_EDGE * clamp(style.size, 0.25, 6), 1);
  // finalRect 已经包含屏幕 zoom 的缩放和平移，所以这里只把源点映射到裁切后的归一化空间。
  let curX = screen.finalRect.x + localX * screen.finalRect.width;
  let curY = screen.finalRect.y + localY * screen.finalRect.height;
  if (screen.projectedQuad && (screen.rotationX || screen.rotationY || screen.rotationZ)) {
    const projectedPoint = screen.projectedQuad.project({ x: curX, y: curY }, screen.finalRect);
    if (projectedPoint && Number.isFinite(projectedPoint.x) && Number.isFinite(projectedPoint.y)) {
      curX = projectedPoint.x;
      curY = projectedPoint.y;
    }
  }
  return {
    x: curX,
    y: curY,
    height: referenceHeight,
    appearance: style.appearance === 'automatic' ? sample.recordedCursor : style.appearance,
    shadow: { opacity: 0.42, radius: Math.max(referenceHeight * 1.5 / 44, 0.5), offsetY: Math.max(referenceHeight / 44, 0.5) },
    click: sample.clickPhase
      ? clickGeometry(style.clickEffectStyle, sample.clickPhase.progress, referenceHeight, style.clickOpacity, style.clickScale)
      : null,
    clickColor: style.clickColor,
  };
}

/// time 为素材时间（秒）。zoomClips 需先经过 zoom.orderedClips。
function evaluateScene(project, options = {}) {
  const {
    time = 0,
    width = 1920,
    height = 1080,
    sourceAspect = 16 / 9,
    cameraAspect = null,
    zoomClips = [],
    pointerTrack = null,
  } = options;
  const w = Math.max(width, 2);
  const h = Math.max(height, 2);
  const sampleTime = Math.max(time, 0);
  const outputTime = Number.isFinite(options.outputTime) ? Math.max(options.outputTime, 0) : sampleTime;
  const styleScale = canonicalStyleScale(w, h);

  // 1. 评估屏幕卡片基础几何与裁切
  const screen = evaluateScreen(
    project,
    sampleTime,
    w,
    h,
    sourceAspect,
    zoomClips,
    pointerTrack,
    options.screenMotionClips || project.timeline?.screenMotionClips,
    project.motion
  );
  const screenMotion = screen.screenMotion;

  // 2. 开场序列
  const openingSeq = project.openingSequence;
  const openingSourceTime = project.timeline?.segments?.[0]?.sourceStart ?? 0;
  const hasOpeningSticker = Boolean(
    (options.stickerClips || project.timeline?.stickerClips)?.some(clip => {
      const start = clip.timing?.startTime ?? clip.startTime ?? 0;
      const end = clip.timing?.endTime ?? (start + (clip.timing?.duration ?? clip.duration ?? 0));
      return start <= openingSourceTime + 0.0001 && end > openingSourceTime + 0.0001;
    })
  );
  const hasOpeningCamera = Boolean(
    (cameraAspect || project.media?.camera) && !project.camera?.isHidden
  );
  const seqElementOrder = openingSeq?.elementOrder || ['screen', 'camera', 'stickers'];
  const seqIncluded = new Set(openingSeq?.includedElements || ['screen', 'camera', 'stickers']);
  const availableOpeningElements = seqElementOrder.filter(elem => {
    if (!seqIncluded.has(elem)) return false;
    if (elem === 'screen') return true;
    if (elem === 'camera') return hasOpeningCamera;
    if (elem === 'stickers') return hasOpeningSticker;
    return false;
  });

  const screenOpening = openingSample(
    'screen',
    openingSeq,
    availableOpeningElements,
    outputTime,
    w,
    h
  );

  if (screenOpening && (screenOpening.scale !== 1 || (screenOpening.offset && (screenOpening.offset.x !== 0 || screenOpening.offset.y !== 0)))) {
    screen.finalRect = openingRect(screen.finalRect, screenOpening);
    screen.cornerRadius *= screenOpening.scale;
    screen.borderWidth *= screenOpening.scale;
    if (screen.shadow) {
      screen.shadow.radius *= screenOpening.scale;
      screen.shadow.offsetY *= screenOpening.scale;
    }
  }

  // 3. 屏幕外框与装饰
  const screenFrameStyle = project.canvas?.screenFrame || 'none';
  const decoration = screenDecoration({
    style: screenFrameStyle,
    frameScale: project.canvas?.screenFrameScale ?? 1,
    toolbarScale: project.canvas?.screenFrameToolbarScale ?? 1,
    outerCornerRadius: project.canvas?.screenFrameOuterCornerRadius,
    contentCornerRadius: project.canvas?.screenFrameContentCornerRadius,
    title: project.canvas?.screenFrameTitle ?? '',
    browserAddress: project.canvas?.screenFrameBrowserAddress ?? '',
    geometry: screen,
    styleScale,
  });

  // 4. 3D 屏幕投影几何
  const rotationX = clamp(screenMotion.rotationX, -89, 89) + (screenOpening?.rotationX || 0);
  const rotationY = clamp(screenMotion.rotationY, -89, 89) + (screenOpening?.rotationY || 0);
  const rotationZ = screenMotion.rotationZ;
  const perspective = Math.min(Math.max(screenMotion.perspective + (screenOpening?.perspective || 0), 0), 2);

  const projectionRect = (decoration && decoration.outerRect && decoration.style !== 'none')
    ? decoration.outerRect
    : screen.finalRect;
  const anchorNorm = screen.projectionAnchor || screenMotion.position;
  const projectionAnchor = {
    x: screen.finalRect.x + screen.finalRect.width * (anchorNorm.x ?? 0.5),
    y: screen.finalRect.y + screen.finalRect.height * (anchorNorm.y ?? 0.5),
  };

  const projectedQuad = ScreenProjection.project({
    rect: projectionRect,
    rotationX,
    rotationY,
    rotationZ,
    perspective,
    anchor: projectionAnchor,
  });

  screen.rotationX = rotationX;
  screen.rotationY = rotationY;
  screen.rotationZ = rotationZ;
  screen.perspective = perspective;
  screen.decoration = decoration;
  screen.projectedQuad = projectedQuad;

  // 5. 马赛克覆盖评估
  const rawMosaicClips = options.mosaicClips || project.timeline?.mosaicClips || [];
  const mosaics = evaluateMosaics(rawMosaicClips, sampleTime);
  screen.mosaics = mosaics;

  // 6. 摄像头运动与开场评估
  const rawCameraClips = options.cameraMotionClips || project.timeline?.cameraMotionClips || [];
  const cameraOpening = openingSample(
    'camera',
    openingSeq,
    availableOpeningElements,
    outputTime,
    w,
    h
  );
  let camera = null;
  if (cameraAspect && !project.camera?.isHidden) {
    const cameraMotionSample = evaluateCameraMotion(
      rawCameraClips,
      project.camera,
      sampleTime,
      project.motion,
      cameraAspect,
      w / h
    );
    camera = evaluateCamera(
      project.camera,
      cameraAspect,
      screen.zoom.scale,
      w,
      h,
      cameraMotionSample,
      cameraOpening
    );
  }

  // 7. 贴图评估与开场形变
  const rawStickerClips = options.stickerClips || project.timeline?.stickerClips || [];
  const stickerOpening = openingSample(
    'stickers',
    openingSeq,
    availableOpeningElements,
    outputTime,
    w,
    h
  );
  const suppressesInitialEntry = Boolean(
    openingSeq?.isEnabled && seqIncluded.has('stickers')
  );
  let stickers = evaluateStickers(rawStickerClips, sampleTime, w, h, {
    suppressesInitialEntry,
    initialSourceTime: openingSourceTime,
  });
  if (stickerOpening && (stickerOpening.scale !== 1 || (stickerOpening.offset && (stickerOpening.offset.x !== 0 || stickerOpening.offset.y !== 0)) || stickerOpening.opacity !== 1)) {
    stickers = stickers.map(item => {
      const updated = { ...item };
      const offX = stickerOpening.offset?.x ?? 0;
      const offY = stickerOpening.offset?.y ?? 0;
      updated.x += offX;
      updated.y += offY;
      updated.centerX = updated.x;
      updated.centerY = updated.y;
      updated.scale *= stickerOpening.scale;
      updated.width *= stickerOpening.scale;
      updated.height *= stickerOpening.scale;
      updated.opacity *= stickerOpening.opacity;
      return updated;
    });
  }
  const stickerBackdrop = evaluateStickerBackdrop(rawStickerClips, sampleTime, stickers);

  // 8. 光标评估
  const cursor = evaluateCursor(project, sampleTime, screen, w, h, pointerTrack);

  const opening = {
    ...screenOpening,
    screen: screenOpening,
    camera: cameraOpening,
    stickers: stickerOpening,
  };

  return {
    width: w,
    height: h,
    styleScale,
    outputTime,
    screenMotion,
    screen,
    camera,
    cursor,
    crop: screen.crop,
    decoration,
    projectedQuad,
    mosaics,
    stickers,
    stickerBackdrop,
    opening,
  };
}

module.exports = { canonicalStyleScale, aspectFit, evaluateScene, evaluateCamera, clickGeometry };
