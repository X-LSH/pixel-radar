/**
 * Pixel Radar · 目标绘制
 * ---------------------------------------------------------------
 * 逐帧工作，所以每一步都要为「500 架目标」负责：
 *  · 视口外先剔除，再谈绘制；
 *  · 精灵查表 + 一次 drawImage，没有任何逐帧几何变换；
 *  · 扫描高亮复用同一张精灵（惰性着色的亮色版本），不新建图形。
 *
 * 视觉语义（对应规格配色）：
 *   空中   → 绿，随高度分三档（低空亮、高空暗偏青）
 *   地面   → 灰
 *   下降   → 红；上升 → 青
 *   选中   → 琥珀
 * 非绿颜色只承担真实状态语义，不做装饰。
 */

import { PAL, PERF } from '../config.js';
import { phaseColorKey, isAirborne } from '../data/phases.js';
import { bearingDeg } from '../core/geo.js';

const MARGIN = 14;

/** 调色板键 → 实际颜色 */
function colorOf(key) {
  return PAL[key] || PAL.altMid;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} frame tracker.frame() 输出
 * @param {object} proj
 * @param {object} sprites createSpriteLibrary() 的返回值
 * @param {object} o
 */
export function drawPlanes(ctx, frame, proj, sprites, o = {}) {
  const { w, h, sweep, selectedHex, hoverHex, airport } = o;
  const showTrend = o.trend !== false;

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  for (const item of frame) {
    const p = proj.toPixel(item.lat, item.lon);
    if (p.x < -MARGIN || p.y < -MARGIN || p.x > w + MARGIN || p.y > h + MARGIN) continue;

    const plane = item.plane;
    const isSel = item.hex === selectedHex;
    const isHover = item.hex === hoverHex;

    // —— 基色 ——
    let key = phaseColorKey(plane.phase, plane.altFt);
    if (plane.typeClass === 'unknown' && !plane.onGround && key.startsWith('alt')) key = 'unknown';
    let color = colorOf(key);
    if (isSel) color = PAL.selected;

    const dir = sprites.dirOf(plane.trackDeg || 0);
    const off = sprites.OFFSET || 7;
    const x = Math.round(p.x) - off;
    const y = Math.round(p.y) - off;

    // —— 扫描余辉：被波束扫过短暂提亮 ——
    let pingAlpha = 0;
    if (sweep && sweep.isEnabled() && airport) {
      const brg = bearingDeg(airport.lat, airport.lon, item.lat, item.lon);
      pingAlpha = sweep.ping(brg);
    }
    if (pingAlpha > 0.02) {
      ctx.globalAlpha = Math.min(1, pingAlpha * 0.95);
      ctx.drawImage(sprites.get(plane.typeClass, dir, PAL.hudHot), x, y);
      ctx.globalAlpha = 1;
    }

    // —— 本体 ——
    // 陈旧目标（本轮未观测到）降低不透明度，而不是画成另一种颜色：
    // 颜色已经被状态语义占满了，再加一层视觉编码只会更难读。
    if (item.stale) ctx.globalAlpha = 0.42;
    ctx.drawImage(sprites.get(plane.typeClass, dir, color), x, y);
    ctx.globalAlpha = 1;

    // —— 垂直趋势箭头：显著升降时在目标下方加一个 3×4 象形 ——
    if (showTrend && !plane.onGround && Math.abs(plane.vsFpm) > 500) {
      const up = plane.vsFpm > 0;
      const ax = Math.round(p.x) - 1;
      const ay = Math.round(p.y) + off + 1;
      ctx.fillStyle = up ? PAL.climb : PAL.descent;
      if (up) {
        ctx.fillRect(ax, ay + 2, 3, 1);
        ctx.fillRect(ax + 1, ay + 1, 1, 1);
      } else {
        ctx.fillRect(ax, ay, 3, 1);
        ctx.fillRect(ax + 1, ay + 1, 1, 1);
      }
    }

    // —— 选中 / 悬停标记 ——
    if (isSel || isHover) {
      ctx.strokeStyle = isSel ? PAL.selected : PAL.hudHot;
      ctx.globalAlpha = isSel ? 0.9 : 0.5;
      ctx.lineWidth = 1;
      const r = 9;
      const cx = Math.round(p.x) + 0.5;
      const cy = Math.round(p.y) + 0.5;
      ctx.beginPath();
      // 四段弧，留出缺口，避免与目标本体糊在一起
      for (let q = 0; q < 4; q++) {
        const a0 = q * (Math.PI / 2) + 0.38;
        const a1 = (q + 1) * (Math.PI / 2) - 0.38;
        ctx.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
        ctx.arc(cx, cy, r, a0, a1, false);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      if (isSel) {
        // 跟随目标（规格：双击锁定）用外圈短横表示「已锁定」
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  ctx.restore();
}

/**
 * 命中测试：找到距离 (px,py) 最近且在半径内的目标。
 * 用「屏幕距离」而不是「世界距离」—— 用户点的是屏幕上的东西。
 */
export function pickAt(frame, proj, px, py, radius = 14) {
  let best = null;
  let bestD = radius * radius;
  for (const item of frame) {
    const p = proj.toPixel(item.lat, item.lon);
    const dx = p.x - px;
    const dy = p.y - py;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = item;
    }
  }
  return best;
}

/**
 * 硬护栏：目标数超过上限时，按「距机场由近及远」保留前 limit 个。
 *
 * 为什么要有：`PERF.hardCutoff` 的注释承诺了这条降级路径，而中继模式下
 * 请求半径可达 250nm，目标数完全可能冲破 500 —— 届时若没有护栏，
 * 绘制成本会随目标数线性失控。
 *
 * 未超限时返回**原数组**：热路径上不分配、不排序，代价为零。
 * @param {Array} frame tracker.frame() 输出
 * @param {object} proj 局部等距方位投影（中心在机场，故其极径即离机场距离）
 * @param {number} limit 保留上限
 */
export function cullByDistance(frame, proj, limit) {
  if (!limit || frame.length <= limit) return frame;
  const scored = new Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    const p = proj.project(frame[i].lat, frame[i].lon);
    scored[i] = { i, d: p.x * p.x + p.y * p.y };
  }
  scored.sort((a, b) => a.d - b.d);
  const out = new Array(limit);
  for (let k = 0; k < limit; k++) out[k] = frame[scored[k].i];
  return out;
}

/** 统计聚合：架数、空中/地面、最高、最快、最忙航向 */
export function computeStats(frame) {
  let air = 0;
  let ground = 0;
  let topAlt = null;
  let fastestKt = null;
  const hdgBuckets = new Array(8).fill(0);

  for (const item of frame) {
    const pl = item.plane;
    if (isAirborne(pl.phase)) {
      air++;
      if (pl.altFt != null && (topAlt === null || pl.altFt > topAlt)) topAlt = pl.altFt;
    } else {
      ground++;
    }
    if (pl.gsKt != null && (fastestKt === null || pl.gsKt > fastestKt)) fastestKt = pl.gsKt;
    if (!pl.onGround && pl.has && pl.has.track) {
      hdgBuckets[Math.floor((((pl.trackDeg || 0) % 360) + 360) % 360 / 45) % 8]++;
    }
  }

  let busiest = null;
  let maxN = 0;
  for (let i = 0; i < 8; i++) {
    if (hdgBuckets[i] > maxN) {
      maxN = hdgBuckets[i];
      busiest = i * 45;
    }
  }

  return {
    count: frame.length,
    air,
    ground,
    topAlt,
    fastestKt,
    busiestHdg: busiest,
    cullLimit: PERF.hardCutoff,
  };
}
