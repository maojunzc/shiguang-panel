import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');

test('缺少证书时模块与代理仍能启动，抓包加载时给出生成提示', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-capture-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const captureDir = path.join(temporary, 'src', 'capture');
  fs.mkdirSync(captureDir, { recursive: true });
  for (const name of ['certificates.mjs', 'proxy.mjs', 'system.mjs', 'session.mjs']) {
    fs.copyFileSync(path.join(import.meta.dirname, name), path.join(captureDir, name));
  }
  fs.copyFileSync(path.join(root, 'src', 'msgpack.mjs'), path.join(temporary, 'src', 'msgpack.mjs'));
  const { loadCertificates } = await import(pathToFileURL(path.join(captureDir, 'certificates.mjs')));
  const { createProxy } = await import(pathToFileURL(path.join(captureDir, 'proxy.mjs')));
  const { isCaInstalled } = await import(pathToFileURL(path.join(captureDir, 'system.mjs')));
  const { createCaptureSession } = await import(pathToFileURL(path.join(captureDir, 'session.mjs')));
  assert.equal(isCaInstalled(), false);
  assert.throws(() => loadCertificates(), /npm run certs/);
  const proxy = createProxy({ port: 0 });
  t.after(() => proxy.stop());
  await proxy.listen();
  assert.ok(proxy.port > 0);
  const session = createCaptureSession({ workDir: path.join(temporary, 'work'), accountsDir: path.join(temporary, 'work', 'accounts') });
  assert.equal(session.status().certInstalled, false);
  if (process.platform === 'win32') {
    const status = await session.start();
    assert.equal(status.phase, 'error');
    assert.match(status.error, /npm run certs/);
    assert.equal(fs.existsSync(path.join(temporary, 'work', 'proxy-backup.json')), false);
  }
});

test('生成的运行时证书可加载，重复生成保持 CA，不写源码模块', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-certs-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temporary, 'tools'));
  const generator = path.join(temporary, 'tools', 'gen-certs.mjs');
  fs.copyFileSync(path.join(root, 'tools', 'gen-certs.mjs'), generator);
  const directory = path.join(temporary, 'certificates');
  execFileSync(process.execPath, [generator], { stdio: 'pipe' });
  const { loadCertificates } = await import('./certificates.mjs');
  const first = loadCertificates(directory);
  assert.ok(first.cert.length > 0);
  assert.ok(first.keyPem.length > 0);
  assert.match(first.thumbprint, /^[A-F0-9]{40}$/);
  execFileSync(process.execPath, [generator], { stdio: 'pipe' });
  assert.equal(loadCertificates(directory).thumbprint, first.thumbprint);
  assert.equal(fs.existsSync(path.join(temporary, 'src', 'capture', 'certs.mjs')), false);
  const alternate = path.join(temporary, 'work', 'mitm');
  execFileSync(process.execPath, [generator, '--dir', alternate], { stdio: 'pipe' });
  assert.notEqual(loadCertificates(alternate).thumbprint, first.thumbprint);
  fs.writeFileSync(path.join(alternate, 'leaf.key'), 'invalid');
  assert.throws(() => loadCertificates(alternate), /--force/);
});
