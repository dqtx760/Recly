'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PROJECT_EXTENSION } = require('./recording');

function copyProjectToFolder(sourceDirectory, destinationFolder) {
  const source = fs.realpathSync(path.resolve(sourceDirectory));
  const destination = fs.realpathSync(path.resolve(destinationFolder));
  const sourceStat = fs.statSync(source);
  const destinationStat = fs.statSync(destination);
  if (!sourceStat.isDirectory() || !destinationStat.isDirectory()) {
    throw new Error('项目或目标位置不是文件夹');
  }
  if (!fs.existsSync(path.join(source, 'project.json'))) {
    throw new Error('找不到项目文件，无法另存');
  }
  if (path.extname(source).toLowerCase() !== PROJECT_EXTENSION) {
    throw new Error('选择的文件夹不是 Recly 项目');
  }

  const relativeDestination = path.relative(source, destination);
  if (!relativeDestination || (!relativeDestination.startsWith(`..${path.sep}`) && relativeDestination !== '..' && !path.isAbsolute(relativeDestination))) {
    throw new Error('另存位置不能位于当前项目文件夹内');
  }

  const projectName = path.basename(source, path.extname(source));
  const temporary = path.join(destination, `.recly-copy-${randomUUID()}.partial`);
  fs.cpSync(source, temporary, { recursive: true, errorOnExist: true, force: false });

  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? `${projectName}${PROJECT_EXTENSION}` : `${projectName} ${suffix}${PROJECT_EXTENSION}`;
    const target = path.join(destination, name);
    if (fs.existsSync(target)) continue;
    try {
      fs.renameSync(temporary, target);
      return target;
    } catch (error) {
      if (!fs.existsSync(target)) throw error;
    }
  }
}

module.exports = { copyProjectToFolder };
