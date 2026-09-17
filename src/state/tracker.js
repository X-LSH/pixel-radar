/**
 * Pixel Radar · 轨迹追踪器
 * ---------------------------------------------------------------
 * 解决的问题：上游每 5 秒才给一次位置，而屏幕要 60fps 连续运动。
 *
 * 采用「插值 + 外推 + 位置平滑」三段式：
 *
 *   1. **插值（t < tCurr）**：在上一帧与最新观测之间线性推进，
 *      保证位置永远落在真实观测点上，不会累积漂移。
 *   2. **外推（t > tCurr）**：用速度与航向做线性外推，
 *      并设上限 —— 数据断流时目标不能无限飞出去。
 *   3. **平滑**：位置以 τ=0.6s 的指数趋近目标值。
 *      观测落到新点时会产生一次微小修正，直接赋值会看到「抖」，
 *      平滑后视觉上完全连续，而引入的滞后仅约 0.4 逻辑像素。
 *
 * 尾迹按固定间隔采样，与帧率解耦 —— 否则高刷屏会产生更密的尾迹，
 * 同一个空域在两台设备上看起来不一样。
 */

import { TRAIL } from '../config.js';
import { destination, distKm } from '../core/geo.js';

/** 外推上限（秒）：超过这个时长就不再往前推 */
const MAX_EXTRAPOLATE_S = 25;
/** 位置平滑时间常数（秒） */
const TAU = 0.6;
/** 目标消失多久后从追踪器移除（毫秒） */
const DROP_AFTER_MS = 90000;

function entryFor(plane, now) {
  return {
    hex: plane.hex,
    prev: null,
    curr: plane,
    tPrev: now,
    tCurr: now,
    /** 平滑后的位置（经纬度） */
    sx: plane.lat,
    sy: plane.lon,
    salt: plane.altFt == null ? 0 : plane.altFt,
    /** 冷却：首次观测不走平滑，直接落位 */
    seeded: false,
    lastSeen: now,
    lastSample: 0,
    trail: [],
  };
}

export class Tracker {
  constructor(opts = {}) {
    this.sampleMs = opts.sampleMs || TRAIL.sampleMs;
    this.maxPoints = opts.maxPoints || TRAIL.maxPoints;
    /** @type {Map<string, object>} */
    this.entries = new Map();
    this.startedAt = 0;
  }

  reset() {
    this.entries.clear();
    this.startedAt = 0;
  }

  /**
   * 写入一批新观测。
   * @param {Array<object>} planes 归一化后的目标数组
   * @param {number} now 毫秒时间戳
   */
  ingest(planes, now) {
    if (!this.startedAt) this.startedAt = now;
    const seen = new Set();

    for (const p of planes) {
      if (!p || !p.hex) continue;
      seen.add(p.hex);
      let e = this.entries.get(p.hex);

      if (!e) {
        e = entryFor(p, now);
        this.entries.set(p.hex, e);
        continue;
      }

      // 观测序列滚动：prev ← curr，curr ← 新观测
      e.prev = e.curr;
      e.tPrev = e.tCurr;
      e.curr = p;
      e.tCurr = now;
      e.lastSeen = now;
    }

    // —— 淘汰长时间未出现的目标 ——
    for (const [hex, e] of this.entries) {
      if (!seen.has(hex) && now - e.lastSeen > DROP_AFTER_MS) this.entries.delete(hex);
    }
  }

  /** 目标是否在衰减期（本轮未观测到，但仍在保留期内） */
  isStale(e, now) {
    return now - e.lastSeen > this.sampleMs * 2;
  }

