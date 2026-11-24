import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareWorkDirectory } from './paths.mjs';

test('打包版迁移旧数据且不覆盖已有账号文件', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-data-paths-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const appDirectory = path.join(temporary, 'app');
  const dataDirectory = path.join(temporary, 'local');
  const legacyWork = path.join(appDirectory, 'work');
  const targetWork = path.join(dataDirectory, 'work');
  fs.mkdirSync(path.join(legacyWork, 'accounts'), { recursive: true });
  fs.mkdirSync(path.join(targetWork, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(legacyWork, 'accounts', 'same.json'), 'legacy');
  fs.writeFileSync(path.join(legacyWork, 'settings.json'), 'settings');
  fs.writeFileSync(path.join(targetWork, 'accounts', 'same.json'), 'current');

  assert.equal(prepareWorkDirectory({ packaged: true, appDirectory, dataDirectory }), targetWork);
  assert.equal(fs.readFileSync(path.join(targetWork, 'accounts', 'same.json'), 'utf8'), 'current');
  assert.equal(fs.readFileSync(path.join(targetWork, 'settings.json'), 'utf8'), 'settings');
  assert.equal(fs.readFileSync(path.join(legacyWork, 'accounts', 'same.json'), 'utf8'), 'legacy');
});

test('开发模式的数据目录仍位于项目根目录', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-dev-paths-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const appDirectory = path.join(temporary, 'project');
  const workDirectory = prepareWorkDirectory({
    packaged: false,
    appDirectory,
    dataDirectory: appDirectory,
  });

  assert.equal(workDirectory, path.join(appDirectory, 'work'));
  assert.equal(fs.existsSync(workDirectory), true);
});
