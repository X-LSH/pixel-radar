/**
 * Pixel Radar · 雷达扫描
 * ---------------------------------------------------------------
 * 周期 4 秒（规格指定）的扇形扫描，中心固定在**机场**而不是视口中心 ——
 * 这是真实雷达的语义：天线在机场，屏幕可以平移，但波束始终从天线发出。
 *
 * 实现要点：
 *  · 扇形用 conic gradient 一次填充完成（角度方向渐变是它的原生能力），
 *    相比「切 20 层扇形叠加」既快又不会出现层间条纹；
 *  · 不支持 conic gradient 的环境退回分层扇形，视觉几乎一致；
 *  · 「扫到目标时短暂高亮」不做状态记录，而是解析计算：
 *    目标方位与扫描前沿的角差 ÷ 角速度 = 距上次扫过的毫秒数。
 *    无状态意味着换机场、跳帧、时间轴回放都不会出现残留高亮。
 */

import { SWEEP, PAL } from '../config.js';

const TAU = Math.PI * 2;
/** 角度 → canvas 弧度：正北为 -90°，顺时针为正 */
const bearingToCanvas = (deg) => ((deg - 90) * Math.PI) / 180;

export function createSweep() {
  let angleDeg = 0; // 扫描前沿方位角
  let enabled = true;
  let conicSupported = null;

  function supportsConic(ctx) {
    if (conicSupported !== null) return conicSupported;
    conicSupported = typeof ctx.createConicGradient === 'function';
    return conicSupported;
  }

  /** 推进角度 */
  function update(dtMs) {
    if (!enabled) return;
    angleDeg = (angleDeg + (360 / SWEEP.periodMs) * dtMs) % 360;
  }

  /**
   * 目标在最近一次扫过后的余辉强度。
   * @returns {number} 0（已消散）~ 1（刚刚扫过）
   */
  function ping(bearingDeg) {
    if (!enabled) return 0;
    let delta = angleDeg - bearingDeg;
    delta = ((delta % 360) + 360) % 360; // 前沿刚越过目标多少度
    const elapsedMs = (delta / (360 / SWEEP.periodMs));
    if (elapsedMs > SWEEP.pingMs) return 0;
    return 1 - elapsedMs / SWEEP.pingMs;
  }

  function draw(ctx, cx, cy, radius) {
    if (!enabled || radius < 8) return;

    const leadAngle = bearingToCanvas(angleDeg);
    const tailAngle = bearingToCanvas(angleDeg - SWEEP.arcDeg);
    const arcRad = (SWEEP.arcDeg * Math.PI) / 180;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, tailAngle, leadAngle, false);
    ctx.closePath();

    if (supportsConic(ctx)) {
      const g = ctx.createConicGradient(tailAngle, cx, cy);
      const span = arcRad / TAU;
      // 亮度集中在扫描前沿附近：把衰减提前到 70% 处并压低峰值。
      // 峰值过高时，46° 的扇形会变成一整片压在底图上的亮区，
      // 反而削弱了「前沿扫过」这个唯一的动态信号。
      g.addColorStop(0, 'rgba(79,191,79,0)');
      g.addColorStop(span * 0.7, 'rgba(79,191,79,0.055)');
      g.addColorStop(span, 'rgba(143,255,160,0.26)');
      // 扇形之外的部分保持透明（虽然被裁剪掉了，但保证渐变定义完整）
      g.addColorStop(Math.min(0.9999, span + 0.0001), 'rgba(79,191,79,0)');
      g.addColorStop(1, 'rgba(79,191,79,0)');
      ctx.fillStyle = g;
      ctx.fill();
    } else {
      const SEGMENTS = 18;
      for (let i = 0; i < SEGMENTS; i++) {
        const a0 = tailAngle + (arcRad * i) / SEGMENTS;
        const a1 = tailAngle + (arcRad * (i + 1)) / SEGMENTS;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, a0, a1, false);
        ctx.closePath();
        ctx.fillStyle = `rgba(79,191,79,${(0.02 + 0.24 * ((i + 1) / SEGMENTS) ** 2).toFixed(3)})`;
        ctx.fill();
      }
    }
    ctx.restore();

    // 扫描前沿：一条 1px 亮线，是整块屏幕唯一的「动」的强信号。
    // 必须落在半像素上，否则 1px 线会跨两个像素渲染成 2px 半透明，
    // 在整数倍放大后明显发虚。
    ctx.save();
    ctx.strokeStyle = PAL.sweepCore;
    ctx.globalAlpha = 0.62;
    ctx.lineWidth = SWEEP.edgeWidth;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, Math.round(cy) + 0.5);
    ctx.lineTo(
      Math.round(cx + Math.cos(leadAngle) * radius) + 0.5,
      Math.round(cy + Math.sin(leadAngle) * radius) + 0.5,
    );
    ctx.stroke();

    // 前沿根部的一点辉光，让天线位置有「发光体」的感觉
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = PAL.sweepBody;
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  return {
    update,
    draw,
    ping,
    setEnabled: (v) => { enabled = v; },
    isEnabled: () => enabled,
    getAngle: () => angleDeg,
    setAngle: (a) => { angleDeg = ((a % 360) + 360) % 360; },
  };
}
