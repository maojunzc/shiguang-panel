// 本机 MITM 代理：解 TLS 后把游戏的 HTTP 登录响应与 WebSocket 帧读出来。
//
// 参考 crazywaterworld 的 tools/mitm-proxy.mjs，去掉 protobuf 依赖，改为由调用方
// 传入 frameDecoder（这里是时光大爆炸的 msgpack）。代理本身不碰注册表、不装证书。
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { LEAF_CRT_BASE64, LEAF_KEY_BASE64 } from './certs.mjs';

const LEAF_CERT = Buffer.from(LEAF_CRT_BASE64, 'base64');
const LEAF_KEY = Buffer.from(LEAF_KEY_BASE64, 'base64');

export const DEFAULT_PROXY_PORT = Number(process.env.SG_PROXY_PORT ?? 17324);
const HTTP_BODY_LIMIT = 4 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

function makeFrameReader(onMessage) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentedOpcode = null;
  let fragmentedLength = 0;
  let failed = false;
  return (chunk) => {
    if (failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      // 代理没有协商 permessage-deflate，收到扩展帧说明无法继续解析。
      if (buffer[0] & 0x70) { failed = true; buffer = Buffer.alloc(0); return; }
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const wideLength = buffer.readBigUInt64BE(2);
        if (wideLength > BigInt(MAX_MESSAGE_BYTES)) { failed = true; buffer = Buffer.alloc(0); return; }
        length = Number(wideLength);
        offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) { failed = true; buffer = Buffer.alloc(0); return; }
      let mask = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (mask) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        onMessage({ opcode, payload });
        return;
      }
      if (opcode === 0x9 || opcode === 0xa) continue;
      if (opcode === 1 || opcode === 2) {
        if (fragmentedOpcode !== null) { failed = true; return; }
        fragmentedOpcode = opcode;
      } else if (opcode !== 0 || fragmentedOpcode === null) {
        failed = true;
        return;
      }
      fragmentedLength += payload.length;
      if (fragmentedLength > MAX_MESSAGE_BYTES) { failed = true; fragments = []; return; }
      fragments.push(payload);
      if (fin) {
        onMessage({ opcode: fragmentedOpcode, payload: Buffer.concat(fragments) });
        fragments = [];
        fragmentedOpcode = null;
        fragmentedLength = 0;
      }
    }
  };
}

function readBody(stream, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    };
    stream.on('data', (chunk) => {
      if (size >= limit) return;
      const room = limit - size;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      size += Math.min(chunk.length, room);
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
  });
}

