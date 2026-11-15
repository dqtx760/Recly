'use strict';

const path = require('node:path');

const EDITOR_CLOSE_TIMEOUT_MS = 30_000;

/**
 * Move project directories to the Windows recycle bin without aborting the batch
 * when one directory fails.
 *
 * @param {string[]} directories project directories to move
 * @param {(directory: string) => Promise<void>} trashProject one-project trash operation
 * @returns {Promise<{total: number, moved: number, failed: Array<{directory: string, error: string}>}>}
 */
async function trashProjects(directories, trashProject) {
  const result = { total: directories.length, moved: 0, failed: [] };
  for (const directory of directories) {
    try {
      await trashProject(directory);
      result.moved += 1;
    } catch (error) {
      result.failed.push({ directory, error: String(error && error.message ? error.message : error) });
    }
  }
  return result;
}

function closeEditorBeforeTrash(editor) {
  if (!editor || editor.isDestroyed()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      editor.removeListener('closed', onClosed);
      editor.webContents?.removeListener('will-prevent-unload', onUnloadPrevented);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onClosed = () => finish();
    const onUnloadPrevented = () => finish(new Error('工程编辑器尚未保存完成，已跳过；请先保存并关闭编辑器后重试'));

    editor.once('closed', onClosed);
    editor.webContents?.once('will-prevent-unload', onUnloadPrevented);
    timeout = setTimeout(() => finish(new Error('工程编辑器未能关闭，已跳过移入回收站')), EDITOR_CLOSE_TIMEOUT_MS);
    try {
      editor.close();
      if (editor.isDestroyed()) onClosed();
    } catch (error) {
      finish(new Error(`工程编辑器未能关闭，已跳过移入回收站：${String(error && error.message || error)}`));
    }
  });
}

async function trashEditorProject(editor, directory, trashItem) {
  await closeEditorBeforeTrash(editor);
  await trashItem(directory);
}

function canonicalPath(directory) {
  if (typeof directory !== 'string' || !directory.trim()) return null;
  try { return path.resolve(directory).toLowerCase(); } catch { return null; }
}

/**
 * Validate a renderer selection against the current project list, confirm once,
 * then move each valid project to the recycle bin while keeping partial failures.
 *
 * @param {{requestedDirectories: string[], availableDirectories: string[], confirm: (total: number) => Promise<boolean>, trashProject: (directory: string) => Promise<void>}} options
 */
async function trashSelectedProjects({ requestedDirectories, availableDirectories, confirm, trashProject }) {
  const requested = Array.isArray(requestedDirectories) ? requestedDirectories : [];
  const available = new Map();
  for (const directory of (Array.isArray(availableDirectories) ? availableDirectories : [])) {
    const key = canonicalPath(directory);
    if (key && !available.has(key)) available.set(key, directory);
  }

  const directories = [];
  const invalid = [];
  const seen = new Set();
  for (const value of requested) {
    const key = canonicalPath(value);
    const uniqueKey = key || `invalid:${String(value)}`;
    if (seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);
    const directory = key && available.get(key);
    if (directory) directories.push(directory);
    else invalid.push({ directory: typeof value === 'string' ? value : String(value), error: '项目路径无效或已不在当前工程列表中' });
  }

  const total = directories.length + invalid.length;
  if (!total) return { total: 0, moved: 0, failed: [], cancelled: false };
  if (!directories.length) return { total, moved: 0, failed: invalid, cancelled: false };
  if (!(await confirm(total))) return { total, moved: 0, failed: invalid, cancelled: true };

  const result = await trashProjects(directories, trashProject);
  return { total, moved: result.moved, failed: [...invalid, ...result.failed], cancelled: false };
}

module.exports = { trashProjects, trashSelectedProjects, closeEditorBeforeTrash, trashEditorProject };
