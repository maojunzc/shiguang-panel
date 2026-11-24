import test from 'node:test';
import assert from 'node:assert/strict';
import { ShiguangClient } from '../src/client.mjs';
import { encode } from '../src/msgpack.mjs';

function client() {
  return new ShiguangClient({ gateway: 'ws://localhost', loginFrame: { '': 1 } });
}

test('推送属性先合并并只发一次 changed', () => {
  const c = client();
  const changes = [];
  c.on('changed', list => changes.push(list));
  c.on('push', () => assert.equal(c.getDt(1010), 123));
  c._onMessage({ data: encode({ '': -3, data: { dt: [1010, 123] } }) });
  assert.deepEqual(changes, [[1010, 123]]);
});

test('串行排队请求发送前重新检查取消条件', async () => {
  const c = client();
  c.socket = { readyState: 1 };
  let release;
  c._chain = new Promise(resolve => { release = resolve; });
  let sent = 0;
  c._sendNow = async () => { sent++; return { code: 0 }; };
  let writable = true;
  const result = c.request('task', 'finish', {}, 100, () => {
    if (!writable) throw new Error('只读');
  });
  writable = false;
  release();
  await assert.rejects(result, /只读/);
  assert.equal(sent, 0);
});

test('切换连接后取消旧连接排队请求', async () => {
  const c = client();
  c.socket = { readyState: 1 };
  let release;
  c._chain = new Promise(resolve => { release = resolve; });
  let sent = 0;
  c._sendNow = async () => { sent++; };
  const result = c.request('task', 'finish');
  c.socket = { readyState: 1 };
  release();
  await assert.rejects(result, /连接已切换/);
  assert.equal(sent, 0);
});
