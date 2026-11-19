// 《时光大爆炸》本地控制台服务。
// 只连抓包记录的官方网关；默认允许写操作，仅当显式 --read-only 时才只读。
// 启动后先展示登录页，由用户在账号列表里选择抓包账号再连接。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';
import { ShiguangClient, attrName } from './client.mjs';
import { ACTIONS, listActions, runAction } from './actions.mjs';
import { activityBook } from './activities.mjs';
import PROTOCOLS from './protocols.mjs';
import { createCaptureSession } from './capture/session.mjs';
import { removeCa } from './capture/system.mjs';

// 源码运行取 src 的上级；打包成 exe 后取 exe 所在目录（public/ 与 work/ 放在 exe 旁边）。
const SRC_DIR = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const ROOT = isSea() ? path.dirname(process.execPath) : path.resolve(SRC_DIR, '..');
const PUBLIC = path.join(ROOT, 'public');
const WORK = path.join(ROOT, 'work');
const ACCOUNTS_DIR = path.join(WORK, 'accounts');
const SETTINGS_FILE = path.join(WORK, 'settings.json');

function parseArgs(argv) {
  const options = { capture: path.join(WORK, 'capture.json'), port: 8848, allowWrite: true, interval: 300 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--capture') options.capture = path.resolve(argv[++i]);
    else if (argv[i] === '--port') options.port = Number(argv[++i]);
    else if (argv[i] === '--read-only') options.allowWrite = false;
    else if (argv[i] === '--allow-write') options.allowWrite = true;
    else if (argv[i] === '--auto') options.auto = true;
    else if (argv[i] === '--interval') options.interval = Math.max(30, Number(argv[++i]));
    else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(`用法：${isSea() ? path.basename(process.execPath) : 'node src/server.mjs'} [--capture work/capture.json] [--port 8848] [--read-only] [--auto] [--interval 300]`);
  console.log('  默认可写：面板里的领奖/结算/升级按钮会真实发请求。只看数据时加 --read-only。');
  console.log('  加 --auto 后启动即登录默认账号，并按 --interval 秒（默认 300）自动执行勾选的动作；只读模式下不生效。');
  process.exit(0);
}

// ---------- 设置（自动挂机勾选） ----------

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(next) {
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
}

const settings = readSettings();

// 协议库：_logic_ 里出现过的全部 mod.op，界面上可以逐个勾选或手动执行。
const protoIndex = new Map(PROTOCOLS.map((item) => [`${item.mod}.${item.op}`, item]));
const protoData = settings.protoData && typeof settings.protoData === 'object' ? { ...settings.protoData } : {};

function isValidPlanName(name) {
  return Boolean(ACTIONS[name]) || protoIndex.has(name);
}

function saveProtoData() {
  settings.protoData = protoData;
  writeSettings(settings);
}

// 自动模式只跑这些「不消耗资源、不需要选目标」的动作；全部只操作已勾选项。
const DEFAULT_AUTO_PLAN = [
  'build.collect', 'build.settle', 'build.offline',
  'task.claimAll', 'task.dailyBox', 'task.mainFinish',
  'mail.claimAll', 'helper.collect', 'helper.gainAward',
  'market.settle', 'market.rumor', 'market.replenish',
  'tech.finish', 'tech.aidOthers', 'wonder.finishVisit',
  'privilege.moon', 'privilege.forever', 'freeshopping.claim',
  'activity.claimAll',
];

const autoPlan = new Set(
  Array.isArray(settings.autoPlan)
    ? settings.autoPlan.filter((name) => isValidPlanName(name))
    : DEFAULT_AUTO_PLAN.filter((name) => ACTIONS[name]),
);

function saveAutoPlan() {
  settings.autoPlan = [...autoPlan];
  writeSettings(settings);
}

// ---------- 抓包账号 ----------

function loadCaptureFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { data, gateway: data.ws?.url ?? data.wsUrl, loginFrame: data.loginFrame };
}

function gatewayHost(gateway) {
  try {
    return new URL(gateway).host;
  } catch {
    return null;
  }
}

