/**
 * Pixel Radar · 屏内 HUD
 * ---------------------------------------------------------------
 * 屏幕内只出现 ASCII / 数字 / 箭头的位图文字 —— 这是 CRT 字符发生器的
 * 真实能力边界，也是中文界面文案全部放在 DOM 外壳里的原因。
 * 这样做换来的是：任何分辨率下文字都是硬边像素，永远不会糊。
 *
 * HUD 的信息纪律：屏幕上只保留「驾驶员真需要」的读数 ——
 * 量程、比例尺、源类型、目标数、选中目标标识。
 * 其余全部移到侧栏，否则雷达屏会被信息淹没。
 */

import { PAL } from '../config.js';
import { drawText, drawTextRight, measure, GLYPH_H } from './bitfont.js';
import { PHASES, altText, vsArrow } from '../data/phases.js';

const PAD = 6;
const LINE = GLYPH_H + 3;

/** 比例尺候选（km） */
const SCALE_STEPS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200];

/**
 * 主 HUD
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} o
 */
export function drawHud(ctx, o) {
  const { w, h, proj, airport, feed, sweep, paused, selected, frameCount } = o;
  if (!airport) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  /* ── 左上：机场标识 ── */
  const l1 = `${airport.icao}  ${airport.iata}`;
  drawText(ctx, l1, PAD, PAD, PAL.hud, { shadow: PAL.ink });
  const name = truncate(airport.en, 22);
  drawText(ctx, name, PAD, PAD + LINE, PAL.hudDim, { shadow: PAL.ink });

  /* ── 右上：数据源徽标 + 目标数 ── */
  const src = sourceBadge(feed, frameCount);
  drawTextRight(ctx, src.text, w - PAD, PAD, src.color, { shadow: PAL.ink });
  drawTextRight(ctx, `TGT ${String(frameCount).padStart(3, '0')}`, w - PAD, PAD + LINE, PAL.hudDim, { shadow: PAL.ink });

  /* ── 左下：比例尺 ── */
  drawScaleBar(ctx, proj, PAD, h - PAD - 4);

  /* ── 右下：只放扫描状态 ──
   * 量程已经被「距离环标签 + 侧栏」表达过两次，再在屏角重复第三次
   * 只会增加噪音（实测三个 5KM 文本同框，读起来很乱）。 */
  const stateText = paused ? 'HOLD' : `${String(Math.round(sweep.getAngle())).padStart(3, '0')}DEG`;
  drawTextRight(ctx, stateText, w - PAD, h - PAD - GLYPH_H, paused ? PAL.selected : PAL.hudDim, { shadow: PAL.ink });

  /* ── 暂停时全屏加一层轻压暗，给出明确的「不在跑」信号 ── */
  if (paused) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, 0, w, h);
    drawText(ctx, 'PAUSED', PAD, Math.round(h / 2) - GLYPH_H, PAL.selected, { shadow: PAL.ink });
  }

  /* ── 四边方位（顶部与左侧各标一个 N，避免遮挡） ── */
  drawText(ctx, 'N', Math.round(w / 2) - 2, PAD, PAL.compass, { shadow: PAL.ink });
  drawText(ctx, 'E', w - PAD - measure('E'), Math.round(h / 2) - 3, PAL.compass, { shadow: PAL.ink });
  drawText(ctx, 'S', Math.round(w / 2) - 2, h - PAD - GLYPH_H, PAL.compass, { shadow: PAL.ink });
  drawText(ctx, 'W', PAD, Math.round(h / 2) - 3, PAL.compass, { shadow: PAL.ink });

  /* ── 选中目标：屏幕四角聚焦框 ── */
  if (selected) {
    drawFocusCorners(ctx, w, h, PAL.selected);
  }

  ctx.restore();
}

/** 数据源徽标 */
function sourceBadge(feed, count) {
  if (feed.state === 'simulation') return { text: 'SIMULATED', color: PAL.selected };
  if (feed.state === 'snapshot') return { text: 'SNAPSHOT', color: PAL.hudHot };
  if (feed.state === 'live') return { text: 'LIVE ADS-B', color: PAL.hud };
  if (feed.state === 'down') return { text: 'NO FEED', color: PAL.descent };
  return { text: 'CONNECTING', color: PAL.hudDim };
}

