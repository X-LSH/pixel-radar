/**
 * Pixel Radar · 底图
 * ---------------------------------------------------------------
 * 底图是「静态」的：海岸线、城市建成区、湖泊、公里网格、距离环、跑道。
 * 它只在（机场 / 缩放 / 视口中心移动过多 / 画布尺寸）变化时才重建，
 * 平时每帧只是一次 drawImage。
 *
 * 一个关键工程取舍：底图画得**比视口大一圈**（四周各留 M 边距），
 * 平移时只改变 blit 偏移，不重建。只有当视口中心移出预留边距的一半
 * 才重建 —— 否则拖动地图会每帧重算四五千个投影点，直接掉到个位数帧率。
 *
 * 数据诚实性声明：
 *   · 海岸线 / 建成区 / 湖泊 / 跑道 全部来自真实权威数据；
 *   · 滑行道与停机坪是「由跑道几何派生的示意图形」（见 deriveAprons），
 *     我们并没有真实滑行道数据，因此它只在放大到一定程度时出现，
 *     并且不在界面上伪装成精确设施。
 */

import { PAL, VIEW } from '../config.js';
import { drawText } from './bitfont.js';
import { destination } from '../core/geo.js';

/** 公里网格的候选间距（km），取第一个使像素间距落在可读区间的档位 */
const GRID_STEPS = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250];
const GRID_MIN_PX = 20;
const GRID_MAX_PX = 64;

/** 投影一条扁平 [lon,lat,...] 折线到像素路径 */
function tracePath(ctx, flat, proj) {
  const n = flat.length / 2;
  if (n < 2) return false;
  let started = false;
  for (let i = 0; i < n; i++) {
    const p = proj.toPixel(flat[i * 2 + 1], flat[i * 2]);
    if (!started) {
      ctx.moveTo(p.x, p.y);
      started = true;
    } else {
      ctx.lineTo(p.x, p.y);
    }
  }
  return true;
}

/** 选择网格间距 */
export function pickGridStep(kmPerPx) {
  for (const s of GRID_STEPS) {
    const px = s / kmPerPx;
    if (px >= GRID_MIN_PX) return { step: s, px };
  }
  const last = GRID_STEPS[GRID_STEPS.length - 1];
  return { step: last, px: last / kmPerPx };
}

let urbanTileCache = null;

/**
 * 生成（并缓存）4×4 网点瓦片。
 *
 * 为什么建成区不用实心填充：实心块在城市密集区会变成一整片抢戏的亮绿，
 * 把网格、海岸线、距离环全部压住，屏幕失去焦点（实测 ZBAA 与 KJFK
 * 都被北京/纽约的建成区糊掉了大半屏）。
 * 雷达图表达建成区的传统做法本就是网点/网线，既压住了亮度，
 * 又天然带出像素画的颗粒感，网格还能从孔洞里透出来。
 */
function urbanTile() {
  if (urbanTileCache) return urbanTileCache;
  const tile = document.createElement('canvas');
  tile.width = 4;
  tile.height = 4;
  const c = tile.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.fillStyle = PAL.city;
  // 25% 覆盖率（2 像素栅格点阵）。50% 棋盘实测还是太亮 ——
  // 视觉上仍然是一整块抢戏的绿。25% 下平均亮度只比背景高约 1.8 倍，
  // 读作「这里有建成区」而不会盖住网格与海岸线。
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      if (x % 2 === 0 && y % 2 === 0) c.fillRect(x, y, 1, 1);
    }
  }
  urbanTileCache = tile;
  return tile;
}

/**
 * 建成区的「网点纹理」。
 *
 * 为什么不用实心填充：实心块在城市密集区会变成一整片抢戏的亮绿，
 * 把网格、海岸线、距离环全部压住，屏幕失去焦点（实测 ZBAA 与 KJFK
 * 都被北京/纽约的建成区糊掉了大半屏）。
 * 雷达图表达建成区的传统做法就是网点/网线，既压住了亮度，
 * 又天然带出像素画的颗粒感，而且网格能从孔洞里透出来。
 *
 * 注意：pattern 由具体 context 创建，不能跨 context 缓存 ——
 * 画布尺寸变化时会换新 context，旧 pattern 会随之悬空。
 * 因此只缓存瓦片本身，pattern 每次现建（开销可忽略）。
 */
function urbanPattern(ctx) {
  return ctx.createPattern(urbanTile(), 'repeat');
}

/**
 * 绘制底图。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} o
 * @param {number} o.w 画布宽
 * @param {number} o.h 画布高
 * @param {object} o.proj 已配置好中心与 kmPerPx 的投影（其 cx/cy 为 0）
 * @param {object} o.airport 机场对象
 * @param {object|null} o.shapes 该机场的地理形状
 * @param {number} o.activeRingKm 当前选中的距离环
 */
