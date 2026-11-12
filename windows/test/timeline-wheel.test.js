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
const view = { nodes: { scroller }, zoomLevel: 0.5 };
let zoomCall;
view.setZoom = (...args) => { zoomCall = args; };
function wheel(overrides = {}) {
  let prevented = false;
  const event = { altKey: false, ctrlKey: false, deltaX: 0, deltaY: 0, deltaMode: 0, clientX: 230,
    preventDefault() { prevented = true; }, ...overrides };
  TimelineView.prototype.handleWheel.call(view, event);
  return { event, prevented };
}

let result = wheel({ ctrlKey: true, deltaY: 100 });
assert.equal(result.prevented, true, 'Ctrl wheel prevents browser page zoom');
assert.deepEqual(zoomCall, [0.44, 230], 'Ctrl+wheel down zooms out around the pointer');
result = wheel({ ctrlKey: true, deltaY: -100 });
assert.deepEqual(zoomCall, [0.56, 230], 'Ctrl+wheel up zooms in around the pointer');
result = wheel({ ctrlKey: true, deltaY: 2 });
assert.ok(Math.abs(zoomCall[0] - 0.485) < 1e-9, 'small pixel-based trackpad input is converted to a gentle zoom step');
result = wheel({ altKey: true, deltaY: 2, deltaMode: 1 });
assert.equal(result.prevented, true);
assert.equal(scroller.scrollLeft, 200, 'Alt+wheel moves horizontally using normalized line units');
wheel({ altKey: true, deltaX: -3, deltaY: 5, deltaMode: 1 });
assert.equal(scroller.scrollLeft, 80, 'Alt+horizontal wheel uses its horizontal delta when available');
result = wheel({ deltaY: 100 });
assert.equal(result.prevented, false, 'plain wheel keeps native timeline scrolling');

console.log('时间线 Ctrl 滚轮缩放与 Alt 滚轮水平定位通过');
