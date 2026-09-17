/**
 * Pixel Radar · 模拟航班引擎
 * ---------------------------------------------------------------
 * 职责：在没有可用真实数据时，生成一片「看不出是假」的空域。
 *
 * 分工：本文件只管**生成多少、什么时候生成、什么时候回收**；
 * 「一架飞机具体怎么飞」在 sim-modes.js 里。
 *
 * 设计要点：
 *  1. **确定性**：种子 = 机场 ICAO。同一个机场每次打开画面一致，
 *     换走再换回来不会变成一片陌生空域。绝不用 Math.random。
 *  2. **真实跑道驱动**：进近航向、下滑道起点、离场爬升都取自
 *     OurAirports 的真实跑道端点坐标。
 *  3. 输出的对象结构与真实数据的归一化结果完全一致，下游无需分支。
 */

import { makeRng } from '../core/rng.js';
import { PHASES } from './phases.js';
import { classifyType } from './normalize.js';
import {
  initArrival, stepArrival, stepRollout,
  initDeparture, stepRoll, stepClimb,
  initOverflight, stepOverflight,
  initHolding, stepHolding,
} from './sim-modes.js';

/* ================================================================
 * 承运人池（按区域）
 * ----------------------------------------------------------------
 * 不必覆盖全球航司 —— 只要保证「点开某个机场，看到的呼号像是那里该有的」。
 * ---------------------------------------------------------------- */
const AIRLINE_POOLS = {
  cn: ['CCA', 'CES', 'CSN', 'CHH', 'CSZ', 'CQH', 'CXA', 'CDG', 'CSH', 'DKH', 'CUA', 'GCR', 'HXA', 'LKE', 'CDC'],
  hk: ['CPA', 'HDA', 'CRK', 'CCA', 'CES', 'CSN', 'CSZ'],
  jp: ['ANA', 'JAL', 'APJ', 'SKY', 'JJP', 'CCA', 'CES', 'KAL'],
  kr: ['KAL', 'AAR', 'JJA', 'TWB', 'ESR', 'ANA', 'CCA'],
  sg: ['SIA', 'SLK', 'AXM', 'MAS', 'THA', 'CPA', 'UAE'],
  ae: ['UAE', 'ETD', 'QTR', 'SVA', 'GFA', 'KAC', 'BAW', 'DLH'],
  uk: ['BAW', 'EZY', 'VIR', 'RYR', 'AFR', 'KLM', 'DLH', 'AAL', 'DAL', 'UAL'],
  fr: ['AFR', 'EZY', 'RYR', 'DLH', 'BAW', 'KLM', 'IBE', 'ITY'],
  de: ['DLH', 'EWG', 'CLH', 'AFR', 'KLM', 'SWR', 'AUA', 'BAW', 'THY'],
  us: ['AAL', 'DAL', 'UAL', 'SWA', 'JBU', 'ASA', 'NKS', 'SKW', 'ENY', 'RPA', 'FDX', 'UPS', 'ACA'],
  au: ['QFA', 'JST', 'VOZ', 'QLK', 'SIA', 'UAE', 'ANA'],
};

const REGION_OF = {
  ZBAA: 'cn', ZSPD: 'cn', ZGGG: 'cn', ZGSZ: 'cn', ZUUU: 'cn',
  VHHH: 'hk', RJAA: 'jp', RJTT: 'jp', RKSI: 'kr', WSSS: 'sg',
  OMDB: 'ae', EGLL: 'uk', LFPG: 'fr', EDDF: 'de',
  KJFK: 'us', KLAX: 'us', KSFO: 'us', KSEA: 'us',
  YSSY: 'au', YMML: 'au',
};

/** 各机型分类的候选机型代码（用于生成真实感的 t 字段） */
const TYPES = {
  wide: ['B77W', 'B789', 'A359', 'A333', 'B744', 'A388', 'B78X', 'A35K'],
  narrow: ['A320', 'A321', 'B738', 'A319', 'B739', 'A20N', 'A21N', 'B38M'],
  prop: ['AT76', 'DH8D', 'C208', 'PC12', 'SF34'],
  heli: ['EC35', 'H60', 'R44', 'B407'],
};

/** 按机场规模决定目标流量（架次），让大枢纽更繁忙 */
const BUSY = {
  ZBAA: 34, ZSPD: 32, ZGGG: 30, ZGSZ: 26, ZUUU: 22,
  VHHH: 30, RJAA: 28, RJTT: 32, RKSI: 28, WSSS: 28,
  OMDB: 32, EGLL: 34, LFPG: 32, EDDF: 32,
  KJFK: 34, KLAX: 32, KSFO: 28, KSEA: 22,
  YSSY: 26, YMML: 24,
};

/* ================================================================
 * 身份与初始状态
 * ================================================================ */

let uidCounter = 0;

function makeIdent(rng, pool) {
  const airline = pool[Math.floor(rng.next() * pool.length)];
  const num = rng.int(1, 4999);
  const suffix = rng.chance(0.06) ? String.fromCharCode(65 + rng.int(0, 25)) : '';
  const callsign = `${airline}${num}${suffix}`;
  const hex = Array.from({ length: 6 }, () => '0123456789abcdef'[rng.int(0, 15)]).join('');
  // 22% 宽体、其余多为窄体、少量螺旋桨，与真实枢纽的构成大致相当
  const typeCode = rng.pick(TYPES[rng.chance(0.22) ? 'wide' : rng.chance(0.88) ? 'narrow' : 'prop']);
  return { callsign, hex, typeCode, typeClass: classifyType(typeCode) };
}

