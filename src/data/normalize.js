/**
 * Pixel Radar · 字段归一化
 * ---------------------------------------------------------------
 * 上游是「readsb 风格」的原始帧（adsb.lol / airplanes.live 同源格式），
 * 字段名短、单位混（节/英尺/度）、大量字段可选且可能缺失。
 * 这一层负责把它收敛成内部稳定模型 —— 上层渲染与 UI 只认这个模型。
 *
 * 关键取舍：
 *  · 内部统一用 **英制航空单位**（ft / kt），因为界面上飞行员读的就是它们，
 *    换算成公制再显示会引入二次舍入误差；
 *  · 距离单独用 km（距离环按 km 标定），只在这一处做换算。
 */

import { detectPhase } from './phases.js';

/** 1 海里 = 1.852 km */
export const KM_PER_NM = 1.852;
/** 1 英尺 = 0.3048 m */
export const M_PER_FT = 0.3048;

export const nmToKm = (nm) => nm * KM_PER_NM;
export const kmToNm = (km) => km / KM_PER_NM;
export const ftToM = (ft) => ft * M_PER_FT;
export const ktToKmh = (kt) => kt * KM_PER_NM;
/** 节 → km/min，用于帧间外推 */
export const ktToKmPerMin = (kt) => kt * KM_PER_NM / 60;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 清理呼号：上游以空格右侧填充到 8 字符 */
export function cleanCallsign(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return s.length ? s : null;
}

/* ----------------------------------------------------------------
 * 机型分类
 * ----------------------------------------------------------------
 * 依据 ICAO 机型代码前缀判定。用于选择飞机精灵形状，
 * 因此只分 5 类，不做精确型号识别 —— 屏上只有 12×12 像素。
 * ---------------------------------------------------------------- */
const WIDEBODY = /^(A3[3-9]|A38|B74|B76|B77|B78|B787|IL96|A30|A310|MD11|B767)/;
const NARROW = /^(A31|A32|A19|A20|A21|A22|B73|B75|B71|MD8|MD9|E1[7-9]|E29|CRJ|RJ|SU9|SSJ|C919)/;
const PROP = /^(AT[2-7]|DH8|DH7|DHC|C20[78]|C208|PC12|BE20|BE30|SF34|SB20|L410|AN[2-4]|F50|F27|JS3|TBM|M20|PA[23]|SR2|C17[2-5]|TEX2)/;
const HELI = /^(H60|H47|H53|R22|R44|R66|EC[1-5]|EC35|AS[3-6]|B40[67]|A109|A139|AW13|S76|S92|UH|CH|NH90|MD90)/;

export function classifyType(typeCode) {
  if (!typeCode || typeof typeCode !== 'string') return 'unknown';
  const t = typeCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!t) return 'unknown';
  if (HELI.test(t)) return 'heli';
  if (WIDEBODY.test(t)) return 'wide';
  if (NARROW.test(t)) return 'narrow';
  if (PROP.test(t)) return 'prop';
  return 'unknown';
}

/* ----------------------------------------------------------------
 * 航空公司（按呼号三字码）
 * ----------------------------------------------------------------
 * 规格要求「航空公司（根据呼号前缀）」。这里只覆盖 20 个预设机场
 * 周边最常出现的承运人；查不到就回落为空，界面显示 ICAO 三字码本身。
 * ---------------------------------------------------------------- */
const AIRLINES = {
  // 中国内地
  CCA: '中国国际航空', CES: '中国东方航空', CSN: '中国南方航空',
  CHH: '海南航空', CSZ: '深圳航空', CQH: '春秋航空', CKG: '重庆航空',
  CXA: '厦门航空', CBJ: '北京航空', CDG: '山东航空', CSH: '上海航空',
  CUA: '中国联合航空', CGZ: '贵州航空', HXA: '华夏航空', GCR: '天津航空',
  DKH: '吉祥航空', OTT: '奥凯航空', UEA: '成都航空', RLH: '瑞丽航空',
  LKE: '幸福航空', JYH: '九元航空', CDC: '长龙航空', CSNX: '南方航空',
  // 中国港澳台
  CPA: '国泰航空', HDA: '香港航空', CRK: '香港快运', HKE: '香港快运',
  CES_HK: '东方航空',
  // 亚太
  ANA: '全日空', AJX: '全日空', JAL: '日本航空', JJP: '捷星日本',
  APJ: '乐桃航空', SKY: '天马航空', KAL: '大韩航空', AAR: '韩亚航空',
  JJA: '真航空', ESR: '伊士亚洲', TWB: '德威航空',
  SIA: '新加坡航空', SLK: '酷航', TGW: '酷航', MAS: '马来西亚航空',
  AXM: '亚洲航空', THA: '泰国国际航空', VTI: '维斯塔拉',
  QFA: '澳洲航空', JST: '捷星航空', VOZ: '维珍澳洲', QLK: '澳洲连接',
  // 中东 / 欧洲
  UAE: '阿联酋航空', ETD: '阿提哈德航空', QTR: '卡塔尔航空',
  SVA: '沙特航空', GFA: '海湾航空', KAC: '科威特航空',
  BAW: '英国航空', EZY: '易捷航空', VIR: '维珍大西洋',
  AFR: '法国航空', DLH: '汉莎航空', EWG: '欧洲之翼', CLH: '汉莎城际',
  KLM: '荷兰皇家航空', IBE: '伊比利亚航空', ITY: '意大利航空',
  SWR: '瑞士国际航空', AUA: '奥地利航空', SAS: '北欧航空',
  RYR: '瑞安航空', TAP: '葡萄牙航空', AEE: '爱琴海航空',
  THY: '土耳其航空', AIC: '印度航空', AXY: '亚航 X',
  // 北美
  AAL: '美国航空', DAL: '达美航空', UAL: '美联航', SWA: '西南航空',
  JBU: '捷蓝航空', ASA: '阿拉斯加航空', NKS: '精神航空',
  SKW: '天西航空', ENY: '特使航空', RPA: '共和航空', FDX: '联邦快递',
  UPS: '联合包裹', ACA: '加拿大航空', WJA: '西捷航空',
  // 货运 / 其它
  GTI: '亚特拉斯航空', CKS: '卡利塔航空', BOX: '汉莎货运', CLX: '卢森堡货运',
};

