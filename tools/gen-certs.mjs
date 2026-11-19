// 生成抓包用的本机测试证书（构建期执行，运行 exe 时不需要 OpenSSL）。
//
// 产物：
//   certificates/ca.crt / ca.key      测试根证书（只用来给目标证书签名，不进 exe）
//   certificates/leaf.crt / leaf.key  覆盖 *.y55l6.com 的通配目标证书（打进 exe）
//   src/capture/certs.mjs             上面两份证书的 base64，供 exe 运行时使用
//
// 已有 certs.mjs 时默认跳过，避免每次构建都换新 CA 让用户重新信任；需要更换用 --force。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CA_DIR = path.join(ROOT, 'certificates');
const OUT = path.join(ROOT, 'src', 'capture', 'certs.mjs');
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

const openssl = findOpenSsl();
const run = (args) => execFileSync(openssl, args, {
  env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (fs.existsSync(OUT) && !FORCE) {
  console.log(`已存在 ${path.relative(ROOT, OUT)}，跳过证书生成（需要更换请加 --force）`);
  process.exit(0);
}

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
const base64 = (file) => fs.readFileSync(file).toString('base64');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `// 由 tools/gen-certs.mjs 生成，请勿手改。
// caCrt 是测试根证书（安装到当前用户受信任根，用于本机解密）；
// leafCrt/leafKey 是覆盖游戏域名的目标证书，仅用于本机抓包。
export const CA_CRT_BASE64 = '${base64(caCrt)}';
export const LEAF_CRT_BASE64 = '${base64(leafCrt)}';
export const LEAF_KEY_BASE64 = '${base64(leafKey)}';
export const CA_THUMBPRINT = '${thumbprint}';
`, 'utf8');

console.log(`已生成测试证书：${path.relative(ROOT, OUT)}`);
console.log(`CA 指纹：${thumbprint}`);