// certificateFor 默认返回内嵌的通配目标证书；其它域名需自行提供证书。
export function createProxy({
  port = DEFAULT_PROXY_PORT,
  log = () => {},
  interceptHosts,
  interceptPorts = [443],
  frameDecoder,
  inspectHttp,
  onHttp,
  onFrame,
  certificateFor = () => ({ cert: LEAF_CERT, keyPem: LEAF_KEY }),
  caIsInstalled = () => true,
} = {}) {
  const hosts = interceptHosts === undefined ? null
    : interceptHosts instanceof Set ? interceptHosts
      : new Set([...interceptHosts].map((host) => host.toLowerCase()));
  const intercept = new Set(interceptPorts);
  const tlsServers = new Map();
  const liveSockets = new Set();
  const requests = new Set();
  let started = false;

  const httpServer = http.createServer(onRequest);
  httpServer.on('upgrade', onUpgrade);
  httpServer.on('connect', onConnect);
  function trackSocket(socket) {
    if (liveSockets.has(socket)) return socket;
    liveSockets.add(socket);
    socket.once('close', () => liveSockets.delete(socket));
    return socket;
  }
  httpServer.on('connection', trackSocket);

  function trackRequest(request) {
    requests.add(request);
    request.on('close', () => requests.delete(request));
    request.on('socket', trackSocket);
    return request;
  }

  function decodeFrame(payload) {
    if (!frameDecoder) return null;
    try { return frameDecoder(payload) ?? null; } catch { return null; }
  }

  function attachWebSocketLogging(socket, direction, context) {
    const reader = makeFrameReader(({ opcode, payload }) => {
      if (opcode === 0x8) return;
      const decoded = decodeFrame(payload);
      if (!decoded) return;
      onFrame?.({ direction, context, name: decoded.name, body: decoded.body, bytes: payload });
    });
    socket.on('data', reader);
    return reader;
  }

  function tlsServerFor(host, targetPort) {
    const key = `${host}:${targetPort}`;
    if (tlsServers.has(key)) return tlsServers.get(key);
    const { cert, keyPem } = certificateFor(host);
    const server = tls.createServer({ cert, key: keyPem }, (socket) => {
      socket._target = { host, port: targetPort };
      httpServer.emit('connection', socket);
    });
    server.on('tlsClientError', (error) => log('tls', `${key} 客户端错误: ${error.message}`));
    tlsServers.set(key, server);
    return server;
  }

  function onConnect(req, clientSocket, head) {
    let target;
    try { target = new URL(`https://${req.url}`); }
    catch { clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const targetPort = Number(target.port || 443);
    const key = `${host}:${targetPort}`;
    log('connect', key);
    clientSocket.on('error', () => {});

    // 只解密游戏域名和 443 端口，其它流量原样隧道转发。
    if (!intercept.has(targetPort) || (hosts && !hosts.has(host.toLowerCase()))) {
      const upstream = trackSocket(net.connect(targetPort, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      }));
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => upstream.destroy());
      return;
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) clientSocket.unshift(head);
    try { tlsServerFor(host, targetPort).emit('connection', clientSocket); }
    catch (error) { log('tls', `生成目标证书失败: ${error.message}`); clientSocket.destroy(); }
  }

  function onRequest(req, res) {
    let target = req.socket._target;
    let requestPath = req.url;
    if (!target && /^https?:\/\//i.test(req.url)) {
      const url = new URL(req.url);
      target = { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
      requestPath = `${url.pathname}${url.search}`;
    }
    if (!target) {
      res.writeHead(502);
      res.end('proxy: no target');
      return;
    }
    const secure = target.port !== 80;
    const transport = secure ? https : http;
    const url = `${secure ? 'https' : 'http'}://${target.host}:${target.port}${requestPath}`;
    log('http', `${req.method} ${url}`);
    let inspected = false;
    try { inspected = typeof inspectHttp === 'function' && inspectHttp(url) === true; } catch { inspected = false; }
    const requestBody = inspected ? readBody(req, HTTP_BODY_LIMIT) : null;

    const upstream = trackRequest(transport.request({
      host: target.host,
      port: target.port,
      path: requestPath,
      method: req.method,
      headers: req.headers,
      servername: target.host,
      rejectUnauthorized: true,
    }, (upstreamRes) => {
      if (inspected) {
        const responseBody = readBody(upstreamRes, HTTP_BODY_LIMIT);
        Promise.all([requestBody, responseBody]).then(([requestBytes, responseBytes]) => {
          try {
            onHttp?.({
              url, method: req.method, status: upstreamRes.statusCode,
              requestBody: requestBytes.toString('utf8'), responseBody: responseBytes.toString('utf8'),
            });
          } catch (error) {
            log('http', `处理报文失败: ${error.message}`);
          }
        }).catch(() => {});
      }
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    }));
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.on('error', (error) => {
      log('http', `上游出错: ${error.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }

  function onUpgrade(req, clientSocket, head) {
    let target = req.socket._target;
    let requestPath = req.url;
    if (!target && /^https?:\/\//i.test(req.url)) {
      const url = new URL(req.url);
      target = { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
      requestPath = `${url.pathname}${url.search}`;
    }
    if (!target) {
      clientSocket.destroy();
      return;
    }
    const secure = target.port !== 80;
    const transport = secure ? https : http;
    const scheme = secure ? 'wss' : 'ws';
    const context = `${scheme}://${target.host}:${target.port}${requestPath}`;
    log('upgrade', context);

    const headers = { ...req.headers };
    delete headers['sec-websocket-extensions'];
    const upstream = trackRequest(transport.request({
      host: target.host,
      port: target.port,
      path: requestPath,
      method: 'GET',
      headers,
      servername: target.host,
      rejectUnauthorized: true,
    }));
    clientSocket.on('close', () => upstream.destroy());
    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const responseHeaders = Object.entries(upstreamRes.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      clientSocket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders}\r\n\r\n`);
      const readDown = attachWebSocketLogging(upstreamSocket, 'down', context);
      const readUp = attachWebSocketLogging(clientSocket, 'up', context);

      clientSocket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => clientSocket.destroy());
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
      if (head && head.length) { readUp(head); upstreamSocket.write(head); }
      if (upstreamHead && upstreamHead.length) { readDown(upstreamHead); clientSocket.write(upstreamHead); }
    });
    upstream.on('error', (error) => {
      log('upgrade', `上游出错: ${error.message}`);
      clientSocket.destroy();
    });
    upstream.end();
  }

  return {
    get port() { return httpServer.address()?.port ?? port; },
    listen() {
      if (started) return Promise.resolve();
      started = true;
      if (!caIsInstalled()) log('warn', '当前用户根证书里没有本工具的测试 CA，请先安装再抓包');
      return new Promise((resolve, reject) => {
        const failed = (error) => { started = false; reject(error); };
        httpServer.once('error', failed);
        httpServer.listen(port, '127.0.0.1', () => {
          httpServer.removeListener('error', failed);
          log('start', `代理监听 127.0.0.1:${port}`);
          resolve();
        });
      });
    },
    // close() 会等活连接自己结束，所以还要把连接都断掉。
    async stop() {
      if (!started) return;
      started = false;
      const closed = new Promise((resolve) => httpServer.close(() => resolve()));
      for (const request of requests) request.destroy();
      requests.clear();
      for (const socket of liveSockets) socket.destroy();
      liveSockets.clear();
      for (const server of tlsServers.values()) server.close();
      tlsServers.clear();
      await closed;
    },
  };
}
