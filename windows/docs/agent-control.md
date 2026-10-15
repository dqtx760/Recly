# Recly 当前工程 Agent 控制

Recly 提供一个本机 Agent 接口，供 CLI、MCP 客户端或本机自动化工具读取和编辑当前打开的工程。它只接受 `windows/agent/api.js` 声明的固定方法；不会执行任意 JavaScript、任意 IPC 或 JSONPath。

## 启动方式

先启动 Recly 并打开目标工程。源码开发时，在 `windows/` 目录运行：

```powershell
npm run agent -- project.list
npm run mcp
```

CLI 示例（PowerShell 单引号包住 JSON，路径中的反斜杠写成双反斜杠）：

```powershell
npm run agent -- project.get '{"directory":"C:\\Users\\you\\Videos\\DogSC\\project.dogscproject"}'
```

MCP 客户端可以手动配置为启动 `node` 并传入 `windows/agent/recly-mcp.js` 的绝对路径。配置示意：

```json
{
  "mcpServers": {
    "recly": {
      "command": "node",
      "args": ["D:/path/to/Recly/windows/agent/recly-mcp.js"]
    }
  }
}
```

此片段只说明启动形状，不含密钥；Recly 不会替用户修改 Codex、Claude 或其他 Agent 的配置。打包后可用 `resources/agent/` 下的客户端脚本由外部 Node.js 启动。

可以先人工初剪再交给 Agent，也可以录制后直接交接。Recly 提供剪辑与字幕操作接口，没有内置自动剪辑决策；需要所连接的客户端具备工具调用能力，按你的要求决定保留、删除和纠错。

