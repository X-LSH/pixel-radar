/**
 * Pixel Radar · 地理与投影
 * ---------------------------------------------------------------
 * 投影选用「局部等距方位投影（AEQD）」—— 这正是真实雷达显示器用的
 * 投影：以机场为中心，等距圆环是真正的圆，方位角无变形。
 *
 * 为什么不用 Web Mercator：墨卡托只保角不保距，在 50km 尺度上
 * 圆环会被拉成椭圆，而「距离环」是本项目最核心的视觉语言。
 *
 * 正向投影（经纬度 → 像素）是本模块唯一的热路径，
 * 反向投影在业务上并不需要（视口中心始终是一个已知经纬度），
 * 因此不做，也就不必承担 acos 反解的数值误差。
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** IUGG 平均地球半径 */
export const EARTH_R_KM = 6371.0088;
/** 每度纬度的平均公里数（WGS84 椭球在 45° 处的近似） */
export const KM_PER_DEG_LAT = 111.132;
/** 赤道每度经度的公里数 */
export const KM_PER_DEG_LON_EQ = 111.320;

export const toRad = (d) => d * D2R;
export const toDeg = (r) => r * R2D;

/** 角度归一到 [0, 360) */
export function norm360(d) {
  const m = d % 360;
  return m < 0 ? m + 360 : m;
}

/** 角度归一到 (-180, 180] */
export function norm180(d) {
  let m = d % 360;
  if (m > 180) m -= 360;
  if (m <= -180) m += 360;
  return m;
}

/** 经度归一到 (-180, 180] */
export function normLon(lon) {
  return norm180(lon);
}

/* ================================================================
 * 大圆计算
 * ================================================================ */

/** 两点间大圆距离（km） */
export function distKm(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * D2R;
  const φ2 = lat2 * D2R;
  const dφ = φ2 - φ1;
  const dλ = (lon2 - lon1) * D2R;
  const sφ = Math.sin(dφ / 2);
  const sλ = Math.sin(dλ / 2);
  const a = sφ * sφ + Math.cos(φ1) * Math.cos(φ2) * sλ * sλ;
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 起点到终点的初始方位角（度，0=正北，顺时针） */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * D2R;
  const φ2 = lat2 * D2R;
  const dλ = (lon2 - lon1) * D2R;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return norm360(Math.atan2(y, x) * R2D);
}

/**
 * 从起点沿指定方位角前进指定距离，返回新的经纬度。
 * 用于模拟航班的位姿推进，以及基于速度/航向的外推。
 */
export function destination(lat, lon, bearing, km) {
  if (!(km > 0)) return { lat, lon };
  const φ1 = lat * D2R;
  const λ1 = lon * D2R;
  const θ = bearing * D2R;
  const δ = km / EARTH_R_KM;
  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);

  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
  const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * sinδ * cosφ1, cosδ - sinφ1 * sinφ2);

  return { lat: φ2 * R2D, lon: normLon(λ2 * R2D) };
}

/** 16 方位罗盘缩写 */
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compass16(deg) {
  return COMPASS[Math.round(norm360(deg) / 22.5) % 16];
}

/**
 * 由中心点与半径推算经纬度包络框。
 * 用于向 bbox 型数据源（如 OpenSky）发起查询。
 */
export function bboxAround(lat, lon, radiusKm) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const cosLat = Math.max(0.01, Math.cos(lat * D2R));
  const dLon = radiusKm / (KM_PER_DEG_LON_EQ * cosLat);
  return {
    latMin: Math.max(-90, lat - dLat),
    latMax: Math.min(90, lat + dLat),
    lonMin: normLon(lon - dLon),
    lonMax: normLon(lon + dLon),
  };
}

/* ================================================================
 * 局部等距方位投影
 * ================================================================ */

export class Projection {
  constructor(lat0 = 0, lon0 = 0) {
    /** 投影中心（同时也是视口中心） */
    this.lat0 = lat0;
    this.lon0 = lon0;
    /** 视口：逻辑像素 */
    this.cx = 0;
    this.cy = 0;
    this.kmPerPx = 1;
    /** 中心点的三角函数缓存，避免每次投影都重算 */
    this._sin0 = 0;
    this._cos0 = 1;
    this.setCenter(lat0, lon0);
  }

  setCenter(lat, lon) {
    this.lat0 = lat;
    this.lon0 = lon;
    const φ = lat * D2R;
    this._sin0 = Math.sin(φ);
    this._cos0 = Math.cos(φ);
  }

  /** 设置视口锚点与比例尺 */
  setView(cx, cy, kmPerPx) {
    this.cx = cx;
    this.cy = cy;
    this.kmPerPx = kmPerPx > 0 ? kmPerPx : 1;
  }

  /**
   * 经纬度 → 以投影中心为原点的平面坐标（km，X 向东 / Y 向北）
   * @returns {{x:number, y:number}}
   */
  project(lat, lon) {
    const φ2 = lat * D2R;
    const dλ = (lon - this.lon0) * D2R;
    const cosφ2 = Math.cos(φ2);
    const sinφ2 = Math.sin(φ2);
    const cosΔ = Math.cos(dλ);
    const sinΔ = Math.sin(dλ);

    const cosc = this._sin0 * sinφ2 + this._cos0 * cosφ2 * cosΔ;
    const c = Math.acos(cosc < -1 ? -1 : cosc > 1 ? 1 : cosc);
    const sinc = Math.sin(c);
    const k = Math.abs(sinc) > 1e-9 ? c / sinc : 1;

    const x = cosφ2 * sinΔ;
    const y = this._cos0 * sinφ2 - this._sin0 * cosφ2 * cosΔ;
    return { x: EARTH_R_KM * k * x, y: EARTH_R_KM * k * y };
  }

  /** 经纬度 → 逻辑像素（可含半像素，绘制时再取整） */
  toPixel(lat, lon) {
    const p = this.project(lat, lon);
    return { x: this.cx + p.x / this.kmPerPx, y: this.cy - p.y / this.kmPerPx };
  }

  /** 像素偏移量 → 公里（用于把缩放锚点固定在光标处） */
  pxToKm(px) {
    return px * this.kmPerPx;
  }

  /** 视口对角线半径（km），用于剔除不可见目标 */
  viewRadiusKm() {
    const w = this.cx * 2;
    const h = this.cy * 2;
    return Math.hypot(w, h) * 0.5 * this.kmPerPx;
  }
}

/** 便捷函数：直接算像素，不构造对象（热路径备选） */
export function latLonToPixel(proj, lat, lon, out) {
  const p = proj.project(lat, lon);
  const x = proj.cx + p.x / proj.kmPerPx;
  const y = proj.cy - p.y / proj.kmPerPx;
  if (out) { out.x = x; out.y = y; return out; }
  return { x, y };
}
