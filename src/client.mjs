// 《时光大爆炸》网关客户端：登录、串行请求、心跳、重连、服务端推送。
//
// 协议要点（均来自抓包与 _logic_ 反查）：
//   请求帧 {"":reqNo, mod, op, data}
//   响应帧 {"":reqNo, code, data, changed}
//   推送帧 {"":-3, opCode, data}
//   重连帧 {"":-1, ...}，踢线帧 {"":-2}
//   心跳：每 5 秒发 msgpack 字符串 "p"，服务端回 {t, changed}
// 只依赖 Node 内置能力，不引入任何 npm 包。
import { EventEmitter } from 'node:events';
import { encode, decode, toJsonSafe } from './msgpack.mjs';
import ATTRS from './attrs.mjs';

// 属性 ID 拆分规则，与游戏内 DtBase 一致。
export function splitAttrId(id) {
  return { ci: id % 1000, mod: Math.floor(id / 1000) % 100, tid: Math.floor(id / 1e5) };
}

// 属性 ID -> "类.属性[tid]"，用于展示；解析不出时返回 null。
export function attrName(id) {
  const { ci, mod, tid } = splitAttrId(id);
  const field = ATTRS.fields[`${ci}:${mod}`];
  if (!field) return null;
  return { ...field, mod, tid, label: `${field.cls}.${field.name}${tid ? `[${tid}]` : ''}` };
}

export class ShiguangClient extends EventEmitter {
  constructor({ gateway, loginFrame, timeoutMs = 15000, pingIntervalMs = 5000, autoReconnect = false }) {
    super();
    if (!gateway) throw new Error('缺少网关地址');
    if (!loginFrame) throw new Error('缺少登录帧');
    this.gateway = gateway;
    this.loginFrame = loginFrame;
    this.timeoutMs = timeoutMs;
    this.pingIntervalMs = pingIntervalMs;
    this.autoReconnect = autoReconnect;

    this.socket = null;
    this.reqNo = Number(loginFrame[''] ?? 1);
    this.pending = new Map();
    this.dt = new Map();
    this.loginResponse = null;
    this.serverMS = null;
    this._chain = Promise.resolve();
    this._pingTimer = null;
    this._closed = false;
  }

  // 建立连接并完成登录，返回登录响应的 data。
  async connect() {
    const socket = new WebSocket(this.gateway);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this._closed = false;

    const opened = new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    socket.addEventListener('message', (event) => this._onMessage(event));
    socket.addEventListener('close', (event) => this._onClose(event));

    await opened;
    this.reqNo = Math.max(1, this.reqNo);
    this._startPing();
    const response = await this._send(this.loginFrame.mod ?? 'user', this.loginFrame.op ?? 'login', this.loginFrame.data ?? {}, this.timeoutMs);
    if (response.code) throw new Error(`登录被拒绝：code=${JSON.stringify(response.code)}`);
    this.loginResponse = response;
    this._applyDt(response.data?.dt);
    this.emit('login', response);
    return response.data ?? {};
  }

  // 串行发送请求：同一时刻只有一帧在途，与客户端行为一致。
  request(mod, op, data = {}, timeoutMs = this.timeoutMs) {
    return this._send(mod, op, data, timeoutMs);
  }

  _send(mod, op, data, timeoutMs) {
    const run = () => this._sendNow(mod, op, data, timeoutMs);
    const next = this._chain.then(run, run);
    this._chain = next.catch(() => {});
    return next;
  }

  _sendNow(mod, op, data, timeoutMs) {
    if (!this.socket || this.socket.readyState !== 1) return Promise.reject(new Error('连接未就绪'));
    this.reqNo += 1;
    const reqNo = this.reqNo;
    const frame = { '': reqNo, mod, op, data };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqNo);
        reject(new Error(`请求超时：${mod}.${op}`));
      }, timeoutMs);
      this.pending.set(reqNo, { resolve, reject, timer, mod, op });
      this.socket.send(encode(frame));
    });
  }

  _onMessage(event) {
    let message;
    try {
      message = decode(new Uint8Array(event.data));
    } catch (error) {
      this.emit('error', new Error(`无法解析服务器帧：${error.message}`));
      return;
    }
    if (typeof message === 'string') return; // 心跳回包 "p"
    if (!message || typeof message !== 'object') return;

    if (message.t !== undefined && message[''] === undefined) {
      // 心跳回包：{t, changed}，changed 是扁平属性增量。
      if (typeof message.t === 'number') this.serverMS = message.t;
      if (message.changed) {
        this._applyDt(message.changed);
        this.emit('changed', message.changed);
      }
      return;
    }
    const reqNo = message[''];
    if (reqNo === -3) {
      this.emit('push', { opCode: message.opCode, data: message.data });
      return;
    }
    if (reqNo === -1) {
      this.emit('reconnect', message);
      return;
    }
    if (reqNo === -2) {
      this.emit('kick', message);
      this.close();
      return;
    }
    const slot = this.pending.get(reqNo);
    if (!slot) {
      this.emit('unknown', message);
      return;
    }
    this.pending.delete(reqNo);
    clearTimeout(slot.timer);
    if (message.changed) {
      this._applyDt(message.changed);
      this.emit('changed', message.changed);
    }
    slot.resolve(message);
  }

  _onClose(event) {
    this._stopPing();
    for (const [reqNo, slot] of this.pending) {
      clearTimeout(slot.timer);
      slot.reject(new Error(`连接已关闭（code=${event.code}，${slot.mod}.${slot.op}）`));
      this.pending.delete(reqNo);
    }
    this.emit('close', event);
    if (!this._closed && this.autoReconnect) {
      this.emit('reconnecting');
      setTimeout(() => {
        this.connect().then(
          () => this.emit('resumed'),
          (error) => this.emit('error', error),
        );
      }, 2000);
    }
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this.socket?.readyState === 1) this.socket.send(encode('p'));
    }, this.pingIntervalMs);
    this._pingTimer.unref?.();
  }

  _stopPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  // dt 是扁平数组 [属性ID, 值, ...]。
  _applyDt(list) {
    if (!Array.isArray(list)) return;
    for (let i = 0; i + 1 < list.length; i += 2) this.dt.set(list[i], list[i + 1]);
  }

  getDt(id) {
    return this.dt.get(id);
  }

  // 快照：属性 ID / 名称 / 值，便于展示或落盘。
  snapshot() {
    const list = [];
    for (const [id, value] of this.dt) {
      const info = attrName(id);
      list.push({ id, value: toJsonSafe(value), cls: info?.cls ?? null, name: info?.name ?? null, tid: info?.tid ?? 0, label: info?.label ?? `未知属性#${id}` });
    }
    return list;
  }

  close() {
    this._closed = true;
    this._stopPing();
    try { this.socket?.close(); } catch {}
    this.socket = null;
  }
}

export { ATTRS };
