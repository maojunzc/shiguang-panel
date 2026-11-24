import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';

export const IS_PACKAGED = isSea();
export const APP_DIRECTORY = IS_PACKAGED
  ? path.dirname(process.execPath)
  : path.resolve(typeof __dirname === 'string' ? __dirname : import.meta.dirname, '..');
export const DATA_DIRECTORY = IS_PACKAGED
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ShiguangPanel')
  : APP_DIRECTORY;
export const WORK_DIRECTORY = path.join(DATA_DIRECTORY, 'work');

function copyMissingFiles(sourceDirectory, targetDirectory) {
  fs.mkdirSync(targetDirectory, { recursive: true });
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const source = path.join(sourceDirectory, entry.name);
    const target = path.join(targetDirectory, entry.name);
    if (entry.isDirectory()) {
      copyMissingFiles(source, target);
    } else if (entry.isFile() && !fs.existsSync(target)) {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    }
  }
}

export function prepareWorkDirectory({
  packaged = IS_PACKAGED,
  appDirectory = APP_DIRECTORY,
  dataDirectory = DATA_DIRECTORY,
} = {}) {
  const workDirectory = path.join(dataDirectory, 'work');
  const legacyWorkDirectory = path.join(appDirectory, 'work');
  if (packaged && path.resolve(legacyWorkDirectory) !== path.resolve(workDirectory)
    && fs.existsSync(legacyWorkDirectory)) {
    try {
      copyMissingFiles(legacyWorkDirectory, workDirectory);
    } catch (error) {
      throw new Error(`无法迁移旧版数据目录 ${legacyWorkDirectory}：${error.message}`);
    }
  }

  fs.mkdirSync(workDirectory, { recursive: true });
  return workDirectory;
}
