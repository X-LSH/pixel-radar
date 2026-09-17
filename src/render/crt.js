/**
 * Pixel Radar · CRT 效果层
 * ---------------------------------------------------------------
 * 扫描线、暗角、噪点。三者都必须可单独关闭（规格要求），
 * 因为在低端设备上它们是纯粹的负收益。
 *
 * 性能取舍：
 *  · 扫描线与暗角只依赖画布尺寸 → 预渲染成离屏画布，每帧一次 drawImage；
 *  · 噪点必须每帧变化，但逐帧生成 17 万个随机数会直接吃掉主线程。
 *    改为**预生成 6 张噪点瓦片**，每帧平铺并用不同偏移错开，
 *    视觉上是连续闪动的静态噪声，成本是十几次 drawImage。
 */

const NOISE_TILE = 128;
const NOISE_TILES = 6;
/** 噪点每次平铺的偏移候选，用来打破瓦片的规律性 */
const NOISE_OFFSETS = [
  [0, 0], [37, 11], [13, 61], [71, 29], [5, 97], [89, 43],
];

function makeCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

/** 扫描线：每 2 个逻辑像素压暗一行 */
function buildScanlines(w, h) {
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d');
  // 0.13 是实测出来的：再重就会在整数倍放大后形成明显的摩尔纹条带，
  // 整屏看上去像「百叶窗」而不是屏幕。
  ctx.fillStyle = 'rgba(0,0,0,0.13)';
  for (let y = 0; y < h; y += 2) ctx.fillRect(0, y, w, 1);
  return cv;
}

/** 暗角：屏幕四角压暗 + 轻微边缘内阴影 */
function buildVignette(w, h) {
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d');
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.hypot(cx, cy);
  const g = ctx.createRadialGradient(cx, cy, r * 0.46, cx, cy, r);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.74, 'rgba(0,0,0,0.13)');
  g.addColorStop(1, 'rgba(0,0,0,0.44)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  return cv;
}

/**
 * 噪点瓦片。
 * 密度刻意压得很低（约 18% 像素有值，且多数几乎透明）：
 * 噪点是为了让画面「像电子信号」而不是「像 JPEG 压缩瑕疵」，
 * 一旦能在静态截图里一眼看到噪点纹理，就说明加多了。
 */
function buildNoiseTiles() {
  const tiles = [];
  for (let t = 0; t < NOISE_TILES; t++) {
    const cv = makeCanvas(NOISE_TILE, NOISE_TILE);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(NOISE_TILE, NOISE_TILE);
    const d = img.data;
    // xorshift，避免依赖 Math.random 导致每次刷新画面质感不同
    let s = 0x9e3779b9 ^ (t * 0x85ebca6b);
    const rnd = () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
    for (let i = 0; i < d.length; i += 4) {
      const v = rnd();
      if (v > 0.96) {
        // 稀疏亮点：CRT 的高斯噪声尖峰
        d[i] = 140;
        d[i + 1] = 220;
        d[i + 2] = 150;
        d[i + 3] = 10 + Math.floor(rnd() * 20);
      } else if (v > 0.82) {
        d[i] = 90;
        d[i + 1] = 150;
        d[i + 2] = 100;
        d[i + 3] = Math.floor(rnd() * 6);
      } else {
        d[i + 3] = 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    tiles.push(cv);
  }
  return tiles;
}

export function createCrtLayer(w, h) {
  let size = { w, h };
  let scanlines = buildScanlines(w, h);
  let vignette = buildVignette(w, h);
  const noiseTiles = buildNoiseTiles();
  let frame = 0;

  /** 画布尺寸变化时重建（只在分辨率档位或窗口尺寸改变时发生） */
  function resize(nw, nh) {
    if (nw === size.w && nh === size.h) return;
    size = { w: nw, h: nh };
    scanlines = buildScanlines(nw, nh);
    vignette = buildVignette(nw, nh);
  }

  /** 每帧推进噪点序号（按 12fps 推进即可，60fps 换图反而像雪花电视） */
  function tick(dtMs) {
    frame += dtMs * 0.012;
  }

  function draw(ctx, opts = {}) {
    const { w, h } = size;

    if (opts.crt === false) return;

    if (opts.noise !== false) {
      const idx = Math.floor(frame) % noiseTiles.length;
      const tile = noiseTiles[idx];
      const [ox, oy] = NOISE_OFFSETS[Math.floor(frame * 0.7) % NOISE_OFFSETS.length];
      ctx.save();
      // 平铺：起点为负偏移，保证四边都盖满
      for (let y = -oy; y < h; y += NOISE_TILE) {
        for (let x = -ox; x < w; x += NOISE_TILE) {
          ctx.drawImage(tile, x, y);
        }
      }
      ctx.restore();
    }

    if (opts.scanlines !== false) ctx.drawImage(scanlines, 0, 0);
    if (opts.vignette !== false) ctx.drawImage(vignette, 0, 0);
  }

  return { draw, resize, tick, get size() { return size; } };
}

/**
 * 屏幕外发光：把整屏内容以极低透明度放大一点点叠加，
 * 模拟 CRT 的荧光晕散。成本是 1 次 drawImage，收益是「像屏幕」而不是「像 PNG」。
 *
 * 透明度必须很小：它是全屏叠加，0.10 就足以把背景整体提亮一档，
 * 让「深色底 + 高亮目标」的对比关系塌掉。
 */
export function drawBloom(ctx, source, w, h) {
  ctx.save();
  ctx.globalAlpha = 0.055;
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(source, -1, -1, w + 2, h + 2);
  ctx.restore();
}
