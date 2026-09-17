/**
 * Pixel Radar · 飞机精灵
 * ---------------------------------------------------------------
 * 规格要求「预渲染 16 个方向，避免每帧旋转模糊」。这里完全照做：
 * 在初始化时把 5 种机型剪影按 16 个方位重采样成小位图，
 * 运行期只做一次 drawImage，不做任何几何变换。
 *
 * 为什么必须预渲染而不是每帧 rotate()：
 *   canvas 的 rotate + drawImage 会对 12×12 的位图做双线性重采样，
 *   在整数倍放大后就是一团灰边。而「按方位重采样一次」得到的
 *   是纯 1bit 像素，与 CRT 风格一致。
 *
 * 关于尺寸：精灵大小是**符号尺寸**，不是物理尺寸。
 * 一架 40m 的客机在 0.35km/px 下只有 0.11 像素，真实雷达也是
 * 用固定大小的符号表示目标。因此不做随缩放变化。
 */

import { PAL } from '../config.js';

export const SPRITE = 12;
const HALF = SPRITE / 2;
/** 位图画布比剪影大一圈，用来放 1px 轮廓 —— 否则轮廓会被裁掉 */
export const CANVAS = SPRITE + 2;
/** 绘制时从中心偏移的量 */
export const OFFSET = CANVAS / 2;
/** 方位角量化数 —— 规格指定 16 */
export const DIRS = 16;

/* ----------------------------------------------------------------
 * 剪影（正北朝上 = 行 0 为机头方向）
 * 每行 12 字符，'o' 为实体。模块加载时会校验行长，写错当场断言。
 * ---------------------------------------------------------------- */
const SHAPES = {
  /**
   * 窄体：2px 机身 + 渐缩翼展（1–10 列）
   * 剪影必须连通 —— 第一版把翼尖放在独立一行，斜向渲染时看起来像「+」号。
   */
  narrow: [
    '............',
    '.....oo.....',
    '.....oo.....',
    '.....oo.....',
    '.....oo.....',
    '....oooo....',
    '..oooooooo..',
    '.oooooooooo.',
    '.....oo.....',
    '....oooo....',
    '.....oo.....',
    '............',
  ],
  /** 宽体：4px 机身 + 满展翼（0–11 列），一眼就能与窄体区分 */
  wide: [
    '............',
    '....oooo....',
    '....oooo....',
    '....oooo....',
    '....oooo....',
    '...oooooo...',
    '.oooooooooo.',
    'oooooooooooo',
    '....oooo....',
    '..oooooooo..',
    '....oooo....',
    '............',
  ],
  /**
   * 螺旋桨：平直长翼（大展弦比）+ 翼下两台发动机短舱。
   * 短舱必须挂在机翼上 —— 早先把它画成机头前方的独立像素，
   * 连通性断言当场抓住了这个缺陷。
   */
  prop: [
    '............',
    '.....oo.....',
    '.....oo.....',
    '.....oo.....',
    '.....oo.....',
    'oooooooooooo',
    '..o..oo..o..',
    '.....oo.....',
    '.....oo.....',
    '...oooooo...',
    '.....oo.....',
    '............',
  ],
  /** 直升机：旋翼十字 + 机身 */
  heli: [
    '............',
    '............',
    '.....oo.....',
    '.....oo.....',
    '....oooo....',
    'oooooooooooo',
    'oooooooooooo',
    '....oooo....',
    '.....oo.....',
    '.....oo.....',
    '............',
    '............',
  ],
  /** 未知：菱形点，不暗示机型 */
  unknown: [
    '............',
    '............',
    '............',
    '............',
    '.....oo.....',
    '....oooo....',
    '....oooo....',
    '.....oo.....',
    '............',
    '............',
    '............',
    '............',
  ],
};

/**
 * 加载期校验。三条都是真不变量，写错就当场抛错，而不是等肉眼看屏幕：
 *   1. 尺寸必须恰好 12×12；
 *   2. 剪影必须**单连通**（4 邻接）—— 第一版把翼尖放在独立一行，
 *      与翼身不相连，斜向渲染时就变成一个「+」号；
 *   3. 剪影必须**左右对称** —— 飞机本来就是对称的，不对称必然是手滑。
 */
(function validate() {
  for (const [name, rows] of Object.entries(SHAPES)) {
    if (rows.length !== SPRITE) throw new Error(`精灵 ${name} 行数应为 ${SPRITE}，实为 ${rows.length}`);
    rows.forEach((r, i) => {
      if (r.length !== SPRITE) throw new Error(`精灵 ${name} 第 ${i} 行长度应为 ${SPRITE}，实为 ${r.length}`);
    });

    for (let y = 0; y < SPRITE; y++) {
      for (let x = 0; x < SPRITE; x++) {
        if (rows[y][x] !== rows[y][SPRITE - 1 - x]) {
          throw new Error(`精灵 ${name} 左右不对称：第 ${y} 行第 ${x} 列`);
        }
      }
    }

    let total = 0;
    let seedX = -1;
    let seedY = -1;
    for (let y = 0; y < SPRITE; y++) {
      for (let x = 0; x < SPRITE; x++) {
        if (rows[y][x] === 'o') {
          total++;
          if (seedX < 0) { seedX = x; seedY = y; }
        }
      }
    }
    if (total === 0) throw new Error(`精灵 ${name} 是空的`);

    const seen = new Uint8Array(SPRITE * SPRITE);
    const stack = [[seedX, seedY]];
    let reached = 0;
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= SPRITE || y >= SPRITE) continue;
      const idx = y * SPRITE + x;
      if (seen[idx] || rows[y][x] !== 'o') continue;
      seen[idx] = 1;
      reached++;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    if (reached !== total) {
      throw new Error(`精灵 ${name} 不连通：${total} 个像素中有 ${total - reached} 个与主体分离`);
    }
  }
})();

