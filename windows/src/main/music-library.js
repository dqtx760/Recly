'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { importAudio } = require('./asset-import');

function readCatalog(root) {
  const tracks = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8'));
  return tracks.map((track) => {
    if (path.basename(track.file) !== track.file || path.extname(track.file).toLowerCase() !== '.mp3' || !Number.isFinite(track.duration) || track.duration <= 0) {
      throw new Error('内置音乐目录无效');
    }
    return track;
  });
}

function listBuiltInMusic(root) {
  return readCatalog(root).map(({ id, file, name, duration }) => ({ id, name, duration, url: pathToFileURL(path.join(root, file)).href }));
}

async function importBuiltInMusic({ root, directory, id }, media) {
  const track = readCatalog(root).find((item) => item.id === id);
  if (!track) throw new Error('未找到这首内置音乐');
  return importAudio({ directory, file: path.join(root, track.file), name: track.name }, media);
}

module.exports = { listBuiltInMusic, importBuiltInMusic };
