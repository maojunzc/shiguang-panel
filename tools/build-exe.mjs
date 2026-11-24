// 把面板打包成单文件 exe：Node SEA + esbuild bundle + postject 注入。
// 产物：dist/时光大爆炸面板.exe；不包含本机数据或证书。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');

function collectAssets(directory, prefix = '') {
  const assets = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(prefix, entry.name);
    const sourcePath = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(assets, collectAssets(sourcePath, relativePath));
    else if (entry.isFile()) assets[`public/${relativePath.replaceAll(path.sep, '/')}`] = sourcePath;
  }
  return assets;
}

fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

await build({
  entryPoints: [path.join(ROOT, 'src', 'server.mjs')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(BUILD, 'server.cjs'),
  logOverride: { 'empty-import-meta': 'silent' },
});

const seaConfig = {
  main: 'server.cjs',
  output: 'sea-prep.blob',
  assets: collectAssets(path.join(ROOT, 'public')),
  disableExperimentalSEAWarning: true,
};
fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], {
  cwd: BUILD,
  stdio: 'inherit',
});

const exe = path.join(DIST, '时光大爆炸面板.exe');
fs.rmSync(exe, { force: true });
fs.copyFileSync(process.execPath, exe);
const postject = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(process.execPath, [
  postject, exe, 'NODE_SEA_BLOB', path.join(BUILD, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { stdio: 'inherit' });

console.log(`已生成 ${exe}`);
