'use strict';

const { applyOperations } = require('../../core/edit-commands');
const { patchSubtitles } = require('./agent-bridge');

function applyAssistantResult(store, result, revision, busy = false) {
  if (!result || typeof result.reply !== 'string' || !Array.isArray(result.operations)
    || !result.subtitlePatch || typeof result.subtitlePatch !== 'object' || Array.isArray(result.subtitlePatch)
    || !['none', 'undo', 'redo'].includes(result.historyAction)) throw new Error('智能体返回了无效的编辑方案');
  const hasEdits = result.operations.length > 0 || Object.keys(result.subtitlePatch).length > 0;
  if (result.historyAction !== 'none' && hasEdits) throw new Error('撤销或重做不能与其它修改混用');
  if (!hasEdits && result.historyAction === 'none') return false;
  if (store.revision !== revision) throw new Error('等待回复期间工程已改变，请根据当前工程重新发送要求');
  if (store.gesture || busy) throw new Error('请完成当前拖动或导出后再让助手修改');
  if (result.historyAction !== 'none') {
    if (!store[result.historyAction]()) throw new Error('没有可撤销或重做的修改');
    return true;
  }
  const next = result.operations.length ? applyOperations(store.project, result.operations).project
    : JSON.parse(JSON.stringify(store.project));
  if (Object.keys(result.subtitlePatch).length) patchSubtitles(next, result.subtitlePatch);
  if (JSON.stringify(next) === JSON.stringify(store.project)) return false;
  store.mutate((draft) => {
    for (const key of Object.keys(draft)) delete draft[key];
    Object.assign(draft, next);
  });
  return true;
}

module.exports = { applyAssistantResult };
