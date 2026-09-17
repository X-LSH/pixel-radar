/**
 * Pixel Radar · 数据管线
 * ---------------------------------------------------------------
 * 职责：按优先级依次尝试数据源，失败自动降级，最终落到模拟数据，
 * 并把「当前用的是什么、上游是谁、多久前拿到的」如实告诉界面。
 *
 * 优先级链（对应规格的三层降级 + OpenSky 兜底）：
 *   自备中继 → 静态快照 → 直接聚合源 → OpenSky → 模拟
 *
 * 几条纪律：
 *  · **绝不静默造假**：一旦回落到模拟，界面必须显示「模拟数据」。
 *  · **绝不空屏**：任何路径失败都不会导致空域为空。
 *  · **失败要退避**：指数退避，避免把上游打挂 / 烧光自己的配额。
 *  · 页面隐藏时降频，这不是省流量，而是不打扰后台标签页。
 */

import { POLL } from '../config.js';
import { normalizePlane } from './normalize.js';
import { createSimulator } from './simulate.js';
import {
  relaySource, snapshotSource, directSource, openSkySource,
  FetchError,
} from './sources.js';
import { Tracker } from '../state/tracker.js';

/** 初始探测的预算：超时即先上模拟，别让用户对着启动幕发呆 */
const BOOT_BUDGET_MS = 6000;
/** 全链失败后，隔多久重试一次整条链 */
const CHAIN_RETRY_MS = 60000;
/** 连续失败多少次就降级到下一个源 */
const FAILS_BEFORE_DOWNGRADE = 2;

