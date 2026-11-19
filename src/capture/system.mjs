// 抓包需要的 Windows 系统改动：系统代理（HKCU）与当前用户受信任根证书。
//
// 只改当前用户，不需要管理员：代理写注册表，证书用 certutil -user 安装；
// 抓包结束后恢复代理，证书保留在「当前用户 → 受信任的根证书颁发机构」，可随时移除。
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { CA_CRT_BASE64, CA_THUMBPRINT } from './certs.mjs';

const execFileAsync = promisify(execFile);

export const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const VALUES = ['ProxyEnable', 'ProxyServer', 'ProxyOverride'];

export function assertWindows() {
  if (process.platform !== 'win32') throw new Error('微信登录抓包只支持 Windows 电脑版微信');
}

function reg(args) {
  try {
    return execFileSync('reg', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (error) {
    return error.stdout?.toString() ?? '';
  }
}

export function readProxy() {
  let out = '';
  try {
    out = execFileSync('reg', ['query', REG_KEY], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch {
    return {};
  }
  const values = {};
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_\w+\s+(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

function pointsTo(values, port) {
  if (Number(values.ProxyEnable) !== 1) return false;
  return String(values.ProxyServer ?? '').split(';').some((part) => {
    const address = part.split('=').at(-1).trim().replace(/^https?:\/\//i, '').toLowerCase();
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(address);
  });
}

function setValue(name, value) {
  if (value === undefined) {
    reg(['delete', REG_KEY, '/v', name, '/f']);
    return;
  }
  reg(['add', REG_KEY, '/v', name, '/t', name === 'ProxyEnable' ? 'REG_DWORD' : 'REG_SZ', '/d', value, '/f']);
}

export function writeProxyBackup(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ key: REG_KEY, values, savedAt: new Date().toISOString() }, null, 2));
}

export function readProxyBackup(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved?.key === REG_KEY && saved.values && typeof saved.values === 'object' ? saved.values : null;
  } catch {
    return null;
  }
}

// 指向本机抓包端口；返回原始设置，用于 restoreProxy。上次异常退出留下的代理会先按备份还原。
export function enableProxy(port, backupFile, log = () => {}) {
  const current = readProxy();
  if (pointsTo(current, port)) {
    const saved = readProxyBackup(backupFile);
    if (saved) {
      restoreProxy(saved, log);
      log('proxy', '检测到上次未还原的系统代理，已先恢复');
    }
  }
  const original = readProxy();
  writeProxyBackup(backupFile, original);
  setValue('ProxyEnable', '1');
  setValue('ProxyServer', `127.0.0.1:${port}`);
  setValue('ProxyOverride', '<local>');
  const active = readProxy();
  if (!pointsTo(active, port)) throw new Error('系统代理写入后校验失败，请检查是否有安全软件拦截');
  return original;
}

export function restoreProxy(original, log = () => {}) {
  if (!original) return;
  for (const name of VALUES) setValue(name, original[name]);
  const active = readProxy();
  const ok = VALUES.every((name) => (original[name] ?? '') === (active[name] ?? ''));
  if (!ok) log('warn', '系统代理还原校验失败，请到 Windows 设置 → 网络 → 代理 中手动关闭');
}

function caFile(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ca.crt');
  const pem = Buffer.from(CA_CRT_BASE64, 'base64').toString('utf8');
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { /* 首次写入 */ }
  if (existing !== pem) fs.writeFileSync(file, pem);
  return file;
}

let installedCache = { at: 0, value: false };

export function isCaInstalled({ fresh = false } = {}) {
  if (!fresh && Date.now() - installedCache.at < 5000) return installedCache.value;
  let value = false;
  try {
    execFileSync('certutil', ['-user', '-store', 'Root', CA_THUMBPRINT], { stdio: ['ignore', 'pipe', 'pipe'] });
    value = true;
  } catch {
    value = false;
  }
  installedCache = { at: Date.now(), value };
  return value;
}

export async function installCa(dir, log = () => {}) {
  assertWindows();
  if (isCaInstalled({ fresh: true })) return true;
  const file = caFile(dir);
  log('ca', '正在把本机测试证书加入「当前用户」受信任根证书；如果 Windows 弹出安全警告，请选择「是」');
  try {
    await execFileAsync('certutil', ['-user', '-addstore', 'Root', file], { windowsHide: true, timeout: 120000 });
  } catch (error) {
    const detail = (error.stderr || error.stdout || error.message || '').toString().trim();
    throw new Error(`安装测试证书失败：${detail || error.code || '未知错误'}`);
  }
  for (let i = 0; i < 10; i += 1) {
    if (isCaInstalled({ fresh: true })) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('测试证书未出现在当前用户根证书库，可能被安全软件拦截');
}

export async function removeCa(log = () => {}) {
  assertWindows();
  if (!isCaInstalled({ fresh: true })) {
    log('ca', '当前用户根证书里没有本工具的测试证书，无需移除');
    return false;
  }
  try {
    await execFileAsync('certutil', ['-user', '-delstore', 'Root', CA_THUMBPRINT], { windowsHide: true, timeout: 60000 });
  } catch (error) {
    throw new Error(`移除测试证书失败：${error.message}`);
  }
  installedCache = { at: Date.now(), value: false };
  log('ca', '测试证书已从当前用户根证书库移除');
  return true;
}
