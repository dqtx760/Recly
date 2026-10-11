<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="Recly Windows 录屏与剪辑工具：录制屏幕、自动运镜、编辑时间线并导出视频">
</p>

<p align="center">
  <a href="windows/README.md"><strong>使用与开发说明</strong></a>
  · <a href="https://github.com/laogou717/dogsc">原作者项目 DogSC</a>
  · <a href="https://dqtx.cc">官网 dqtx.cc</a>
</p>

## 用录屏完成一条视频

Recly 是一款面向 Windows 的录屏与轻量剪辑工具。它把录制、自动跟随运镜、时间线编辑和导出放在一条工作流里，适合制作软件演示、操作教程和产品讲解。

<p align="center">
  <img src="assets/readme/recorder-console.png" width="420" alt="Recly 录屏主控台：选择录制范围和音频设备，可开启录制时隐藏桌面图标">
</p>

![Recly 编辑器：实际录制项目的画面预览、背景设置与时间线](assets/readme/editor-example.png)

## 能做什么

当前源码版本：**0.1.2-win.3**。最近一次更新修复了剪辑后播放卡住、截图粘贴兼容性，并补上录制期间关闭窗口与退出保护。

- **录制屏幕、窗口或自选区域**，可选择麦克风、摄像头和系统声音。
- **连续录制多段素材**：完成后选择保存项目或进入编辑；桌面 / 区域录制可隐藏桌面图标。
- **自动运镜跟随操作**：根据点击生成缩放片段，连续操作时镜头跟随指针；也能手动调整焦点、倍率和缓动。
- **编辑录制内容**：分割、Q/W 波纹裁切、拖动重排、恢复缺口、变速、波形与吸附，支持片段独立音量、撤销与重做。
- **调整画面**：背景 / 布局 / 样机分组，浏览器地址文字可自定义；支持拖入图片、粘贴截图、画布贴图变换、虚化与仅背景显示，效果可分割、复制与粘贴属性。
- **制作动画**：开场、连续屏幕 3D、摄像头运动与内部取景、相邻贴图过渡、动态图案与视频背景。预览可选择流畅或原画质量。
- **导出成片**：输出 MP4 视频或 M4A 音频，并选择分辨率和帧率。

## 从录制到成片

1. 选择屏幕、窗口或区域，设置麦克风、摄像头和系统声音；需要干净桌面时开启“录制时隐藏桌面图标”。
2. 结束录制后，右下角显示完成提示。项目已自动保存，可另存项目、进入编辑，或继续录制下一段。
3. 在编辑器中剪切和重排片段，设置运镜、背景与样机；通过预览区“+”、拖入图片或粘贴截图添加贴图。
4. 检查预览后导出 MP4 或 M4A。剪辑和效果支持保存重开、撤销与重做。

## 运行

### 直接启动

在 Windows 上下载或克隆仓库，双击 `windows/start.bat`。首次启动会安装运行依赖。录制与导出还需要系统可调用的 FFmpeg 6.0 或更新版本：

```powershell
winget install Gyan.FFmpeg
```

### 从源码启动

需要 Windows 10 2004 或更新版本、Node.js 22.12.0+ 和 FFmpeg 6.0+。

```powershell
cd windows
npm install
npm start
```

打包 Windows 免安装目录版：

```powershell
npm run package
```

打包后的程序入口为 `windows/dist/Recly-win32-x64/Recly.exe`；运行时保留整个文件夹。仓库不包含本机打包目录，需要按上面的命令生成。更完整的使用说明、自测方式和目录结构见 [`windows/README.md`](windows/README.md)。

## 当前限制

- **仅支持 Windows。** 窗口录制采集的是可见区域，目标窗口需要保持在原位且不被遮挡。
- **字幕编辑、自动识别字幕、语音跟随提词器尚未接入。** 现有提词器支持手动控制。
- **iPhone / iPad 原生有线采集尚未接入。** 投屏接收器配合窗口录制是待实机验证的方案，见 [设备录制调研](windows/docs/ios-device-recording-20261011.md)。
- **高分辨率与复杂效果会增加负载。** 可切换流畅预览；不保证所有设备实时预览 4K。

本轮已验证保存重开、撤销重做、剪辑后播放及预览 / 导出一致性，详情见 [更新与验收说明](windows/docs/editor-revision-20261012.md)。

## 适配说明

Recly 的 Windows 版本以 Electron、FFmpeg 和 WebCodecs 实现录制及导出，并移植了原项目中的自动缩放、指针跟随、光标平滑和画面布局等核心逻辑。Windows 的窗口录制通过采集窗口可见区域实现，因此录制时目标窗口需要保持在原位且不被遮挡；Windows 项目文件也不与 macOS 原版互通。

## 原作者与许可

原版 DogSC 由 [神烦老狗（@laogou717）](https://github.com/laogou717) 创建，原项目和源码见 [laogou717/dogsc](https://github.com/laogou717/dogsc)。原作者未发布或背书 Recly 的 Windows 版本；原版版权声明与 MIT 许可见 [`LICENSE`](LICENSE)。再分发时请保留原作者的版权声明，字体等附带资源遵循各自许可。

## 👨‍💻 关于我

**大强同学（Derek Zhao）**
AI 工具与工作流实践者 · GitHub 开源项目作者

我在 Windows、AI Agent、Obsidian 和个人网站这些真实场景里，
把能跑通的工具、Skill 和流程，整理成可复用的开源项目与交付方案。

- 文章与工具：[dqtx.cc](https://www.dqtx.cc/) · [os.dqtx.cc](https://os.dqtx.cc/) · [blog.dqtx.cc](https://blog.dqtx.cc/)
- 关注更新：[B 站](https://space.bilibili.com/491358682/upload/video) · [YouTube](https://www.youtube.com/@dqtx760/videos) · [即刻](https://web.okjike.com/u/24236868-c3e9-49ef-ab93-93a60e1a25db) · [CSDN](https://blog.csdn.net/2402_82616859?type=blog)
- 公众号：微信搜索「大强同学」

![](https://gitee.com/da-qiang-classmate/typora/raw/master/image/未命名的设计（2）.webp)

卡在安装、配置、报错，或想把 AI 接进自己的工作流，可以直接找我。

**本软件是参考了原作者的代码进行改版，仅支持 Windows。**
