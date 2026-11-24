import test from 'node:test';
import assert from 'node:assert/strict';
import { runAction } from '../src/actions.mjs';

const makeClient = (initial, request = async () => ({ code: 0 })) => ({
  dt: new Map([[1010, initial.tid ?? 0], [3010, initial.canFinish ?? 0], [4010, initial.finishedTask ?? 0]]),
  async request(...args) { return request(this, ...args); },
});

test('主线未满足时不盲目发送full或finish', async () => {
  let calls = 0;
  const client = makeClient({ tid: 12, canFinish: 0 }, async () => { calls++; return { code: 0 }; });
  const result = await runAction(client, 'task.autoMain');
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.match(result.skipped, /尚无已验证/);
  assert.equal(result.meta.tid, 12);
});

test('主线领奖需服务器状态确认进展', async () => {
  const client = makeClient({ tid: 12, canFinish: 1, finishedTask: 10 }, async c => {
    c.dt.set(1010, 13);
    c.dt.set(3010, 0);
    c.dt.set(4010, 12);
    return { code: 0 };
  });
  const result = await runAction(client, 'task.autoMain');
  assert.equal(result.ok, true);
  assert.equal(result.progress, true);
  assert.equal(result.meta.nextTid, 13);
});

test('服务器无错误码但主线属性不变不能报成功', async () => {
  const client = makeClient({ tid: 12, canFinish: 1, finishedTask: 10 });
  const result = await runAction(client, 'task.autoMain');
  assert.equal(result.ok, false);
  assert.equal(result.progress, false);
});

test('缺少响应对象不能报成功', async () => {
  const client = makeClient({});
  client.request = async () => null;
  const result = await runAction(client, 'mail.claimAll');
  assert.equal(result.ok, false);
});
