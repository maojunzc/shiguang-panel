// 微信登录抓包会话：开本机代理 → 等电脑微信里的游戏登录 → 自动保存成账号文件。
//
// 只在本机解密游戏域名（*.y55l6.com）的 HTTPS/WS，不访问第三方服务器；
// 结束或取消时自动还原系统代理，测试证书保留在「当前用户」根证书库（可手动移除）。
import fs from 'node:fs';
import path from 'node:path';
import { createProxy, DEFAULT_PROXY_PORT } from './proxy.mjs';
import { loadCertificates } from './certificates.mjs';
import { decode, toJsonSafe } from '../msgpack.mjs';
import {
  assertWindows, enableProxy, restoreProxy, installCa, isCaInstalled,
} from './system.mjs';

const APPID = 'wx0e42fefbaa22e71b';
const LOGIN_HOST = /(^|\.)y55l6\.com$/;
const INTERESTING_HTTP = /\/(player\/(login|trustshipLogin)|server\/getAllServerName)(\?|$)/;
const SEED_HOSTS = ['login-cc-31.y55l6.com', 'login-cc-32.y55l6.com', 'login-cc-35.y55l6.com'];
const DEFAULT_TIMEOUT_MS = 180 * 1000;
const SNAPSHOT_GRACE_MS = 10 * 1000;

async function generateCertificatesInWorkDirectory(directory) {
  const { generateRuntimeCertificates } = await import('./generate-certificates.mjs');
  return generateRuntimeCertificates(directory);
}

// 初始放行登录域名；出现网关地址后再把网关域名加进来。
class GameHosts extends Set {
  has(host) {
    const name = String(host).toLowerCase();
    return super.has(name) || LOGIN_HOST.test(name);
  }
}

function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text.slice(0, 2000); }
}

function normalizeWsUrl(address) {
  return address.startsWith('ws') ? address : `ws://${address}`;
}

