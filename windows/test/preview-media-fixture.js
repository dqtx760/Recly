'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function runFfmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `ffmpeg 生成预览同步夹具失败：${result.stderr || result.stdout}`);
}

function createPreviewMediaFixture(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const screen = path.join(directory, 'screen-timecode.mp4');
  const screenProxy = path.join(directory, 'screen-timecode-proxy.mp4');
  const camera = path.join(directory, 'camera-timecode.mp4');
  const microphone = path.join(directory, 'microphone-pulses.m4a');
  const flash = "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t,1),0.06)'";
  const timecode = "drawtext=text='%{pts\\:hms}':x=24:y=24:fontsize=42:fontcolor=white:box=1:boxcolor=black@0.7";

  runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6', '-vf', `${flash},${timecode}`,
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30', '-movflags', '+faststart', screen]);
  runFfmpeg(['-i', screen, '-vf', 'fps=20,scale=480:-2', '-an', '-c:v', 'libx264', '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p', '-g', '20', '-movflags', '+faststart', screenProxy]);
  runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=6', '-vf', `${flash},${timecode}`,
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30', '-movflags', '+faststart', camera]);
  runFfmpeg(['-f', 'lavfi', '-i', "aevalsrc=if(lt(mod(t\\,1)\\,0.06)\\,0.8*sin(2*PI*1000*t)\\,0):s=48000:d=6",
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', microphone]);

  return { screen, screenProxy, camera, microphone, duration: 6 };
}

if (require.main === module) {
  const directory = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'builds', 'preview-sync-media-fixture'));
  process.stdout.write(`${JSON.stringify(createPreviewMediaFixture(directory), null, 2)}\n`);
}

module.exports = { createPreviewMediaFixture };
