/**
 * Pixel Radar · 状态存储
 * ---------------------------------------------------------------
 * 极简的「单例可观察对象」：一个 state 对象 + 订阅者集合。
 * 不引入任何框架 —— 本项目的状态变更点很少（换机场、改视图、选目标），
 * 上框架的收益抵不上它的体积与心智负担。
 *
 * 纪律：state 只由 set() 改写，订阅者只读。
 * 渲染层不允许直接写 state（避免「谁改的」无法追溯）。
 */

import { DEFAULTS, STORE_KEYS } from '../config.js';

/** 只持久化这些键，其余属于会话态 */
const PERSISTED = [
  'airportIcao', 'ringKm', 'zoomIndex', 'scale',
  'crt', 'scanlines', 'vignette', 'noise', 'sweepOn', 'trailsOn', 'labelsOn',
  'relayUrl',
];
const PERSISTED_SET = new Set(PERSISTED);

/**
 * 落盘合并窗口。
 * `localStorage.setItem` 是同步调用，而滚轮缩放一次手势就能产生几十个
 * `set()`（每次都「有变更」），连发会把主线程卡在存储 IO 上。
 * 改为：250ms 内的变更合并成一次写入，页面隐藏时立刻冲刷，关页前不丢设置。
 */
const PERSIST_DEBOUNCE_MS = 250;

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORE_KEYS.settings);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    const out = {};
    for (const k of PERSISTED) if (k in obj) out[k] = obj[k];
    return out;
  } catch {
    // 隐私模式 / 存储被禁用：静默降级为默认设置，不影响主流程
    return {};
  }
}

function savePersisted(state) {
  try {
    const out = {};
    for (const k of PERSISTED) out[k] = state[k];
    localStorage.setItem(STORE_KEYS.settings, JSON.stringify(out));
  } catch {
    /* 忽略配额与禁用错误 */
  }
}

export function createStore() {
  const listeners = new Set();
  let saveTimer = 0;

  const state = {
    ...DEFAULTS,
    ...loadPersisted(),

    /* —— 会话态（不持久化）—— */
    /** 当前机场对象 */
    airport: null,
    /** 视图：由 stage 维护，store 只持有引用供 UI 读取 */
    view: null,
    /** 选中的目标 hex */
    selectedHex: null,
    /** 当前数据源状态 */
    feed: {
      state: 'boot', // boot | live | snapshot | simulation | down
      label: '正在接入',
      detail: '',
      sourceId: '',
      fetchedAt: 0,
      count: 0,
      lastError: null,
      trail: [], // 源探测轨迹，用于侧栏链路可视化
    },
    /** 帧率（由主循环写入，UI 读取） */
    fps: 0,
    /** 逻辑分辨率（由 stage 写入） */
    resolution: { w: 0, h: 0, scale: 0 },
    /** 面板是否收起 */
    panelOpen: true,
    /** 目标统计 */
    stats: { count: 0, air: 0, ground: 0, topAlt: null, fastestKt: null, busiestHdg: null },
  };

  function get() {
    return state;
  }

  /** 浅合并写入并广播。返回实际发生变化的键数组。 */
  function set(patch, opts = {}) {
    const changed = [];
    for (const k of Object.keys(patch)) {
      if (state[k] !== patch[k]) {
        state[k] = patch[k];
        changed.push(k);
      }
    }
    if (changed.length || opts.force) {
      // 只有可持久化的键变了才排期落盘：paused / selectedHex 这类会话态
      // 每秒都在变，不该连带触发一次对内容毫无变化的写入。
      if (!opts.silent && changed.some((k) => PERSISTED_SET.has(k))) schedulePersist();
      for (const fn of listeners) {
        try {
          fn(state, changed);
        } catch (e) {
          // 单个订阅者出错不应拖垮整个广播
          console.error('[store] 订阅者异常', e);
        }
      }
    }
    return changed;
  }

  /** 合并写入：把窗口内的多次变更压成一次 localStorage 写 */
  function schedulePersist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      savePersisted(state);
    }, PERSIST_DEBOUNCE_MS);
  }

  /** 立即落盘（页面隐藏 / 关闭前调用，保证设置不丢） */
  function flushPersisted() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    savePersisted(state);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushPersisted);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushPersisted();
    });
  }

  /** 深层局部更新（仅用于 feed 与 stats 这类嵌套结构） */
  function patch(key, sub) {
    const prev = state[key] || {};
    // 无实质变化就不广播：resolution 每次 resize 都会带一个新对象进来，
    // stats 每 500ms 一份新对象，多数时候数值完全没动。
    let dirty = false;
    for (const k of Object.keys(sub)) {
      if (!Object.is(prev[k], sub[k])) { dirty = true; break; }
    }
    if (!dirty) return;

    state[key] = { ...prev, ...sub };
    for (const fn of listeners) {
      try {
        fn(state, [key]);
      } catch (e) {
        console.error('[store] 订阅者异常', e);
      }
    }
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** 恢复出厂设置（用于「重置」按钮） */
  function resetSettings() {
    const patchObj = {};
    for (const k of Object.keys(DEFAULTS)) patchObj[k] = DEFAULTS[k];
    set(patchObj);
  }

  return { get, set, patch, subscribe, resetSettings, flushPersisted, PERSISTED };
}
