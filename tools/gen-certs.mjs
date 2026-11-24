// 在使用抓包的机器上生成证书，仅写入本地 certificates/（或 --dir 指定目录）。
// ca.crt / ca.key 为根证书；leaf.crt / leaf.key 为目标证书，不生成源码模块或嵌入 exe。
// 已有完整证书时默认跳过；需要更换用 --force。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const dirIndex = process.argv.indexOf('--dir');
if (dirIndex !== -1 && (!process.argv[dirIndex + 1] || process.argv[dirIndex + 1].startsWith('--'))) {
  throw new Error('--dir 需要指定证书目录');
}
const CA_DIR = dirIndex === -1 ? path.join(ROOT, 'certificates') : path.resolve(process.argv[dirIndex + 1]);
const FORCE = process.argv.includes('--force');

export const CA_CN = 'Shiguang Local Capture CA';
export const LEAF_SANS = ['*.y55l6.com', 'y55l6.com', '*.yingqunet.com', 'yingqunet.com'];

function findOpenSsl() {
  if (process.env.SG_OPENSSL) return process.env.SG_OPENSSL;
  const options = { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    execFileSync('openssl', ['version'], options);
    return 'openssl';
  } catch {
    // Git for Windows 自带 OpenSSL，但通常不在 PATH 里。
    let gitPaths = [];
    try { gitPaths = execFileSync('where.exe', ['git'], options).toString().trim().split(/\r?\n/); }
    catch { /* 在下面报错 */ }
    const bundled = gitPaths.map((file) => path.resolve(path.dirname(file), '../usr/bin/openssl.exe'))
      .find((file) => fs.existsSync(file));
    if (bundled) return bundled;
    throw new Error('找不到 OpenSSL。请安装 Git for Windows，或用 SG_OPENSSL 指定 openssl.exe 的完整路径。');
  }
}

const requiredFiles = ['ca.crt', 'ca.key', 'leaf.crt', 'leaf.key'].map((name) => path.join(CA_DIR, name));
if (!FORCE && requiredFiles.every((file) => fs.existsSync(file))) {
  console.log(`已存在完整证书 ${CA_DIR}，跳过证书生成（需要更换请加 --force）`);
  process.exit(0);
}
if (!FORCE && requiredFiles.some((file) => fs.existsSync(file))) {
  throw new Error(`证书目录 ${CA_DIR} 不完整，请检查后加 --force 重新生成`);
}

const openssl = findOpenSsl();
const run = (args) => execFileSync(openssl, args, {
  env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

fs.mkdirSync(CA_DIR, { recursive: true });
const caKey = path.join(CA_DIR, 'ca.key');
const caCrt = path.join(CA_DIR, 'ca.crt');
const leafKey = path.join(CA_DIR, 'leaf.key');
const leafCsr = path.join(CA_DIR, 'leaf.csr');
const leafCrt = path.join(CA_DIR, 'leaf.crt');
const leafExt = path.join(CA_DIR, 'leaf.ext');

run(['genrsa', '-out', caKey, '2048']);
run([
  'req', '-x509', '-new', '-key', caKey, '-sha256', '-days', '3650',
  '-out', caCrt,
  '-subj', `/CN=${CA_CN}/O=${CA_CN}/C=CN`,
  '-addext', 'basicConstraints=critical,CA:TRUE',
  '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
]);

run(['genrsa', '-out', leafKey, '2048']);
fs.writeFileSync(leafExt, [
  `subjectAltName=${LEAF_SANS.map((name) => `DNS:${name}`).join(',')}`,
  'basicConstraints=critical,CA:FALSE',
  'keyUsage=critical,digitalSignature,keyEncipherment',
  'extendedKeyUsage=serverAuth',
  '',
].join('\n'));
run(['req', '-new', '-key', leafKey, '-out', leafCsr, '-subj', '/CN=y55l6.com']);
run([
  'x509', '-req', '-in', leafCsr, '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial',
  '-out', leafCrt, '-days', '3650', '-sha256', '-extfile', leafExt,
]);

const fingerprint = run(['x509', '-in', caCrt, '-noout', '-fingerprint', '-sha1']).toString();
const thumbprint = fingerprint.replace(/^.*?=/m, '').trim().replace(/:/g, '').toUpperCase();
console.log(`已生成本机测试证书：${CA_DIR}（含私钥，请勿提交或分发）`);
console.log(`CA 指纹：${thumbprint}`);
