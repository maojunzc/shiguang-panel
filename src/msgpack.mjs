// 时光大爆炸（Cocos Creator 2.x + @msgpack/msgpack）的帧编解码。
//
// 游戏侧用 ext.msgPack 编解码，注册了两个扩展类型：type 0 = Set，type 1 = Map，
// 编码时 ignoreUndefined。这里按同样的规则实现，保证发出去的帧与游戏一致。
// 只处理 Node 侧需要的最小集合：nil/bool/int/float/str/bin/array/map/ext。

const EXT_SET = 0;
const EXT_MAP = 1;

const utf8 = new TextDecoder('utf-8');

class Writer {
  constructor() {
    this.parts = [];
  }

  push(bytes) {
    this.parts.push(bytes);
  }

  int(value) {
    if (value >= 0 && value <= 0x7f) { this.push(Buffer.from([value])); return; }
    if (value < 0 && value >= -32) { this.push(Buffer.from([0x100 + value])); return; }
    if (value >= 0) {
      if (value <= 0xff) this.push(Buffer.from([0xcc, value]));
      else if (value <= 0xffff) { const b = Buffer.allocUnsafe(3); b[0] = 0xcd; b.writeUInt16BE(value, 1); this.push(b); }
      else if (value <= 0xffffffff) { const b = Buffer.allocUnsafe(5); b[0] = 0xce; b.writeUInt32BE(value, 1); this.push(b); }
      else { const b = Buffer.allocUnsafe(9); b[0] = 0xcf; b.writeBigUInt64BE(BigInt(value), 1); this.push(b); }
      return;
    }
    if (value >= -0x80) this.push(Buffer.from([0xd0, value & 0xff]));
    else if (value >= -0x8000) { const b = Buffer.allocUnsafe(3); b[0] = 0xd1; b.writeInt16BE(value, 1); this.push(b); }
    else if (value >= -0x80000000) { const b = Buffer.allocUnsafe(5); b[0] = 0xd2; b.writeInt32BE(value, 1); this.push(b); }
    else { const b = Buffer.allocUnsafe(9); b[0] = 0xd3; b.writeBigInt64BE(BigInt(value), 1); this.push(b); }
  }

  double(value) {
    const b = Buffer.allocUnsafe(9);
    b[0] = 0xcb;
    b.writeDoubleBE(value, 1);
    this.push(b);
  }

  string(value) {
    const bytes = Buffer.from(value, 'utf8');
    const size = bytes.length;
    if (size < 32) this.push(Buffer.from([0xa0 | size]));
    else if (size < 256) this.push(Buffer.from([0xd9, size]));
    else if (size < 65536) { const b = Buffer.allocUnsafe(3); b[0] = 0xda; b.writeUInt16BE(size, 1); this.push(b); }
    else { const b = Buffer.allocUnsafe(5); b[0] = 0xdb; b.writeUInt32BE(size, 1); this.push(b); }
    this.push(bytes);
  }

  binary(bytes) {
    const size = bytes.length;
    if (size < 256) this.push(Buffer.from([0xc4, size]));
    else if (size < 65536) { const b = Buffer.allocUnsafe(3); b[0] = 0xc5; b.writeUInt16BE(size, 1); this.push(b); }
    else { const b = Buffer.allocUnsafe(5); b[0] = 0xc6; b.writeUInt32BE(size, 1); this.push(b); }
    this.push(bytes);
  }

  array(length) {
    if (length < 16) this.push(Buffer.from([0x90 | length]));
    else if (length < 65536) { const b = Buffer.allocUnsafe(3); b[0] = 0xdc; b.writeUInt16BE(length, 1); this.push(b); }
    else { const b = Buffer.allocUnsafe(5); b[0] = 0xdd; b.writeUInt32BE(length, 1); this.push(b); }
  }

