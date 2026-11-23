'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { exportVideoBitrate } = require('../core/model');

const PAINT_TIMEOUT = 5000;
const COLOR_SPACE = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };

async function renderNative({ project, directory, indexes, rawFile, width, height, frameRate, totalFrames }, onProgress, checkCancelled) {
  const { Encoder, HardwareContext, SharedTexture } = await import('node-av-lgpl/api');
  const { HardwareFramesContext, FFmpegError } = await import('node-av-lgpl/lib');
  const av = await import('node-av-lgpl/constants');
  await app.whenReady();

  const hardware = HardwareContext.create(av.AV_HWDEVICE_TYPE_D3D11VA);
  const inputFrames = new HardwareFramesContext();
  const heldTextures = new Map();
  const registeredFrames = [];
  const timeBase = { num: 1, den: frameRate };
  const gop = frameRate * 2;
  const bitrate = exportVideoBitrate(width, height, frameRate);
  let win, importer, file, encoder, pendingPaint, lastPaintCount;
  let writtenFrames = 0;

  function writePacket(packet) {
    try {
      const texture = heldTextures.get(packet.pts);
      const data = packet.data;
      if (packet.pts !== BigInt(writtenFrames) || !texture || !data?.length) {
        throw new Error('硬件编码返回的帧序号异常');
      }
      fs.writeFileSync(file, data);
      heldTextures.delete(packet.pts);
      texture.release();
      writtenFrames++;
    } finally {
      packet.free();
    }
  }

  function disposeEncoder() {
    encoder?.close();
    encoder = null;
    for (const frame of registeredFrames.splice(0)) frame.free();
  }

  async function flushEncoder() {
    for await (const packet of encoder.flushPackets()) writePacket(packet);
    if (heldTextures.size) throw new Error('硬件编码未返回完整的画面');
    disposeEncoder();
  }

  async function paint(action) {
    let timer;
    let texture;
    const nextPaint = new Promise((resolve, reject) => {
      pendingPaint = (next) => { texture = next; resolve(next); };
      timer = setTimeout(() => reject(new Error('离屏画面生成超时')), PAINT_TIMEOUT);
    });
    try {
      const [, frameTexture] = await Promise.all([action(), nextPaint]);
      return frameTexture;
    } catch (error) {
      texture?.release();
      throw error;
    } finally {
      pendingPaint = null;
      clearTimeout(timer);
    }
  }

  try {
    inputFrames.alloc(hardware.deviceContext);
    inputFrames.format = av.AV_PIX_FMT_D3D11;
    inputFrames.swFormat = av.AV_PIX_FMT_BGRA;
    inputFrames.width = width;
    inputFrames.height = height;
    FFmpegError.throwIfError(inputFrames.init(), '初始化显卡纹理队列');
    importer = SharedTexture.create(hardware);
    file = fs.openSync(rawFile, 'wx');
    win = new BrowserWindow({
      show: false,
      frame: false,
      useContentSize: true,
      width, height,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: { useSharedTexture: true } },
    });
    win.webContents.setFrameRate(frameRate);
    win.webContents.stopPainting();
    win.webContents.on('paint', ({ texture }) => {
      if (!texture) return;
      const receive = pendingPaint;
      pendingPaint = null;
      if (receive) receive(texture);
      else texture.release();
    });
    await win.loadFile(path.join(__dirname, '../renderer/export-offscreen.html'));
    const sceneJob = JSON.stringify({ project, directory, indexes, width, height, frameRate });
    await win.webContents.executeJavaScript('window.prepareExport(' + sceneJob + ')');
    (await paint(() => win.webContents.startPainting())).release();

    const startedAt = performance.now();
    for (let n = 0; n < totalFrames; n++) {
      checkCancelled();
      if (!encoder) {
        encoder = await Encoder.create('h264_nvenc', {
          timeBase,
          context: {
            bitRate: bitrate, rcMaxRate: bitrate * 2, gopSize: gop, maxBFrames: 0, frameRate: { num: frameRate, den: 1 },
            colorSpace: av.AVCOL_SPC_BT709, colorRange: av.AVCOL_RANGE_MPEG,
            colorPrimaries: av.AVCOL_PRI_BT709, colorTrc: av.AVCOL_TRC_BT709,
          },
          options: { preset: 'p4', rc: 'vbr', 'rc-lookahead': '0', zerolatency: '1' },
        });
      }
      const texture = await paint(() => win.webContents.executeJavaScript('window.drawExportFrame(' + n + ')'));
      const pts = BigInt(n);
      heldTextures.set(pts, texture);
      const info = texture.textureInfo;
      const paintCount = info.metadata?.frameCount;
      if (info.codedSize.width !== width || info.codedSize.height !== height || info.pixelFormat !== 'bgra') {
        throw new Error('硬件导出的离屏画面尺寸或像素格式不匹配');
      }
      if (Number.isFinite(paintCount) && Number.isFinite(lastPaintCount) && paintCount <= lastPaintCount) {
        throw new Error('离屏画面重复，无法继续硬件导出');
      }
      lastPaintCount = paintCount;
      const frame = importer.importTexture(info, { pts, timeBase });
      try {
        frame.hwFramesCtx = inputFrames;
        // NVENC 会缓存已注册的 D3D11 指针。编码器结束后才释放这些引用，
        // 每两个视频秒重建编码器，让注册资源有界，并保持原导出的关键帧间隔。
        registeredFrames.push(frame.clone());
        for (const packet of await encoder.encodeAll(frame)) writePacket(packet);
      } finally {
        frame.free();
      }
      const frames = n + 1;
      if (frames % gop === 0 || frames === totalFrames) await flushEncoder();
      if (n % 5 === 0 || frames === totalFrames) {
        onProgress({ stage: '正在渲染画面', fraction: frames / totalFrames, frames, totalFrames, elapsed: (performance.now() - startedAt) / 1000 });
      }
    }
    if (writtenFrames !== totalFrames) throw new Error('硬件导出帧数与请求不一致');
    return { colorSpace: COLOR_SPACE, encoder: 'h264_nvenc / d3d11', writtenFrames };
  } finally {
    disposeEncoder();
    for (const texture of heldTextures.values()) texture.release();
    if (win && !win.isDestroyed()) win.destroy();
    if (file !== undefined) fs.closeSync(file);
    importer?.dispose();
    inputFrames.free();
    hardware.dispose();
  }
}

function main() {
  // 不注册快捷键、不共享用户数据目录，保留主编辑器的预览兼容设置。
  const option = (name) => process.argv.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1);
  const profile = option('--recly-export-profile');
  const jobFile = option('--recly-export-job');
  if (!profile || !jobFile) { app.exit(1); return; }
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  const emit = (data, callback) => process.stdout.write(JSON.stringify(data) + '\n', callback);
  const checkCancelled = () => { if (fs.existsSync(`${jobFile}.cancel`)) throw new Error('已取消导出'); };
  Promise.resolve().then(() => renderNative(JSON.parse(fs.readFileSync(jobFile, 'utf8')), (progress) => emit({ progress }), checkCancelled)).then(
    (result) => emit({ result }, () => app.exit(0)),
    (error) => emit({ error: String(error.message || error) }, () => app.exit(1)),
  );
}

module.exports = { main };
