// 把面板打包成单文件 exe：Node SEA + esbuild bundle + postject 注入。
// 产物：dist/时光大爆炸面板.exe、dist/public/、使用说明；不包含本机数据或证书。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');

fs.rmSync(BUILD, { recursive: true, force: true });
fs.rmSync(DIST, { recursive: true, force: true });
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
  main: path.join(BUILD, 'server.cjs'),
  output: path.join(BUILD, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
};
fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(BUILD, 'sea-config.json')], { stdio: 'inherit' });

const exe = path.join(DIST, '时光大爆炸面板.exe');
fs.copyFileSync(process.execPath, exe);
const postject = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(process.execPath, [
  postject, exe, 'NODE_SEA_BLOB', path.join(BUILD, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { stdio: 'inherit' });

fs.cpSync(path.join(ROOT, 'public'), path.join(DIST, 'public'), { recursive: true });

// 给玩家看的入口：双击 exe 即可写；说明用 txt。

const readme = `时光大爆炸挂机控制台 · 使用说明

一、微信登录（推荐，任何账号都能用）
1. 先在电脑上登录微信，并用要挂机的微信号登录。
2. 双击「时光大爆炸面板.exe」，浏览器打开 http://127.0.0.1:8848
3. 首次抓包前，在这台电脑的源码目录运行 npm run certs（需安装 Node.js 和 OpenSSL / Git for Windows），
   将本机生成的 certificates 目录放到 exe 同目录；也可运行 node tools/gen-certs.mjs --dir "exe 所在目录/work/mitm"。
   证书含私钥，每台电脑单独生成，请勿随安装包分发。没有证书仍可启动面板并导入账号。
4. 在登录页点「开始微信登录」，首次使用会把本机测试证书加入「当前用户」的受信任根证书：
   Windows 弹出安全警告时点「是」；不需要管理员权限。
5. 在微信里把《时光大爆炸》完全关闭，再重新打开并进入游戏主界面。
6. 面板会自动抓到登录、保存账号并进入控制台。结束后系统代理会自动还原。
7. 不想再用时，登录页点「移除本机测试证书」即可。

二、或者导入已有的 capture.json
1. 把文件拖进登录页的虚线框，点账号上的「进入」。
2. 打开「操作」页，勾选要自动做的事；点「立即执行一轮」或开启自动挂机。

三、直接双击就能用
- 双击「时光大爆炸面板.exe」即可：可手动领奖、结算、升级；自动挂机仅运行经过白名单限制的领取/收取动作。
- 只想看数据、不想发送任何操作时，可在命令行启动并加 --read-only。

四、所有账号通用
- 任何等级、任何区服都能用，多账号可分别登录/导入、随时切换。
- 未解锁的模块会标注「未解锁」；条件不满足的动作会自动跳过，不会报错。

五、自动挂机边界
默认计划仅包含：收取建筑产物、离线收益结算、已达成的任务领奖、管家奖励、已完成剧情事件奖励。
推进主线、战斗、升级、集市/科技等动作不加入自动计划；请在可控账号上单独核验并手动执行。自动计划限步数与运行时长，遇到错误或断线即停止。

六、常见问题
- 一直离线 / 登录被拒绝：凭证过期或已在别处登录，回到登录页重新用「微信登录」抓一次。
- 抓不到登录：确认电脑微信已登录、微信里的游戏是重新打开的、没有开其它代理或 VPN；先点「取消」再重新开始。
- 按钮无反应：确认游戏处于在线状态；如果启动时加了 --read-only，按钮会是灰的。
- 「全部协议」是进阶功能，普通玩家无需使用，参数不确定时不要执行。

七、安全
账号文件等同账号凭证，请勿外传；抓包只在本机进行，不会上传数据。
写操作会真实改动账号数据，请自行判断并遵守游戏规则。
`;
fs.writeFileSync(path.join(DIST, '使用说明.txt'), `\uFEFF${readme}`, 'utf8');

console.log(`已生成 ${exe}`);
