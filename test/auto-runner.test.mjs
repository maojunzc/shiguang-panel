import assert from 'node:assert/strict';
import test from 'node:test';
import { AutoRunner } from '../src/auto-runner.mjs';

const successful = (name) => ({ ok: true, title: name, elapsedMs: 1 });

function createRunner(options = {}) {
  return new AutoRunner({
    execute: async (name) => successful(name),
    isOnline: () => true,
    ...options,
  });
}

test('only one run can be in flight', async () => {
  let announceStarted;
  let releaseExecution;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const gate = new Promise((resolve) => { releaseExecution = resolve; });
  let calls = 0;
  const runner = createRunner({
    execute: async (name) => {
      calls += 1;
      announceStarted();
      await gate;
      return successful(name);
    },
  });

  const firstRun = runner.run(['build.collect']);
  await started;
  assert.equal(await runner.run(['build.offline']), null);
  releaseExecution();

  assert.deepEqual((await firstRun).map(({ name }) => name), ['build.collect']);
  assert.equal(calls, 1);
});

test('non-whitelisted actions never reach the executor', async () => {
  let calls = 0;
  const runner = createRunner({ execute: async () => { calls += 1; } });

  const results = await runner.run(['task.delete', 'account.reset']);

  assert.equal(calls, 0);
  assert.deepEqual(results.map(({ status }) => status), ['blocked', 'blocked']);
});

test('main-task and completed-story claims are allowed by the automatic plan', async () => {
  const calls = [];
  const runner = createRunner({
    execute: async (name) => {
      calls.push(name);
      return successful(name);
    },
  });

  const results = await runner.run(['task.autoMain', 'task.autoStory']);

  assert.deepEqual(calls, ['task.autoMain', 'task.autoStory']);
  assert.deepEqual(results.map(({ status }) => status), ['success', 'success']);
});

test('action progress metadata and review notes are retained in run results', async () => {
  const runner = createRunner({
    execute: async (name) => ({
      ...successful(name),
      meta: { completed: 2, note: '状态未变化，已停止并等待复核' },
    }),
  });

  const [result] = await runner.run(['task.autoMain']);

  assert.equal(result.meta.completed, 2);
  assert.match(result.note, /等待复核/);
});

test('a skipped action does not prevent later actions', async () => {
  const calls = [];
  const runner = createRunner({
    execute: async (name) => {
      calls.push(name);
      return name === 'build.collect'
        ? { ok: false, skipped: '没有可领取内容' }
        : successful(name);
    },
  });

  const results = await runner.run(['build.collect', 'build.offline']);

  assert.deepEqual(calls, ['build.collect', 'build.offline']);
  assert.deepEqual(results.map(({ status }) => status), ['skipped', 'success']);
});

test('a server error stops the run immediately', async () => {
  const calls = [];
  const runner = createRunner({
    execute: async (name) => {
      calls.push(name);
      return { ok: false, code: 'DENIED' };
    },
  });

  const results = await runner.run(['build.collect', 'build.offline']);

  assert.deepEqual(calls, ['build.collect']);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'error');
  assert.equal(runner.snapshot().stopReason, '服务器返回错误');
});

test('an executor exception stops the run immediately', async () => {
  const calls = [];
  const runner = createRunner({
    execute: async (name) => {
      calls.push(name);
      throw new Error('request failed');
    },
  });

  const results = await runner.run(['build.collect', 'build.offline']);

  assert.deepEqual(calls, ['build.collect']);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'error');
  assert.equal(runner.snapshot().stopReason, '请求异常');
});

test('pausing during execution prevents the next action', async () => {
  let announceStarted;
  let releaseExecution;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const gate = new Promise((resolve) => { releaseExecution = resolve; });
  const calls = [];
  const runner = createRunner({
    execute: async (name) => {
      calls.push(name);
      announceStarted();
      await gate;
      return successful(name);
    },
  });

  const run = runner.run(['build.collect', 'build.offline']);
  await started;
  runner.pause('测试暂停');
  releaseExecution();

  const results = await run;
  assert.deepEqual(calls, ['build.collect']);
  assert.deepEqual(results.map(({ name }) => name), ['build.collect']);
  assert.equal(runner.snapshot().phase, 'paused');
  assert.equal(runner.snapshot().stopReason, '测试暂停');
});

test('a disconnection stops before the next action', async () => {
  let online = true;
  const calls = [];
  const runner = createRunner({
    isOnline: () => online,
    execute: async (name) => {
      calls.push(name);
      online = false;
      return successful(name);
    },
  });

  const results = await runner.run(['build.collect', 'build.offline']);

  assert.deepEqual(calls, ['build.collect']);
  assert.deepEqual(results.map(({ name }) => name), ['build.collect']);
  assert.equal(runner.snapshot().phase, 'paused');
  assert.equal(runner.snapshot().stopReason, '连接已断开');
});

test('run history retains only the latest 20 entries', async () => {
  const runner = createRunner();
  const plans = Array.from({ length: 22 }, (_, index) => [
    ['build.collect', 'build.offline', 'task.claimAll'][index % 3],
  ]);

  for (const plan of plans) await runner.run(plan);

  const history = runner.snapshot().history;
  assert.equal(history.length, 20);
  assert.equal(history[0].results[0].name, plans[21][0]);
  assert.equal(history[19].results[0].name, plans[2][0]);
});

test('execution stops at the configured step limit', async () => {
  const calls = [];
  const runner = createRunner({
    maxSteps: 2,
    execute: async (name) => {
      calls.push(name);
      return successful(name);
    },
  });

  const results = await runner.run(['build.collect', 'build.offline', 'task.claimAll']);

  assert.deepEqual(calls, ['build.collect', 'build.offline']);
  assert.deepEqual(results.map(({ name }) => name), ['build.collect', 'build.offline']);
  assert.equal(runner.snapshot().phase, 'paused');
  assert.equal(runner.snapshot().stopReason, '达到本轮执行上限');
});

test('execution stops at the configured duration limit', async () => {
  const calls = [];
  const runner = createRunner({
    maxDurationMs: 1,
    execute: async (name) => {
      calls.push(name);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return successful(name);
    },
  });

  const results = await runner.run(['build.collect', 'build.offline']);

  assert.deepEqual(calls, ['build.collect']);
  assert.deepEqual(results.map(({ name }) => name), ['build.collect']);
  assert.equal(runner.snapshot().phase, 'paused');
  assert.equal(runner.snapshot().stopReason, '达到本轮执行时长上限');
});
