'use strict';
// 打包成可直接双击的 DogSC.exe（免安装目录版）。运行：npm run package
// 产物：windows/dist/DogSC-win32-x64/DogSC.exe，字体与图标随包放在 resources/Resources。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const resources = path.join(root, '..', 'Resources');
const build = path.join(root, 'build');
const icon = path.join(build, 'icon.ico');

// 国内网络下从镜像取 Electron 运行时；已下载过会直接走本机缓存。
process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';

async function main() {
  fs.mkdirSync(build, { recursive: true });
  // Windows 图标由仓库里的应用图标母版转出。
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(resources, 'AppIconMaster.png'), '-vf', 'scale=256:256', icon], { stdio: 'inherit' });

  const { packager } = await import('@electron/packager');
  const [output] = await packager({
    dir: root,
    name: 'DogSC',
    platform: 'win32',
    arch: 'x64',
    out: path.join(root, 'dist'),
    overwrite: true,
    icon,
    extraResource: [resources],
    ignore: [/^\/(dist|build|test|scripts)($|\/)/, /\.bat$/],
    win32metadata: { CompanyName: 'DogSC', FileDescription: 'DogSC', ProductName: 'DogSC' },
  });
  console.log(`\n打包完成：${path.join(output, 'DogSC.exe')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
