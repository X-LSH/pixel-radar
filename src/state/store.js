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
      if (!opts.silent) savePersisted(state);
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

  /** 深层局部更新（仅用于 feed 与 stats 这类嵌套结构） */
  function patch(key, sub) {
    const prev = state[key];
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

  return { get, set, patch, subscribe, resetSettings, PERSISTED };
}
