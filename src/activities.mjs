// 活动配置与可领取条件：数据来自登录推送的 mainConfig / activityDataList / activityConditionDataList。
// 只做本地计算，不额外发请求。
// 只把「免费/签到类」活动开放领取；充值、基金、触发礼包等付费活动一律不碰。
export const CLAIMABLE_TYPES = new Set([113, 114, 115, 116, 145, 150, 224, 233]);

// 活动类型中文名，来自 _tbd_ 的 tb.ActivityEnumCode。
export const ACTIVITY_TYPE_NAMES = {
  101: '同盟充值', 102: '自选礼包', 103: '集市聚宝', 104: '充值返利', 105: '基金',
  106: '超级礼包', 107: '首充', 108: '触发礼包', 109: '同盟同名', 110: '累充天数',
  111: '特权卡', 112: '时间奖励', 113: '时代礼包', 114: '采集助手', 115: '开服庆典',
  116: '七日签到', 117: '抢夺', 118: '建立帝国', 119: '问答', 120: '舞狮宝箱',
  121: '远航', 122: '战力榜', 125: '任务榜', 126: '城墙榜', 127: '缘分', 128: '宠物战斗',
  129: '战争状态', 131: '计谋', 132: '学堂', 133: '埃及祈福', 134: '同盟助战', 135: '四海',
  136: '抽奖', 137: '集结令', 138: '贸易榜', 139: '学堂榜', 140: '春节', 141: '福卡',
  142: '锦鲤', 143: '贪吃蛇', 144: '烟花', 145: '节日礼包', 146: '唐朝集市', 147: '六阵营',
  148: '跨服贸易榜', 149: '演武', 150: '周年签到', 151: '牛人学生', 152: '与你同行',
  153: '节日基金', 154: '轮回缘分', 155: '宝藏', 156: '邀请好友', 158: '唐朝榜',
  159: '偶像', 160: '新远航', 161: '五岳', 162: '财富积累', 163: '宋朝榜', 164: '抖音登录',
  172: '寻宝', 173: '时代演化', 174: '同盟战礼', 175: '龙舟', 180: '神之子', 181: '漠北',
  183: '书籍', 184: '限时活动', 185: '象棋', 186: '老玩家回归', 187: '新玩家回归',
  190: '武道', 199: '巨人星', 200: '免费礼包', 201: '广告触发礼', 202: '看广告',
  203: '看广告', 220: '欢乐生活', 221: '京都', 222: '我的血脉', 223: '永恒',
  224: '欢乐生活签到', 225: '爱永恒', 227: '六阵营巅峰', 228: '团购', 229: '烟火',
  230: '赤壁', 231: '赛马', 232: '逐鹿之战', 233: '家园活动', 234: '战争', 240: '荔枝',
  245: '龙灯', 250: '月桂节', 251: '奇境', 252: '周年庆', 253: '庆典奇观', 260: '讨伐董',
  261: '运输', 262: '盛宴',
};

export class ActivityBook {
  constructor() {
    this.activities = new Map();
    this.claimed = new Set();
  }

  absorb(data) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data.mainConfig)) {
      for (const item of data.mainConfig) {
        if (!item?.activityId) continue;
        this._ensure(item.activityId).type = item.type ?? null;
      }
    }
    for (const list of [data.activityDataList, data.activityConditionDataList]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) this._absorbActivity(item);
    }
  }

  _ensure(activityId) {
    let entry = this.activities.get(activityId);
    if (!entry) {
      entry = { activityId, type: null, conditions: [] };
      this.activities.set(activityId, entry);
    }
    return entry;
  }

  _absorbActivity(item) {
    if (!item?.activityId) return;
    const entry = this._ensure(item.activityId);
    const common = item.detailConfig?.commonConfig ?? {};
    if (common.mainConfig?.type != null) entry.type = common.mainConfig.type;

    if (Array.isArray(common.conditionConfig)) {
      entry.conditions = common.conditionConfig.map((config) => ({
        id: config.conditionId,
        type: config.type,
        param: config.param,
        rewards: config.rewards,
        title: config.title,
        desc: config.desc,
        value: null,
        got: false,
      }));
    }
    if (Array.isArray(common.mallConfig)) {
      entry.malls = common.mallConfig.map((mall) => ({ id: mall.id, bundle: Boolean(mall.bundle) }));
    }
    if (Array.isArray(item.conditionDataList)) {
      for (const state of item.conditionDataList) {
        let condition = entry.conditions.find((row) => row.id === state.conditionId);
        if (!condition) {
          condition = { id: state.conditionId, type: null, param: null, rewards: null, title: null, desc: null, value: null, got: false };
          entry.conditions.push(condition);
        }
        condition.value = state.value;
        condition.got = Boolean(state.getReward);
      }
    }
  }

  _claimable(activityId) {
    const entry = this.activities.get(activityId);
    if (!entry) return [];
    return entry.conditions.filter((condition) => {
      if (condition.got || !condition.param?.length) return false;
      if (this.claimed.has(`${activityId}:${condition.id}`)) return false;
      return Number(condition.value ?? 0) >= Number(condition.param[0]);
    });
  }

  idsToClaim(activityId) {
    const entry = this.activities.get(activityId);
    if (!entry || !CLAIMABLE_TYPES.has(entry.type)) return [];
    return this._claimable(activityId).map((condition) => condition.id);
  }

  // 免费礼包：类型 200 的活动里，非 bundle 的礼包 shopId。
  freeShopIds() {
    const ids = [];
    for (const entry of this.activities.values()) {
      if (entry.type !== 200 || !entry.malls) continue;
      for (const mall of entry.malls) if (!mall.bundle) ids.push(mall.id);
    }
    return ids;
  }

  markClaimed(activityId, ids) {
    for (const id of ids) this.claimed.add(`${activityId}:${id}`);
  }

  summary() {
    const list = [];
    for (const entry of this.activities.values()) {
      if (!CLAIMABLE_TYPES.has(entry.type)) continue;
      if (!entry.conditions.length) continue;
      const claimable = this._claimable(entry.activityId).length;
      list.push({
        activityId: entry.activityId,
        type: entry.type,
        typeName: ACTIVITY_TYPE_NAMES[entry.type] ?? `类型${entry.type ?? '?'}`,
        total: entry.conditions.length,
        claimable,
        got: entry.conditions.filter((condition) => condition.got).length,
      });
    }
    return list.sort((a, b) => b.claimable - a.claimable || b.got - a.got);
  }
}

export const activityBook = new ActivityBook();
