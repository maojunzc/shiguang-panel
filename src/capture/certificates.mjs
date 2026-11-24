import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { isSea } from 'node:sea';
import { createSecureContext } from 'node:tls';

const ROOT = isSea() ? path.dirname(process.execPath) : path.resolve(import.meta.dirname, '../..');

export function loadCertificates(dir) {
  const directories = [dir ?? path.join(ROOT, 'work', 'mitm'), path.join(ROOT, 'certificates')];
  for (const directory of new Set(directories)) {
    const files = ['ca.crt', 'leaf.crt', 'leaf.key'].map((name) => path.join(directory, name));
    if (!files.some((file) => fs.existsSync(file))) continue;
    try {
      const [ca, cert, keyPem] = files.map((file) => fs.readFileSync(file));
      const root = new X509Certificate(ca);
      const leaf = new X509Certificate(cert);
      if (!leaf.checkIssued(root) || !leaf.verify(root.publicKey)) throw new Error('目标证书与根证书不匹配');
      createSecureContext({ cert, key: keyPem });
      return { ca, cert, keyPem, caFile: files[0], thumbprint: root.fingerprint.replace(/:/g, '') };
    } catch (error) {
      throw new Error(`本机抓包证书不可用（${directory}）：${error.message}。请运行 node tools/gen-certs.mjs --dir "${directory}" --force 重新生成，再开始抓包。`);
    }
  }
  throw new Error(`缺少本机抓包证书。请在本机源码目录运行 npm run certs，或运行 node tools/gen-certs.mjs --dir "${directories[0]}"；需要 ca.crt、leaf.crt 和 leaf.key。使用 exe 时请将本机生成的证书放到 exe 同目录的 certificates 或 work/mitm 目录，再开始抓包。`);
}