export function drawBasemap(ctx, o) {
  const { w, h, proj, airport, shapes, activeRingKm } = o;

  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = PAL.bg;
  ctx.fillRect(0, 0, w, h);

  if (shapes) {
    drawLakes(ctx, shapes, proj);
    drawUrban(ctx, shapes, proj);
    drawCoastline(ctx, shapes, proj);
  }
  // 网格压在地物之上：它才是「量程尺」，被建成区盖住就失去意义
  drawGrid(ctx, w, h, proj, airport);
  drawRings(ctx, w, h, proj, activeRingKm);
  drawRunways(ctx, proj, airport);
  drawAirportMark(ctx, proj, airport);
}

/* ----------------------------------------------------------------
 * 公里网格
 * ---------------------------------------------------------------- */
function drawGrid(ctx, w, h, proj, airport) {
  const { step, px } = pickGridStep(proj.kmPerPx);
  if (px < 6) return;

  const cx = proj.cx;
  const cy = proj.cy;
  ctx.strokeStyle = PAL.gridDim;
  ctx.lineWidth = 1;
  ctx.beginPath();

  const nx = Math.ceil(w / px) + 1;
  for (let i = -nx; i <= nx; i++) {
    const x = Math.round(cx + i * px) + 0.5;
    if (x < -1 || x > w + 1) continue;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  const ny = Math.ceil(h / px) + 1;
  for (let i = -ny; i <= ny; i++) {
    const y = Math.round(cy + i * px) + 0.5;
    if (y < -1 || y > h + 1) continue;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
}

/* ----------------------------------------------------------------
 * 面状要素
 * ---------------------------------------------------------------- */

/** 湖泊：实心暗色，读作「水面 = 没有纹理」 */
function drawLakes(ctx, shapes, proj) {
  if (!shapes.LAKES || !shapes.LAKES.length) return;
  ctx.fillStyle = PAL.bgDeep;
  ctx.beginPath();
  for (const ring of shapes.LAKES) {
    if (ring.length < 6) continue;
    tracePath(ctx, ring, proj);
    ctx.closePath();
  }
  ctx.fill();
}

/** 建成区：网点纹理 + 大块加 1px 暗边 */
function drawUrban(ctx, shapes, proj) {
  if (!shapes.URBAN || !shapes.URBAN.length) return;

  const pattern = urbanPattern(ctx);
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.beginPath();
    for (const ring of shapes.URBAN) {
      if (ring.length < 6) continue;
      tracePath(ctx, ring, proj);
      ctx.closePath();
    }
    ctx.fill();
  }

  // 大块建成区补一圈暗淡边界，避免网点边缘「毛」掉
  ctx.strokeStyle = PAL.cityHot;
  ctx.globalAlpha = 0.32;
  ctx.lineWidth = 1;
  for (const ring of shapes.URBAN) {
    if (ring.length < 40) continue;
    ctx.beginPath();
    tracePath(ctx, ring, proj);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawCoastline(ctx, shapes, proj) {
  if (!shapes.COASTLINE || !shapes.COASTLINE.length) return;

  // 水下侧压一层更暗的粗线（读作浅滩），再压 1px 亮线作为岸线本身
  ctx.strokeStyle = PAL.landEdge;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (const line of shapes.COASTLINE) tracePath(ctx, line, proj);
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.strokeStyle = PAL.coast;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const line of shapes.COASTLINE) tracePath(ctx, line, proj);
  ctx.stroke();
}

/* ----------------------------------------------------------------
 * 距离环与方位刻度
 * ---------------------------------------------------------------- */
function drawRings(ctx, w, h, proj, activeRingKm) {
  const cx = proj.cx;
  const cy = proj.cy;

  for (const km of VIEW.rings) {
    const r = km / proj.kmPerPx;
    if (r < 8 || r > Math.hypot(w, h)) continue;
    const active = km === activeRingKm;

    ctx.strokeStyle = active ? PAL.ringHot : PAL.ring;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.round(r) + 0.5, 0, Math.PI * 2);
    ctx.stroke();

    if (active) {
      // 环上打四个方位刻度，增强「量程」的读数感
      ctx.strokeStyle = PAL.compass;
      ctx.beginPath();
      for (let a = 0; a < 360; a += 30) {
        const rad = ((a - 90) * Math.PI) / 180;
        const x0 = cx + Math.cos(rad) * (r - 3);
        const y0 = cy + Math.sin(rad) * (r - 3);
        const x1 = cx + Math.cos(rad) * (r + 3);
        const y1 = cy + Math.sin(rad) * (r + 3);
        ctx.moveTo(Math.round(x0) + 0.5, Math.round(y0) + 0.5);
        ctx.lineTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
      }
      ctx.stroke();

      // 环标签放在 45° 方向（右下），避开中心区域的信息
      const lx = cx + r * Math.SQRT1_2 + 3;
      const ly = cy + r * Math.SQRT1_2 - 5;
      if (lx < w - 40 && ly > 8 && ly < h - 12) {
        drawText(ctx, `${km}KM`, Math.round(lx), Math.round(ly), PAL.compass);
      }
    }
  }

  // 中心十字
  ctx.strokeStyle = PAL.compass;
  ctx.beginPath();
  ctx.moveTo(Math.round(cx) + 0.5, Math.round(cy) - 5);
  ctx.lineTo(Math.round(cx) + 0.5, Math.round(cy) + 5);
  ctx.moveTo(Math.round(cx) - 5, Math.round(cy) + 0.5);
  ctx.lineTo(Math.round(cx) + 5, Math.round(cy) + 0.5);
  ctx.stroke();
}

/* ----------------------------------------------------------------
 * 机场设施
 * ---------------------------------------------------------------- */

/**
 * 由跑道几何派生示意滑行道与停机坪。
 * 明确声明：这不是真实滑行道数据，只是「贴着跑道平行的一条线 +
 * 两端联络道」，用来让机场区域在高缩放下有结构，而不是两条孤线。
 */
function deriveAprons(airport, proj) {
  const out = [];
  for (const rw of airport.runways || []) {
    const offKm = 0.17;
    const a = destination(rw.leLat, rw.leLon, rw.hdg + 90, offKm);
    const b = destination(rw.heLat, rw.heLon, rw.hdg + 90, offKm);
    const pa = proj.toPixel(a.lat, a.lon);
    const pb = proj.toPixel(b.lat, b.lon);
    const ple = proj.toPixel(rw.leLat, rw.leLon);
    const phe = proj.toPixel(rw.heLat, rw.heLon);
    out.push([
      [ple.x, ple.y], [pa.x, pa.y],
      [pb.x, pb.y], [phe.x, phe.y],
    ]);
  }
  return out;
}

function drawRunways(ctx, proj, airport) {
  if (!airport || !airport.runways || !airport.runways.length) return;
  const kmPerPx = proj.kmPerPx;

  // 滑行道只在足够放大时出现（否则会糊成一团）
  if (kmPerPx < 0.16) {
    ctx.strokeStyle = PAL.taxi;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1;
    for (const poly of deriveAprons(airport, proj)) {
      ctx.beginPath();
      poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  for (const rw of airport.runways) {
    const a = proj.toPixel(rw.leLat, rw.leLon);
    const b = proj.toPixel(rw.heLat, rw.heLon);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenPx = Math.hypot(dx, dy);
    if (lenPx < 1.5) continue;

    // 真实道面宽度在多数缩放下不足 1 像素，因此设下限 2px ——
    // 位置与朝向严格真实，只有宽度是夸张过的。
    const realW = (rw.widFt * 0.3048) / 1000 / kmPerPx;
    const wPx = Math.max(2, Math.min(14, realW));

    ctx.strokeStyle = PAL.runway;
    ctx.lineWidth = wPx;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    // 长跑道加一条暗色中线，读作「跑道」而不是「一条线」
    if (lenPx > 14 && wPx >= 3) {
      ctx.strokeStyle = PAL.apron;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
}

function drawAirportMark(ctx, proj, airport) {
  const p = proj.toPixel(airport.lat, airport.lon);
  ctx.strokeStyle = PAL.runwayHot;
  ctx.lineWidth = 1;

  // 机场参考点：方括号形标记。
  // 不再在屏内写机场代码 —— 顶栏 HUD 已经在左上角给出了 ICAO/IATA 与场名，
  // 再在跑道中央叠一遍只会和跑道图形糊在一起。
  const s = 5;
  ctx.beginPath();
  ctx.moveTo(Math.round(p.x) - s, Math.round(p.y) - s + 2);
  ctx.lineTo(Math.round(p.x) - s, Math.round(p.y) - s);
  ctx.lineTo(Math.round(p.x) - s + 2, Math.round(p.y) - s);
  ctx.moveTo(Math.round(p.x) + s - 2, Math.round(p.y) - s);
  ctx.lineTo(Math.round(p.x) + s, Math.round(p.y) - s);
  ctx.lineTo(Math.round(p.x) + s, Math.round(p.y) - s + 2);
  ctx.moveTo(Math.round(p.x) + s, Math.round(p.y) + s - 2);
  ctx.lineTo(Math.round(p.x) + s, Math.round(p.y) + s);
  ctx.lineTo(Math.round(p.x) + s - 2, Math.round(p.y) + s);
  ctx.moveTo(Math.round(p.x) - s + 2, Math.round(p.y) + s);
  ctx.lineTo(Math.round(p.x) - s, Math.round(p.y) + s);
  ctx.lineTo(Math.round(p.x) - s, Math.round(p.y) + s - 2);
  ctx.stroke();
}
