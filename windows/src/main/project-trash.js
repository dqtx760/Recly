'use strict';

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

module.exports = { trashProjects };
