/**
 * Pixel Radar · 舞台
 * ---------------------------------------------------------------
 * 负责三件事：
 *   1. **逻辑分辨率与整数倍放大** —— 锁定整数像素尺寸，反推逻辑分辨率，
 *      再用 CSS 放大到视口。任意宽高比都能铺满，且永远没有半像素。
 *   2. **视口数学** —— 投影中心固定在机场（保证距离环是真圆），
 *      平移体现为「视口中心相对机场的公里偏移」，缩放锚定在光标处。
 *   3. **逐帧合成** —— 底图 / 尾迹 / 扫描 / 目标 / 辉光 / 标签 / HUD / CRT。
 *
 * 底图缓存策略见 basemap.js 顶部注释；这里是它的调度方。
 */

import { RES, VIEW, PAL, PERF, CLAMP } from '../config.js';
import { Projection } from '../core/geo.js';
import { drawBasemap } from './basemap.js';
import { createSweep } from './sweep.js';
import { drawTrails } from './trails.js';
import { drawPlanes, pickAt } from './planes.js';
import { drawHud, drawPlaneLabels } from './hud.js';
import { createCrtLayer, drawBloom } from './crt.js';
import { createSpriteLibrary } from './sprites.js';

/** 底图四周预留的边距（相对视口短边的比例） */
const BMAP_MARGIN_RATIO = 0.4;
/** 视口中心偏离底图中心超过边距的这个比例就重建 */
const BMAP_REBUILD_RATIO = 0.45;
/** 地景数据的裁剪半径（度）。由 setAirport 注入，用于限制平移范围。 */
const DEFAULT_CLIP_DEG = 1.6;
/** 每度纬度的公里数（与 geo.js 保持一致，此处只需量级正确） */
const KM_PER_DEG = 111.132;

function makeCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