function describeCapture(file) {
  const info = {
    file: path.basename(file),
    path: path.resolve(file),
    valid: false,
    name: null,
    level: null,
    roleId: null,
    serverId: null,
    host: null,
    mtime: null,
    error: null,
  };
  try {
    info.mtime = fs.statSync(file).mtimeMs;
    const { data, gateway, loginFrame } = loadCaptureFile(file);
    info.valid = Boolean(gateway && loginFrame);
    info.host = gateway ? gatewayHost(gateway) : null;
    info.name = data.login?.response?.nickName ?? null;
    info.roleId = data.snapshot?.data?.roleId ?? loginFrame?.data?.playerId ?? null;
    info.serverId = loginFrame?.data?.serverId ?? data.login?.response?.realmsId ?? null;
    const dt = data.snapshot?.data?.dt;
    if (Array.isArray(dt)) {
      for (let i = 0; i + 1 < dt.length; i += 2) {
        const info2 = attrName(dt[i]);
        if (!info2 || info2.tid !== 0) continue;
        if (info2.cls === 'UserDt' && info2.name === 'level') info.level = dt[i + 1];
        if (!info.name && info2.cls === 'UserDt' && info2.name === 'name') info.name = dt[i + 1];
      }
    }
  } catch (error) {
    info.error = error.message;
  }
  return info;
}

function accountFiles() {
  const files = [];
  if (fs.existsSync(options.capture)) files.push(options.capture);
  if (fs.existsSync(ACCOUNTS_DIR)) {
    for (const name of fs.readdirSync(ACCOUNTS_DIR)) {
      if (name.toLowerCase().endsWith('.json')) files.push(path.join(ACCOUNTS_DIR, name));
    }
  }
  return files;
}

function listAccounts() {
  return accountFiles().map((file) => {
    const info = describeCapture(file);
    info.active = Boolean(currentAccount) && path.resolve(currentAccount.path) === path.resolve(file);
    return info;
  });
}

function isAllowedCapture(file) {
  const abs = path.resolve(file);
  if (abs === path.resolve(options.capture)) return true;
  return abs.startsWith(path.resolve(ACCOUNTS_DIR) + path.sep);
}

// ---------- 微信登录抓包 ----------

const captureSession = createCaptureSession({
  workDir: WORK,
  accountsDir: ACCOUNTS_DIR,
  onCapture(file) {
    startAccount(file);
    return describeCapture(file);
  },
  log(kind, message) {
    console.log(`[微信登录 ${kind}] ${message}`);
  },
});

process.on('exit', () => captureSession.dispose());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    captureSession.dispose();
    process.exit(0);
  });
}

// ---------- 客户端与会话 ----------

let client = null;
let currentAccount = null;
const subscribers = new Set();
const changes = [];
const prevDt = new Map();
let status = 'no-account';
let lastError = '';
let syncedAt = null;

function startAccount(file) {
  if (!isAllowedCapture(file)) throw new Error('账号文件不在可访问目录内');
  const { gateway, loginFrame } = loadCaptureFile(file);
  if (!gateway || !loginFrame) throw new Error('登录信息缺少网关地址或登录帧，请重新抓包并进入游戏主界面');

  if (client) client.close();
  activityBook.activities.clear();
  activityBook.claimed.clear();
  prevDt.clear();
  changes.length = 0;
  lastError = '';
  syncedAt = null;
  status = 'connecting';

  currentAccount = describeCapture(file);
  client = new ShiguangClient({ gateway, loginFrame, autoReconnect: true });
  wireClient(client);
  client.connect().catch((error) => {
    status = 'offline';
    lastError = error.message;
    console.error(`登录失败：${error.message}`);
    scheduleBroadcast();
  });
  scheduleBroadcast();
}

function stopAccount() {
  if (client) client.close();
  client = null;
  currentAccount = null;
  activityBook.activities.clear();
  activityBook.claimed.clear();
  prevDt.clear();
  changes.length = 0;
  status = 'no-account';
  lastError = '';
  syncedAt = null;
  scheduleBroadcast();
}

function wireClient(instance) {
  instance.on('login', (response) => {
    status = 'online';
    lastError = '';
    syncedAt = Date.now();
    prevDt.clear();
    const dt = response.data?.dt;
    if (Array.isArray(dt)) for (let i = 0; i + 1 < dt.length; i += 2) prevDt.set(dt[i], dt[i + 1]);
    console.log(`登录成功：${instance.gateway}`);
    scheduleBroadcast();
  });
  instance.on('changed', (list) => remember(list));
  instance.on('push', (push) => {
    activityBook.absorb(push.data);
    if (push.data?.dt) remember(push.data.dt);
    else scheduleBroadcast();
  });
  instance.on('error', (error) => {
    lastError = error.message;
    console.error(`[错误] ${error.message}`);
    scheduleBroadcast();
  });
  instance.on('reconnecting', () => {
    status = 'reconnecting';
    scheduleBroadcast();
  });
  instance.on('close', () => {
    if (instance !== client) return;
    status = instance._closed ? 'closed' : 'reconnecting';
    scheduleBroadcast();
  });
}