/** 比例尺：一根带端刺的线段 + 公里标注 */
function drawScaleBar(ctx, proj, x, bottomY) {
  const targetPx = 72;
  let step = SCALE_STEPS[0];
  for (const s of SCALE_STEPS) {
    step = s;
    if (s / proj.kmPerPx >= targetPx) break;
  }
  const lenPx = Math.round(step / proj.kmPerPx);
  if (lenPx < 12 || lenPx > 260) return;

  const y = bottomY - 2;
  ctx.strokeStyle = PAL.hudDim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, y + 0.5);
  ctx.lineTo(x + lenPx + 0.5, y + 0.5);
  ctx.moveTo(x + 0.5, y - 3.5);
  ctx.lineTo(x + 0.5, y + 2.5);
  ctx.moveTo(x + lenPx + 0.5, y - 3.5);
  ctx.lineTo(x + lenPx + 0.5, y + 2.5);
  ctx.stroke();

  const label = step >= 1 ? `${step} KM` : `${step * 1000} M`;
  drawText(ctx, label, x, y - GLYPH_H - 2, PAL.hudDim, { shadow: PAL.ink });
}

/** 选中目标时的四角聚焦框 */
function drawFocusCorners(ctx, w, h, color) {
  const m = 3;
  const L = 12;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // 左上
  ctx.moveTo(m + 0.5, m + L); ctx.lineTo(m + 0.5, m + 0.5); ctx.lineTo(m + L, m + 0.5);
  // 右上
  ctx.moveTo(w - m - L, m + 0.5); ctx.lineTo(w - m - 0.5, m + 0.5); ctx.lineTo(w - m - 0.5, m + L);
  // 左下
  ctx.moveTo(m + 0.5, h - m - L); ctx.lineTo(m + 0.5, h - m - 0.5); ctx.lineTo(m + L, h - m - 0.5);
  // 右下
  ctx.moveTo(w - m - L, h - m - 0.5); ctx.lineTo(w - m - 0.5, h - m - 0.5); ctx.lineTo(w - m - 0.5, h - m - L);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/* ================================================================
 * 目标标签
 * ----------------------------------------------------------------
 * 只标注「选中」与「跟随」目标，以及少量高优先级目标 ——
 * 给 200 架飞机全部打标签等于没有标签。
 * ================================================================ */

export function drawPlaneLabels(ctx, frame, proj, opts = {}) {
  if (opts.enabled === false) return;
  const selectedHex = opts.selectedHex;
  const hoverHex = opts.hoverHex;

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  for (const item of frame) {
    const isSel = item.hex === selectedHex || item.hex === hoverHex;
    if (!isSel) continue;
    const p = proj.toPixel(item.lat, item.lon);
    const plane = item.plane;

    const tag = plane.callsign || plane.hex.toUpperCase();
    const alt = altText(plane.altFt, plane.altIsGeom);
    const arrow = vsArrow(plane.vsFpm);
    const line1 = tag;
    const line2 = `${alt}${arrow ? ` ${arrow}` : ''}`;

    // 标签放在目标右上方；靠近右边界时翻到左侧
    const w1 = measure(line1);
    const w2 = measure(line2);
    const boxW = Math.max(w1, w2) + 6;
    const boxH = GLYPH_H * 2 + 7;
    let bx = Math.round(p.x) + 9;
    let by = Math.round(p.y) - boxH - 4;
    const w = opts.w || 480;
    const h = opts.h || 360;
    if (bx + boxW > w - 4) bx = Math.round(p.x) - 9 - boxW;
    if (by < 4) by = Math.round(p.y) + 9;

    // 底板：半透明黑 + 1px 描边，保证任何底图上都读得清
    ctx.fillStyle = 'rgba(4,8,4,0.78)';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeStyle = PAL.selected;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);
    ctx.globalAlpha = 1;

    drawText(ctx, line1, bx + 3, by + 3, PAL.selected);
    drawText(ctx, line2, bx + 3, by + 3 + GLYPH_H + 2, PAL.hud);

    // 引线：从标签指向目标
    ctx.strokeStyle = PAL.selected;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    const ax = bx > p.x ? bx : bx + boxW;
    const ay = by + boxH / 2;
    ctx.moveTo(Math.round(ax) + 0.5, Math.round(ay) + 0.5);
    ctx.lineTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/** 阶段 → 屏内徽标文字（英文，给 CRT 用） */
export function phaseBadge(phase) {
  switch (phase) {
    case PHASES.TAXI: return 'TAXI';
    case PHASES.GROUND: return 'GND';
    case PHASES.CLIMB: return 'CLB';
    case PHASES.CRUISE: return 'CRZ';
    case PHASES.DESCENT: return 'DES';
    case PHASES.APPROACH: return 'APP';
    default: return '---';
  }
}

function truncate(s, n) {
  if (!s) return '';
  const t = String(s).toUpperCase();
  return t.length <= n ? t : `${t.slice(0, n - 1)}\u00b7`;
}
