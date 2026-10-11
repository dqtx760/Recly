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

module.exports = { importAsset, readClipboardImage };
