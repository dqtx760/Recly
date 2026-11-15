'use strict';

function createHistorySelection(list, { document = list.ownerDocument, onChange = () => {}, isActive = () => true } = {}) {
  const selected = new Set();
  let anchor = null;
  let pendingDrag = null;
  let drag = null;
  let selectionBox = null;
  let scrollFrame = null;
  let suppressNextClick = false;

  const rows = () => Array.from(list.querySelectorAll('.history-item'));
  const rowKey = (row) => row && (row.dataset.projectDirectory || row.getAttribute('data-project-directory'));
  const selectedDirectories = () => rows().map(rowKey).filter((directory) => directory && selected.has(directory));
  const rowForTarget = (target) => {
    const row = target && typeof target.closest === 'function' ? target.closest('.history-item') : null;
    return row && list.contains(row) ? row : null;
  };
  const publish = (next) => {
    selected.clear();
    next.forEach((directory) => selected.add(directory));
    for (const row of rows()) {
      const directory = rowKey(row);
      const isSelected = Boolean(directory && selected.has(directory));
      row.classList.toggle('is-selected', isSelected);
      row.setAttribute('aria-selected', String(isSelected));
    }
    onChange(selectedDirectories());
  };
  const selectRow = (row, { preserveIfSelected = false } = {}) => {
    const directory = rowKey(row);
    if (!directory) return;
    if (preserveIfSelected && selected.has(directory)) return;
    anchor = directory;
    publish(new Set([directory]));
  };
  const clear = () => {
    anchor = null;
    publish(new Set());
  };
  const selectAll = () => {
    const all = rows().map(rowKey).filter(Boolean);
    anchor = all[0] || null;
    publish(new Set(all));
  };
  const selectRange = (row, additive) => {
    const currentRows = rows();
    const anchorIndex = currentRows.findIndex((item) => rowKey(item) === anchor);
    const rowIndex = currentRows.indexOf(row);
    if (anchorIndex < 0 || rowIndex < 0) {
      selectRow(row);
      return;
    }
    const next = additive ? new Set(selected) : new Set();
    for (let index = Math.min(anchorIndex, rowIndex); index <= Math.max(anchorIndex, rowIndex); index += 1) {
      const directory = rowKey(currentRows[index]);
      if (directory) next.add(directory);
    }
    publish(next);
  };

  const scrollContainer = () => {
    const candidates = [];
    for (let element = list; element; element = element.parentElement) candidates.push(element);
    const view = document.defaultView;
    for (const element of candidates) {
      if (element.scrollHeight > element.clientHeight) return element;
      if (view && view.getComputedStyle) {
        const overflowY = view.getComputedStyle(element).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') return element;
      }
    }
    return document.scrollingElement || list;
  };
  const contentY = (clientY, container) => {
    const bounds = container.getBoundingClientRect();
    return container.scrollTop + clientY - bounds.top;
  };
  const updateSelectionBox = () => {
    if (!drag || !selectionBox) return;
    const left = Math.min(drag.startX, drag.currentX);
    const top = Math.min(drag.startClientY, drag.currentClientY);
    selectionBox.style.left = `${left}px`;
    selectionBox.style.top = `${top}px`;
    selectionBox.style.width = `${Math.abs(drag.currentX - drag.startX)}px`;
    selectionBox.style.height = `${Math.abs(drag.currentClientY - drag.startClientY)}px`;
  };
  const updateDragSelection = () => {
    if (!drag) return;
    drag.currentY = contentY(drag.currentClientY, drag.scroll);
    updateSelectionBox();
    const left = Math.min(drag.startX, drag.currentX);
    const right = Math.max(drag.startX, drag.currentX);
    const top = Math.min(drag.startY, drag.currentY);
    const bottom = Math.max(drag.startY, drag.currentY);
    const scrollBounds = drag.scroll.getBoundingClientRect();
    const next = new Set(drag.base);
    for (const row of rows()) {
      const directory = rowKey(row);
      if (!directory) continue;
      const bounds = row.getBoundingClientRect();
      const rowTop = bounds.top + drag.scroll.scrollTop - scrollBounds.top;
      const rowBottom = bounds.bottom + drag.scroll.scrollTop - scrollBounds.top;
      const horizontalHit = left === right
        ? left >= bounds.left && left <= bounds.right
        : bounds.left < right && bounds.right > left;
      const verticalHit = top === bottom
        ? top >= rowTop && top <= rowBottom
        : rowTop < bottom && rowBottom > top;
      if (horizontalHit && verticalHit) next.add(directory);
    }
    publish(next);
  };
  const edgeScrollDelta = () => {
    if (!drag) return 0;
    const bounds = drag.scroll.getBoundingClientRect();
    if (drag.currentX < bounds.left || drag.currentX > bounds.right) return 0;
    const edge = Math.min(36, Math.max(18, Math.floor(bounds.height / 5)));
    if (drag.currentClientY < bounds.top + edge) {
      return -Math.min(24, Math.max(4, Math.ceil((bounds.top + edge - drag.currentClientY) / 2)));
    }
    if (drag.currentClientY > bounds.bottom - edge) {
      return Math.min(24, Math.max(4, Math.ceil((drag.currentClientY - (bounds.bottom - edge)) / 2)));
    }
    return 0;
  };
  const cancelScrollFrame = () => {
    if (scrollFrame === null) return;
    const view = document.defaultView;
    if (view && view.cancelAnimationFrame) view.cancelAnimationFrame(scrollFrame);
    else clearTimeout(scrollFrame);
    scrollFrame = null;
  };
  const scheduleEdgeScroll = () => {
    if (!drag || !edgeScrollDelta() || scrollFrame !== null) return;
    const view = document.defaultView;
    const requestFrame = view && view.requestAnimationFrame
      ? view.requestAnimationFrame.bind(view)
      : (callback) => setTimeout(callback, 16);
    scrollFrame = requestFrame(() => {
      scrollFrame = null;
      if (!drag) return;
      const delta = edgeScrollDelta();
      const maximum = Math.max(0, drag.scroll.scrollHeight - drag.scroll.clientHeight);
      const before = drag.scroll.scrollTop;
      drag.scroll.scrollTop = Math.max(0, Math.min(maximum, before + delta));
      if (drag.scroll.scrollTop !== before) updateDragSelection();
      scheduleEdgeScroll();
    });
  };
  const beginDrag = () => {
    if (!pendingDrag) return;
    const scroll = scrollContainer();
    drag = {
      startX: pendingDrag.startX,
      currentX: pendingDrag.startX,
      startClientY: pendingDrag.startY,
      currentClientY: pendingDrag.startY,
      startY: contentY(pendingDrag.startY, scroll),
      currentY: contentY(pendingDrag.startY, scroll),
      scroll,
      base: pendingDrag.additive ? new Set(selected) : new Set(),
      pointerId: pendingDrag.pointerId,
    };
    pendingDrag = null;
    selectionBox = document.createElement('div');
    selectionBox.className = 'history-selection-box';
    selectionBox.setAttribute('aria-hidden', 'true');
    document.body.append(selectionBox);
    updateDragSelection();
  };
  const finishDrag = (suppressClick) => {
    if (selectionBox) selectionBox.remove();
    selectionBox = null;
    drag = null;
    pendingDrag = null;
    cancelScrollFrame();
    if (suppressClick) {
      suppressNextClick = true;
      setTimeout(() => { suppressNextClick = false; }, 0);
    }
  };

  const onPointerDown = (event) => {
    if (event.button !== 0 || !isActive()) return;
    pendingDrag = {
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      additive: Boolean(event.ctrlKey || event.metaKey),
    };
  };
  const onPointerMove = (event) => {
    if (pendingDrag && (pendingDrag.pointerId === undefined || event.pointerId === pendingDrag.pointerId)) {
      const distance = Math.hypot(event.clientX - pendingDrag.startX, event.clientY - pendingDrag.startY);
      if (distance >= 5) beginDrag();
    }
    if (!drag || (drag.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    drag.currentX = event.clientX;
    drag.currentClientY = event.clientY;
    updateDragSelection();
    if (edgeScrollDelta()) scheduleEdgeScroll();
    else cancelScrollFrame();
    event.preventDefault();
  };
  const onPointerUp = (event) => {
    if (!drag && !pendingDrag) return;
    if (drag && drag.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
    finishDrag(Boolean(drag));
  };
  const onPointerCancel = () => finishDrag(false);
  const onClick = (event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      return;
    }
    if (!isActive()) return;
    const row = rowForTarget(event.target);
    if (!row) {
      clear();
      return;
    }
    if (event.shiftKey) selectRange(row, Boolean(event.ctrlKey || event.metaKey));
    else if (event.ctrlKey || event.metaKey) {
      const directory = rowKey(row);
      if (!directory) return;
      const next = new Set(selected);
      if (next.has(directory)) next.delete(directory);
      else next.add(directory);
      anchor = directory;
      publish(next);
    } else selectRow(row);
  };
  const onKeyDown = (event) => {
    if (!isActive()) return;
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      if (rows().length) {
        event.preventDefault();
        selectAll();
      }
    } else if (event.key === 'Escape' && selected.size) {
      event.preventDefault();
      clear();
    }
  };

  list.addEventListener('pointerdown', onPointerDown);
  list.addEventListener('click', onClick, true);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
  document.addEventListener('keydown', onKeyDown);
  onChange([]);

  return {
    clear,
    getSelectedDirectories: selectedDirectories,
    getSelectedRows: () => rows().filter((row) => {
      const directory = rowKey(row);
      return directory && selected.has(directory);
    }),
    selectRow,
    selectAll,
    destroy() {
      list.removeEventListener('pointerdown', onPointerDown);
      list.removeEventListener('click', onClick, true);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      document.removeEventListener('keydown', onKeyDown);
      finishDrag(false);
    },
  };
}

module.exports = { createHistorySelection };
