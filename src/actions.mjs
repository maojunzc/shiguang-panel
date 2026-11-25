// 写操作白名单。默认放行；启动时加 --read-only 则全部拦截。
// 每个动作都先读本地属性做前置判断，条件不满足直接返回 skipped，不向服务器发帧。
import { attrName } from './client.mjs';
import { activityBook } from './activities.mjs';

// 直接按属性名查当前值：返回 { id, tid, value } 列表。
function find(client, cls, name) {
  const list = [];
  for (const [id, value] of client.dt) {
    const info = attrName(id);
    if (info && info.cls === cls && info.name === name) list.push({ id, tid: info.tid, value });
  }
  return list;
}

function first(client, cls, name) {
  return find(client, cls, name).find((row) => row.tid === 0)?.value ?? null;
}

function num(client, cls, name) {
  return Number(first(client, cls, name) ?? 0);
}

// 服务器返回 code 为空表示成功；有值时是错误码（数组或数字）。
function isError(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return true;
  const code = response.code;
  const value = Array.isArray(code) ? code[0] : code;
  return Boolean(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 只接受现代 Unix 绝对时间的数量级；相对时长及单位不明的值不能用于领奖。
function epochMS(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const time = Number(value);
  if (!Number.isFinite(time)) return null;
  if (time >= 1e9 && time < 1e10) return time * 1000;
  if (time >= 1e12 && time < 1e13) return time;
  return null;
}

function timerBlocked(client, cls, field) {
  const end = epochMS(first(client, cls, field));
  const now = client.serverMS == null ? Date.now() : epochMS(client.serverMS);
  if (end === null || now === null) return '无法确认计时单位或到期时间，暂不领取';
  return end > now ? '计时尚未到期' : null;
}

export const ACTIONS = {
  'mail.claimAll': {
    title: '邮件一键领取',
    write: true,
    async run(client) {
      const response = await client.request('mail', 'getAllReward');
      return { response };
    },
  },

  'task.claimAll': {
    title: '任务领奖（可领的全部）',
    write: true,
    async run(client) {
      const tids = find(client, 'TaskDt', 'comState').filter((row) => Number(row.value) === 2).map((row) => row.tid);
      if (!tids.length) return { skipped: '当前没有可领取的任务' };
      const response = await client.request('task', 'comFinish', tids);
      return { response, tids };
    },
  },

  'task.dailyBox': {
    title: '每日任务宝箱',
    write: true,
    async run(client) {
      const response = await client.request('task', 'getDailyTaskBoxAward');
      return { response };
    },
  },

  'task.mainFinish': {
    title: '主线领奖',
    write: true,
    async run(client) {
      const can = Number(first(client, 'TaskDt', 'can_finish') ?? 0);
      if (!can) return { skipped: '当前没有可领取的主线奖励' };
      const response = await client.request('task', 'finish');
      return { response };
    },
  },

  'build.settle': {
    title: '挂机资源结算',
    write: true,
    async run(client) {
      const response = await client.request('build', 'settleResInc');
      return { response };
    },
  },

  'build.offline': {
    title: '离线收益结算',
    write: true,
    async run(client) {
      const left = Number(first(client, 'BuildDt', 'left_offline_duration') ?? 0);
      if (!left) return { skipped: '当前没有可结算的离线收益' };
      const response = await client.request('build', 'settleOfflineAward');
      return { response };
    },
  },

  'build.upgrade': {
    title: '建筑升级',
    write: true,
    async run(client, params) {
      const buildTid = Number(params?.buildTid);
      if (!buildTid) return { skipped: '缺少 buildTid' };
      const response = await client.request('build', 'buildLvUp', { buildTid });
      return { response };
    },
  },

  'market.settle': {
    title: '集市营业结算',
    write: true,
    async run(client) {
      const response = await client.request('market', 'settleAward');
      return { response };
    },
  },

  'market.rumor': {
    title: '集市流言奖励',
    write: true,
    async run(client) {
      const rows = find(client, 'MarketDt', 'rumor');
      if (!rows.length) return { skipped: '当前没有可领取的流言奖励' };
      const response = await client.request('market', 'getRumorReward');
      return { response };
    },
  },

  'helper.collect': {
    title: '管家托管收取',
    write: true,
    async run(client) {
      if (Number(first(client, 'HelperDt', 'start') ?? 0) !== 1) return { skipped: '管家托管未开启' };
      const response = await client.request('helper', 'collect');
      return { response };
    },
  },

  'helper.gainAward': {
    title: '管家奖励领取',
    write: true,
    async run(client) {
      const drops = find(client, 'HelperDt', 'dropCount');
      const total = drops.reduce((sum, row) => sum + Number(row.value ?? 0), 0);
      if (total < 1) return { skipped: '管家暂无可领奖励（需要月卡/终身卡）' };
      const response = await client.request('helper', 'gainAward');
      return { response };
    },
  },

  'tech.finish': {
    title: '科技研究完成',
    write: true,
    async run(client) {
      if (!Number(first(client, 'TechDt', 'unlocking_tech') ?? 0)) return { skipped: '当前没有进行中的研究' };
      const blocked = timerBlocked(client, 'TechDt', 'unlock_end_time');
      if (blocked) return { blocked, skipped: blocked };
      const response = await client.request('tech', 'finish');
      return { response };
    },
  },

  'tech.aidOthers': {
    title: '科技互助',
    write: true,
    async run(client) {
      if (!Number(first(client, 'UnionDt', 'id') ?? 0)) return { skipped: '尚未加入同盟' };
      if (!Number(first(client, 'MyUnionDt', 'ask_aid_count') ?? 0)) return { skipped: '今日互助次数已用完' };
      const response = await client.request('tech', 'aidOthers');
      return { response };
    },
  },

  'wonder.finishVisit': {
    title: '奇观完成游览',
    write: true,
    async run(client) {
      if (!Number(first(client, 'WonderDt', 'visit_end_time') ?? 0)) return { skipped: '当前没有进行中的游览' };
      const blocked = timerBlocked(client, 'WonderDt', 'visit_end_time');
      if (blocked) return { blocked, skipped: blocked };
      const response = await client.request('wonder', 'finishVisit');
      return { response };
    },
  },

  'privilege.moon': {
    title: '月卡每日奖励',
    write: true,
    async run(client) {
      const end = Number(first(client, 'PrivilegeCardDt', 'moon_card_end_time') ?? 0);
      if (end * 1000 <= Date.now()) return { skipped: '月卡未生效' };
      const response = await client.request('privilegeCard', 'getAward', { type: 1 });
      return { response };
    },
  },

  'privilege.forever': {
    title: '终身卡每日奖励',
    write: true,
    async run(client) {
      const end = Number(first(client, 'PrivilegeCardDt', 'forever_card_end_time') ?? 0);
      if (end * 1000 <= Date.now()) return { skipped: '终身卡未生效' };
      const response = await client.request('privilegeCard', 'getAward', { type: 2 });
      return { response };
    },
  },

  'activity.claim': {
    title: '活动条件奖励',
    write: true,
    async run(client, params) {
      const activityId = Number(params?.activityId);
      if (!activityId) return { skipped: '缺少 activityId' };
      const ids = activityBook.idsToClaim(activityId);
      if (!ids.length) return { skipped: '该活动暂无可领取条件' };
      const response = await client.request('activity', 'getConditionRewards', { activityId, idList: ids });
      if (!isError(response)) activityBook.markClaimed(activityId, ids);
      return { response, tids: ids };
    },
  },

  'activity.claimAll': {
    title: '活动奖励（全部可领）',
    write: true,
    async run(client) {
      const rows = activityBook.summary().filter((row) => row.claimable > 0);
      if (!rows.length) return { skipped: '当前没有可领取的活动奖励' };
      let last = null;
      let claimed = 0;
      let failed = 0;
      for (const row of rows) {
        const ids = activityBook.idsToClaim(row.activityId);
        if (!ids.length) continue;
        const response = await client.request('activity', 'getConditionRewards', { activityId: row.activityId, idList: ids });
        if (!isError(response)) {
          activityBook.markClaimed(row.activityId, ids);
          claimed += ids.length;
        } else {
          failed += 1;
          return { response, meta: { claimed, failed } };
        }
        last = response;
      }
      return { response: last, meta: { claimed, failed } };
    },
  },

  'market.replenish': {
    title: '集市一键补货',
    write: true,
    async run(client) {
      const shelves = find(client, 'MarketDt', 'saleType');
      if (!shelves.length) return { skipped: '集市未解锁' };
      const dataMap = {};
      for (const shelf of shelves) dataMap[shelf.tid] = false;
      const response = await client.request('market', 'addGoodsOneKey', { dataMap, fromAssistant: false });
      return { response, tids: shelves.map((shelf) => shelf.tid) };
    },
  },

  'freeshopping.claim': {
    title: '免费礼包领取',
    write: true,
    async run(client) {
      const claimed = new Map(find(client, 'FreeShoppingDt', 'claimed').map((row) => [row.tid, Number(row.value ?? 0)]));
      const shopIds = activityBook.freeShopIds().filter((id) => (claimed.get(id) ?? 0) === 0);
      if (!shopIds.length) return { skipped: '当前没有可领取的免费礼包' };
      let last = null;
      for (const shopId of shopIds) {
        last = await client.request('freeshopping', 'claim', { shopId });
        if (isError(last)) return { response: last, tids: [shopId] };
      }
      return { response: last, tids: shopIds };
    },
  },

  'helper.start': {
    title: '开启管家托管',
    write: true,
    async run(client) {
      const response = await client.request('helper', 'start', { open: true });
      return { response };
    },
  },

  'build.collect': {
    title: '收取建筑产物',
    write: true,
    async run(client) {
      const rows = find(client, 'BuildDt', 'collectClickCount').filter((row) => Number(row.value ?? 0) > 0);
      if (!rows.length) return { skipped: '当前没有可收取的建筑产物' };
      const response = await client.request('build', 'collect', {
        buildTidL: rows.map((row) => row.tid),
        clickCountL: rows.map((row) => Number(row.value)),
      });
      return { response, tids: rows.map((row) => row.tid) };
    },
  },

  // ---- 自动剧情 / 主线 / 征战 ----

  'task.autoMain': {
    title: '主线任务推进（只领取已完成节点）',
    write: true,
    async run(client) {
      const maxSteps = 10;
      const startTid = num(client, 'TaskDt', 'tid');
      const startFinished = num(client, 'TaskDt', 'finished_task');
      if (!startTid) return { skipped: '当前没有进行中的主线任务' };
      if (!num(client, 'TaskDt', 'can_finish')) {
        return { skipped: '当前主线条件未完成；不会猜测或发送任务动作', meta: { tid: startTid, finishedTask: startFinished } };
      }
      let completed = 0;
      let response = null;
      for (; completed < maxSteps; completed += 1) {
        if (!num(client, 'TaskDt', 'can_finish')) break;
        const tid = num(client, 'TaskDt', 'tid');
        if (!tid) break;
        const finishedTask = num(client, 'TaskDt', 'finished_task');
        response = await client.request('task', 'finish');
        if (isError(response)) {
          return { response, progress: completed > 0, meta: { completed, tid, finishedTask, note: '服务器未接受主线领奖' } };
        }
        if (num(client, 'TaskDt', 'tid') === tid && num(client, 'TaskDt', 'finished_task') === finishedTask) {
          return {
            response,
            progress: false,
            meta: { completed, tid, finishedTask, note: '服务器响应成功但任务状态未变化，已停止并等待复核' },
          };
        }
      }
      return {
        response,
        progress: true,
        meta: {
          completed,
          startTid,
          nextTid: num(client, 'TaskDt', 'tid'),
          finishedTask: startFinished,
          nextFinished: num(client, 'TaskDt', 'finished_task'),
          limitReached: completed === maxSteps && Boolean(num(client, 'TaskDt', 'can_finish')),
        },
      };
    },
  },

  'task.autoStory': {
    title: '自动剧情任务（领奖）',
    write: true,
    async run(client) {
      const ready = find(client, 'TaskDt', 'comState')
        .filter((row) => Number(row.value) === 2)
        .map((row) => row.tid)
        .slice(0, 128);
      if (!ready.length) return { skipped: '当前没有已确认可领取的剧情任务；不会刷新所有进行中任务或猜测章节奖励' };
      const response = await client.request('task', 'comFinish', ready);
      return { response, tids: ready, meta: { claimed: isError(response) ? 0 : ready.length } };
    },
  },

  'mission.autoFight': {
    title: '自动征战推图（打关卡/首领）',
    write: true,
    async run(client, params) {
      if (num(client, 'MissionDt', 'graduation')) return { skipped: '征战已全部通关（毕业）' };
      const rounds = clamp(Number(params?.rounds) || 8, 1, 40);
      const waitMs = clamp(Number(params?.waitSec ?? 10) * 1000, 2000, 30000);
      const stats = { startMission: num(client, 'MissionDt', 'mission'), fights: 0, bossFights: 0, wins: 0, awards: 0, endMission: null, note: null };
      let last = null;
      let idle = 0;
      for (let i = 0; i < rounds; i += 1) {
        if (num(client, 'MissionDt', 'graduation')) {
          stats.note = '征战已毕业';
          break;
        }
        const before = num(client, 'MissionDt', 'mission');
        const fightTid = num(client, 'MissionDt', 'fight_tid');
        const boss = num(client, 'MissionDt', 'boss');
        if (!fightTid) {
          stats.note = '未读到当前征战关卡';
          break;
        }
        if (boss) {
          last = await client.request('mission', 'fightBoss');
          stats.bossFights += 1;
          if (isError(last)) {
            stats.note = '首领战失败（条件不足）';
            break;
          }
          const win = last.data?.result?.win ?? last.data?.win;
          if (!win) {
            stats.note = '首领战未获胜（战力不足）';
            break;
          }
        } else {
          last = await client.request('mission', 'fightNormal', { fightTid, isHeal: true });
          stats.fights += 1;
          if (isError(last)) {
            stats.note = '普通战斗失败（兵力或补给不足）';
            break;
          }
        }
        stats.wins += 1;
        await sleep(waitMs);
        if (num(client, 'MissionDt', 'mission') === before) {
          idle += 1;
          if (idle >= 2) {
            stats.note = '征战进度没有变化（可能宝箱已满或战力不足）';
            break;
          }
        } else {
          idle = 0;
        }
        const award = await client.request('mission', 'gainChapterReward');
        last = award;
        if (isError(award)) {
          stats.note = '征战章节领奖失败';
          break;
        }
        if (!isError(award)) {
          stats.awards += 1;
          await sleep(300);
        }
      }
      stats.endMission = num(client, 'MissionDt', 'mission');
      return { response: last, meta: stats, skipped: stats.wins ? undefined : (stats.note ?? '本轮没有产生战斗') };
    },
  },

  'mapEvent.claimAward': {
    title: '剧情事件奖励领取',
    write: true,
    async run(client) {
      const tids = find(client, 'TaskDt', 'mapEvent').filter((row) => Number(row.value) === 3).map((row) => row.tid);
      if (!tids.length) return { skipped: '当前没有已完成待领奖的剧情事件' };
      let last = null;
      let claimed = 0;
      for (const tid of tids) {
        const response = await client.request('mapEvent', 'gainAward', { tid });
        last = response;
        if (isError(response)) break;
        claimed += 1;
      }
      return { response: last, tids, meta: { claimed } };
    },
  },

  // 协议库里的任意 mod.op 都通过这一个动作发送，data 由界面填写。
  'proto.call': {
    title: '协议调用',
    write: true,
    async run(client, params) {
      const mod = String(params?.mod ?? '').trim();
      const op = String(params?.op ?? '').trim();
      if (!mod || !op) return { skipped: '缺少 mod/op' };
      const data = params?.data && typeof params.data === 'object' ? params.data : {};
      const response = await client.request(mod, op, data);
      return { response };
    },
  },
};

export function listActions() {
  return Object.entries(ACTIONS).map(([name, action]) => ({ name, title: action.title, write: action.write }));
}

export async function runAction(client, name, params) {
  const action = ACTIONS[name];
  if (!action) throw new Error(`未知动作：${name}`);
  const startedAt = Date.now();
  const result = await action.run(client, params ?? {});
  const response = result.response;
  const code = response?.code;
  const ok = !result.skipped && response && typeof response === 'object' && !isError(response) && result.progress !== false;
  return {
    name,
    title: action.title,
    ok: Boolean(ok),
    skipped: result.skipped ?? null,
    code: code ?? null,
    tids: result.tids ?? null,
    meta: result.meta ?? null,
    progress: result.progress ?? null,
    note: result.progress === false ? (result.meta?.note ?? '请求完成但状态未发生可确认变化') : null,
    elapsedMs: Date.now() - startedAt,
  };
}
