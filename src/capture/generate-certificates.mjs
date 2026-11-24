import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import forge from 'node-forge';

const CERTIFICATE_NAMES = ['ca.crt', 'ca.key', 'leaf.crt', 'leaf.key'];
const DNS_NAMES = ['*.y55l6.com', 'y55l6.com', '*.yingqunet.com', 'yingqunet.com'];
const CERTIFICATE_DAYS = 3650;

function createSerialNumber() {
  const serialNumber = randomBytes(16);
  serialNumber[0] &= 0x7f;
  return serialNumber.toString('hex');
}

function createCertificate(keyPair, subject, issuer, extensions) {
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keyPair.publicKey;
  certificate.serialNumber = createSerialNumber();
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + CERTIFICATE_DAYS * 24 * 60 * 60 * 1000);
  certificate.setSubject(subject);
  certificate.setIssuer(issuer);
  certificate.setExtensions(extensions);
  return certificate;
}

function generateKeyPair() {
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (error, keyPair) => {
      if (error) reject(error);
      else resolve(keyPair);
    });
  });
}

function createCaCertificate(caKeys) {
  const subject = [
    { name: 'commonName', value: 'Shiguang Local Capture CA' },
    { name: 'organizationName', value: 'Shiguang Local Capture CA' },
    { name: 'countryName', value: 'CN' },
  ];
  const certificate = createCertificate(caKeys, subject, subject, [
    { name: 'basicConstraints', critical: true, cA: true },
    { name: 'keyUsage', critical: true, keyCertSign: true, cRLSign: true },
  ]);
  certificate.sign(caKeys.privateKey, forge.md.sha256.create());
  return certificate;
}

function createLeafCertificate(leafKeys, caCertificate, caKeys) {
  const certificate = createCertificate(leafKeys, [
    { name: 'commonName', value: 'y55l6.com' },
  ], caCertificate.subject.attributes, [
    { name: 'subjectAltName', altNames: DNS_NAMES.map((value) => ({ type: 2, value })) },
    { name: 'basicConstraints', critical: true, cA: false },
    { name: 'keyUsage', critical: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ]);
  certificate.sign(caKeys.privateKey, forge.md.sha256.create());
  return certificate;
}

async function createCertificateFiles() {
  const caKeys = await generateKeyPair();
  const leafKeys = await generateKeyPair();
  const caCertificate = createCaCertificate(caKeys);
  const leafCertificate = createLeafCertificate(leafKeys, caCertificate, caKeys);

  return {
    'ca.crt': forge.pki.certificateToPem(caCertificate),
    'ca.key': forge.pki.privateKeyToPem(caKeys.privateKey),
    'leaf.crt': forge.pki.certificateToPem(leafCertificate),
    'leaf.key': forge.pki.privateKeyToPem(leafKeys.privateKey),
  };
}

export async function generateRuntimeCertificates(directory) {
  const certificateDirectory = path.resolve(directory);
  const certificatePaths = CERTIFICATE_NAMES.map((name) => path.join(certificateDirectory, name));
  const existingPaths = certificatePaths.filter((file) => fs.existsSync(file));
  if (existingPaths.length === certificatePaths.length) return false;
  if (existingPaths.length > 0) {
    throw new Error(`证书目录 ${certificateDirectory} 不完整；为避免覆盖已有私钥，请先检查该目录`);
  }

  const files = await createCertificateFiles();
  fs.mkdirSync(certificateDirectory, { recursive: true });
  const temporarySuffix = `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const temporaryPaths = certificatePaths.map((file) => `${file}${temporarySuffix}`);
  const createdPaths = [];

  try {
    for (let index = 0; index < CERTIFICATE_NAMES.length; index += 1) {
      fs.writeFileSync(temporaryPaths[index], files[CERTIFICATE_NAMES[index]], {
        encoding: 'utf8',
        flag: 'wx',
        mode: CERTIFICATE_NAMES[index].endsWith('.key') ? 0o600 : 0o644,
      });
    }
    for (let index = 0; index < CERTIFICATE_NAMES.length; index += 1) {
      fs.renameSync(temporaryPaths[index], certificatePaths[index]);
      createdPaths.push(certificatePaths[index]);
    }
  } catch (error) {
    for (const file of temporaryPaths) fs.rmSync(file, { force: true });
    for (const file of createdPaths) fs.rmSync(file, { force: true });
    throw new Error(`无法在 ${certificateDirectory} 保存本机抓包证书：${error.message}`);
  }

  return true;
}
