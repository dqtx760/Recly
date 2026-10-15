'use strict';

const field = (type, description, extra = {}) => ({ type, description, ...extra });
const objectSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const directoryField = field('string', 'Recly 工程目录；必须属于项目库或已在编辑器中打开。');
const revisionField = field('integer', '编辑器当前项目版本，写入时用于冲突检测。');
const requestIdField = field('string', '写操作唯一编号；重试时复用同一编号与相同参数。');

const METHODS = [
  { name: 'project.list', description: '列出 Recly 项目库中的录屏工程。', inputSchema: objectSchema({}) },
  { name: 'project.open', description: '在 Recly 编辑器中打开项目并等待编辑器就绪。', inputSchema: objectSchema({ directory: directoryField }, ['directory']) },
  { name: 'project.get', description: '读取编辑器当前 Store 中的项目与版本。', inputSchema: objectSchema({ directory: directoryField }, ['directory']) },
  { name: 'timeline.get', description: '读取当前时间线的片段、源时间及成片时间。', inputSchema: objectSchema({ directory: directoryField }, ['directory']) },
  { name: 'edit.preview', description: '预检一组编辑操作并返回绑定当前版本的计划。', inputSchema: objectSchema({ directory: directoryField, operations: field('array', '待预检操作列表。', { items: { type: 'object' } }) }, ['directory', 'operations']) },
  { name: 'edit.apply', description: '提交已经预检的编辑计划，或直接提交编辑操作；写入按 requestId 去重。', inputSchema: objectSchema({ directory: directoryField, expectedRevision: revisionField, requestId: requestIdField, planId: field('string', 'edit.preview 返回的计划编号。'), operations: field('array', '可选的编辑操作列表；可省略并改用 planId 对应计划。', { items: { type: 'object' } }) }, ['directory', 'expectedRevision', 'requestId']) },
  { name: 'history.undo', description: '撤销当前工程最近一次编辑事务。', inputSchema: objectSchema({ directory: directoryField, expectedRevision: revisionField, requestId: requestIdField }, ['directory', 'expectedRevision', 'requestId']) },
  { name: 'history.redo', description: '重做当前工程最近一次已撤销的编辑事务。', inputSchema: objectSchema({ directory: directoryField, expectedRevision: revisionField, requestId: requestIdField }, ['directory', 'expectedRevision', 'requestId']) },
  { name: 'project.save', description: '等待当前编辑器将项目持久化并返回保存状态。', inputSchema: objectSchema({ directory: directoryField, expectedRevision: revisionField, requestId: requestIdField }, ['directory', 'expectedRevision', 'requestId']) },
  { name: 'media.frame', description: '从当前 Store 读取录屏源时间或成片时间的一帧，返回短期本地 PNG 路径。', inputSchema: objectSchema({ directory: directoryField, timeDomain: field('string', 'source 或 output。', { enum: ['source', 'output'] }), time: field('number', '对应时间域中的时间，单位秒。') }, ['directory', 'timeDomain', 'time']) },
  { name: 'media.audio_excerpt', description: '从当前 Store 工程的指定音轨读取源时间或单个成片片段的短区间；不跨剪辑点。', inputSchema: objectSchema({ directory: directoryField, timeDomain: field('string', 'source 或 output。', { enum: ['source', 'output'] }), track: field('string', 'microphone 或 systemAudio。', { enum: ['microphone', 'systemAudio'] }), start: field('number', '对应时间域的起点，单位秒。'), duration: field('number', '截取时长，最多 30 秒。'), speed: field('number', '成片片段速度；source 模式应为 1。') }, ['directory', 'timeDomain', 'track', 'start', 'duration']) },
  { name: 'transcript.generate', description: '基于麦克风或系统声音生成 ASR 任务；结果只覆盖完整源素材或当前保留源区间。', inputSchema: objectSchema({ directory: directoryField, track: field('string', 'microphone 或 systemAudio。', { enum: ['microphone', 'systemAudio'] }), scope: field('string', 'source 或 retained。', { enum: ['source', 'retained'] }), expectedRevision: revisionField, requestId: requestIdField }, ['directory', 'track', 'scope', 'expectedRevision', 'requestId']) },
  { name: 'transcript.get', description: '读取字幕识别任务或当前工程已有的转写文本。', inputSchema: objectSchema({ directory: directoryField, jobId: field('string', '可选的识别任务编号。') }, ['directory']) },
  { name: 'subtitles.get', description: '读取当前工程中的字幕轨。', inputSchema: objectSchema({ directory: directoryField }, ['directory']) },
  { name: 'subtitles.patch', description: '按当前工程版本批量替换字幕、调整样式或字幕轨状态。', inputSchema: objectSchema({ directory: directoryField, expectedRevision: revisionField, requestId: requestIdField, patch: objectSchema({ replaceCues: field('array', '完整替换字幕列表。', { items: { type: 'object' } }), cues: field('array', '按字幕 id 局部更新。', { items: { type: 'object' } }), style: field('object', '字幕样式增量。'), enabled: field('boolean', '是否启用字幕。'), sourceTrack: field('string', '字幕来源音轨。', { enum: ['microphone', 'systemAudio'] }), language: field('string', '字幕语言标签。') }) }, ['directory', 'expectedRevision', 'requestId', 'patch']) },
  { name: 'export.start', description: '使用当前 Store 项目启动 MP4/M4A 导出；输出文件必须不存在且不能覆盖工程素材。', inputSchema: objectSchema({ directory: directoryField, expectedRevision: revisionField, requestId: requestIdField, outputFile: field('string', '新的 MP4 或 M4A 输出路径。'), kind: field('string', 'video 或 audio。', { enum: ['video', 'audio'] }), resolution: field('string', '视频分辨率设置。'), frameRate: field('integer', '视频帧率。') }, ['directory', 'expectedRevision', 'requestId', 'outputFile', 'kind']) },
  { name: 'jobs.get', description: '读取导出或字幕识别任务状态。', inputSchema: objectSchema({ directory: directoryField, jobId: field('string', '任务编号。') }, ['directory', 'jobId']) },
  { name: 'jobs.cancel', description: '取消可取消的导出或字幕识别任务。', inputSchema: objectSchema({ directory: directoryField, jobId: field('string', '任务编号。'), expectedRevision: revisionField, requestId: requestIdField }, ['directory', 'jobId', 'expectedRevision', 'requestId']) },
];

const METHOD_NAMES = new Set(METHODS.map((item) => item.name));
const WRITE_METHODS = new Set(['edit.apply', 'history.undo', 'history.redo', 'project.save', 'transcript.generate', 'subtitles.patch', 'export.start', 'jobs.cancel']);

module.exports = { METHODS, METHOD_NAMES, WRITE_METHODS };
