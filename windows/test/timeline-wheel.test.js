'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (parent?.filename.endsWith('timeline-view.js') && request === '../common') return {};
  if (parent?.filename.endsWith('timeline-view.js') && request === './waveform') return {};
  return originalLoad.call(this, request, parent, isMain);
};
let TimelineView;
try { ({ TimelineView } = require('../src/renderer/editor/timeline-view')); }
finally { Module._load = originalLoad; }

const scroller = { scrollLeft: 120, clientWidth: 400, clientHeight: 200 };
const view = { nodes: { scroller }, zoomLevel: 0 };
const zoomCalls = [];
view.setZoom = (...args) => zoomCalls.push(args);
function wheel(overrides = {}) {
  let prevented = false;
  const event = { altKey: false, ctrlKey: false, deltaX: 0, deltaY: 0, deltaMode: 0, clientX: 230,
    preventDefault() { prevented = true; }, ...overrides };
  TimelineView.prototype.handleWheel.call(view, event);
  return { event, prevented };
}

let result = wheel({ ctrlKey: true, deltaY: 100 });
assert.equal(result.prevented, true, 'Ctrl wheel prevents browser page zoom');
assert.deepEqual(zoomCalls.at(-1), [-0.06, 230], 'Ctrl+wheel down zooms out from the default fit view around the pointer');
result = wheel({ ctrlKey: true, deltaY: -100 });
assert.deepEqual(zoomCalls.at(-1), [0.06, 230], 'Ctrl+wheel up zooms in around the pointer');
result = wheel({ ctrlKey: true, deltaY: 2 });
assert.ok(Math.abs(zoomCalls.at(-1)[0] - (-0.015)) < 1e-9, 'small pixel-based trackpad input is converted to a gentle zoom step');
result = wheel({ altKey: true, deltaY: 2, deltaMode: 1 });
assert.equal(result.prevented, true);
assert.equal(scroller.scrollLeft, 200, 'Alt+wheel moves horizontally using normalized line units');
const previousZoomCallCount = zoomCalls.length;
wheel({ altKey: true, ctrlKey: true, deltaX: -3, deltaY: 5, deltaMode: 1 });
assert.equal(scroller.scrollLeft, 80, 'Alt+horizontal wheel uses its horizontal delta when available');
assert.equal(zoomCalls.length, previousZoomCallCount, 'Alt+Ctrl remains horizontal scrolling and does not zoom');
result = wheel({ deltaY: 100 });
assert.equal(result.prevented, false, 'plain wheel keeps native timeline scrolling');

view.zoomLevel = -0.98;
wheel({ ctrlKey: true, deltaY: 1000 });
assert.deepEqual(zoomCalls.at(-1), [-1, 230], 'Ctrl wheel stops at the 50% fit-scale lower bound');
view.zoomLevel = 0.98;
wheel({ ctrlKey: true, deltaY: -1000 });
assert.deepEqual(zoomCalls.at(-1), [1, 230], 'Ctrl wheel preserves the existing upper bound');

function makeRenderableView(duration = 20) {
  const scrollerNode = { clientWidth: 400, clientHeight: 200, scrollLeft: 0, left: 100 };
  const lanes = {
    style: {},
    getBoundingClientRect: () => ({ left: scrollerNode.left - scrollerNode.scrollLeft }),
  };
  const renderable = Object.create(TimelineView.prototype);
  Object.assign(renderable, {
    nodes: { scroller: scrollerNode, lanes, slider: { value: 0 } },
    preview: { time: 0 },
    zoomLevel: 0,
    renderRuler() {},
    renderSubtitleClips() {},
    renderSegments() {},
    renderAudioClips() {},
    renderZoomClips() {},
    renderEffectClips() {},
    updatePlayhead() {},
  });
  Object.defineProperty(renderable, 'duration', { value: duration });
  return renderable;
}

const renderable = makeRenderableView();
renderable.render();
const fitPps = renderable.pps;
assert.equal(renderable.zoomLevel, 0, 'default timeline view remains fit-to-width');
assert.equal(renderable.nodes.slider.value, 0, 'default slider position remains the fit view');
assert.equal(renderable.pps, (400 - 28) / 20, 'default fit scale is unchanged');
renderable.setZoom(-1);
assert.equal(renderable.pps, fitPps * 0.5, 'minimum zoom renders the project at half of fit scale');
assert.equal(renderable.nodes.slider.value, -1, 'slider reflects the 50% fit-scale minimum');

const anchored = makeRenderableView();
anchored.render();
const anchorX = 300;
const timeBeforeZoom = anchored.timeAt(anchorX);
anchored.setZoom(0.5, anchorX);
assert.ok(Math.abs(anchored.timeAt(anchorX) - timeBeforeZoom) < 1e-8, 'zoom-in keeps the time under the pointer fixed');
anchored.setZoom(0, anchorX);
assert.ok(Math.abs(anchored.timeAt(anchorX) - timeBeforeZoom) < 1e-8, 'zooming back to fit keeps the time under the pointer fixed');

console.log('时间线 Ctrl 滚轮缩放与 Alt 滚轮水平定位通过');
