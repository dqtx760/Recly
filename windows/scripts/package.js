'use strict';
// 打包成可直接双击的 Recly.exe（免安装目录版）。运行：npm run package
// 产物：windows/dist/Recly-win32-x64/Recly.exe，字体随包放在 resources/Fonts。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const resources = path.join(root, '..', 'Resources');
const fonts = path.join(resources, 'Fonts');
const appIconPng = path.join(root, 'assets', 'AppIconMaster.png');
const license = path.join(root, '..', 'LICENSE');
const build = path.join(root, 'build');
const icon = path.join(build, 'icon.ico');

// 国内网络下从镜像取 Electron 运行时；已下载过会直接走本机缓存。
process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';

async function main() {
  fs.mkdirSync(build, { recursive: true });
  // Windows 图标由 Windows 专用图标母版转出。
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', appIconPng, '-vf', 'scale=256:256', icon], { stdio: 'inherit' });

  const { packager } = await import('@electron/packager');
  const [output] = await packager({
    dir: root,
    name: 'Recly',
    platform: 'win32',
    arch: 'x64',
    out: path.join(root, 'dist'),
    overwrite: true,
    icon,
    extraResource: [fonts, appIconPng, license],
    ignore: [/^\/(dist|build|test|scripts)($|\/)/, /\.bat$/],
    win32metadata: { CompanyName: 'Recly', FileDescription: 'Recly', ProductName: 'Recly' },
  });
  console.log(`\n打包完成：${path.join(output, 'Recly.exe')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