// ---------- 自动挂机 ----------

const auto = {
  enabled: Boolean(options.allowWrite && (settings.autoEnabled ?? Boolean(options.auto))),
  intervalSec: options.interval,
  running: false,
  lastRunAt: null,
  lastResults: [],
};

async function runAutoOnce(force = false) {
  if ((!auto.enabled && !force) || auto.running || status !== 'online' || !client) return null;
  auto.running = true;
  const results = [];
  try {
    for (const name of autoPlan) {
      try {
        let result;
        if (ACTIONS[name]) {
          result = await runAction(client, name);
        } else {
          const entry = protoIndex.get(name);
          if (!entry) continue;
          result = await runAction(client, 'proto.call', { mod: entry.mod, op: entry.op, data: protoData[name] ?? {} });
          result = { ...result, title: name };
        }
        results.push({ name, title: result.title, ok: result.ok, code: result.code ?? null, note: result.skipped ?? null });
      } catch (error) {
        results.push({ name, title: name, ok: false, note: error.message });
      }
    }
    auto.lastRunAt = Date.now();
    auto.lastResults = results.slice(-16);
    const done = results.filter((row) => row.ok).length;
    if (done) console.log(`[自动] ${new Date().toLocaleTimeString('zh-CN')} 执行成功 ${done} 项`);
    scheduleBroadcast();
  } finally {
    auto.running = false;
  }
  return results;
}

if (auto.enabled) setTimeout(runAutoOnce, 8000);
setInterval(runAutoOnce, auto.intervalSec * 1000);

function recordChanges(list) {
  if (!Array.isArray(list)) return;
  for (let i = 0; i + 1 < list.length; i += 2) {
    const id = list[i];
    const value = list[i + 1];
    const before = prevDt.get(id);
    prevDt.set(id, value);
    if (before === value) continue;
    const info = attrName(id);
    changes.unshift({
      at: Date.now(),
      id,
      label: info?.label ?? `未知属性#${id}`,
      cls: info?.cls ?? null,
      name: info?.name ?? null,
      tid: info?.tid ?? 0,
      before: before ?? null,
      after: value,
    });
  }
  if (changes.length > 200) changes.length = 200;
}

// ---------- 状态快照 ----------

