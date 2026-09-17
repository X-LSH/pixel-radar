/**
 * Pixel Radar · 尾迹
 * ---------------------------------------------------------------
 * 规格（P1 描述，但雷达屏缺了它就是残缺的，所以 M1 即实装）：
 *   · 每 5 秒记录一个点（由 tracker 负责采样）
 *   · 最多保留 180 点
 *   · 尾迹长度随速度变化（0–20 逻辑像素）
 *   · 尾迹颜色随高度变化（低空亮，高空暗）
 *
 * 渲染时的关键约束：**只画视觉上看得见的那一段**。
 * 轨迹数组可能有上百个点，但屏幕上的尾迹只有 20 像素长，
 * 因此从尾部倒着走，累计像素长度超过上限就停 —— 这把每帧的工作量
 * 从「点数」降到「像素数」，是 500 架目标仍能 60fps 的关键。
 */

import { TRAIL, PAL } from '../config.js';
import { trailColor } from './sprites.js';

/** 速度（节）→ 尾迹长度（逻辑像素） */
export function trailLengthFor(gsKt) {
  const t = Math.max(0, Math.min(1,
    (gsKt - TRAIL.speedLowKt) / (TRAIL.speedHighKt - TRAIL.speedLowKt)));
  return TRAIL.minLen + (TRAIL.maxLen - TRAIL.minLen) * t;
}

/**
 * 绘制全部尾迹。
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} frame tracker.frame() 的输出
 * @param {object} proj 投影
 * @param {{enabled:boolean, maxPlanes:number}} opts
 */
export function drawTrails(ctx, frame, proj, opts = {}) {
  if (opts.enabled === false) return;
  if (frame.length > (opts.maxPlanes || 320)) return;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.lineCap = 'butt';

  for (const item of frame) {
    const trail = item.trail;
    if (!trail || trail.length < 2) continue;
    // 地面目标的轨迹没有意义，只会在地面糊成一团
    if (item.plane.onGround) continue;

    const maxLen = trailLengthFor(item.plane.gsKt || 0);
    if (maxLen < 1) continue;

    // 先把需要的那一段投影成像素，倒序走
    let budget = maxLen;
    let px = null; // 当前点
    let py = null;

    for (let i = trail.length - 1; i >= 0; i--) {
      const node = trail[i];
      const p = proj.toPixel(node.lat, node.lon);

      if (px === null) {
        px = p.x;
        py = p.y;
        continue;
      }

      const segPx = Math.hypot(p.x - px, p.y - py);
      if (segPx <= 0.01) {
        // 采样过密（目标几乎静止），直接吞掉这一节
        px = p.x;
        py = p.y;
        continue;
      }
      if (segPx > budget) {
        // 只画到这里为止：按比例截断，避免尾迹末端出现突然一段长线
        const t = budget / segPx;
        const tx = px + (p.x - px) * t;
        const ty = py + (p.y - py) * t;
        const age = 1 - (maxLen - budget) / maxLen;
        ctx.strokeStyle = withAlpha(trailColor(node.alt), 0.18 + 0.55 * (1 - age));
        ctx.beginPath();
        ctx.moveTo(Math.round(tx) + 0.5, Math.round(ty) + 0.5);
        ctx.lineTo(Math.round(px) + 0.5, Math.round(py) + 0.5);
        ctx.stroke();
        budget = 0;
        break;
      }

      budget -= segPx;
      // 越靠近飞机越亮、越不透明；颜色取该点所记录的高度
      const t = 1 - budget / maxLen;
      const alpha = 0.12 + 0.62 * t;
      ctx.strokeStyle = withAlpha(trailColor(node.alt), alpha);
      ctx.beginPath();
      ctx.moveTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
      ctx.lineTo(Math.round(px) + 0.5, Math.round(py) + 0.5);
      ctx.stroke();

      px = p.x;
      py = p.y;
      if (budget <= 0) break;
    }
  }

  ctx.restore();
}

/** #rrggbb + alpha → rgba() */
function withAlpha(hex, a) {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/** 尾迹点总数（自检用） */
export function trailStats(frame) {
  let points = 0;
  let planes = 0;
  for (const it of frame) {
    if (it.trail && it.trail.length > 1) {
      points += it.trail.length;
      planes++;
    }
  }
  return { points, planes, avgPoints: planes ? points / planes : 0 };
}

export { PAL };
