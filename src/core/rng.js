/**
 * Pixel Radar · 确定性随机与噪声
 * ---------------------------------------------------------------
 * 两条纪律：
 *  1. 模拟航班、地图纹理必须可复现 —— 同一个种子必须给出同一幅画面，
 *     否则「换机场再换回来」会得到一张完全陌生的地图，观感上是 bug。
 *  2. 绝不用 Math.random 参与任何视觉或模拟逻辑。
 */

/** mulberry32：32 位状态、质量足够、速度极快 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串 → 32 位种子（FNV-1a） */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 由任意参数组合出种子 */
export function seedOf(...parts) {
  return hashString(parts.join('\u0001'));
}

/** 带便捷方法的随机源 */
export function makeRng(seed) {
  const r = mulberry32(typeof seed === 'string' ? hashString(seed) : seed);
  return {
    next: r,
    /** [lo, hi) 浮点 */
    range: (lo, hi) => lo + r() * (hi - lo),
    /** [lo, hi] 整数 */
    int: (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)),
    /** 概率 p 为真 */
    chance: (p) => r() < p,
    /** 数组随机取一 */
    pick: (arr) => arr[Math.floor(r() * arr.length) % arr.length],
    /** 正态分布（Box-Muller），截断到 ±3σ */
    normal: (mu = 0, sigma = 1) => {
      let u = 0;
      let v = 0;
      while (u === 0) u = r();
      while (v === 0) v = r();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      return mu + sigma * Math.max(-3, Math.min(3, z));
    },
    /** 就地洗牌 */
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
      }
      return arr;
    },
  };
}

/* ================================================================
 * 像素地图用的确定性值噪声
 * ================================================================ */

/**
 * 二维值噪声。用于地图纹理、噪点层的「同一画面不同帧」效果。
 * 注意：噪点层每帧要变，那是刻意为之，用帧序号当种子即可。
 */
export function valueNoise2D(seed) {
  const s = seed >>> 0;
  const h = (x, y) => {
    let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ s;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  return function noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = smooth(x - xi);
    const yf = smooth(y - yi);
    const a = h(xi, yi);
    const b = h(xi + 1, yi);
    const c = h(xi, yi + 1);
    const d = h(xi + 1, yi + 1);
    return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
  };
}

/** 分形叠加（fBm），用于生成有机的地形/云层纹理 */
export function fbm2D(seed, octaves = 4) {
  const noise = valueNoise2D(seed);
  return function fbm(x, y) {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += noise(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  };
}