Git 不包含 `runtime/whisper` 程序、模型或 CUDA DLL。识别默认需要 `runtime/whisper/Release/whisper-cli.exe`、该构建配套的 DLL 和 `runtime/whisper/ggml-small.bin` 多语言模型；CUDA 构建还需匹配的驱动及 CUDA 依赖，不保证所有 GPU 可用。程序和模型路径可分别用 `RECLY_WHISPER_EXE`、`RECLY_WHISPER_MODEL` 覆盖，详细运行与打包步骤见 [Windows 说明](../README.md#离线字幕与-agent-接手)。打包脚本复制实际 runtime 目录，配置为 `overwrite: false`；重复打包需用 `RECLY_PACKAGE_OUT` 指定新的输出目录。

## 编辑版本与写入规则

`project.get` 和 `timeline.get` 都读取编辑器当前 Store，不从磁盘读旧快照。旧工程从 `revision: 0` 开始；每次人工修改、Agent 事务、撤销或重做都会使版本递增。`project.get`、`timeline.get` 和写操作结果会返回当前版本。

所有写方法都必须带 `expectedRevision` 和 `requestId`。版本不匹配时返回 `revision_conflict`；同一个 `requestId` 与完全相同的参数重试会复用第一次结果；同一编号换了参数会返回 `request_id_conflict`。人工拖动手势尚未结束，或输入框仍处于编辑状态时，工程写操作会返回 `project_busy`。

推荐先用 `edit.preview` 校验操作。它返回 `planId` 和绑定的工程版本；随后 `edit.apply` 可提交相同 `operations` 与 `planId`。批量编辑会先在工程副本上验证，全部通过后才以一次 Store mutation 应用，并作为一次撤销记录。失败的批次不会留下部分修改。

支持的 `edit.apply.operations`：

- `split`: `{ "type":"split", "segmentId":"…", "sourceTime":12.5 }`
- `trim`: `{ "type":"trim", "segmentId":"…", "start":10, "end":18 }`，时间为录屏源秒。
- `remove`、`remove_range`、`keep_ranges`：片段按稳定 id，范围用 `{ "sourceStart":10, "sourceEnd":18 }`。
- `reorder`: `segmentIds` 必须完整列出当前主时间线片段 id。
- `speed`: `{ "type":"speed", "segmentId":"…", "value":1.5 }`。
- `audio`: 修改全局或指定片段的麦克风 / 系统音量与静音。
- `canvas`、`camera`、`zoom`、`effect`: 仅允许现有字段白名单。效果类别限 `screen`、`camera`、`mosaic`、`sticker`，不支持任意路径或创建新效果。

撤销、重做使用 `history.undo` / `history.redo`。`project.save` 等待串行保存队列写入最新版本；保存失败会返回错误，不会报告为已保存。

## 字幕识别与校正

字幕统一保存在 `project.subtitles`，字幕 cue 与词时间均使用录屏源秒：

```json
{
  "enabled": true,
  "sourceTrack": "microphone",
  "language": "zh",
  "style": {
    "fontSize": 48,
    "color": "#FFFFFF",
    "backgroundColor": "#000000",
    "backgroundOpacity": 1,
    "baselineY": 0.86
  },
  "cues": [
    {
      "id": "cue-1",
      "start": 1.2,
      "end": 2.8,
      "text": "我在用 Codex",
      "originalText": "我在用 coldex",
      "alignment": "valid",
      "words": [{ "start": 1.2, "end": 2.8, "text": "我在用 Codex" }]
    }
  ]
}
```

识别结果不会自动覆盖现有字幕。首次识别需要显式把任务结果传给 `subtitles.patch.patch.replaceCues`；只校正部分字幕时，用 cue `id` 批量提交 `patch.cues`。修改 `text` 而不同时提供新的 `words` 会将 `alignment` 标记为 `stale`，这样跨剪切片段时不会误显示旧词。修改文字后若提供新词时间戳，应保证这些词与新文本对齐。

完整流程示例：

```powershell
# 读取 revision 和当前字幕轨；旧工程通常从 revision 0 开始
npm run agent -- project.get '{"directory":"C:\\Users\\you\\Videos\\DogSC\\project.dogscproject"}'

# 使用录屏源素材识别；scope 也可以是 retained（仅当前保留的源区间）
npm run agent -- transcript.generate '{"directory":"C:\\Users\\you\\Videos\\DogSC\\project.dogscproject","track":"microphone","scope":"source","expectedRevision":0,"requestId":"asr-start-1"}'

# 用返回的 jobId 轮询，直到 completed；result.cues 是可提交的源时间 cue
npm run agent -- jobs.get '{"directory":"C:\\Users\\you\\Videos\\DogSC\\project.dogscproject","jobId":"返回的 jobId"}'

# 将识别结果明确写入字幕轨（下面用省略号代表上一步 result.cues 的完整数组）
npm run agent -- subtitles.patch '{"directory":"C:\\Users\\you\\Videos\\DogSC\\project.dogscproject","expectedRevision":0,"requestId":"subtitle-install-1","patch":{"replaceCues":[...]}}'

# 按 cue id 改正专名；未提供新 words 时服务端会自动标记 alignment=stale
npm run agent -- subtitles.patch '{"directory":"C:\\Users\\you\\Videos\\DogSC\\project.dogscproject","expectedRevision":1,"requestId":"subtitle-correct-1","patch":{"cues":[{"id":"cue-id","text":"我在用 Codex"}]}}'

# 再读取最新版本并持久化
npm run agent -- project.get '{"directory":"C:\\Users\\you\\Videos\\DogSC\\project.dogscproject"}'
npm run agent -- project.save '{"directory":"C:\\Users\\you\\Videos\\DogSC\\project.dogscproject","expectedRevision":2,"requestId":"save-1"}'
```

`subtitles.get` 返回源字幕、映射到成片的 `mappedCues`、剪切边界警告和成片 SRT 文本。跨剪切的字幕仅在有可靠词对齐时保留对应词；无法安全映射的部分会隐藏并返回 warning。

## 媒体预览与导出

- `media.frame` 的 `timeDomain` 可选 `source` 或 `output`。源帧经主进程解码；成片帧由编辑器预览合成器定位并渲染，包含当前画布、摄像头、效果和字幕。结果是 PNG base64。
- `media.audio_excerpt` 读取指定 `microphone` 或 `systemAudio` 音轨，长度最多 30 秒。`source` 以录屏源秒读取；`output` 以成片秒定位并按片段速度变换声音，支持 0.25–8 倍速，不接受跨剪辑点的区间，映射后的源区间最多 120 秒。返回音频 base64，以及实际截取的 `time`、`sourceStart`、`sourceDuration` 和成片 `duration`；音轨延迟或提前结束会缩短截取区间。
- `export.start` 必须给出新的 `outputFile` 和 `kind`。主进程校验扩展名、父目录、工程及素材路径，拒绝覆盖已有文件；UI 与 Agent 共用同一个工程导出锁。它返回 jobId，进度用 `jobs.get` 轮询，可用 `jobs.cancel` 取消。
- `transcript.generate` 返回识别 jobId；`jobs.get` / `jobs.cancel` 可查询或取消识别与导出任务。任务状态包括 `queued`、`running`、`completed`、`failed`、`cancelled`。

完整方法和参数以 [`windows/agent/api.js`](../agent/api.js) 为准。CLI 与 MCP 只服务本机已打开的工程，不提供远程访问入口。

## 验证

`npm run test:agent` 始终执行单元测试。真实中文语音识别需显式设置 `RECLY_ASR_TEST_AUDIO` 为音频绝对路径，再运行 `node test/transcription.test.js`；程序和模型分别沿用 `RECLY_WHISPER_EXE`、`RECLY_WHISPER_MODEL`，未设置时使用 `runtime/whisper`。没有提供测试音频时会明确报告跳过真实识别。

`npm run test:agent:electron` 必须显式设置 `RECLY_AGENT_TEST_FIXTURE` 为本地 `.dogscproject` 工程目录；未设置时会报错并提示本章节。脚本将工程复制到临时目录，隔离工程库、用户数据及配置，验证真实编辑器、识别、纠错持久化、媒体预览与关闭导出窗口后的锁恢复，不修改原始工程。临时验收产物保留供核查，私有录制不随 Git 仓库分发。

这是针对已有中文验收素材的集成测试：工程录屏时长为 20 秒，首个主时间线片段应覆盖整段素材、速度为 1；需包含麦克风音轨和有效视频、索引及所有引用资源。录音在 16–18 秒包含 Codex，在 18–20 秒包含 WorkBuddy；当前测试要求真实识别结果出现 `coldex` 或 `work body`，以验证错词确实被修改，随后导出源区间 15.5–19.5 秒。其他素材或模型可能返回不同识别结果，不能直接满足这一特定验收断言。

```powershell
$env:RECLY_AGENT_TEST_FIXTURE = 'C:\path\to\fixture.dogscproject'
npm run test:agent:electron
```