function buildState() {
  const rows = client ? client.snapshot() : [];
  const get = (cls, name) => rows.filter((row) => row.cls === cls && row.name === name);
  const scalar = (cls, name) => get(cls, name).find((row) => row.tid === 0)?.value ?? null;
  const hasCls = (cls) => rows.some((row) => row.cls === cls);
  const items = get('ItemDt', 'count')
    .map((row) => ({ tid: row.tid, count: Number(row.value) }))
    .sort((a, b) => b.count - a.count);
  const taskRows = get('TaskDt', 'comState');
  const taskStates = {};
  for (const row of taskRows) taskStates[row.value] = (taskStates[row.value] ?? 0) + 1;
  const builds = get('BuildDt', 'lv').map((row) => ({ tid: row.tid, lv: Number(row.value) })).sort((a, b) => b.lv - a.lv);
  const mods = get('ModDt', 'unlockTime');
  const moduleList = [
    { key: 'market', name: '集市', desc: '营业结算 / 流言 / 补货', unlocked: hasCls('MarketDt') },
    { key: 'helper', name: '管家', desc: '托管收取 / 奖励领取', unlocked: hasCls('HelperDt') },
    { key: 'union', name: '同盟', desc: '科技互助 / 同盟战', unlocked: Number(scalar('UnionDt', 'id') ?? 0) > 0 },
    { key: 'tech', name: '科技', desc: '研究完成 / 互助', unlocked: hasCls('TechDt') },
    { key: 'wonder', name: '奇观', desc: '游览完成 / 奇观奖励', unlocked: hasCls('WonderDt') },
    { key: 'privilege', name: '月卡', desc: '每日奖励 / 终身卡', unlocked: Number(scalar('PrivilegeCardDt', 'moon_card_end_time') ?? 0) * 1000 > Date.now() },
  ];

  return {
    status,
    error: lastError,
    syncedAt,
    serverMS: client?.serverMS ?? null,
    account: currentAccount,
    profile: {
      name: scalar('UserDt', 'name'),
      level: scalar('UserDt', 'level'),
      roleId: scalar('UserDt', 'role_id') ?? currentAccount?.roleId ?? null,
      serverId: scalar('UserDt', 'server_id') ?? currentAccount?.serverId ?? null,
      roleDay: scalar('UserDt', 'role_day'),
      ip: scalar('UserDt', 'ip_location'),
      power: scalar('UserDt', 'history_total_power'),
      sex: scalar('UserDt', 'sex'),
      registerTime: scalar('UserDt', 'register_time'),
      lastLoginTime: scalar('UserDt', 'last_login_time'),
      offlineTime: scalar('UserDt', 'offline_time'),
    },
    items,
    tasks: { total: taskRows.length, states: taskStates },
    builds: { total: builds.length, list: builds },
    mods: { unlocked: mods.length },
    modules: moduleList,
    counters: {
      attrs: rows.length,
      parsed: rows.filter((row) => row.cls).length,
    },
    writeEnabled: options.allowWrite,
    auto: {
      enabled: auto.enabled,
      running: auto.running,
      intervalSec: auto.intervalSec,
      lastRunAt: auto.lastRunAt,
      lastResults: auto.lastResults,
    },
    autoPlan: [...autoPlan],
    activities: activityBook.summary(),
    activityTotal: activityBook.activities.size,
    changes: changes.slice(0, 60),
  };
}

let broadcastTimer = null;
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const payload = `event: state\ndata: ${JSON.stringify(buildState())}\n\n`;
    for (const res of subscribers) res.write(payload);
  }, 300);
}