export const CLASSES = Object.keys(SHAPES);

/* ----------------------------------------------------------------
 * 位图构建
 * ---------------------------------------------------------------- */

/** ASCII 剪影 → Uint8 遮罩（1 = 实体） */
function toMask(rows) {
  const m = new Uint8Array(SPRITE * SPRITE);
  for (let y = 0; y < SPRITE; y++) {
    for (let x = 0; x < SPRITE; x++) {
      if (rows[y][x] === 'o') m[y * SPRITE + x] = 1;
    }
  }
  return m;
}

/**
 * 把正北朝上的遮罩按整数方位重采样。
 * 推导：输出像素相对中心的偏移 (dx,dy)（屏幕坐标，y 向下）反解到
 * 源图坐标应旋转 -θ，化简后得到下面两式（无需逐点三角运算）。
 */
function rotateMask(src, dirIndex) {
  const theta = (dirIndex / DIRS) * 2 * Math.PI;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const out = new Uint8Array(SPRITE * SPRITE);

  for (let dy = -HALF; dy < HALF; dy++) {
    for (let dx = -HALF; dx < HALF; dx++) {
      const r = Math.hypot(dx, dy);
      // 机头在 r < 1.2 处会被采样噪声放大，直接取中心像素
      if (r < 1.2) {
        if (src[(HALF - 1) * SPRITE + (HALF - 1)]) out[(dy + HALF) * SPRITE + (dx + HALF)] = 1;
        continue;
      }
      const sx = dx * c + dy * s;
      const sy = dy * c - dx * s;
      const px = Math.round(HALF + sx - 0.5);
      const py = Math.round(HALF + sy - 0.5);
      if (px < 0 || py < 0 || px >= SPRITE || py >= SPRITE) continue;
      if (src[py * SPRITE + px]) out[(dy + HALF) * SPRITE + (dx + HALF)] = 1;
    }
  }
  return out;
}

/** 遮罩 → 单色 canvas（剪影居中留 1px 边，轮廓由着色阶段统一处理） */
function maskToCanvas(mask, color) {
  const cv = document.createElement('canvas');
  cv.width = CANVAS;
  cv.height = CANVAS;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = color;
  for (let y = 0; y < SPRITE; y++) {
    for (let x = 0; x < SPRITE; x++) {
      if (mask[y * SPRITE + x]) ctx.fillRect(x + 1, y + 1, 1, 1);
    }
  }
  return cv;
}

/* ----------------------------------------------------------------
 * 精灵库
 * ---------------------------------------------------------------- */

export function createSpriteLibrary() {
  /** 白色基准：class → dir → canvas（未着色，供着色缓存派生） */
  const white = new Map();
  /** 着色缓存：`${class}|${dir}|${color}` → canvas */
  const tinted = new Map();

  for (const cls of CLASSES) {
    const mask = toMask(SHAPES[cls]);
    const dirs = [];
    for (let d = 0; d < DIRS; d++) {
      const rotated = d === 0 ? mask : rotateMask(mask, d);
      dirs.push(maskToCanvas(rotated, '#ffffff'));
    }
    white.set(cls, dirs);
  }

  /** 取（或按需生成）着色精灵 */
  function get(cls, dirIndex, color) {
    const c = CLASSES.includes(cls) ? cls : 'unknown';
    const d = ((Math.round(dirIndex) % DIRS) + DIRS) % DIRS;
    const key = `${c}|${d}|${color}`;
    let cv = tinted.get(key);
    if (cv) return cv;

    const src = white.get(c)[d];
    cv = document.createElement('canvas');
    cv.width = CANVAS;
    cv.height = CANVAS;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // 轮廓：把白色剪影向八邻域膨胀一圈成暗色底。
    // 画布比剪影大 1px，因此膨胀不会被裁掉，四边轮廓完整。
    ctx.globalAlpha = 0.45;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        ctx.drawImage(src, ox, oy);
      }
    }
    ctx.globalAlpha = 1;

    // 用 source-in 把剪影整体染成目标色
    const solid = document.createElement('canvas');
    solid.width = CANVAS;
    solid.height = CANVAS;
    const sctx = solid.getContext('2d');
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(src, 0, 0);
    sctx.globalCompositeOperation = 'source-in';
    sctx.fillStyle = color;
    sctx.fillRect(0, 0, CANVAS, CANVAS);

    ctx.drawImage(solid, 0, 0);

    tinted.set(key, cv);
    return cv;
  }

  /** 航向角 → 方位序号（0 = 正北，顺时针） */
  function dirOf(trackDeg) {
    return Math.round((((trackDeg % 360) + 360) % 360) / (360 / DIRS)) % DIRS;
  }

  return { get, dirOf, SPRITE, CANVAS, OFFSET, DIRS, classes: CLASSES, cacheSize: () => tinted.size };
}

/**
 * 尾迹颜色：随高度变化。
 * 规格要求「低空亮，高空暗」，这里用极坐标插值：
 * 0ft → trailLow（亮绿），38000ft 以上 → trailHigh（暗青绿）。
 */
export function trailColor(altFt) {
  const t = Math.max(0, Math.min(1, (altFt || 0) / 38000));
  return mixHex(PAL.trailLow, PAL.trailHigh, t);
}

/** 十六进制颜色线性插值 */
export function mixHex(a, b, t) {
  const ra = parseInt(a.slice(1), 16);
  const rb = parseInt(b.slice(1), 16);
  const ar = (ra >> 16) & 255;
  const ag = (ra >> 8) & 255;
  const ab = ra & 255;
  const br = (rb >> 16) & 255;
  const bg = (rb >> 8) & 255;
  const bb = rb & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}