export function createPipeline({
  store, getRelayUrl, getAirport, getRadiusNm, getSnapshotConfig,
}) {
  const tracker = new Tracker();

  let sources = [];
  let cursor = 0;
  let mode = 'boot'; // boot | relay | snapshot | direct | opensky | simulation
  let sim = null;
  let timer = null;
  let pollAbort = null;
  let consecutiveFails = 0;
  let visible = true;
  let running = false;
  let chainRetryAt = 0;
  let bootedAt = 0;
  let lastSuccessAt = 0;
  let lastObservationAt = 0;
  let sourceId = '';
  let noteText = '';
  let lastError = null;
  /** 上次广播出去的架数，用于抑制无意义的逐帧广播 */
  let lastCount = -1;

  /* ------------------------------------------------------------
   * 源链构建
   * ------------------------------------------------------------ */
  function buildSources() {
    return [
      relaySource(getRelayUrl),
      snapshotSource(() => (getSnapshotConfig ? getSnapshotConfig() : { repo: '', branch: 'data' })),
      directSource(),
      openSkySource(),
    ];
  }

  /** 把探测轨迹写回 store，供侧栏链路可视化 */
  function publishTrail() {
    const trail = sources.map((s, i) => {
      let state = 'idle';
      if (i < cursor) state = 'fail';
      else if (i === cursor) state = 'active';
      else state = 'idle';
      if (s.id === 'relay' && !s.available()) state = 'skip';
      return { id: s.id, label: s.label, state };
    });
    store.patch('feed', { trail });
  }

  function publishFeed(patchObj) {
    store.patch('feed', patchObj);
  }

  /* ------------------------------------------------------------
   * 单次拉取
   * ------------------------------------------------------------ */
  async function pullOnce(ctx) {
    pollAbort = new AbortController();
    const res = await sources[cursor].run(ctx, pollAbort.signal);

    const planes = [];
    for (const raw of res.records) {
      const p = normalizePlane(raw, res.sourceId);
      if (!p) continue;
      // 观测时刻：信息卡的「最后更新」以此为准，而不是页面渲染时刻
      p.obsAt = lastSuccessAt;
      planes.push(p);
    }

    /**
     * 空结果按「无数据」处理，继续沿链条降级。
     * 依据实测：上游在某些空域确实没有接收覆盖（返回 total:0 且非限流），
     * 若把它当成一次成功，用户看到的会是一块完全空白的雷达屏。
     * 规格要求「保证视觉不空」，因此这里主动降级，由界面明确标注来源。
     */
    if (!planes.length) {
      throw new FetchError('该空域暂无数据（上游无接收覆盖）', 'empty');
    }

    lastSuccessAt = Date.now();
    lastObservationAt = lastSuccessAt;
    sourceId = res.sourceId;
    noteText = res.note || '';

    // 观测写入追踪器 —— 只写观测，不写外推结果
    tracker.ingest(planes, lastSuccessAt);

    const feedState = cursor === 0 ? 'live' : cursor === 1 ? 'snapshot' : 'live';
    mode = sources[cursor].id;
    consecutiveFails = 0;
    lastCount = planes.length;

    publishFeed({
      state: feedState,
      label: labelOf(feedState),
      detail: `${res.records.length} 条原始记录`,
      sourceId,
      fetchedAt: res.fetchedAt || lastSuccessAt,
      count: planes.length,
      lastError: null,
    });
    publishTrail();

    return planes.length;
  }

  function labelOf(state) {
    switch (state) {
      case 'live': return '实时数据';
      case 'snapshot': return '静态快照';
      case 'simulation': return '模拟数据';
      default: return '正在接入';
    }
  }

  /* ------------------------------------------------------------
   * 降级
   * ------------------------------------------------------------ */
  function downgrade(reason) {
    lastError = reason;
    consecutiveFails++;
    if (consecutiveFails < FAILS_BEFORE_DOWNGRADE) return;

    consecutiveFails = 0;
    cursor++;
    publishTrail();

    if (cursor >= sources.length) enterSimulation(reason);
  }

  function enterSimulation(reason) {
    if (!sim) {
      const airport = getAirport();
      sim = createSimulator(airport, { radiusKm: 90 });
      tracker.reset();
    }
    mode = 'simulation';
    sourceId = 'simulation';
    chainRetryAt = Date.now() + CHAIN_RETRY_MS;
    publishFeed({
      state: 'simulation',
      label: labelOf('simulation'),
      detail: reason ? `上游不可用：${reason}` : '上游不可用',
      sourceId: '模拟',
      fetchedAt: Date.now(),
      lastError: reason || null,
    });
    publishTrail();
  }

  /** 重建源链并从第一个源重试（换机场或配置变更时调用） */
  function restartChain(immediate = false) {
    sources = buildSources();
    cursor = 0;
    consecutiveFails = 0;
    chainRetryAt = 0;
    tracker.reset();
    sim = null;
    publishTrail();
    if (immediate) scheduleNext(0);
  }

  /* ------------------------------------------------------------
   * 调度
   * ------------------------------------------------------------ */
  function nextInterval() {
    if (mode === 'simulation') return CHAIN_RETRY_MS;
    if (!visible) return POLL.hiddenMs;
    if (consecutiveFails > 0) {
      const idx = Math.min(consecutiveFails, POLL.backoffMs.length) - 1;
      return POLL.backoffMs[idx];
    }
    return POLL.visibleMs;
  }

  function scheduleNext(delay) {
    if (!running) return;
    clearTimeout(timer);
    const d = delay == null ? nextInterval() : delay;
    timer = setTimeout(tick, d);
  }

  async function tick() {
    if (!running) return;
    const now = Date.now();
    const ctx = context();

    // 处于模拟态：定期重试整条链，看上游是否恢复
    if (mode === 'simulation') {
      if (now >= chainRetryAt) {
        sources = buildSources();
        cursor = 0;
        consecutiveFails = 0;
        publishTrail();
        try {
          await pullOnce(ctx);
          tracker.reset();
          sim = null;
        } catch (e) {
          enterSimulation(reasonOf(e));
        }
      }
      scheduleNext();
      return;
    }

    if (!ctx) return;

    try {
      await pullOnce(ctx);
    } catch (e) {
      const reason = reasonOf(e);
      publishFeed({ lastError: reason });
      downgrade(reason);
      // 降级后若还有下一个源，立即再试一次，不要干等一个退避周期
      if (mode !== 'simulation' && cursor < sources.length) {
        scheduleNext(400);
        return;
      }
    }
    scheduleNext();
  }

  function reasonOf(e) {
    if (e instanceof FetchError) return e.message;
    return e && e.message ? e.message : '未知错误';
  }

  function context() {
    const airport = getAirport();
    if (!airport) return null;
    const nm = Math.max(10, Math.min(POLL.maxRadiusNm, Math.round(getRadiusNm())));
    return {
      icao: airport.icao,
      lat: airport.lat,
      lon: airport.lon,
      radiusNm: nm,
      radiusKm: nm * 1.852,
    };
  }

  /* ------------------------------------------------------------
   * 对外接口
   * ------------------------------------------------------------ */

  /**
   * 启动：先用一个有限预算探测真实源，失败即上模拟。
   * 这样大多数情况下用户直接就落到真实数据，不会看到模拟画面闪一下。
   */
  async function start() {
    running = true;
    bootedAt = Date.now();
    sources = buildSources();
    cursor = 0;
    publishTrail();

    const ctx = context();
    if (!ctx) {
      enterSimulation('未选择机场');
      return;
    }

    const budget = new Promise((resolve) => setTimeout(() => resolve('timeout'), BOOT_BUDGET_MS));
    /** 竞速结束标记：预算到点后不再理会仍在途中的探测，避免它事后改写状态 */
    let settled = false;
    const real = (async () => {
      while (cursor < sources.length) {
        if (settled) return 'cancelled';
        try {
          await pullOnce(ctx);
          return settled ? 'cancelled' : 'ok';
        } catch (e) {
          publishFeed({ lastError: reasonOf(e) });
          cursor++;
          publishTrail();
        }
      }
      return 'exhausted';
    })();

    const winner = await Promise.race([real, budget]);
    settled = true;
    if (winner === 'ok') {
      mode = sources[Math.min(cursor, sources.length - 1)].id;
    } else {
      enterSimulation(winner === 'exhausted' ? '全部上游不可用' : '探测超时');
    }
    scheduleNext(mode === 'simulation' ? CHAIN_RETRY_MS : POLL.visibleMs);
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    if (pollAbort) pollAbort.abort();
  }

  /** 主循环调用：推进模拟并产出渲染帧 */
  function update(now, dtSec) {
    if (mode === 'simulation' && sim) {
      sim.update(dtSec);
      // 模拟数据本身是连续的，直接作为观测写入
      const list = [...sim.planes.values()];
      for (const p of list) p.obsAt = now;
      tracker.ingest(list, now);
      if (list.length !== lastCount) {
        lastCount = list.length;
        publishFeed({ count: list.length, fetchedAt: now, sourceId: '模拟' });
      }
    }
    const frame = tracker.frame(now, dtSec);
    // 只在架数真正变化时广播 —— 每帧广播会把侧栏 DOM 打爆
    if (frame.length !== lastCount) {
      lastCount = frame.length;
      publishFeed({ count: frame.length });
    }
    return frame;
  }

  /** 换机场：重置追踪器与模拟器，链从头再来 */
  function setAirport() {
    restartChain(true);
  }

  function setVisible(v) {
    visible = v;
    // 重新可见时立刻拉一次，不必等满一个隐藏周期
    if (v && running) scheduleNext(0);
  }

  /** 配置变更（如填入中继地址）：立即重试 */
  function notifyConfigChanged() {
    restartChain(true);
  }

  function status() {
    return {
      mode,
      sourceId,
      note: noteText,
      lastSuccessAt,
      lastObservationAt,
      lastError,
      simStats: sim ? sim.stats() : null,
      cursor,
      sources: sources.map((s) => ({ id: s.id, label: s.label, available: s.available() })),
    };
  }

  return {
    start, stop, update, setAirport, setVisible, notifyConfigChanged, status,
    getTracker: () => tracker,
    getMode: () => mode,
  };
}
