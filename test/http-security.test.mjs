import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedLocalRequest } from '../src/http-security.mjs';

function request(headers) {
  return { headers };
}

test('本机同源页面可访问当前面板端口', () => {
  assert.equal(isAllowedLocalRequest(request({
    host: '127.0.0.1:8848',
    origin: 'http://127.0.0.1:8848',
  }), 8848), true);
});

test('允许 localhost，但拒绝其它 Host 和端口', () => {
  assert.equal(isAllowedLocalRequest(request({
    host: 'localhost:8848',
    origin: 'http://localhost:8848',
  }), 8848), true);
  assert.equal(isAllowedLocalRequest(request({ host: 'attacker.example:8848' }), 8848), false);
  assert.equal(isAllowedLocalRequest(request({ host: '127.0.0.1:8849' }), 8848), false);
});

test('拒绝跨站请求和不匹配的 Origin', () => {
  assert.equal(isAllowedLocalRequest(request({
    host: '127.0.0.1:8848',
    origin: 'http://attacker.example',
  }), 8848), false);
  assert.equal(isAllowedLocalRequest(request({
    host: '127.0.0.1:8848',
    'sec-fetch-site': 'cross-site',
  }), 8848), false);
  assert.equal(isAllowedLocalRequest(request({
    host: '127.0.0.1:8848',
    origin: 'null',
  }), 8848), false);
});