function remember(list) {
  recordChanges(list);
  scheduleBroadcast();
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 8 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error(`请求 JSON 无法解析：${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: state\ndata: ${JSON.stringify(buildState())}\n\n`);
    subscribers.add(res);
    req.on('close', () => subscribers.delete(res));
    return;
  }

  if (url.pathname === '/api/state') {
    sendJson(res, 200, buildState());
    return;
  }

  if (url.pathname === '/api/accounts') {
    sendJson(res, 200, { accounts: listAccounts(), accountsDir: ACCOUNTS_DIR });
    return;
  }

  if (url.pathname === '/api/account/select' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.file) throw new Error('缺少要登录的账号文件');
      startAccount(String(body.file));
      sendJson(res, 200, { ok: true, account: currentAccount });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/account/logout' && req.method === 'POST') {
    stopAccount();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/accounts/import' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = typeof body.content === 'string' ? JSON.parse(body.content) : body.content;
      const gateway = data?.ws?.url ?? data?.wsUrl;
      if (!gateway || !data?.loginFrame) throw new Error('不是有效的 capture.json（缺少 ws.url 或 loginFrame）');
      fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
      const base = String(body.name || data?.login?.response?.nickName || data?.snapshot?.data?.roleId || 'account')
        .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
        .slice(0, 40);
      const file = path.join(ACCOUNTS_DIR, `${base}-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      sendJson(res, 200, { ok: true, account: { ...describeCapture(file), active: false } });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/wechat/status') {
    sendJson(res, 200, captureSession.status());
    return;
  }

  if (url.pathname === '/api/wechat/start' && req.method === 'POST') {
    try {
      const status = await captureSession.start();
      sendJson(res, 200, { ok: true, status });
    } catch (error) {
      sendJson(res, 409, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/wechat/cancel' && req.method === 'POST') {
    sendJson(res, 200, { ok: true, status: captureSession.cancel() });
    return;
  }

  if (url.pathname === '/api/wechat/cert' && req.method === 'DELETE') {
    try {
      await removeCa((kind, message) => console.log(`[微信登录 ${kind}] ${message}`));
      sendJson(res, 200, { ok: true, installed: captureSession.status().certInstalled });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/auto-plan' && req.method === 'GET') {
    sendJson(res, 200, {
      allowWrite: options.allowWrite,
      actions: listActions().filter((action) => action.name !== 'proto.call'),
      plan: [...autoPlan],
      protoData,
    });
    return;
  }

  if (url.pathname === '/api/auto-plan' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const next = Array.isArray(body.plan) ? [...new Set(body.plan.filter((name) => isValidPlanName(name)))] : null;
      if (!next) throw new Error('plan 必须是动作名数组');
      autoPlan.clear();
      for (const name of next) autoPlan.add(name);
      saveAutoPlan();
      if (body.protoData && typeof body.protoData === 'object') {
        const clean = {};
        for (const [key, value] of Object.entries(body.protoData)) {
          if (!protoIndex.has(key) || !value || typeof value !== 'object') continue;
          clean[key] = value;
        }
        for (const key of Object.keys(protoData)) delete protoData[key];
        Object.assign(protoData, clean);
        saveProtoData();
      }
      scheduleBroadcast();
      sendJson(res, 200, { ok: true, plan: [...autoPlan], protoData });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/protocols') {
    sendJson(res, 200, { total: PROTOCOLS.length, list: PROTOCOLS, plan: [...autoPlan], protoData });
    return;
  }

  if (url.pathname === '/api/auto' && req.method === 'POST') {
    if (!options.allowWrite) {
      sendJson(res, 403, { ok: false, error: '只读模式：启动时去掉 --read-only 才能开启自动挂机' });
      return;
    }
    try {
      const body = await readBody(req);
      const enabled = Boolean(body.enabled);
      auto.enabled = enabled;
      settings.autoEnabled = enabled;
      writeSettings(settings);
      if (enabled) setTimeout(runAutoOnce, 1500);
      scheduleBroadcast();
      sendJson(res, 200, { ok: true, enabled });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/auto/run-now' && req.method === 'POST') {
    if (!options.allowWrite) {
      sendJson(res, 403, { ok: false, error: '只读模式：启动时去掉 --read-only 才能执行动作' });
      return;
    }
    if (!client || status !== 'online') {
      sendJson(res, 409, { ok: false, error: '账号尚未连接' });
      return;
    }
    if (auto.running) {
      sendJson(res, 409, { ok: false, error: '上一轮还在执行，请稍候' });
      return;
    }
    try {
      const results = (await runAutoOnce(true)) ?? [];
      sendJson(res, 200, {
        ok: true,
        total: results.length,
        done: results.filter((row) => row.ok).length,
        results,
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/system/open-accounts' && req.method === 'POST') {
    try {
      fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
      const child = spawn('explorer.exe', [ACCOUNTS_DIR], { detached: true, stdio: 'ignore' });
      child.unref();
      sendJson(res, 200, { ok: true, dir: ACCOUNTS_DIR });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/rows') {
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    let rows = client ? client.snapshot() : [];
    if (query) rows = rows.filter((row) => row.label.toLowerCase().includes(query) || String(row.id).includes(query));
    sendJson(res, 200, rows.slice(0, 600));
    return;
  }

  if (url.pathname === '/api/actions') {
    sendJson(res, 200, { allowWrite: options.allowWrite, actions: listActions().filter((action) => action.name !== 'proto.call') });
    return;
  }

  if (url.pathname === '/api/action' && req.method === 'POST') {
    if (!options.allowWrite) {
      sendJson(res, 403, { ok: false, error: '只读模式：启动时加了 --read-only' });
      return;
    }
    if (!client || status !== 'online') {
      sendJson(res, 409, { ok: false, error: '账号尚未连接' });
      return;
    }
    try {
      const payload = await readBody(req);
      const result = await runAction(client, payload.name, payload.params);
      console.log(`[动作] ${result.name} ok=${result.ok} code=${result.code} ${result.skipped ?? ''}`);
      scheduleBroadcast();
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  const relative = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(relative).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(options.port, '127.0.0.1', () => {
  console.log(`监控面板：http://127.0.0.1:${options.port}`);
  console.log(options.allowWrite ? '写模式：面板按钮会真实改动账号数据。' : '只读模式：不会发送任何业务请求（启动时加了 --read-only）。');
  if (auto.enabled) console.log(`自动模式：每 ${auto.intervalSec} 秒执行一轮已勾选动作。`);
  if (options.auto && fs.existsSync(options.capture)) {
    try {
      startAccount(options.capture);
    } catch (error) {
      console.error(`自动登录失败：${error.message}`);
    }
  } else {
    console.log('请打开面板，在登录页选择账号。');
  }
});
