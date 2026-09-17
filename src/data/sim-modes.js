/**
 * Pixel Radar · 模拟交通的各类行为
 * ---------------------------------------------------------------
 * 从 simulate.js 拆出来的一层：这里只描述「一架飞机怎么飞」，
 * 不关心「什么时候生成、生成多少、什么时候回收」——那是引擎的事。
 *
 * 四种交通模式覆盖雷达屏上应有的全部运动形态：
 *   arrival    进近：从下滑道起点直线进场，按 3° 下滑，落地后滑行离开
 *   departure  离场：跑道滚行 → 抬轮 → 爬升 → 初始转弯
 *   overflight 过境：巡航高度直线穿越，走到远端即消失
 *   holding    盘旋：绕机场做等待航线，模拟进近前的排队
 *
 * 所有几何都取自真实跑道端点坐标，而不是凭空画圆。
 */

import { destination, distKm, bearingDeg, norm360, norm180 } from '../core/geo.js';
import { detectPhase, PHASES } from './phases.js';

const RAD = Math.PI / 180;
/** 标准 3° 下滑道：每海里约 318 英尺 */
export const GLIDESLOPE_FT_PER_NM = 318;

/** 从机场的跑道表里挑一条，并决定从哪一端进近 */
export function pickRunway(rng, airport) {
  if (!airport.runways || !airport.runways.length) return null;
  const rw = rng.pick(airport.runways);
  const fromLe = rng.chance(0.5);
  const thrLat = fromLe ? rw.leLat : rw.heLat;
  const thrLon = fromLe ? rw.leLon : rw.heLon;
  const farLat = fromLe ? rw.heLat : rw.leLat;
  const farLon = fromLe ? rw.heLon : rw.leLon;
  // 进近航向 = 从远端指向近端
  const hdg = bearingDeg(farLat, farLon, thrLat, thrLon);
  return { rw, thrLat, thrLon, hdg };
}

/* ================================================================
 * 共用运动学
 * ================================================================ */

/** 由 track / gs / vs 推进位置与高度，并刷新飞行阶段 */
export function stepKinematics(p, dtSec) {
  if (p.gsKt > 0) {
    const km = (p.gsKt * 1.852 / 3600) * dtSec;
    const next = destination(p.lat, p.lon, p.trackDeg, km);
    p.lat = next.lat;
    p.lon = next.lon;
  }
  if (p.vsFpm !== 0) {
    p.altFt = Math.max(0, p.altFt + (p.vsFpm / 60) * dtSec);
  }
  p.phase = detectPhase(p);
}

/** 朝目标航向转弯（限速率，避免瞬间扭头） */
export function turnToward(p, targetHdg, rateDegPerSec, dtSec) {
  const diff = norm180(targetHdg - p.trackDeg);
  const maxTurn = rateDegPerSec * dtSec;
  p.trackDeg = norm360(p.trackDeg + Math.max(-maxTurn, Math.min(maxTurn, diff)));
}

/* ================================================================
 * 进近
 * ================================================================ */

export function initArrival(rng, airport, plane) {
  const r = pickRunway(rng, airport);
  if (!r) return false;

  const entryNm = rng.range(11, 22);
  const start = destination(r.thrLat, r.thrLon, norm360(r.hdg + 180), entryNm * 1.852);

  plane.lat = start.lat;
  plane.lon = start.lon;
  plane.trackDeg = r.hdg;
  plane.gsKt = entryNm > 15 ? rng.range(230, 268) : rng.range(185, 225);
  plane.altFt = Math.round((airport.elevFt || 0) + entryNm * GLIDESLOPE_FT_PER_NM);
  plane.vsFpm = Math.round(-plane.gsKt * GLIDESLOPE_FT_PER_NM / 60);
  plane.onGround = false;
  plane.phase = PHASES.APPROACH;
  plane.simMode = 'arrival';
  plane.simRef = r;
  plane.simTimer = 0;
  return true;
}

export function stepArrival(p, dtSec, airport) {
  const r = p.simRef;
  const dNm = distKm(p.lat, p.lon, r.thrLat, r.thrLon) / 1.852;
  const elev = airport.elevFt || 0;

  if (dNm < 0.35 || p.altFt <= elev + 20) {
    // —— 接地 ——
    p.altFt = elev;
    p.onGround = true;
    p.vsFpm = 0;
    p.simMode = 'rollout';
    p.trackDeg = r.hdg;
    p.gsKt = Math.min(p.gsKt, 145);
    p.phase = PHASES.GROUND;
    return;
  }

  // 目标高度来自下滑道；垂直速率由高度差反推，得到自然的小幅波动
  const targetAlt = elev + dNm * GLIDESLOPE_FT_PER_NM;
  p.vsFpm = Math.round(Math.max(-2200, Math.min(200, (targetAlt - p.altFt) * 9)));

  // 速度按距跑道口的距离递减
  const targetGs = dNm > 12 ? 250 : dNm > 8 ? 200 : dNm > 4 ? 165 : 142;
  p.gsKt += (targetGs - p.gsKt) * Math.min(1, dtSec * 0.35);

  stepKinematics(p, dtSec);
  p.trackDeg = r.hdg;
}

