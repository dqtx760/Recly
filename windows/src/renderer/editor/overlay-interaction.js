'use strict';
// 预览区添加入口、图片拖放与贴图画布变换交互。

const { ipcRenderer, webUtils } = require('electron');

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function isImageFile(file) {
  if (!file) return false;
  if (typeof file.type === 'string' && file.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(file.name || '');
}

function nativeFilePath(file) {
  if (typeof file?.path === 'string' && file.path) return file.path;
  try {
    const filePath = webUtils?.getPathForFile?.(file);
    return typeof filePath === 'string' && filePath ? filePath : null;
  } catch {
    return null;
  }
}

function normalizedDegrees(value) {
  let degrees = value % 360;
  if (degrees > 180) degrees -= 360;
  if (degrees < -180) degrees += 360;
  const anchors = [-180, -90, 0, 90, 180];
  const nearest = anchors.reduce((best, item) => Math.abs(degrees - item) < Math.abs(degrees - best) ? item : best, anchors[0]);
  return Math.abs(degrees - nearest) <= 3 ? nearest : degrees;
}

function initOverlayInteraction({
  store,
  preview,
  stage,
  canvasWrap,
  onAddMosaic,
  onImportImage,
  onPasteImage,
  onPasteSelected,
  onShowOverlayInspector,
  onToast,
}) {
  if (!store || !preview || !canvasWrap) throw new TypeError('贴图画布交互缺少 store、preview 或 canvasWrap');
  const root = stage || canvasWrap.closest?.('#stage') || document;
  const addButton = root.querySelector('#preview-add-button');
  const addMenu = root.querySelector('#preview-add-menu');
  const layer = document.createElement('div');
  layer.className = 'overlay-interaction-layer';
  layer.setAttribute('aria-label', '画布贴图操作');
  const dropHint = document.createElement('div');
  dropHint.className = 'preview-drop-hint';
  dropHint.textContent = '松开即可添加贴图';
  dropHint.hidden = true;
  canvasWrap.append(layer, dropHint);
  if (preview.canvas) preview.canvas.tabIndex = 0;

  const controls = new Map();
  let activeDrag = null;
  let animationFrame = 0;
  let dragDepth = 0;
  let disposed = false;

  const toast = (message) => { if (onToast) onToast(message); };
  const menuIsOpen = () => Boolean(addMenu && !addMenu.hidden);
  const closeMenu = () => {
    if (!addMenu || !addButton) return;
    addMenu.hidden = true;
    addButton.setAttribute('aria-expanded', 'false');
  };
  const toggleMenu = () => {
    if (!addMenu || !addButton) return;
    addMenu.hidden = !addMenu.hidden;
    addButton.setAttribute('aria-expanded', addMenu.hidden ? 'false' : 'true');
  };
  const runMenuAction = (action) => {
    closeMenu();
    try {
      const result = action?.();
      if (result && typeof result.catch === 'function') result.catch((error) => toast(error.message || '无法添加画面内容'));
    } catch (error) {
      toast(error.message || '无法添加画面内容');
    }
  };

  const menuActionListeners = [];
  const addMenuActions = [
    ['#preview-add-mosaic', onAddMosaic],
    ['#preview-add-sticker', () => onImportImage?.(null)],
    ['#preview-paste-image', onPasteImage],
  ];
  addMenuActions.forEach(([selector, action]) => {
    const button = root.querySelector(selector);
    if (!button) return;
    const listener = () => runMenuAction(action);
    button.addEventListener('click', listener);
    menuActionListeners.push([button, listener]);
  });
  const onAddButtonClick = () => toggleMenu();
  addButton?.addEventListener('click', onAddButtonClick);
  const closeMenuOutside = (event) => {
    if (menuIsOpen() && !addMenu.contains(event.target) && event.target !== addButton) closeMenu();
  };
  const closeMenuOnEscape = (event) => {
    if (event.key === 'Escape' && menuIsOpen()) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      closeMenu();
      addButton?.focus();
    }
  };
  document.addEventListener('pointerdown', closeMenuOutside);
  document.addEventListener('keydown', closeMenuOnEscape);

  function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    canvasWrap.classList.remove('overlay-drag-active');
    dropHint.hidden = true;
    const files = Array.from(event.dataTransfer?.files || []);
    const file = files.find(isImageFile);
    if (!file) return toast('请拖入图片文件');
    const filePath = nativeFilePath(file);
    if (!filePath) return toast('无法读取拖入图片的本地路径');
    try {
      const result = onImportImage?.(filePath);
      if (result && typeof result.catch === 'function') result.catch((error) => toast(error.message || '贴图导入失败'));
    } catch (error) {
      toast(error.message || '贴图导入失败');
    }
  }

  const onDragEnter = (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    dragDepth += 1;
    canvasWrap.classList.add('overlay-drag-active');
    dropHint.hidden = false;
  };
  const onDragOver = (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    dragDepth = Math.max(dragDepth - 1, 0);
    if (dragDepth === 0) {
      canvasWrap.classList.remove('overlay-drag-active');
      dropHint.hidden = true;
    }
  };
  canvasWrap.addEventListener('dragenter', onDragEnter);
  canvasWrap.addEventListener('dragover', onDragOver);
  canvasWrap.addEventListener('dragleave', onDragLeave);
  canvasWrap.addEventListener('drop', handleDrop);

  const isEditableTarget = (target) => Boolean(target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName));
  const onPasteShortcut = (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== 'v') return;
    if (isEditableTarget(event.target)) return;
    const focusedInPreview = canvasWrap.contains(document.activeElement) || canvasWrap.contains(event.target);
    if (!focusedInPreview) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    ipcRenderer.invoke('clipboard:has-image').then((hasImage) => {
      runMenuAction(hasImage ? onPasteImage : onPasteSelected);
    }).catch((error) => {
      console.error('无法检查系统剪贴板图片', error);
      toast(error.message || '读取系统剪贴板失败');
    });
  };
  window.addEventListener('keydown', onPasteShortcut, true);

  function createControl(id) {
    const box = document.createElement('div');
    box.className = 'overlay-transform';
    box.dataset.overlayId = id;
    box.tabIndex = -1;
    box.setAttribute('role', 'button');
    box.setAttribute('aria-label', '贴图，可拖动定位');
    const stem = document.createElement('i');
    stem.className = 'overlay-rotate-stem';
    stem.setAttribute('aria-hidden', 'true');
    box.append(stem);
    for (const corner of ['nw', 'ne', 'se', 'sw']) {
      const handle = document.createElement('button');
      handle.className = 'overlay-handle';
      handle.type = 'button';
      handle.dataset.overlayAction = `resize-${corner}`;
      handle.setAttribute('aria-label', '调整贴图大小');
      handle.hidden = true;
      box.append(handle);
    }
    const rotation = document.createElement('button');
    rotation.className = 'overlay-handle overlay-rotate';
    rotation.type = 'button';
    rotation.dataset.overlayAction = 'rotate';
    rotation.setAttribute('aria-label', '旋转贴图');
    rotation.textContent = '↻';
    rotation.hidden = true;
    box.append(rotation);
    box.addEventListener('pointerdown', (event) => startStickerDrag(event, id));
    layer.append(box);
    controls.set(id, box);
    return box;
  }

  function startStickerDrag(event, id) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const selectedBefore = store.selection?.type === 'sticker' && store.selection.id === id;
    if (!selectedBefore) {
      store.select({ type: 'sticker', id });
    } else onShowOverlayInspector?.('sticker');
    if (preview.playing) preview.pause();
    const clip = store.getClip ? store.getClip('sticker', id) : store.project.timeline.stickerClips.find((item) => item.id === id);
    const canvasRect = preview.canvas.getBoundingClientRect();
    const sceneSticker = preview.scene?.stickers?.find((item) => item.id === id);
    if (!clip || !canvasRect.width || !canvasRect.height || !sceneSticker) return;
    const actionNode = event.target?.closest?.('[data-overlay-action]');
    const action = actionNode?.dataset.overlayAction || 'move';
    const center = {
      x: canvasRect.left + (sceneSticker.centerX / (preview.scene.width || preview.canvas.width)) * canvasRect.width,
      y: canvasRect.top + (sceneSticker.centerY / (preview.scene.height || preview.canvas.height)) * canvasRect.height,
    };
    const startAngle = Math.atan2(event.clientY - center.y, event.clientX - center.x);
    activeDrag = {
      id,
      action,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      center,
      startAngle,
      startRadius: Math.max(Math.hypot(event.clientX - center.x, event.clientY - center.y), 1),
      startPosition: { ...clip.position },
      startWidth: clip.width,
      startRotation: clip.rotationDegrees ?? clip.rotation ?? 0,
      canvasRect,
      canvasWidth: preview.scene.width || preview.canvas.width,
      canvasHeight: preview.scene.height || preview.canvas.height,
      aspectRatio: clip.aspectRatio || 1,
    };
    store.beginGesture();
    preview.canvas.focus?.();
    window.addEventListener('pointermove', onStickerPointerMove);
    window.addEventListener('pointerup', endStickerPointer, { once: true });
    window.addEventListener('pointercancel', endStickerPointer, { once: true });
  }

  function onStickerPointerMove(event) {
    const drag = activeDrag;
    if (!drag || (drag.pointerId !== undefined && event.pointerId !== undefined && drag.pointerId !== event.pointerId)) return;
    store.mutate((project) => {
      const clip = project.timeline.stickerClips.find((item) => item.id === drag.id);
      if (!clip) return;
      if (drag.action === 'move') {
        const halfWidth = Math.min((clip.width || drag.startWidth) / 2, 0.5);
        const halfHeight = Math.min(((clip.width || drag.startWidth) * drag.canvasWidth / drag.canvasHeight / drag.aspectRatio) / 2, 0.5);
        clip.position = {
          x: clamp(drag.startPosition.x + (event.clientX - drag.startX) / drag.canvasRect.width, halfWidth, 1 - halfWidth),
          y: clamp(drag.startPosition.y + (event.clientY - drag.startY) / drag.canvasRect.height, halfHeight, 1 - halfHeight),
        };
      } else if (drag.action.startsWith('resize-')) {
        const radius = Math.hypot(event.clientX - drag.center.x, event.clientY - drag.center.y);
        clip.width = clamp(drag.startWidth * radius / drag.startRadius, 0.03, 1.5);
      } else if (drag.action === 'rotate') {
        let delta = Math.atan2(event.clientY - drag.center.y, event.clientX - drag.center.x) - drag.startAngle;
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        clip.rotationDegrees = normalizedDegrees(drag.startRotation + delta * 180 / Math.PI);
      }
    }, { history: false });
  }

  function endStickerPointer(event) {
    if (!activeDrag || (activeDrag.pointerId !== undefined && event.pointerId !== undefined && activeDrag.pointerId !== event.pointerId)) return;
    window.removeEventListener('pointermove', onStickerPointerMove);
    window.removeEventListener('pointerup', endStickerPointer);
    window.removeEventListener('pointercancel', endStickerPointer);
    activeDrag = null;
    store.endGesture();
  }

  function syncControls() {
    animationFrame = 0;
    if (disposed) return;
    const scene = preview.scene;
    const stickers = scene?.stickers || [];
    const canvasRect = preview.canvas?.getBoundingClientRect?.();
    const wrapRect = canvasWrap.getBoundingClientRect();
    if (canvasRect && scene?.width && scene?.height) {
      layer.style.left = `${canvasRect.left - wrapRect.left}px`;
      layer.style.top = `${canvasRect.top - wrapRect.top}px`;
      layer.style.width = `${canvasRect.width}px`;
      layer.style.height = `${canvasRect.height}px`;
    }
    const activeIds = new Set(stickers.map((sticker) => sticker.id));
    for (const [id, node] of controls) {
      if (!activeIds.has(id)) {
        node.remove();
        controls.delete(id);
      }
    }
    if (!canvasRect || !scene?.width || !scene?.height) {
      animationFrame = requestAnimationFrame(syncControls);
      return;
    }
    const selectedId = store.selection?.type === 'sticker' ? store.selection.id : null;
    for (const sticker of stickers) {
      const box = controls.get(sticker.id) || createControl(sticker.id);
      const selected = sticker.id === selectedId;
      box.classList.toggle('selected', selected);
      box.tabIndex = selected ? 0 : -1;
      box.style.left = `${(sticker.centerX / scene.width) * canvasRect.width}px`;
      box.style.top = `${(sticker.centerY / scene.height) * canvasRect.height}px`;
      box.style.width = `${(sticker.width / scene.width) * canvasRect.width}px`;
      box.style.height = `${(sticker.height / scene.height) * canvasRect.height}px`;
      box.style.transform = `translate(-50%, -50%) rotate(${sticker.rotation}deg)`;
      box.style.zIndex = selected ? '10000' : String(sticker.layerIndex || 0);
      box.setAttribute('aria-pressed', selected ? 'true' : 'false');
      box.querySelectorAll('.overlay-handle').forEach((handle) => { handle.hidden = !selected; });
    }
    animationFrame = requestAnimationFrame(syncControls);
  }

  const onStoreChange = (reason) => {
    if (reason === 'selection' && ['sticker', 'mosaic'].includes(store.selection?.type)) onShowOverlayInspector?.(store.selection.type);
  };
  store.subscribe(onStoreChange);
  syncControls();

  return () => {
    disposed = true;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    if (activeDrag) endStickerPointer({ pointerId: activeDrag.pointerId });
    store.listeners?.delete(onStoreChange);
    document.removeEventListener('pointerdown', closeMenuOutside);
    document.removeEventListener('keydown', closeMenuOnEscape);
    window.removeEventListener('keydown', onPasteShortcut, true);
    addButton?.removeEventListener('click', onAddButtonClick);
    menuActionListeners.forEach(([button, listener]) => button.removeEventListener('click', listener));
    canvasWrap.removeEventListener('dragenter', onDragEnter);
    canvasWrap.removeEventListener('dragover', onDragOver);
    canvasWrap.removeEventListener('dragleave', onDragLeave);
    canvasWrap.removeEventListener('drop', handleDrop);
    layer.remove();
    dropHint.remove();
  };
}

module.exports = { initOverlayInteraction, isImageFile, nativeFilePath, normalizedDegrees };
