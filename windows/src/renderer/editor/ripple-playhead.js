'use strict';

function rippleTrimSeekTime(hit, outputTime, edge) {
  if (!hit || !Number.isFinite(outputTime)) return null;
  if (edge === 'start') return hit.outputStart;
  if (edge === 'end') return outputTime;
  return null;
}

module.exports = { rippleTrimSeekTime };