export function createStage({ canvas, settings }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const proj = new Projection(0, 0);
  const sprites = createSpriteLibrary();
  const sweep = createSweep();

  /** 逻辑分辨率 */
  let W = 480;
  let H = 360;
  let scale = 3;

  /** 视口中心相对机场的偏移（km，X 东 / Y 北） */
  let panKm = { x: 0, y: 0 };
  let kmPerPx = 0.35;
  let ringKm = VIEW.defaultRing;
  let zoomIndex = VIEW.defaultZoomIndex;

  /** 机场像素锚点（机场在屏幕上的位置） */
  let anchorX = W / 2;
  let anchorY = H / 2;

  let airport = null;
  let shapes = null;
  /** 当前机场地景数据的裁剪半径（度），决定可平移范围 */
  let clipDeg = DEFAULT_CLIP_DEG;

  /** 底图缓存 */
  let bmap = null;
  let crt = createCrtLayer(W, H);

  /* ------------------------------------------------------------
   * 分辨率
   * ------------------------------------------------------------ */
  function computeScale(cssW, cssH) {
    if (settings.scale) return settings.scale;
    const raw = Math.min(cssW / RES.refW, cssH / RES.refH);
    return CLAMP(Math.round(raw), RES.minScale, RES.maxScale);
  }

  function resize(cssW, cssH) {
    let s = computeScale(cssW, cssH);
    let w = Math.ceil(cssW / s);
    let h = Math.ceil(cssH / s);

    // 逻辑像素总量护栏：超大屏上宁可放大像素，也不要撑爆内存
    while (w * h > RES.maxLogicalPixels && s < RES.maxScale) {
      s++;
      w = Math.ceil(cssW / s);
      h = Math.ceil(cssH / s);
    }

    const changed = w !== W || h !== H || s !== scale;
    if (!changed) return false;

    W = w;
    H = h;
    scale = s;
    canvas.width = W;
    canvas.height = H;
    // 用 ceil 保证 canvas 至少覆盖视口，多出的不到 1 个像素由父容器裁掉
    canvas.style.width = `${W * scale}px`;
    canvas.style.height = `${H * scale}px`;
    ctx.imageSmoothingEnabled = false;

    crt.resize(W, H);
    invalidateBasemap();
    applyView();
    return true;
  }

  /* ------------------------------------------------------------
   * 视口
   * ------------------------------------------------------------ */
  function baseKmPerPx() {
    const shortSide = Math.min(W, H);
    return ringKm / Math.max(20, (shortSide / 2) * VIEW.fitFill);
  }

  function applyView() {
    const mult = VIEW.zoomMults[CLAMP(zoomIndex, 0, VIEW.zoomMults.length - 1)];
    kmPerPx = CLAMP(baseKmPerPx() / mult, VIEW.minKmPerPx, VIEW.maxKmPerPx);

    // 平移上限由「地景数据的覆盖范围」反推，而不是拍一个固定值：
    // 让视口最远角始终落在有数据的那块地里，用户就不会拖到一片空白。
    // 缩小量程时视口变大，可平移距离随之收窄，这是正确行为。
    const viewRadiusKm = Math.hypot(W / 2, H / 2) * kmPerPx;
    const maxPanKm = Math.max(0, clipDeg * KM_PER_DEG - viewRadiusKm - 4);
    panKm.x = CLAMP(panKm.x, -maxPanKm, maxPanKm);
    panKm.y = CLAMP(panKm.y, -maxPanKm, maxPanKm);

    anchorX = W / 2 - panKm.x / kmPerPx;
    anchorY = H / 2 + panKm.y / kmPerPx;

    proj.setView(anchorX, anchorY, kmPerPx);
    if (airport) proj.setCenter(airport.lat, airport.lon);
  }

  function resetView() {
    panKm = { x: 0, y: 0 };
    zoomIndex = VIEW.defaultZoomIndex;
    applyView();
    invalidateBasemap();
  }

  function setRing(km) {
    ringKm = km;
    applyView();
    invalidateBasemap();
  }

  function zoomTo(index, anchorPx) {
    const prevKmPerPx = kmPerPx;
    const nextIndex = CLAMP(index, 0, VIEW.zoomMults.length - 1);
    if (nextIndex === zoomIndex) return;

    if (anchorPx) {
      // 保持光标下的地理点不动：先算出它相对机场的公里偏移，再反解新的平移量
      const offX = (anchorPx.x - anchorX) * prevKmPerPx;
      const offY = -(anchorPx.y - anchorY) * prevKmPerPx;
      zoomIndex = nextIndex;
      applyView();
      const newAnchorX = anchorPx.x - offX / kmPerPx;
      const newAnchorY = anchorPx.y + offY / kmPerPx;
      panKm.x = (W / 2 - newAnchorX) * kmPerPx;
      panKm.y = (newAnchorY - H / 2) * kmPerPx;
      applyView();
    } else {
      zoomIndex = nextIndex;
      applyView();
    }
    invalidateBasemap();
  }

  function panBy(dxPx, dyPx) {
    panKm.x -= dxPx * kmPerPx;
    panKm.y += dyPx * kmPerPx;
    applyView();
  }

  /* ------------------------------------------------------------
   * 底图缓存
   * ------------------------------------------------------------ */
  function invalidateBasemap() {
    bmap = null;
  }

  function ensureBasemap() {
    if (!airport || !shapes) return;
    const M = Math.round(Math.min(W, H) * BMAP_MARGIN_RATIO);
    const bw = W + M * 2;
    const bh = H + M * 2;

    if (bmap
      && bmap.kmPerPx === kmPerPx
      && bmap.w === bw && bmap.h === bh
      && Math.abs(anchorX - bmap.anchorX) < M * BMAP_REBUILD_RATIO
      && Math.abs(anchorY - bmap.anchorY) < M * BMAP_REBUILD_RATIO) {
      return;
    }

    const cv = bmap && bmap.w === bw && bmap.h === bh ? bmap.cv : makeCanvas(bw, bh);
    const bctx = cv.getContext('2d', { alpha: false });
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, bw, bh);

    // 底图使用同一套投影，只是把锚点平移 (M, M) 并冻结在本次构建时的锚点上
    const saveCx = proj.cx;
    const saveCy = proj.cy;
    proj.setView(anchorX + M, anchorY + M, kmPerPx);
    drawBasemap(bctx, { w: bw, h: bh, proj, airport, shapes, activeRingKm: ringKm });
    proj.setView(saveCx, saveCy, kmPerPx);

    bmap = { cv, w: bw, h: bh, anchorX, anchorY, kmPerPx, margin: M };
  }

  /* ------------------------------------------------------------
   * 渲染
   * ------------------------------------------------------------ */

  /**
   * @param {Array} frame tracker 输出
   * @param {object} o { now, dtMs, feed, selectedHex, hoverHex, paused }
   */
  function render(frame, o = {}) {
    if (!airport) return;
    ensureBasemap();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;

    /* 1) 底图 */
    if (bmap) {
      const dx = Math.round(anchorX - bmap.anchorX) - bmap.margin;
      const dy = Math.round(anchorY - bmap.anchorY) - bmap.margin;
      ctx.drawImage(bmap.cv, dx, dy);
    } else {
      ctx.fillStyle = PAL.bg;
      ctx.fillRect(0, 0, W, H);
    }

    /* 2) 尾迹 */
    drawTrails(ctx, frame, proj, {
      enabled: settings.trailsOn,
      maxPlanes: PERF.trailCutoff,
    });

    /* 3) 雷达扫描（中心在天线，即机场位置） */
    sweep.setEnabled(settings.sweepOn && !o.paused);
    // 推进扫描角。这一步必须在这里发生 —— 漏掉它就得到一块永远停在
    // 000 度的「死屏」，而且数值化的画面断言（只数亮像素）抓不到，
    // 只有真去看渲染结果才会发现。暂停时 sweep 已被 disable，不会推进。
    sweep.update(o.dtMs || 0);
    const radius = Math.hypot(
      Math.max(anchorX, W - anchorX),
      Math.max(anchorY, H - anchorY),
    ) + 8;
    sweep.draw(ctx, anchorX, anchorY, radius);

    /* 4) 目标 */
    drawPlanes(ctx, frame, proj, sprites, {
      w: W,
      h: H,
      sweep,
      airport,
      selectedHex: o.selectedHex,
      hoverHex: o.hoverHex,
    });

    /* 5) 荧光晕散：只作用于发光内容，HUD 保持锐利 */
    if (settings.crt) drawBloom(ctx, canvas, W, H);

    /* 6) 标签 */
    drawPlaneLabels(ctx, frame, proj, {
      enabled: settings.labelsOn,
      selectedHex: o.selectedHex,
      hoverHex: o.hoverHex,
      w: W,
      h: H,
    });

    /* 7) HUD */
    drawHud(ctx, {
      w: W, h: H, proj, airport,
      feed: o.feed,
      sweep,
      paused: o.paused,
      ringKm,
      selected: o.selectedHex,
      frameCount: frame.length,
    });

    /* 8) CRT */
    crt.draw(ctx, {
      crt: settings.crt,
      scanlines: settings.scanlines,
      vignette: settings.vignette,
      noise: settings.noise,
    });
  }

  /* ------------------------------------------------------------
   * 对外
   * ------------------------------------------------------------ */
  function setAirport(nextAirport, nextShapes, nextClipDeg) {
    airport = nextAirport;
    shapes = nextShapes;
    clipDeg = Number.isFinite(nextClipDeg) ? nextClipDeg : DEFAULT_CLIP_DEG;
    proj.setCenter(airport.lat, airport.lon);
    panKm = { x: 0, y: 0 };
    applyView();
    invalidateBasemap();
  }

  function pick(px, py, frame, radius) {
    return pickAt(frame, proj, px, py, radius);
  }

  /** 屏幕坐标 → 相对机场的公里偏移（供跟随、拾取调试使用） */
  function screenToOffsetKm(px, py) {
    return {
      x: (px - anchorX) * kmPerPx,
      y: -(py - anchorY) * kmPerPx,
    };
  }

  /** 把视口中心移动到某个经纬度（跟随模式用） */
  function centerOn(lat, lon, smooth = true) {
    if (!airport) return;
    const km = proj.project(lat, lon);
    const target = { x: km.x, y: km.y };
    if (!smooth) {
      panKm = target;
      applyView();
      return;
    }
    // 指数趋近：跟随目标时避免镜头硬切
    panKm.x += (target.x - panKm.x) * 0.14;
    panKm.y += (target.y - panKm.y) * 0.14;
    applyView();
  }

  return {
    resize,
    render,
    setAirport,
    resetView,
    setRing,
    zoomTo,
    panBy,
    pick,
    centerOn,
    invalidateBasemap,
    get proj() { return proj; },
    get sweep() { return sweep; },
    get sprites() { return sprites; },
    get resolution() { return { w: W, h: H, scale }; },
    get view() {
      return {
        kmPerPx, ringKm, zoomIndex, anchorX, anchorY,
        panKm: { ...panKm },
        zoomMult: VIEW.zoomMults[zoomIndex],
      };
    },
    get basemapInfo() {
      return bmap ? { w: bmap.w, h: bmap.h, margin: bmap.margin, rebuilt: true } : null;
    },
  };
}