/** 由呼号三字码取航司中文名；查不到返回 null */
export function airlineOf(callsign) {
  if (!callsign) return null;
  const p = callsign.slice(0, 3);
  return AIRLINES[p] || null;
}

/** 呼号后段数字部分（通常为航班号），用于显示「MU2106」这类 IATA 形态 */
export function flightNumberOf(callsign) {
  if (!callsign) return null;
  const m = /^([A-Z]{3})(\d{1,4}[A-Z]?)$/.exec(callsign);
  return m ? `${m[1]}${m[2]}` : null;
}

/* ----------------------------------------------------------------
 * 主归一化
 * ---------------------------------------------------------------- */

/**
 * 把一条上游记录转成内部 Plane 模型。
 * @param {object} raw 上游原始记录
 * @param {string} sourceId 数据源标识，用于信息卡署名
 * @returns {object|null}
 */
export function normalizePlane(raw, sourceId = 'unknown') {
  if (!raw || typeof raw !== 'object') return null;

  const hex = typeof raw.hex === 'string' ? raw.hex.toLowerCase() : null;
  if (!hex) return null;

  const lat = num(raw.lat);
  const lon = num(raw.lon);
  // 没有位置的记录（仅收到 Mode-S 呼号的）对雷达无意义
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const callsign = cleanCallsign(raw.flight) || cleanCallsign(raw.call) || null;
  const typeCode = typeof raw.t === 'string' ? raw.t.trim().toUpperCase() : null;

  const altBaro = num(raw.alt_baro);
  const altGeom = num(raw.alt_geom);
  const onGround = raw.alt_baro === 'ground' || raw.on_ground === true;

  // 地面目标的 alt_baro 可能是字符串 "ground"，此时高度按场高处理
  const alt = onGround ? 0 : (altBaro !== null ? altBaro : altGeom);

  const gs = num(raw.gs);
  const track = num(raw.track);
  const baroRate = num(raw.baro_rate);
  const geomRate = num(raw.geom_rate);
  const vs = baroRate !== null ? baroRate : (geomRate !== null ? geomRate : 0);

  const p = {
    hex,
    callsign,
    registration: typeof raw.r === 'string' ? raw.r.trim() : null,
    typeCode,
    typeClass: classifyType(typeCode),
    category: raw.category || null,
    /** 上游若提供注册国（OpenSky 有，adsb.lol 没有），优先采用 */
    originCountry: typeof raw.origin_country === 'string' && raw.origin_country.trim()
      ? raw.origin_country.trim() : null,

    lat,
    lon,
    /** 高度（英尺）。地面为 0。 */
    altFt: alt === null ? null : Math.round(alt),
    altIsGeom: altBaro === null && altGeom !== null,
    onGround,

    /** 地速（节） */
    gsKt: gs === null ? null : Math.round(gs),
    /** 航迹角（度，真北顺时针） */
    trackDeg: track === null ? 0 : track,
    /** 垂直速率（英尺/分） */
    vsFpm: Math.round(vs),

    /** 各字段的可用性标记 —— 界面据此显示 "—" 而不是伪造 0 */
    has: {
      alt: alt !== null,
      gs: gs !== null,
      track: track !== null,
      vs: baroRate !== null || geomRate !== null,
    },

    /** 是否持有位置信息之外的身份信息（用于信息卡降级提示） */
    source: sourceId,
  };

  // 飞行阶段在这里就地判定，而不是留给渲染层。
  // 理由：它是「每个目标都必须有」的派生字段，界面配色、信息卡徽标、
  // 统计口径、筛选都依赖它。若留给消费方各自计算，真实数据路径一旦漏掉
  // 就会出现「阶段未知」的破窗（这正是浏览器 E2E 抓到的第一个真 bug）。
  p.phase = detectPhase(p);
  return p;
}

/**
 * 从上游响应体提取记录数组。
 * adsb.lol / airplanes.live 用 `ac`，OpenSky 用 `states`（数组的数组）。
 */
export function extractRecords(json) {
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json.ac)) return json.ac;
  if (Array.isArray(json.aircraft)) return json.aircraft;
  return [];
}

/** OpenSky states 数组 → 上游风味记录（便于复用 normalizePlane） */
export function openSkyToRaw(row) {
  if (!Array.isArray(row) || row.length < 11) return null;
  return {
    hex: row[0],
    flight: row[1],
    origin_country: row[2],
    lat: row[6],
    lon: row[5],
    alt_baro: row[13] != null ? row[13] : (row[7] != null ? row[7] / M_PER_FT : null),
    on_ground: row[8],
    gs: row[9] != null ? row[9] / KM_PER_NM : null, // m/s → kt
    track: row[10],
    baro_rate: row[11] != null ? row[11] / M_PER_FT * 60 : null, // m/s → ft/min
    category: row[17] != null ? String(row[17]) : null,
  };
}
