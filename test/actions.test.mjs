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
  assert.match(result.skipped, /不会猜测或发送任务动作/);
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

test('主线自动推进连续领取已完成节点并在状态不再满足时停止', async () => {
  let calls = 0;
  const client = makeClient({ tid: 12, canFinish: 1, finishedTask: 10 }, async c => {
    calls += 1;
    c.dt.set(1010, 12 + calls);
    c.dt.set(3010, calls < 3 ? 1 : 0);
    c.dt.set(4010, 10 + calls);
    return { code: 0 };
  });

  const result = await runAction(client, 'task.autoMain');

  assert.equal(calls, 3);
  assert.equal(result.ok, true);
  assert.equal(result.meta.completed, 3);
  assert.equal(result.meta.nextTid, 15);
});

test('主线自动推进每轮最多完成十个节点', async () => {
  let calls = 0;
  const client = makeClient({ tid: 12, canFinish: 1, finishedTask: 10 }, async c => {
    calls += 1;
    c.dt.set(1010, 12 + calls);
    c.dt.set(3010, 1);
    c.dt.set(4010, 10 + calls);
    return { code: 0 };
  });

  const result = await runAction(client, 'task.autoMain');

  assert.equal(calls, 10);
  assert.equal(result.ok, true);
  assert.equal(result.meta.completed, 10);
  assert.equal(result.meta.limitReached, true);
});

test('主线自动推进在部分成功后遇到状态停滞会停止并保留已完成数', async () => {
  let calls = 0;
  const client = makeClient({ tid: 12, canFinish: 1, finishedTask: 10 }, async c => {
    calls += 1;
    if (calls === 1) {
      c.dt.set(1010, 13);
      c.dt.set(4010, 11);
    }
    return { code: 0 };
  });

  const result = await runAction(client, 'task.autoMain');

  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  assert.equal(result.progress, false);
  assert.equal(result.meta.completed, 1);
  assert.match(result.meta.note, /已停止并等待复核/);
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