function hostOfUrl(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

export function createCaptureSession({
  workDir,
  accountsDir,
  port = DEFAULT_PROXY_PORT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  record = false,
  generateCertificates = generateCertificatesInWorkDirectory,
  onCapture = () => null,
  log = () => {},
} = {}) {
  const backupFile = path.join(workDir, 'proxy-backup.json');
  const caDir = path.join(workDir, 'mitm');
  const hosts = new GameHosts(SEED_HOSTS);
  let recordFile = null;

  const status = {
    active: false,
    phase: 'idle',
    message: '',
    startedAt: null,
    finishedAt: null,
    error: null,
    account: null,
    progress: { http: 0, frames: 0, login: false, snapshot: false },
    logs: [],
  };

  let proxy = null;
  let proxyOriginal = null;
  let deadline = null;
  let snapshotTimer = null;
  let finished = true;
  let runId = 0;
  let capture = null;

  function addLog(kind, text) {
    const line = { at: Date.now(), kind, text };
    status.logs.push(line);
    if (status.logs.length > 200) status.logs.shift();
    log(kind, text);
    return line;
  }

  function setPhase(phase, message) {
    status.phase = phase;
    status.message = message;
  }

  function resetState() {
    capture = {
      appid: APPID,
      startedAt: new Date().toISOString(),
      platform: 'wechat',
      source: 'panel',
      http: [],
      ws: null,
      login: null,
      loginFrame: null,
      snapshot: null,
    };
    hosts.clear();
    for (const host of SEED_HOSTS) hosts.add(host);
    // 上次抓到的网关域名先放进来，避免重连型 WS 抢在登录响应前建立。
    try {
      const previousHost = hostOfUrl(JSON.parse(fs.readFileSync(path.join(workDir, 'capture.json'), 'utf8')).ws?.url ?? '');
      if (previousHost) hosts.add(previousHost);
    } catch { /* 没有历史采集时忽略 */ }
    status.progress = { http: 0, frames: 0, login: false, snapshot: false };
    status.error = null;
    status.account = null;
    status.finishedAt = null;
  }

  function addHost(host) {
    if (!host) return;
    const name = host.toLowerCase();
    if (hosts.has(name)) return;
    hosts.add(name);
    addLog('host', `加入网关域名：${name}`);
  }

  function handleHttp({ url, method, status: httpStatus, requestBody, responseBody }) {
    const entry = { url, method, status: httpStatus, request: parseJson(requestBody), response: parseJson(responseBody) };
    capture.http.push(entry);
    if (capture.http.length > 20) capture.http.shift();
    status.progress.http = capture.http.length;
    const data = entry.response;
    if (data && typeof data === 'object') {
      if (data.ret) addLog('http', `登录接口返回 ret=${data.ret}`);
      if (data.wsAddress) {
        capture.ws = { url: normalizeWsUrl(String(data.wsAddress)), frames: [] };
        addHost(hostOfUrl(capture.ws.url));
        addLog('http', `已获取网关地址：${capture.ws.url}`);
      }
      if (url.includes('/player/')) {
        capture.login = entry;
        addLog('http', '已捕获玩家登录响应');
      }
    }
  }

  function handleFrame({ direction, context, body }) {
    if (!capture.ws) capture.ws = { url: context, frames: [] };
    const message = toJsonSafe(body);
    if (recordFile) {
      try {
        fs.appendFileSync(recordFile, `${JSON.stringify({ t: new Date().toISOString(), direction, context, message })}\n`);
      } catch { /* 记录失败不影响抓包 */ }
    }
    capture.ws.frames.push({ t: new Date().toISOString(), direction, message });
    if (capture.ws.frames.length > 400) capture.ws.frames.shift();
    status.progress.frames = capture.ws.frames.length;
    if (!message || typeof message !== 'object') return;

    if (direction === 'up' && message.mod === 'user' && message.op === 'login') {
      if (!capture.loginFrame) addLog('ws', `已捕获网关登录帧（角色 ${message.data?.playerId ?? '?'} · 区服 ${message.data?.serverId ?? '?'}）`);
      capture.loginFrame = message;
      status.progress.login = true;
      // 有些账号的登录响应里没有角色快照；有登录帧就可以连接，最多再等一会儿快照。
      if (!snapshotTimer) {
        snapshotTimer = setTimeout(() => {
          snapshotTimer = null;
          if (!finished && !record) void finish('已拿到登录帧（未收到角色快照）', { ok: true });
        }, SNAPSHOT_GRACE_MS);
      }
    } else if (direction === 'down' && message.data?.dt) {
      capture.snapshot = message;
      status.progress.snapshot = true;
      const count = Array.isArray(message.data.dt) ? message.data.dt.length : '?';
      addLog('ws', `已收到角色快照（${count} 项属性）`);
    }
    if (!record && capture.loginFrame && capture.snapshot) void finish('已拿到登录帧与角色快照', { ok: true });
  }

  function saveCapture() {
    const roleId = capture.loginFrame?.data?.playerId ?? capture.snapshot?.data?.roleId ?? null;
    const serverId = capture.loginFrame?.data?.serverId ?? null;
    const base = `wechat-${serverId ?? '0'}-${roleId ?? Date.now()}`;
    const file = path.join(accountsDir, `${base}.json`);
    fs.mkdirSync(accountsDir, { recursive: true });
    const data = {
      ...capture,
      ws: capture.ws ? { ...capture.ws, frames: capture.ws.frames.slice(-40) } : null,
      capturedAt: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
  }

  async function finish(reason, { ok = false, error = null } = {}) {
    if (finished) return;
    finished = true;
    runId += 1;
    if (deadline) { clearTimeout(deadline); deadline = null; }
    if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
    addLog('stop', reason);

    try {
      restoreProxy(proxyOriginal, addLog);
      addLog('stop', '系统代理已还原');
    } catch (cleanupError) {
      addLog('warn', `系统代理还原失败：${cleanupError.message}`);
    }
    proxyOriginal = null;
    try { await proxy?.stop(); } catch { /* 已关闭 */ }
    proxy = null;

    if (ok) {
      try {
        const file = saveCapture();
        addLog('save', `账号已保存：${path.basename(file)}`);
        const account = onCapture(file);
        status.account = account;
        setPhase('done', '登录成功，账号已保存');
      } catch (saveError) {
        status.error = `保存账号失败：${saveError.message}`;
        setPhase('error', status.error);
      }
    } else {
      status.error = error;
      setPhase(error ? 'error' : 'cancelled', reason);
    }
    status.finishedAt = Date.now();
    status.active = false;
  }

  async function start() {
    if (status.active) throw new Error('抓包已经开始了，请等它结束或先取消');
    assertWindows();
    finished = false;
    runId += 1;
    const id = runId;
    status.active = true;
    status.logs = [];
    status.startedAt = Date.now();
    resetState();
    setPhase('starting', '正在准备测试证书与本机代理');
    addLog('start', `开始微信登录抓包（本机端口 ${port}）`);
    if (record) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      recordFile = path.join(workDir, `record-${stamp}.jsonl`);
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(recordFile, '');
      addLog('record', `日志记录已开启：${path.basename(recordFile)}`);
    } else {
      recordFile = null;
    }

    try {
      addLog('ca', '正在检查本机抓包证书');
      if (await generateCertificates(caDir)) {
        addLog('ca', '已在本机生成专属测试证书');
      }
      const certificates = loadCertificates(caDir);
      if (!isCaInstalled({ certificates })) await installCa(caDir, addLog, certificates);
      else addLog('ca', '测试证书已安装');
      if (finished || id !== runId) return status;

      proxy = createProxy({
        port,
        interceptHosts: hosts,
        interceptPorts: [443],
        frameDecoder: (bytes) => ({ name: 'msgpack', body: decode(bytes) }),
        inspectHttp: (url) => INTERESTING_HTTP.test(url),
        onHttp: handleHttp,
        onFrame: handleFrame,
        certificateFor: () => certificates,
        caIsInstalled: () => isCaInstalled({ certificates }),
        log: (kind, message) => {
          if (kind === 'warn') addLog('warn', message);
        },
      });
      await proxy.listen();
      if (finished || id !== runId) { await proxy.stop(); proxy = null; return status; }

      proxyOriginal = enableProxy(port, backupFile, addLog);
      addLog('start', '系统代理已指向本机抓包端口');
      setPhase('waiting', '等待微信里的游戏登录');
      addLog('wait', '请在电脑微信里完全关闭游戏，再重新打开并进入主界面');

      deadline = setTimeout(() => {
        if (capture.loginFrame) void finish(record ? '记录时间到，已保存账号' : '已超时，但已拿到登录帧', { ok: true });
        else void finish('等待超时：没有检测到登录，请确认电脑微信已登录并在微信里打开游戏', { ok: false, error: '等待超时' });
      }, record ? Math.max(timeoutMs, 30 * 60 * 1000) : timeoutMs);
    } catch (startError) {
      status.error = startError.message;
      await finish(`启动失败：${startError.message}`, { ok: false, error: startError.message });
    }
    return status;
  }

  function cancel() {
    if (!status.active) return status;
    void finish('已取消', { ok: false });
    return status;
  }

  // 服务退出时同步还原，避免留下指向已关闭端口的系统代理。
  function dispose() {
    if (deadline) clearTimeout(deadline);
    if (snapshotTimer) clearTimeout(snapshotTimer);
    if (proxyOriginal) {
      try { restoreProxy(proxyOriginal); } catch { /* 尽力还原 */ }
      proxyOriginal = null;
    }
    try { proxy?.stop(); } catch { /* 进程即将退出 */ }
    proxy = null;
  }

  return {
    start,
    cancel,
    dispose,
    status: () => ({
      ...status,
      recordFile: recordFile ? path.basename(recordFile) : null,
      logs: status.logs.slice(-120),
      certInstalled: isCaInstalled({ dir: caDir }),
    }),
  };
}
