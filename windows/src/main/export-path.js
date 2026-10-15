'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getExportRoot } = require('./config');

function automaticExportPath(name, kind) {
  const directory = getExportRoot();
  if (!directory) return null;
  fs.mkdirSync(directory, { recursive: true });
  fs.accessSync(directory, fs.constants.W_OK);
  let base = String(name || '录屏').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '') || '录屏';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  base = base.slice(0, 180).replace(/[. ]+$/, '');
  const extension = kind === 'audio' ? 'm4a' : 'mp4';
  let file = path.join(directory, `${base}.${extension}`);
  for (let number = 2; fs.existsSync(file) || fs.existsSync(`${file}.h264.tmp`); number++) {
    file = path.join(directory, `${base} (${number}).${extension}`);
  }
  return file;
}

module.exports = { automaticExportPath };
