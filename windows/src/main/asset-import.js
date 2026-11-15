'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function readClipboardImage(clipboard, nativeImage) {
  const items = await clipboard.read();
  for (const item of items) {
    for (const type of item.types || []) {
      if (!/^image\//i.test(type)) continue;
      const blob = await item.getType(type);
      const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
      if (!image.isEmpty()) return image;
    }
  }
  return nativeImage.createEmpty();
}

// 每份素材写入独立文件；切换素材和撤销不会覆盖旧片段引用的图片。
async function importAsset({ directory, kind, file, image }, media, nativeImage) {
  if (!fs.existsSync(path.join(directory, 'project.json'))) throw new Error('项目目录不存在');
  if (!['image', 'video', 'clipboard'].includes(kind)) throw new Error('不支持的素材类型');
  const relative = `media/asset-${randomUUID()}.${kind === 'video' ? 'mp4' : 'png'}`;
  const target = path.join(directory, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (kind !== 'video') {
    const bitmap = image || nativeImage.createFromPath(file);
    if (bitmap.isEmpty()) throw new Error(kind === 'clipboard' ? '剪贴板中没有图片' : '无法读取这张图片');
    const size = bitmap.getSize();
    fs.writeFileSync(target, bitmap.toPNG());
    return { file: relative, width: size.width, height: size.height };
  }
  const info = await media.finalizeCamera(file, target);
  if (!info?.video) throw new Error('这个文件没有可用的视频画面');
  const index = `${relative}.index.json`;
  fs.writeFileSync(path.join(directory, index), JSON.stringify(await media.buildVideoIndex(target)));
  return { file: relative, index, width: info.video.width, height: info.video.height, duration: info.duration };
}

async function importAudio({ directory, file, buffer, name }, media) {
  if (!fs.existsSync(path.join(directory, 'project.json'))) throw new Error('项目目录不存在');
  const extension = buffer ? '.webm' : path.extname(file || '').toLowerCase();
  if (!['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.webm', '.flac', '.mp4'].includes(extension)) {
    throw new Error('不支持这种音频格式');
  }
  const id = randomUUID();
  const sourceRelative = `media/audio-source-${id}${extension}`;
  const outputRelative = `media/audio-${id}.m4a`;
  const source = path.join(directory, sourceRelative);
  const output = path.join(directory, outputRelative);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  try {
    if (buffer) fs.writeFileSync(source, buffer);
    else fs.copyFileSync(file, source);
    const info = await media.finalizeAudio(source, output);
    if (!info?.hasAudio || !Number.isFinite(info.duration) || info.duration <= 0) throw new Error('文件中没有可用的音频');
    return {
      file: outputRelative,
      duration: info.duration,
      name: String(name || path.basename(file || '配音', extension)).slice(0, 160),
    };
  } catch (error) {
    try { fs.unlinkSync(source); } catch { /* 源临时文件不存在 */ }
    try { fs.unlinkSync(output); } catch { /* 输出文件不存在 */ }
    throw error;
  } finally {
    try { fs.unlinkSync(source); } catch { /* 转换已清理或失败 */ }
  }
}

module.exports = { importAsset, importAudio, readClipboardImage };