function basePlane(ident, airport) {
  return {
    hex: ident.hex,
    callsign: ident.callsign,
    registration: null,
    typeCode: ident.typeCode,
    typeClass: ident.typeClass,
    category: null,
    lat: airport.lat,
    lon: airport.lon,
    altFt: airport.elevFt || 0,
    altIsGeom: false,
    onGround: true,
    gsKt: 0,
    trackDeg: 0,
    vsFpm: 0,
    has: { alt: true, gs: true, track: true, vs: true },
    phase: PHASES.TAXI,
    source: 'simulation',
    sim: true,
    simId: ++uidCounter,
  };
}

/* ================================================================
 * 引擎
 * ================================================================ */

/** 各交通模式的混合比例 */
const MIX = [
  { mode: 'arrival', weight: 0.26 },
  { mode: 'departure', weight: 0.24 },
  { mode: 'overflight', weight: 0.34 },
  { mode: 'holding', weight: 0.16 },
];

export function createSimulator(airport, opts = {}) {
  const rng = makeRng(`pixel-radar/sim/${airport.icao}`);
  const pool = AIRLINE_POOLS[REGION_OF[airport.icao] || 'cn'];
  const target = opts.target || BUSY[airport.icao] || 20;
  /** 视景半径（km）：过境航班以它为尺度进入与退出 */
  const radius = opts.radiusKm || 90;

  /** @type {Map<string, object>} */
  const planes = new Map();
  let spawnCooldown = 0;

  function pickMode() {
    let r = rng.next();
    for (const m of MIX) {
      r -= m.weight;
      if (r <= 0) return m.mode;
    }
    return 'overflight';
  }

  function spawn(mode) {
    const ident = makeIdent(rng, pool);
    // 避免同呼号同时出现在屏上
    for (const p of planes.values()) if (p.callsign === ident.callsign) return null;

    const plane = basePlane(ident, airport);
    const ok = mode === 'arrival' ? initArrival(rng, airport, plane)
      : mode === 'departure' ? initDeparture(rng, airport, plane)
        : mode === 'holding' ? initHolding(rng, airport, plane)
          : initOverflight(rng, airport, plane, radius);
    if (!ok) return null;
    planes.set(plane.hex, plane);
    return plane;
  }

  /** 单步推进（按 simMode 分派） */
  function advance(p, dt) {
    switch (p.simMode) {
      case 'arrival': stepArrival(p, dt, airport); return true;
      case 'rollout': return stepRollout(p, dt);
      case 'roll': return stepRoll(p, dt, airport);
      case 'climb': return stepClimb(p, dt, airport);
      case 'overflight': return stepOverflight(p, dt);
      case 'holding': return stepHolding(p, dt);
      default: return false;
    }
  }

  /**
   * 把一段时间切成小步推进。
   * 必须切片：单步 dt 过大时转弯限速率、减速曲线都会失真，
   * 位置也会一帧跨越几十公里（视觉上就是瞬移）。
   */
  function advanceSpan(p, seconds) {
    let remaining = seconds;
    const STEP_MAX = 0.4;
    while (remaining > 0 && p.simMode) {
      const dt = Math.min(STEP_MAX, remaining);
      remaining -= dt;
      if (!advance(p, dt)) return false;
    }
    return true;
  }

  /** 初始填充：让首屏立即有货，而不是从空屏慢慢长出来 */
  function seed() {
    for (let i = 0; i < target; i++) {
      const mode = pickMode();
      const p = spawn(mode);
      if (!p) continue;
      // 把初始航班推到各自行程的中段，画面立刻「有纵深」
      const skip = rng.range(0, 0.55);
      if (skip > 0) {
        const horizon = p.simMode === 'holding' ? p.simLifetime : 90;
        advanceSpan(p, horizon * skip);
      }
    }
  }

  function update(dtSec) {
    // 标签页切回来的 dt 可能高达几十秒，上限截断避免追帧雪崩
    const span = Math.min(dtSec, 3);
    for (const [hex, p] of planes) {
      if (!advanceSpan(p, span)) planes.delete(hex);
    }

    // —— 流量维持 ——
    spawnCooldown -= span;
    if (planes.size < target && spawnCooldown <= 0) {
      // 一次最多补 2 架，避免堆积后突然「炸出」一群
      const need = Math.min(2, target - planes.size);
      for (let i = 0; i < need; i++) spawn(pickMode());
      spawnCooldown = Math.max(0.6, 2.4 - (planes.size / target) * 1.6);
    }
  }

  function reset() {
    planes.clear();
    seed();
  }

  seed();

  return {
    planes,
    update,
    reset,
    /** 供自检使用 */
    stats: () => ({
      count: planes.size,
      target,
      modes: [...planes.values()].reduce((acc, p) => {
        acc[p.simMode] = (acc[p.simMode] || 0) + 1;
        return acc;
      }, {}),
    }),
  };
}

/** 机场 → 承运人区域，供自检与调试使用 */
export { REGION_OF as SIM_REGIONS };