  map(length) {
    if (length < 16) this.push(Buffer.from([0x80 | length]));
    else if (length < 65536) { const b = Buffer.allocUnsafe(3); b[0] = 0xde; b.writeUInt16BE(length, 1); this.push(b); }
    else { const b = Buffer.allocUnsafe(5); b[0] = 0xdf; b.writeUInt32BE(length, 1); this.push(b); }
  }

  ext(type, payload) {
    const size = payload.length;
    if (size < 256) this.push(Buffer.from([0xc7, size, type & 0xff]));
    else if (size < 65536) {
      const b = Buffer.allocUnsafe(4); b[0] = 0xc8; b.writeUInt16BE(size, 1); b[3] = type & 0xff; this.push(b);
    } else {
      const b = Buffer.allocUnsafe(6); b[0] = 0xc9; b.writeUInt32BE(size, 1); b[5] = type & 0xff; this.push(b);
    }
    this.push(payload);
  }

  finish() {
    return Buffer.concat(this.parts);
  }
}

function encodeValue(writer, value) {
  if (value === null || value === undefined) {
    writer.push(Buffer.from([0xc0]));
    return;
  }
  switch (typeof value) {
    case 'boolean':
      writer.push(Buffer.from([value ? 0xc3 : 0xc2]));
      return;
    case 'number':
      if (Number.isSafeInteger(value)) writer.int(value);
      else writer.double(value);
      return;
    case 'bigint':
      if (value >= 0n && value <= 0xffffffffffffffffn && value <= BigInt(Number.MAX_SAFE_INTEGER)) writer.int(Number(value));
      else if (value < 0n && value >= BigInt(Number.MIN_SAFE_INTEGER)) writer.int(Number(value));
      else {
        // 超出安全整数范围时按 int64 原样写出。
        const b = Buffer.allocUnsafe(9);
        b[0] = value < 0n ? 0xd3 : 0xcf;
        if (value < 0n) b.writeBigInt64BE(value, 1); else b.writeBigUInt64BE(value, 1);
        writer.push(b);
      }
      return;
    case 'string':
      writer.string(value);
      return;
    default:
      break;
  }
  if (value instanceof Set) {
    const inner = new Writer();
    inner.array(value.size);
    for (const item of value) encodeValue(inner, item);
    writer.ext(EXT_SET, inner.finish());
    return;
  }
  if (value instanceof Map) {
    // 与游戏一致：Map 扩展的载荷是 [[k, v], ...] 数组。
    const inner = new Writer();
    const pairs = [...value];
    inner.array(pairs.length);
    for (const [key, item] of pairs) {
      inner.array(2);
      encodeValue(inner, key);
      encodeValue(inner, item);
    }
    writer.ext(EXT_MAP, inner.finish());
    return;
  }
  if (Array.isArray(value)) {
    writer.array(value.length);
    for (const item of value) encodeValue(writer, item);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    writer.binary(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    return;
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  writer.map(entries.length);
  for (const [key, item] of entries) {
    writer.string(key);
    encodeValue(writer, item);
  }
}

export function encode(value) {
  const writer = new Writer();
  encodeValue(writer, value);
  return writer.finish();
}

function decodeExt(type, payload) {
  if (type === EXT_SET) {
    const items = decode(payload);
    return new Set(Array.isArray(items) ? items : []);
  }
  if (type === EXT_MAP) {
    const pairs = decode(payload);
    const map = new Map();
    if (Array.isArray(pairs)) for (const pair of pairs) if (Array.isArray(pair) && pair.length === 2) map.set(pair[0], pair[1]);
    return map;
  }
  return { type, data: payload };
}

export function decode(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let offset = 0;

  const need = (count) => {
    if (offset + count > buffer.length) throw new RangeError('msgpack: 数据不完整');
    const start = offset;
    offset += count;
    return start;
  };
  const readString = (length) => {
    const start = need(length);
    return utf8.decode(buffer.subarray(start, start + length));
  };
  const readArray = (length) => {
    const out = new Array(length);
    for (let i = 0; i < length; i++) out[i] = readValue();
    return out;
  };
  const readMap = (length) => {
    const out = {};
    for (let i = 0; i < length; i++) {
      const key = readValue();
      out[typeof key === 'string' ? key : String(key)] = readValue();
    }
    return out;
  };
  const readExt = (length) => {
    const type = buffer[need(1)];
    const start = need(length);
    return decodeExt(type, buffer.subarray(start, start + length));
  };

  function readValue() {
    const start = need(1);
    const byte = buffer[start];
    if (byte <= 0x7f) return byte;
    if (byte >= 0xe0) return byte - 0x100;
    if (byte >= 0x80 && byte <= 0x8f) return readMap(byte & 0x0f);
    if (byte >= 0x90 && byte <= 0x9f) return readArray(byte & 0x0f);
    if (byte >= 0xa0 && byte <= 0xbf) return readString(byte & 0x1f);
    switch (byte) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: {
        const length = buffer[need(1)];
        const at = need(length);
        return buffer.subarray(at, at + length);
      }
      case 0xc5: {
        const length = buffer.readUInt16BE(need(2));
        const at = need(length);
        return buffer.subarray(at, at + length);
      }
      case 0xc6: {
        const length = buffer.readUInt32BE(need(4));
        const at = need(length);
        return buffer.subarray(at, at + length);
      }
      case 0xc7: { const length = buffer[need(1)]; return readExt(length); }
      case 0xc8: { const length = buffer.readUInt16BE(need(2)); return readExt(length); }
      case 0xc9: { const length = buffer.readUInt32BE(need(4)); return readExt(length); }
      case 0xca: { const at = need(4); return buffer.readFloatBE(at); }
      case 0xcb: { const at = need(8); return buffer.readDoubleBE(at); }
      case 0xcc: return buffer[need(1)];
      case 0xcd: return buffer.readUInt16BE(need(2));
      case 0xce: return buffer.readUInt32BE(need(4));
      case 0xcf: {
        const at = need(8);
        const big = buffer.readBigUInt64BE(at);
        return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
      }
      case 0xd0: { const at = need(1); return buffer.readInt8(at); }
      case 0xd1: { const at = need(2); return buffer.readInt16BE(at); }
      case 0xd2: { const at = need(4); return buffer.readInt32BE(at); }
      case 0xd3: {
        const at = need(8);
        const big = buffer.readBigInt64BE(at);
        return big >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(big) : big;
      }
      case 0xd4: return readExt(1);
      case 0xd5: return readExt(2);
      case 0xd6: return readExt(4);
      case 0xd7: return readExt(8);
      case 0xd8: return readExt(16);
      case 0xd9: return readString(buffer[need(1)]);
      case 0xda: return readString(buffer.readUInt16BE(need(2)));
      case 0xdb: return readString(buffer.readUInt32BE(need(4)));
      case 0xdc: return readArray(buffer.readUInt16BE(need(2)));
      case 0xdd: return readArray(buffer.readUInt32BE(need(4)));
      case 0xde: return readMap(buffer.readUInt16BE(need(2)));
      case 0xdf: return readMap(buffer.readUInt32BE(need(4)));
      default:
        throw new RangeError(`msgpack: 未知类型 0x${byte.toString(16)} @${start}`);
    }
  }

  return readValue();
}

// 帧里可能出现 BigInt / Map / Set / Buffer，落盘前统一转成可读 JSON。
export function toJsonSafe(value, depth = 0) {
  if (depth > 16) return '[深层结构]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return { bin: value.toString('base64'), bytes: value.length };
  if (value instanceof Set) return [...value].map((item) => toJsonSafe(item, depth + 1));
  if (value instanceof Map) {
    const out = {};
    for (const [key, item] of value) out[String(key)] = toJsonSafe(item, depth + 1);
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = toJsonSafe(item, depth + 1);
  return out;
}
