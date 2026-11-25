// 自动执行只开放具备明确本地前置条件的领取动作。
export const SAFE_AUTO_PLAN = Object.freeze([
  'build.collect', 'build.offline', 'task.claimAll',
  'task.autoMain', 'task.autoStory',
  'helper.gainAward', 'mapEvent.claimAward',
]);

export class AutoRunner {
  constructor({ execute, isOnline, onChange = () => {}, maxSteps = 30, maxDurationMs = 60000 }) {
    this.execute = execute;
    this.isOnline = isOnline;
    this.onChange = onChange;
    this.maxSteps = maxSteps;
    this.maxDurationMs = maxDurationMs;
    this.state = { running: false, phase: 'idle', currentAction: null, stopReason: null, lastRunAt: null, lastResults: [], history: [] };
    this.generation = 0;
    this.resumeAfterRun = false;
  }

  snapshot() {
    return structuredClone(this.state);
  }

  pause(reason = '用户暂停') {
    this.generation += 1;
    if (this.state.running) this.resumeAfterRun = false;
    this.state.phase = 'paused';
    this.state.stopReason = reason;
    this.onChange();
  }

  resume() {
    if (this.state.running) {
      this.resumeAfterRun = true;
      return;
    }
    this.state.phase = 'idle';
    this.state.stopReason = null;
    this.onChange();
  }

  async run(plan) {
    if (this.state.running || (this.state.phase === 'paused' && !this.resumeAfterRun)) return null;
    this.resumeAfterRun = false;
    if (!this.isOnline()) {
      this.pause('账号未连接或处于只读模式');
      return null;
    }
    const generation = ++this.generation;
    const startedAt = Date.now();
    const results = [];
    const selected = [...new Set(plan)];
    Object.assign(this.state, { running: true, phase: 'running', currentAction: null, stopReason: null });
    this.onChange();
    try {
      for (const name of selected) {
        if (generation !== this.generation) break;
        if (!this.isOnline()) { this.pause('连接已断开'); break; }
        if (results.length >= this.maxSteps || Date.now() - startedAt >= this.maxDurationMs) {
          this.pause('达到本轮执行上限');
          break;
        }
        this.state.currentAction = name;
        this.onChange();
        if (!SAFE_AUTO_PLAN.includes(name)) {
          results.push({ name, title: name, ok: false, status: 'blocked', note: '自动条件或资源消耗尚未核验，需人工执行', at: Date.now() });
          continue;
        }
        let result;
        try {
          result = await this.execute(name, { guard: () => {
            if (generation !== this.generation) throw new Error('自动流程已取消');
            if (!this.isOnline()) throw new Error('连接已断开或已切换只读');
            if (Date.now() - startedAt >= this.maxDurationMs) throw new Error('达到本轮执行时长上限');
          } });
        } catch {
          results.push({ name, title: name, ok: false, status: 'error', note: '请求异常，本轮已停止，请检查连接后重新开启', at: Date.now() });
          this.pause('请求异常');
          break;
        }
        const failed = !result.ok && !result.skipped;
        const note = result.skipped ?? result.meta?.note ?? (failed ? '服务器拒绝执行' : null);
        results.push({ name, title: result.title ?? name, ok: Boolean(result.ok), status: result.skipped ? 'skipped' : failed ? 'error' : 'success', code: result.code ?? null, note, meta: result.meta ?? null, elapsedMs: result.elapsedMs ?? 0, at: Date.now() });
        if (failed) { this.pause(result.note ?? '服务器返回错误'); break; }
        if (Date.now() - startedAt >= this.maxDurationMs) {
          this.pause('达到本轮执行时长上限');
          break;
        }
      }
      if (generation === this.generation) {
        if (results.some((row) => row.ok) || (results.length > 0 && results.every((row) => row.status === 'skipped'))) {
          this.state.phase = 'waiting';
          this.state.stopReason = results.some((row) => row.ok) ? '本轮结束，等待下次检查' : '暂无可领取内容，等待下次检查';
        } else {
          this.pause('本轮没有完成任何动作，已暂停等待检查');
        }
      }
    } finally {
      this.state.running = false;
      this.state.currentAction = null;
      this.state.lastRunAt = startedAt;
      this.state.lastResults = results;
      this.state.history.unshift({ startedAt, endedAt: Date.now(), phase: this.state.phase, reason: this.state.stopReason, results });
      this.state.history.length = Math.min(this.state.history.length, 20);
      this.onChange();
    }
    return results;
  }
}