export function stepRollout(p, dtSec) {
  p.gsKt = Math.max(0, p.gsKt - 140 * dtSec);
  stepKinematics(p, dtSec);
  p.simTimer += dtSec;
  if (p.gsKt < 45) {
    p.phase = PHASES.TAXI;
    p.gsKt = 12; // 滑行速度，慢慢挪出视野
    p.trackDeg = norm360(p.trackDeg + 62);
  }
  // 滑行约 50 秒后离场，为新的航班腾出流量
  return p.simTimer < 50;
}

/* ================================================================
 * 离场
 * ================================================================ */

export function initDeparture(rng, airport, plane) {
  const r = pickRunway(rng, airport);
  if (!r) return false;

  plane.lat = r.thrLat;
  plane.lon = r.thrLon;
  plane.trackDeg = r.hdg;
  plane.altFt = airport.elevFt || 0;
  plane.onGround = true;
  plane.gsKt = rng.range(0, 40);
  plane.vsFpm = 0;
  plane.phase = PHASES.TAXI;
  plane.simMode = 'roll';
  plane.simRef = r;
  plane.simTimer = 0;
  plane.simTargetAlt = Math.round(rng.range(280, 400)) * 100;
  plane.simDepHdg = norm360(r.hdg + (rng.chance(0.5) ? 1 : -1) * rng.range(18, 62));
  return true;
}

export function stepRoll(p, dtSec) {
  p.simTimer += dtSec;
  p.gsKt = Math.min(168, p.gsKt + 155 * dtSec * Math.max(0.35, 1 - p.simTimer / 42));
  stepKinematics(p, dtSec);
  p.trackDeg = p.simRef.hdg;
  if (p.gsKt > 152) {
    p.onGround = false;
    p.simMode = 'climb';
    p.vsFpm = 2400;
    p.phase = PHASES.CLIMB;
  }
  return true;
}

export function stepClimb(p, dtSec, airport) {
  const agl = p.altFt - (airport.elevFt || 0);

  // 初始转弯：1500ft 以上开始转出，转弯率随高度收敛
  if (agl > 1500) {
    turnToward(p, p.simDepHdg, agl < 6000 ? 2.6 : 1.1, dtSec);
  }

  // 爬升率随高度递减（模拟性能受限），接近巡航高度时收敛
  const remain = p.simTargetAlt - p.altFt;
  p.vsFpm = remain < 600
    ? Math.round(Math.max(0, remain * 2.4))
    : Math.round(2650 * Math.max(0.42, 1 - p.altFt / 46000));

  p.gsKt = Math.min(472, p.gsKt + 4.6 * dtSec);
  stepKinematics(p, dtSec);

  if (p.altFt >= p.simTargetAlt - 40) {
    p.altFt = p.simTargetAlt;
    p.vsFpm = 0;
    p.simMode = 'overflight';
    p.simHomeLat = airport.lat;
    p.simHomeLon = airport.lon;
    p.simExitKm = 135; // 已爬升的航班继续飞出视景即回收
  }
  return true;
}

/* ================================================================
 * 过境
 * ================================================================ */

export function initOverflight(rng, airport, plane, radiusKm) {
  const hdg = rng.range(0, 360);
  const offset = rng.range(-0.55, 0.55) * radiusKm;
  // 从圆的随机切线位置进入
  const entry = destination(airport.lat, airport.lon, norm360(hdg + 180), radiusKm * 1.35);
  const side = destination(entry.lat, entry.lon, norm360(hdg + 90), offset);

  plane.lat = side.lat;
  plane.lon = side.lon;
  plane.trackDeg = hdg;
  plane.gsKt = rng.range(410, 505);
  plane.altFt = Math.round(rng.range(290, 410)) * 100;
  plane.vsFpm = 0;
  plane.onGround = false;
  plane.phase = PHASES.CRUISE;
  plane.simMode = 'overflight';
  plane.simHomeLat = airport.lat;
  plane.simHomeLon = airport.lon;
  plane.simExitKm = radiusKm * 1.5;
  return true;
}

export function stepOverflight(p, dtSec) {
  stepKinematics(p, dtSec);
  return distKm(p.lat, p.lon, p.simHomeLat, p.simHomeLon) < p.simExitKm;
}

/* ================================================================
 * 盘旋（等待航线）
 * ================================================================ */

export function initHolding(rng, airport, plane) {
  const bearing = rng.range(0, 360);
  const rangeKm = rng.range(11, 20);
  const center = destination(airport.lat, airport.lon, bearing, rangeKm);

  plane.lat = center.lat;
  plane.lon = center.lon;
  plane.trackDeg = norm360(bearing + 90);
  plane.gsKt = rng.range(198, 228);
  plane.altFt = Math.round((airport.elevFt || 0) + rng.range(4000, 11000));
  plane.vsFpm = 0;
  plane.onGround = false;
  plane.phase = PHASES.CRUISE;
  plane.simMode = 'holding';
  plane.simHoldCenter = center;
  plane.simTimer = 0;
  plane.simLifetime = rng.range(150, 420);
  return true;
}

export function stepHolding(p, dtSec) {
  // 绕以机场为心的圆转圈：航向持续缓慢偏转
  p.trackDeg = norm360(p.trackDeg + 2.15 * dtSec);
  stepKinematics(p, dtSec);
  p.simTimer += dtSec;
  return p.simTimer < p.simLifetime;
}

export { RAD };
