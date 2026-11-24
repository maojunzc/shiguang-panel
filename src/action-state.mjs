import { SAFE_AUTO_PLAN } from './auto-runner.mjs';

const categories = { task: '任务', build: '生产建筑', tech: '科技', market: '集市', helper: '管家', wonder: '奇观', activity: '活动福利', mail: '活动福利', freeshopping: '活动福利', privilege: '活动福利', mission: '征战', mapEvent: '任务' };

export function describeActions(actions, rows) {
  const values = (cls, name) => rows.filter(row => row.cls === cls && row.name === name);
  const positive = (cls, name) => values(cls, name).some(row => Number(row.value) > 0);
  return actions.map(action => {
    const prefix = action.name.split('.')[0];
    let unlocked = null;
    let reason = '尚未取得明确解锁条件';
    const cls = { build: 'BuildDt', tech: 'TechDt', wonder: 'WonderDt' }[prefix];
    if (cls && positive(cls, 'unlock')) { unlocked = true; reason = '已取得解锁状态'; }
    if (prefix === 'task' && (positive('TaskDt', 'tid') || values('TaskDt', 'comState').length)) {
      unlocked = true; reason = '已同步任务状态';
    }
    const evidence = {
      'build.collect': positive('BuildDt', 'collectClickCount'),
      'build.offline': positive('BuildDt', 'left_offline_duration'),
      'task.claimAll': values('TaskDt', 'comState').some(row => Number(row.value) === 2),
      'helper.gainAward': positive('HelperDt', 'dropCount'),
      'mapEvent.claimAward': values('TaskDt', 'mapEvent').some(row => Number(row.value) === 3),
    };
    if (evidence[action.name]) { unlocked = true; reason = '当前有可领取内容'; }
    return { ...action, category: categories[prefix] ?? '其他', unlocked, reason,
      autoEligible: SAFE_AUTO_PLAN.includes(action.name) && unlocked === true };
  });
}
