import test from 'node:test';
import assert from 'node:assert/strict';
import { describeActions } from '../src/action-state.mjs';
const action = name => [{ name, title: name }];
const row = (cls, name, value, tid = 0) => ({ cls, name, value, tid });

test('类存在不能证明模块解锁', () => {
  const [state] = describeActions(action('tech.finish'), [row('TechDt', 'unlocking_tech', 0)]);
  assert.equal(state.unlocked, null);
  assert.equal(state.autoEligible, false);
});

test('明确解锁状态可用于分类门禁', () => {
  const [state] = describeActions(action('build.collect'), [row('BuildDt', 'unlock', 1, 100)]);
  assert.equal(state.unlocked, true);
  assert.equal(state.category, '生产建筑');
});

test('零奖励不等于模块锁定', () => {
  const [state] = describeActions(action('helper.gainAward'), [row('HelperDt', 'dropCount', 0)]);
  assert.equal(state.unlocked, null);
});

test('剧情奖励读取TaskDt并开放领取', () => {
  const [state] = describeActions(action('mapEvent.claimAward'), [row('TaskDt', 'mapEvent', 3, 100)]);
  assert.equal(state.unlocked, true);
  assert.equal(state.autoEligible, true);
});

test('同步到主线任务后允许把条件已满足的领奖推进加入自动计划', () => {
  const [state] = describeActions(action('task.autoMain'), [row('TaskDt', 'tid', 12)]);
  assert.equal(state.unlocked, true);
  assert.equal(state.autoEligible, true);
});
