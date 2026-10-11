# Windows 录制 iPhone / iPad 屏幕调研

日期：2026-10-11
范围：只调查 iPhone / iPad 的 iOS / iPadOS 屏幕录制；不改生产代码，不安装驱动或接收器。

## 结论

Mac 原作者的“设备”来源不是普通 USB 摄像头枚举。`Sources/DogSCApp/CaptureDeviceCatalog.swift` 通过 CoreMediaIO 开启 screen-capture devices，再用 AVFoundation 查找 `.external`、`.muxed` 设备并筛选 `modelID == "iOS Device"`；`CameraRecorder.swift` 把它作为 AVFoundation 输入录制。这依赖 macOS 提供的 iOS 屏幕采集端点。Apple 的 [CoreMediaIO screen-capture 开关](https://developer.apple.com/documentation/coremediaio/kcmiohardwarepropertyallowscreencapturedevices) 与 [AVFoundation 设备发现接口](https://developer.apple.com/documentation/avfoundation/avcapturedevice/discoverysession) 文档确认了这两层；Apple 面向用户公开的 [QuickTime 有线录屏步骤](https://support.apple.com/guide/quicktime-player/record-a-movie-qtp356b55534/mac)也明确写在 Mac 指南里。Windows 上没有找到这条原生 API 路径。

调研没有证明“Windows 绝不可能通过 USB 取到 iOS 视频”：第三方专有应用曾提供 Windows 有线 iPhone 镜像，另有一个开源 USB 项目仍在支持老系统。但我没有找到可直接作为当前 Windows 产品依赖的、已验证支持现代 iOS 的原生 USB 捕获接口/SDK。USB 配对、设备信息读取和单张截图不等于连续视频帧。

最小可验证路线是先使用成熟 AirPlay 接收器，再把接收器的桌面窗口交给现有窗口录制。若必须使用线缆，AirPlayPC 项目报告验证过“USB 个人热点网络 + AirPlay 接收”在 iOS 26.5.2 / Windows 11 上工作；这条路径的视频仍走 AirPlay/IP，只是网络由 USB 共享承载，不能标成 Mac 式原生 USB 设备输入。现有录制器已经支持窗口选择和录制（`windows/src/renderer/recorder.js`、`windows/src/main/recording.js`），因此无需先造一个虚构的 iPhone 设备项。

## 候选方案对比

| 方案 | 实际传输 / 能力 | 现代 iOS 情况 | 对当前应用的意义 |
|---|---|---|---|
| `libimobiledevice` / `idevicescreenshot` | USB 上调用 `screenshotr`，写出一张 TIFF/PNG 截图；官方说明要求设备挂载 Developer Disk Image。工具没有连续视频录制命令。 | iOS 17 起 Developer Disk Image 与 screenshot relay 有变化；`ios-remote` 项目自己的状态说明其现代系统 USB 视频帧循环仍未实现。 | 不适合作为实时录屏源，也不应定时轮询截图伪装成视频。 [工具文档](https://github.com/libimobiledevice/libimobiledevice/blob/master/docs/idevicescreenshot.1) · [官方工具清单](https://github.com/libimobiledevice/libimobiledevice) |
| `ios-remote` 开源 USB 项目 | Windows 原生 USB、实时镜像/录制是其目标；仓库标注 MIT。 | 仓库当前说明将 iOS 14–16 列为目标版本；iOS 17/18/26 的 `screenshotr` 帧循环仍受阻，未达到现代设备可用状态。 | 证明第三方确实在尝试直连 USB，但目前不能作为当前用户设备的可靠实现基础。 [项目状态与兼容表](https://github.com/Fuwaaaaaa/ios-remote) |
| Wormhole Screen Fusion（`er.run`） | 专有 Windows 桌面软件；官方更新记录写明支持 Windows 有线 iPhone 连接。 | 公开更新记录中 iOS 设备适配停留在 iPhone 14/15（2023）；总体更新记录最新可见项为 2024，当前 iOS / iPadOS 的持续兼容性未证实。 | 可作为独立软件在用户指定设备上先试，不是可直接集成的 SDK。官网有 Pro/付费许可；[购买页](https://er.run/purchase)说明许可绑定电脑，公开资料没有给本应用再发行或嵌入授权。不要捆绑。注意它与同名的 Wormhole Virtual Location（虚拟定位）是不同产品。 [Screen Fusion 更新记录](https://er.run/release) · [Pro 许可协议](https://er.run/user-agreement) |
| AirServer（Windows） | AirPlay 接收器；iPhone/iPad 通过控制中心镜像。厂商要求发送端与接收端在同一 Wi-Fi 网络；AirServer 自带录制功能。 | 厂商当前帮助页覆盖 iOS / iPadOS 到 AirServer 接收流程；AirServer 页面列出 Windows 11、30 天试用和付费许可。 | 最省工程的外部接收器候选。可用现有窗口录制录其窗口；要把 AirServer 的视频帧直接作为应用内部设备流，还需厂商提供合适的 SDK/授权，公开的 Connect API 文档目前指向设备管理用途。 [iOS 镜像步骤](https://support.airserver.com/support/solutions/articles/43000535997-how-to-screen-mirror-your-ios-device-to-airserver) · [录制能力](https://www.airserver.com/Usage/Recording) · [许可与系统要求](https://www.airserver.com/Download/) · [Connect API](https://download.airserver.com/doc/connect-api/) |
| UxPlay / AirPlayPC | UxPlay 是 Windows 可运行的 AirPlay 接收器；AirPlayPC 提供 Windows 安装/诊断封装。AirPlayPC 文档报告 iOS 17、18、26 可镜像，并实测 iPhone iOS 26.5.2。它还验证了通过 USB 个人热点网络承载 AirPlay。 | 公开的 USB tether 实测是 iPhone；没有看到其在 iPad 上的实测记录。本机没有 iOS 设备，无法复测。Apple 文档把个人热点限定为 iPhone 或 Wi‑Fi + Cellular 型号的 iPad；Wi‑Fi 版 iPad 没有蜂窝热点能力。AirPlayPC 仓库脚本为 MIT，实际接收引擎 UxPlay 为 GPL-3.0；仓库采用安装时单独下载 UxPlay 的方式，提醒再分发前评估许可。 | 很适合作为首个技术验证：接收器开窗后，使用现有窗口录制。USB tether 需合适设备、用户启用个人热点并信任电脑；Apple 要求 Windows 通过 USB 使用个人热点时安装 Apple Devices 或 iTunes。对于 iPad 即使是 Wi‑Fi + Cellular，也应单独做 USB tether + AirPlay 实机验证，不将 iPhone 实测外推。 [AirPlayPC 的 USB tether / 兼容 / 许可说明](https://github.com/gbulog/pcairplay) · [UxPlay Windows / 网络要求](https://github.com/FDH2/UxPlay) · [Apple 个人热点设备与 USB 说明](https://support.apple.com/en-ie/111785) |
| QtScrcpy | ADB + scrcpy 风格设备镜像。 | 官方仓库明确要求 Android API 21+、打开 ADB 调试；不是 iOS 工具。 | 排除，不应拿来做 iPhone 方案。 [项目要求](https://github.com/barry-ran/QtScrcpy) |

## 建议的最小实施路径

1. **先做真实设备验证，不改设备选择 UI。** 找一台目标 iPhone/iPad，记录精确机型、iOS / iPadOS 版本和 USB 线缆类型。当前主机未连接任何 iOS 设备，所以兼容性不能由本次静态调研代替实测。
2. **按设备分别验证 AirPlay 路径。** 先试 AirPlayPC/UxPlay 的 USB 个人热点链路：AirPlayPC 的公开实测只覆盖 iPhone，步骤需要 iPhone 蜂窝数据/个人热点可用、USB 信任，并且 Windows 安装 Apple Devices 或 iTunes；运营商/套餐可能限制个人热点或另计费。Apple 官方支持 Wi‑Fi + Cellular 型号 iPad 通过 USB 共享个人热点，但这不等于 AirPlayPC 已验证该路径；Wi‑Fi 版 iPad 无法提供此类蜂窝热点。若设备是 Wi‑Fi 版 iPad，或不启用蜂窝热点，则另测普通 Wi‑Fi AirPlay，接收器与 iPad 必须在可互通的同一网络。
3. **接收器工作后沿用现有窗口录制。** 现有录制代码对选中窗口取得 HWND/边界后录制所在显示器区域，因此接收窗口须保持可见且不被遮挡。先用已有的通用“窗口”来源，不把 AirPlay 接收器误报为 USB 设备。
4. **只有在真实设备回归通过后才设计专用 iOS 入口。** 如果要求“插线即出现设备、无需 AirPlay 接收器”，下一步应先向 Wormhole 或其他厂商确认当前 iOS 支持、数据流/API、商业用途与再发行权，或取得可许可的视频采集 SDK。不要基于 `idevicescreenshot` 轮询实现准实时假视频。

USB 热点路线的局限：iPhone 需要蜂窝数据和可用的个人热点；iPad 仅 Wi‑Fi + Cellular 型号可能提供此能力，AirPlayPC 的公开测试仍只覆盖 iPhone。还须启用热点/USB 信任并安装 Apple Devices 或 iTunes，底层协议仍是 AirPlay；开放接收器不支持部分 DRM 受保护内容。若用户不接受个人热点设置、AirPlay 延迟/质量或窗口可见限制，当前调研没有找到能直接替代原作者 macOS CoreMediaIO 的免费、受支持 Windows 原生 USB 端点。

## 本机检查结果

- `Get-PnpDevice -PresentOnly` 按 Apple USB VID / iPhone / iPad 名称筛选，没有发现已连接 iPhone/iPad。
- 已安装 `Apple Mobile Device Support 19.4.0.10`，`Apple Mobile Device Service` 与 Bonjour 服务正在运行。这只说明相关 Apple USB/Bonjour 组件在系统中，不表示有可供录屏的 iOS 视频端点。
- 未发现 `idevice_id`、`ideviceinfo`、`idevicescreenshot`、QtScrcpy、UxPlay 或 AirServer 命令；已安装程序清单也未发现 Apple Devices、iTunes、AirServer、Wormhole、QtScrcpy、QuickTime。未安装、下载或改动系统配置。
- Apple 官方文档支持 Windows 通过 USB 连接 iPhone 并使用个人热点；Apple 官方的 USB QuickTime 屏幕录制流程则是 Mac 上的 QuickTime Player。作者项目自身使用的 AVFoundation/CoreMediaIO 捕获代码详见 `Sources/DogSCApp/CaptureDeviceCatalog.swift` 与 `Sources/DogSCApp/CameraRecorder.swift`。

**实测状态：未实测。** 当前没有连接的 iPhone/iPad，也没有安装 AirPlay 接收器。上文 UxPlay USB 热点结果来自其项目公开的实测记录，不能冒充本机验收。
