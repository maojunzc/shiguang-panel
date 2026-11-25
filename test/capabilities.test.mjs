import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCapabilityManifest } from '../src/capabilities.mjs';

const validManifest = {
  service: 'shiguang-game',
  schemaVersion: 1,
  serverId: 7,
  routeCount: 2,
  routes: ['task.finish', 'build.collect'],
};

test('兼容服务端路由清单按稳定结构校验并保留服务端顺序', () => {
  assert.deepEqual(normalizeCapabilityManifest(validManifest), validManifest);
});

test('拒绝未知清单、重复路由、非法路由和错误计数', () => {
  assert.throws(() => normalizeCapabilityManifest({ ...validManifest, service: 'other' }));
  assert.throws(() => normalizeCapabilityManifest({ ...validManifest, routes: ['task.finish', 'task.finish'] }));
  assert.throws(() => normalizeCapabilityManifest({ ...validManifest, routes: ['../secrets'] }));
  assert.throws(() => normalizeCapabilityManifest({ ...validManifest, routeCount: 1 }));
});

test('拒绝异常区服 ID 和超大清单', () => {
  assert.throws(() => normalizeCapabilityManifest({ ...validManifest, serverId: 0 }));
  assert.throws(() => normalizeCapabilityManifest({
    ...validManifest,
    routeCount: 10001,
    routes: Array.from({ length: 10001 }, (_, index) => `module.op${index}`),
  }));
});
