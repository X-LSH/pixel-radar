/**
 * Pixel Radar · 单位换算
 * ---------------------------------------------------------------
 * 单独成文件的原因：换算方向很容易写反（km↔nm 在高空航迹上
 * 差 1.852 倍，错了会表现为「距离环与目标位置对不上」，
 * 而且极难肉眼发现）。集中在一处便于自检脚本逐一验证。
 */

/** 1 海里 = 1.852 km（国际定义，精确值） */
export const KM_PER_NM = 1.852;
/** 1 英尺 = 0.3048 m（国际定义，精确值） */
export const M_PER_FT = 0.3048;
/** 每度纬度平均公里数 */
export const KM_PER_DEG_LAT = 111.132;
/** 赤道每度经度公里数 */
export const KM_PER_DEG_LON_EQ = 111.320;

export const nmToKm = (nm) => nm * KM_PER_NM;
export const kmToNm = (km) => km / KM_PER_NM;
export const ftToM = (ft) => ft * M_PER_FT;
export const mToFt = (m) => m / M_PER_FT;
export const ktToKmh = (kt) => kt * KM_PER_NM;
export const ktToMs = (kt) => (kt * KM_PER_NM) / 3.6;
/** 节 → 每秒公里，用于逐帧外推 */
export const ktToKmPerSec = (kt) => (kt * KM_PER_NM) / 3600;

/** 安全版：非有限值一律回落到兜底 */
export function kmToNmSafe(km, fallback = 0) {
  return Number.isFinite(km) ? km / KM_PER_NM : fallback;
}

/** 经纬度包络框（供 bbox 型数据源使用） */
export function bboxAround(lat, lon, radiusKm) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const dLon = radiusKm / (KM_PER_DEG_LON_EQ * cosLat);
  return {
    latMin: Math.max(-90, lat - dLat),
    latMax: Math.min(90, lat + dLat),
    lonMin: lon - dLon,
    lonMax: lon + dLon,
  };
}

/** 数字格式化：千分位 */
export function group(n) {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 相对时间：给定毫秒时间戳，返回「x 秒前」这类中文描述 */
export function agoText(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 2) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒前`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分前`;
}

/** 逻辑像素尺寸 → 人类描述 */
export function resText(w, h, scale) {
  return `${w}×${h} 逻辑 · ${scale}× 放大`;
}