  /**
   * 解析出某一时刻的渲染帧。
   * @param {number} now 毫秒时间戳
   * @param {number} dtSec 距上一帧的秒数
   * @returns {Array<object>} 渲染条目 [{ plane, lat, lon, altFt, stale, trail }]
   */
  frame(now, dtSec) {
    // 回收在这里也要做一次，不能只依赖 ingest。
    // 若上游断流，ingest 就再也不会被调用 —— 那样旧目标会永远留在屏幕上
    // 变成「幽灵航班」，标注为陈旧但一直在外推飞行，看起来像数据还在。
    if (this.entries.size) {
      let dead = null;
      for (const [hex, e] of this.entries) {
        if (now - e.lastSeen > DROP_AFTER_MS) (dead || (dead = [])).push(hex);
      }
      if (dead) for (const hex of dead) this.entries.delete(hex);
    }

    const out = [];
    // 指数平滑系数：与帧率无关
    const k = dtSec > 0 ? 1 - Math.exp(-dtSec / TAU) : 1;

    for (const e of this.entries.values()) {
      const p = e.curr;
      if (!p) continue;
      const stale = this.isStale(e, now);

      // —— 1) 计算目标位置 ——
      let tLat = p.lat;
      let tLon = p.lon;
      let tAlt = p.altFt == null ? 0 : p.altFt;

      const span = e.tCurr - e.tPrev;
      const since = now - e.tCurr;

      if (span > 0 && since <= 0) {
        // 插值段：在 prev 与 curr 之间推进
        const a = Math.max(0, Math.min(1, (now - e.tPrev) / span));
        tLat = e.prev.lat + (p.lat - e.prev.lat) * a;
        tLon = e.prev.lon + (p.lon - e.prev.lon) * a;
        const pAlt = e.prev.altFt == null ? 0 : e.prev.altFt;
        tAlt = pAlt + (tAlt - pAlt) * a;
      } else if (since > 0) {
        // 外推段：沿航向按地速前进
        const sec = Math.min(since / 1000, MAX_EXTRAPOLATE_S);
        const gs = p.gsKt || 0;
        if (gs > 0.5) {
          const km = (gs * 1.852 / 3600) * sec;
          const next = destination(p.lat, p.lon, p.trackDeg || 0, km);
          tLat = next.lat;
          tLon = next.lon;
        }
        if (p.vsFpm) tAlt = Math.max(0, tAlt + (p.vsFpm / 60) * sec);
      }

      // —— 2) 平滑趋近 ——
      if (!e.seeded) {
        e.sx = tLat;
        e.sy = tLon;
        e.salt = tAlt;
        e.seeded = true;
      } else {
        e.sx += (tLat - e.sx) * k;
        e.sy += (tLon - e.sy) * k;
        e.salt += (tAlt - e.salt) * k;
      }

      // —— 3) 尾迹采样（按时间间隔，与帧率解耦） ——
      if (now - e.lastSample >= this.sampleMs) {
        e.lastSample = now;
        e.trail.push({ t: now, lat: e.sx, lon: e.sy, alt: e.salt });
        if (e.trail.length > this.maxPoints) e.trail.splice(0, e.trail.length - this.maxPoints);
      }

      out.push({
        plane: p,
        hex: p.hex,
        lat: e.sx,
        lon: e.sy,
        altFt: e.salt,
        stale,
        trail: e.trail,
      });
    }

    return out;
  }

  /** 轨迹点总数（内存与性能自检用） */
  trailPointCount() {
    let n = 0;
    for (const e of this.entries.values()) n += e.trail.length;
    return n;
  }

  size() {
    return this.entries.size;
  }
}

/**
 * 计算某个条目在最大缩放下的位移合理性 —— 自检用。
 * 若上游给出跳变（hex 复用、解析错误），这里能提前发现。
 */
export function looksTeleported(prev, curr, dtMs) {
  if (!prev || !curr) return false;
  const km = distKm(prev.lat, prev.lon, curr.lat, curr.lon);
  const hours = dtMs / 3600000;
  const impliedKt = hours > 0 ? km / 1.852 / hours : 0;
  return impliedKt > 1200; // 民航最高约 600kt，留一倍冗余
}
