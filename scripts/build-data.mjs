/**
 * Pixel Radar · 地理数据构建脚本（一次性 / 可重复运行）
 * ===============================================================
 * 这不是运行时依赖，而是「把权威数据蒸馏成可提交模块」的工具。
 * 只有需要新增机场、或想提高地理精度时才重新运行。
 *
 * 数据来源（全部为公共领域 / 开放许可，已在产物头部标注）：
 *   · OurAirports  —— 机场坐标、跑道端点、朝向、长度、道面
 *     https://davidmegginson.github.io/ourairports-data/   (Public Domain)
 *   · Natural Earth 1:10m —— 海岸线、城市建成区、湖泊
 *     https://www.naturalearthdata.com/                    (Public Domain)
 *
 * 产物：
 *   src/data/airports.js   —— 20 个预设机场 + 真实跑道
 *   src/data/geo-shapes.js —— 按机场裁剪并简化的海岸线 / 建成区 / 湖泊
 *
 * 用法：
 *   node scripts/build-data.mjs            # 全量重建
 *   node scripts/build-data.mjs --only-shapes
 *   node scripts/build-data.mjs --only-airports
 */

import { writeFile, mkdir, readFile, stat, rename, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'src/data');
/**
 * 上游原始文件的本地缓存目录。
 *
 * 为什么必须缓存：Natural Earth 的 1:10m 建成区约 27MB，
 * 在受限网络下反复中途断流（实测 `terminated`）。每次重建都重新下载
 * 既慢又不可靠。缓存到本地后，只要成功一次，后续重建就是秒级，
 * 也不再受网络抖动影响。目录在 .gitignore 中。
 */
const RAW_DIR = resolve(ROOT, '.tmp/raw');

/* ================================================================
 * 机场清单（规格指定的 20 个）
 * ----------------------------------------------------------------
 * tz 用于「按时区推荐」与本地时间显示；中文名用于界面，
 * 英文名直接取 OurAirports 的官方 name 字段，不自行转写。
 * ================================================================ */
const AIRPORT_LIST = [
  { icao: 'ZBAA', iata: 'PEK', cn: '北京首都',   tz: 'Asia/Shanghai' },
  { icao: 'ZSPD', iata: 'PVG', cn: '上海浦东',   tz: 'Asia/Shanghai' },
  { icao: 'ZGGG', iata: 'CAN', cn: '广州白云',   tz: 'Asia/Shanghai' },
  { icao: 'ZGSZ', iata: 'SZX', cn: '深圳宝安',   tz: 'Asia/Shanghai' },
  { icao: 'ZUUU', iata: 'CTU', cn: '成都双流',   tz: 'Asia/Shanghai' },
  { icao: 'VHHH', iata: 'HKG', cn: '中国香港',   tz: 'Asia/Hong_Kong' },
  { icao: 'RJAA', iata: 'NRT', cn: '东京成田',   tz: 'Asia/Tokyo' },
  { icao: 'RJTT', iata: 'HND', cn: '东京羽田',   tz: 'Asia/Tokyo' },
  { icao: 'RKSI', iata: 'ICN', cn: '首尔仁川',   tz: 'Asia/Seoul' },
  { icao: 'WSSS', iata: 'SIN', cn: '新加坡樟宜', tz: 'Asia/Singapore' },
  { icao: 'OMDB', iata: 'DXB', cn: '迪拜国际',   tz: 'Asia/Dubai' },
  { icao: 'EGLL', iata: 'LHR', cn: '伦敦希思罗', tz: 'Europe/London' },
  { icao: 'LFPG', iata: 'CDG', cn: '巴黎戴高乐', tz: 'Europe/Paris' },
  { icao: 'EDDF', iata: 'FRA', cn: '法兰克福',   tz: 'Europe/Berlin' },
  { icao: 'KJFK', iata: 'JFK', cn: '纽约肯尼迪', tz: 'America/New_York' },
  { icao: 'KLAX', iata: 'LAX', cn: '洛杉矶',     tz: 'America/Los_Angeles' },
  { icao: 'KSFO', iata: 'SFO', cn: '旧金山',     tz: 'America/Los_Angeles' },
  { icao: 'KSEA', iata: 'SEA', cn: '西雅图',     tz: 'America/Los_Angeles' },
  { icao: 'YSSY', iata: 'SYD', cn: '悉尼',       tz: 'Australia/Sydney' },
  { icao: 'YMML', iata: 'MEL', cn: '墨尔本',     tz: 'Australia/Melbourne' },
];

/** 裁剪半径（度）。要覆盖 50km 距离环并留出平移余量。 */
const CLIP_DEG = 1.6;
/** 抽稀容差（度）。0.0018° ≈ 200m，在最高缩放下约 10 像素，足够平滑。 */
const TOL_COAST = 0.0018;
const TOL_URBAN = 0.0035;
const TOL_LAKES = 0.0025;
/** 坐标量化位数：4 位 ≈ 11m，远优于最高缩放下的像素尺寸 */
const PREC = 4;
/** 小于该顶点数的环直接丢弃（多半是噪点） */
const MIN_RING_PTS = 4;

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const OA = 'https://davidmegginson.github.io/ourairports-data/';

/* ================================================================
 * 工具
 * ================================================================ */

/**
 * 拉取上游原始文件，带本地缓存与重试。
 *
 * 流程：先看缓存 → 命中直接用；未命中则**流式**下载到临时文件再原子改名
 * （避免半截文件被当成有效缓存）→ 失败按指数退避重试。
 * 用流式而非 res.text() 是因为 27MB 的响应体一次性读入更容易被中途掐断。
 */
async function getText(url, attempt = 1) {
  const name = url.split('/').pop();
  const cached = resolve(RAW_DIR, name);

  // 1) 命中缓存
  const cs = await stat(cached).catch(() => null);
  if (cs && cs.size > 1024) {
    const text = await readFile(cached, 'utf8');
    console.log(`  ✓ ${name} 取自缓存（${(cs.size / 1024).toFixed(0)} KB）`);
    return text;
  }

  // 2) 下载
  process.stdout.write(`  ↓ ${name}${attempt > 1 ? `（第 ${attempt} 次）` : ''} … `);
  const t0 = Date.now();
  const tmp = `${cached}.part`;
  try {
    await mkdir(RAW_DIR, { recursive: true });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 300000);
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'pixel-radar/build-data' },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('响应无 body');

    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    const st = await stat(tmp);
    if (st.size < 1024) throw new Error(`体积异常（${st.size} B）`);
    await rename(tmp, cached);

    const text = await readFile(cached, 'utf8');
    console.log(`${(st.size / 1024).toFixed(0)} KB / ${Date.now() - t0}ms`);
    return text;
  } catch (e) {
    await unlink(tmp).catch(() => {});
    console.log(`失败（${e.message}）`);
    if (attempt >= 5) {
      throw new Error(`拉取 ${name} 连续 5 次失败：${e.message}\n`
        + `  提示：该文件可在浏览器手动下载后放到 ${RAW_DIR} ，重跑本脚本即可命中缓存。`);
    }
    await new Promise((r) => setTimeout(r, 3000 * attempt));
    return getText(url, attempt + 1);
  }
}

async function getJson(url) {
  return JSON.parse(await getText(url));
}

/** 最小 CSV 解析器：支持双引号包裹、字段内逗号与转义双引号 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toRecords(rows) {
  const head = rows[0];
  return rows.slice(1).map((r) => {
    const o = {};
    for (let i = 0; i < head.length; i++) o[head[i]] = r[i];
    return o;
  });
}

const q = (n) => Number(n.toFixed(PREC));

/** Douglas–Peucker 抽稀。输入/输出均为扁平 [lon,lat,...] */
function simplify(flat, tol) {
  const n = flat.length / 2;
  if (n <= 2) return flat;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = tol * tol;

  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b <= a + 1) continue;
    const ax = flat[a * 2], ay = flat[a * 2 + 1];
    const bx = flat[b * 2], by = flat[b * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bestD2 = -1;
    for (let i = a + 1; i < b; i++) {
      const px = flat[i * 2], py = flat[i * 2 + 1];
      let d2;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
        d2 = ex * ex + ey * ey;
      }
      if (d2 > bestD2) { bestD2 = d2; best = i; }
    }
    if (bestD2 > tol2 && best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(q(flat[i * 2]), q(flat[i * 2 + 1]));
  }
  return out;
}

/** 环闭合性判断（首尾点相同） */
function closeRing(flat) {
  const n = flat.length / 2;
  if (n < 3) return flat;
  const d = Math.abs(flat[0] - flat[(n - 1) * 2]) + Math.abs(flat[1] - flat[(n - 1) * 2 + 1]);
  return d < 1e-9 ? flat : flat.concat([flat[0], flat[1]]);
}

/**
 * 用经纬度框裁剪一条折线 —— 真正的线段裁剪（Liang–Barsky），
 * 交点用线性插值求出，坐标再夹回框内。
 *
 * 为什么不能「整段收编」：简化后的长直线段可能跨越几百公里，
 * 若把跨越框的整段原样保留，两端顶点会落在框外 200km 处。
 * 实测这样会多带 9.6% 的无用坐标，而且让「所有坐标都在裁剪框内」
 * 这条不变量无法成立（数据契约就模糊了）。
 */
function clipLine(flat, box) {
  const n = flat.length / 2;
  const pieces = [];
  let cur = null;

  const flush = () => {
    if (cur && cur.length >= 4) pieces.push(cur);
    cur = null;
  };

  for (let i = 0; i < n - 1; i++) {
    const ax = flat[i * 2], ay = flat[i * 2 + 1];
    const bx = flat[i * 2 + 2], by = flat[i * 2 + 3];
    const seg = liangBarsky(ax, ay, bx, by, box);
    if (!seg) { flush(); continue; }

    const [x0, y0, x1, y1] = seg;
    if (!cur) {
      cur = [q(x0), q(y0)];
    } else {
      // 连续两段共享端点：只续写尾点，不重复记录首点。
      // 若这里重复 push，顶点数会凭空翻倍（实测总量涨 23%）。
      const lastX = cur[cur.length - 2];
      const lastY = cur[cur.length - 1];
      if (Math.abs(lastX - x0) > 1e-9 || Math.abs(lastY - y0) > 1e-9) {
        flush();
        cur = [q(x0), q(y0)];
      }
    }
    cur.push(q(x1), q(y1));
  }
  flush();
  return pieces;
}

/** Liang–Barsky 线段裁剪；返回 [x0,y0,x1,y1] 或 null */
function liangBarsky(x0, y0, x1, y1, box) {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;

  const clip = (p, qv) => {
    if (p === 0) return qv >= 0;
    const r = qv / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };

  if (!clip(-dx, x0 - box.lonMin)) return null;
  if (!clip(dx, box.lonMax - x0)) return null;
  if (!clip(-dy, y0 - box.latMin)) return null;
  if (!clip(dy, box.latMax - y0)) return null;
  if (t1 <= t0) return null;

  const cx = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  return [
    cx(x0 + t0 * dx, box.lonMin, box.lonMax),
    cx(y0 + t0 * dy, box.latMin, box.latMax),
    cx(x0 + t1 * dx, box.lonMin, box.lonMax),
    cx(y0 + t1 * dy, box.latMin, box.latMax),
  ];
}

/**
 * 用经纬度框裁剪一个多边形环（Sutherland–Hodgman）。
 * 矩形裁剪区是凸的，因此该算法结果精确且始终闭合。
 */
function clipPolygon(flat, box) {
  let ring = flat;

  // 左边界 lon >= lonMin
  ring = clipHalf(ring, (x) => x >= box.lonMin, (ax, ay, bx, by) => {
    const t = (box.lonMin - ax) / (bx - ax);
    return [box.lonMin, ay + t * (by - ay)];
  });
  if (ring.length < 6) return null;

  // 右边界 lon <= lonMax
  ring = clipHalf(ring, (x) => x <= box.lonMax, (ax, ay, bx, by) => {
    const t = (box.lonMax - ax) / (bx - ax);
    return [box.lonMax, ay + t * (by - ay)];
  });
  if (ring.length < 6) return null;

  // 下边界 lat >= latMin
  ring = clipHalf(ring, (x, y) => y >= box.latMin, (ax, ay, bx, by) => {
    const t = (box.latMin - ay) / (by - ay);
    return [ax + t * (bx - ax), box.latMin];
  });
  if (ring.length < 6) return null;

  // 上边界 lat <= latMax
  ring = clipHalf(ring, (x, y) => y <= box.latMax, (ax, ay, bx, by) => {
    const t = (box.latMax - ay) / (by - ay);
    return [ax + t * (bx - ax), box.latMax];
  });
  if (ring.length < 6) return null;

  const out = ring.map(q);
  return out.length / 2 >= MIN_RING_PTS ? closeRing(out) : null;
}

/** 对单个半平面做一轮 Sutherland–Hodgman 裁剪 */
function clipHalf(ring, inside, intersect) {
  const n = ring.length / 2;
  if (!n) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const ax = ring[i * 2];
    const ay = ring[i * 2 + 1];
    const j = (i + 1) % n;
    const bx = ring[j * 2];
    const by = ring[j * 2 + 1];
    const aIn = inside(ax, ay);
    const bIn = inside(bx, by);
    if (aIn) out.push(ax, ay);
    if (aIn !== bIn) {
      const [ix, iy] = intersect(ax, ay, bx, by);
      out.push(ix, iy);
    }
  }
  return out;
}

/** 计算扁平坐标的包围盒（预计算一次，避免每机场重复扫描顶点） */
function bboxFlat(flat) {
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    const lon = flat[i], lat = flat[i + 1];
    if (lon < lonMin) lonMin = lon;
    if (lon > lonMax) lonMax = lon;
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
  }
  return { lonMin, lonMax, latMin, latMax };
}

/** 两个包围盒是否相交 */
function bboxHit(a, b) {
  return !(a.lonMax < b.lonMin || a.lonMin > b.lonMax || a.latMax < b.latMin || a.latMin > b.latMax);
}

/** GeoJSON 几何 → 扁平坐标环数组 */
function geometryRings(geom) {
  const out = [];
  if (!geom) return out;
  const walk = (coords, depth) => {
    if (depth === 1) {
      out.push(coords.flatMap((c) => [q(c[0]), q(c[1])]));
    } else {
      for (const c of coords) walk(c, depth - 1);
    }
  };
  switch (geom.type) {
    case 'LineString': walk(geom.coordinates, 1); break;
    case 'MultiLineString': walk(geom.coordinates, 2); break;
    case 'Polygon': walk(geom.coordinates, 2); break;
    case 'MultiPolygon': walk(geom.coordinates, 3); break;
    default: break;
  }
  return out;
}

const boxOf = (lat, lon, d = CLIP_DEG) => ({
  latMin: lat - d, latMax: lat + d, lonMin: lon - d, lonMax: lon + d,
});

/* ================================================================
 * 1) 机场与跑道
 * ================================================================ */

async function buildAirports() {
  console.log('\n[1/2] 机场与跑道');
  const [apRows, rwRows] = await Promise.all([
    getText(`${OA}airports.csv`).then(parseCsv),
    getText(`${OA}runways.csv`).then(parseCsv),
  ]);

  const want = new Map(AIRPORT_LIST.map((a) => [a.icao, a]));
  const airports = new Map();

  for (const r of toRecords(apRows)) {
    const spec = want.get(r.ident);
    if (!spec) continue;
    airports.set(r.ident, {
      icao: r.ident,
      iata: r.iata_code || spec.iata,
      cn: spec.cn,
      en: r.name,
      lat: Number(r.latitude_deg),
      lon: Number(r.longitude_deg),
      elevFt: Math.round(Number(r.elevation_ft) || 0),
      tz: spec.tz,
      city: r.municipality || '',
      region: r.iso_region || '',
      runways: [],
    });
  }

  for (const r of toRecords(rwRows)) {
    const ap = airports.get(r.airport_ident);
    if (!ap) continue;
    if (r.closed === '1') continue;
    const lengthFt = Number(r.length_ft) || 0;
    if (lengthFt < 1500) continue; // 忽略滑行道级别的铺装
    ap.runways.push({
      le: r.le_ident,
      he: r.he_ident,
      leLat: Number(r.le_latitude_deg),
      leLon: Number(r.le_longitude_deg),
      heLat: Number(r.he_latitude_deg),
      heLon: Number(r.he_longitude_deg),
      hdg: Number(r.le_heading_degT) || 0,
      lenFt: Math.round(lengthFt),
      widFt: Math.round(Number(r.width_ft) || 0),
      surface: r.surface || '',
      lighted: r.lighted === '1',
    });
  }

  const list = AIRPORT_LIST.map((s) => {
    const ap = airports.get(s.icao);
    if (!ap) throw new Error(`未能在 OurAirports 中找到 ${s.icao}`);

    const before = ap.runways.length;
    /**
     * 跑道有效性过滤。
     *
     * 关键坑：OurAirports 用 **0 表示缺失坐标**，而不是留空。
     * 于是 `Number.isFinite(0)` 为真是成立的，ZSPD 的 15/33 就这样
     * 带着 (0.0000, 0.0000) 混了进来 —— 一条位于几内亚湾、
     * 距上海 12989 公里的「跑道」。仅检查有限性是抓不住它的。
     *
     * 因此改为「与机场参考点的实际距离」判据：真实跑道端点不可能
     * 距场参考点超过 30km（最长跑道约 5.5km，再加参考点偏移余量）。
     */
    ap.runways = ap.runways.filter((r) => {
      if (!Number.isFinite(r.leLat) || !Number.isFinite(r.leLon)) return false;
      if (!Number.isFinite(r.heLat) || !Number.isFinite(r.heLon)) return false;
      if (Math.abs(r.leLat) < 1e-6 && Math.abs(r.leLon) < 1e-6) return false;
      if (Math.abs(r.heLat) < 1e-6 && Math.abs(r.heLon) < 1e-6) return false;
      if (Math.abs(r.leLat) > 90 || Math.abs(r.heLat) > 90) return false;
      const dLe = Math.hypot((r.leLat - ap.lat) * 111.132, (r.leLon - ap.lon) * 111.132 * Math.cos(ap.lat * Math.PI / 180));
      const dHe = Math.hypot((r.heLat - ap.lat) * 111.132, (r.heLon - ap.lon) * 111.132 * Math.cos(ap.lat * Math.PI / 180));
      return Math.max(dLe, dHe) <= 30;
    });
    if (ap.runways.length !== before) {
      console.log(`  · ${s.icao} 剔除 ${before - ap.runways.length} 条无效跑道（坐标缺失或远离机场）`);
    }
    if (!ap.runways.length) console.warn(`  ! ${s.icao} 无可用跑道数据`);
    return ap;
  });

  const header = `/**
 * Pixel Radar · 机场与跑道数据
 * ==================================================================
 * 本文件由 scripts/build-data.mjs 生成，请勿手工编辑。
 * 生成时间：${new Date().toISOString()}
 *
 * 数据来源：OurAirports（https://ourairports.com/data/）
 * 许可：Public Domain
 * 字段说明：
 *   icao/iata  机场代码        lat/lon  机场参考点（WGS84 十进制度）
 *   elevFt     标高（英尺）    tz       IANA 时区名（本地时间由浏览器换算）
 *   runways[]  le/he 跑道两端识别号，leLat/leLon 与 heLat/heLon 为两端真实坐标，
 *              hdg 为磁偏修正后的真航向（度），lenFt/widFt 为长宽（英尺）
 *
 * 共 ${list.length} 个机场，${list.reduce((n, a) => n + a.runways.length, 0)} 条跑道。
 */

`;

  // 每个机场一行。这是生成的数据文件，不需要 2 空格缩进的人肉可读排版 ——
  // 逐字段展开会让文件膨胀到 1100+ 行，而它其实只有 20 条记录。
  const rows = list.map((a) => `  ${JSON.stringify(a)},`).join('\n');

  const body = `export const AIRPORTS = [\n${rows}\n];\n\n`
    + `export const AIRPORT_BY_ICAO = Object.fromEntries(AIRPORTS.map((a) => [a.icao, a]));\n\n`
    + `export const AIRPORT_BY_IATA = Object.fromEntries(AIRPORTS.map((a) => [a.iata, a]));\n`;

  await writeFile(resolve(DATA_DIR, 'airports.js'), header + body, 'utf8');

  const rw = list.reduce((n, a) => n + a.runways.length, 0);
  console.log(`  ✓ airports.js  ${list.length} 机场 / ${rw} 跑道`);
  return list;
}

/* ================================================================
 * 2) 地理形状（海岸线 / 建成区 / 湖泊）
 * ================================================================ */

async function buildShapes(airports) {
  console.log('\n[2/2] 地理形状');

  const [coast, urban, lakes] = await Promise.all([
    getJson(`${NE}ne_10m_coastline.geojson`),
    getJson(`${NE}ne_10m_urban_areas.geojson`),
    getJson(`${NE}ne_10m_lakes.geojson`),
  ]);

  /** 预先抽稀全球数据并预计算包围盒，避免对每个机场重复做功 */
  const prepLine = (fc, tol) => fc.features
    .flatMap((f) => geometryRings(f.geometry).map((r) => simplify(r, tol)))
    .filter((r) => r.length >= 4)
    .map((flat) => ({ flat, box: bboxFlat(flat) }));

  const prepRing = (fc, tol) => fc.features
    .flatMap((f) => geometryRings(f.geometry)
      .map((r) => closeRing(simplify(r, tol)))
      .filter((r) => r.length / 2 >= MIN_RING_PTS))
    .map((flat) => ({ flat, box: bboxFlat(flat) }));

  console.log('  · 预抽稀海岸线…');
  const coastLines = prepLine(coast, TOL_COAST);
  console.log(`    ${coastLines.length} 条线 / ${coastLines.reduce((n, l) => n + l.flat.length / 2, 0)} 顶点`);
  console.log('  · 预抽稀建成区…');
  const urbanRings = prepRing(urban, TOL_URBAN);
  console.log(`    ${urbanRings.length} 个环 / ${urbanRings.reduce((n, r) => n + r.flat.length / 2, 0)} 顶点`);
  console.log('  · 预抽稀湖泊…');
  const lakeRings = prepRing(lakes, TOL_LAKES);
  console.log(`    ${lakeRings.length} 个环 / ${lakeRings.reduce((n, r) => n + r.flat.length / 2, 0)} 顶点`);

  const shapes = {};
  for (const ap of airports) {
    const box = boxOf(ap.lat, ap.lon);

    const coastline = [];
    for (const item of coastLines) {
      if (!bboxHit(item.box, box)) continue;
      for (const seg of clipLine(item.flat, box)) coastline.push(seg);
    }

    // 面要素要真正裁剪多边形，而不是「整环收编」——
    // 否则大都市（纽约、伦敦、北京）的建成区环会带着几百公里外的顶点进来
    const urbanOut = [];
    for (const item of urbanRings) {
      if (!bboxHit(item.box, box)) continue;
      const c = clipPolygon(item.flat, box);
      if (c) urbanOut.push(c);
    }
    const lakesOut = [];
    for (const item of lakeRings) {
      if (!bboxHit(item.box, box)) continue;
      const c = clipPolygon(item.flat, box);
      if (c) lakesOut.push(c);
    }

    shapes[ap.icao] = { coastline, urban: urbanOut, lakes: lakesOut };
  }

  /**
   * 按机场拆分为独立模块。
   * 理由：全量合并约 500KB，而任一时刻只需一个机场（最大约 42KB）。
   * 拆分后首屏 geography 开销降一个数量级，且天然支持动态 import 懒加载。
   */
  const shapesDir = resolve(DATA_DIR, 'shapes');
  await mkdir(shapesDir, { recursive: true });

  const fileHeader = (icao, ap) => `/**
 * Pixel Radar · ${icao} 地理形状（按机场裁剪）
 * ==================================================================
 * 由 scripts/build-data.mjs 生成，请勿手工编辑。
 * 中心：${ap.cn} ${ap.en}（${ap.lat.toFixed(4)}, ${ap.lon.toFixed(4)}）
 * 来源：Natural Earth 1:10m（Public Domain）
 * 坐标：扁平数组 [lon0, lat0, lon1, lat1, ...]，量化到 ${PREC} 位小数
 * 裁剪：±${CLIP_DEG}°（约 ±178km），Douglas–Peucker 容差
 *       海岸线 ${TOL_COAST}° / 建成区 ${TOL_URBAN}° / 湖泊 ${TOL_LAKES}°
 */

`;

  let totalBytes = 0;
  const sizes = [];
  for (const ap of airports) {
    const s = shapes[ap.icao];
    const body = `export const ICAO = '${ap.icao}';\n`
      + `export const CENTER = [${ap.lat}, ${ap.lon}];\n`
      + `export const CLIP_DEG = ${CLIP_DEG};\n`
      + `export const COASTLINE = ${JSON.stringify(s.coastline)};\n`
      + `export const URBAN = ${JSON.stringify(s.urban)};\n`
      + `export const LAKES = ${JSON.stringify(s.lakes)};\n`;
    const text = fileHeader(ap.icao, ap) + body;
    await writeFile(resolve(shapesDir, `${ap.icao}.js`), text, 'utf8');
    const b = Buffer.byteLength(text, 'utf8');
    totalBytes += b;
    sizes.push([ap.icao, b]);
  }

  sizes.sort((a, b) => b[1] - a[1]);

  const indexHeader = `/**
 * Pixel Radar · 地理形状索引
 * ==================================================================
 * 由 scripts/build-data.mjs 生成，请勿手工编辑。
 * 生成时间：${new Date().toISOString()}
 *
 * 每个机场一个模块，动态 import 按需加载。
 * 顺序即机场清单顺序；SHAPE_SIZE_KB 供性能预算自检使用。
 */

`;
  const indexBody = `export const SHAPE_ICAS = [\n`
    + airports.map((a) => `  '${a.icao}',`).join('\n')
    + `\n];\n\n`
    + `export const SHAPE_SIZE_KB = ${JSON.stringify(Object.fromEntries(sizes.map(([k, b]) => [k, +(b / 1024).toFixed(1)]))) };\n\n`
    + `const LOADERS = {\n`
    + airports.map((a) => `  ${a.icao}: () => import('./${a.icao}.js'),`).join('\n')
    + `\n};\n\n`
    + `/** 按需加载某机场的地理形状；未知机场返回 null 而不是抛错 */\n`
    + `export function loadShapes(icao) {\n`
    + `  const fn = LOADERS[icao];\n`
    + `  return fn ? fn() : Promise.resolve(null);\n`
    + `}\n\n`
    + `export function hasShapes(icao) {\n`
    + `  return Object.prototype.hasOwnProperty.call(LOADERS, icao);\n`
    + `}\n`;

  await writeFile(resolve(shapesDir, 'index.js'), indexHeader + indexBody, 'utf8');

  console.log(`  ✓ shapes/  ${airports.length} 个模块 / 合计 ${(totalBytes / 1024).toFixed(0)} KB`
    + ` / 最大 ${sizes[0][0]} ${(sizes[0][1] / 1024).toFixed(1)} KB`);
  return totalBytes;
}

/* ================================================================
 * 主流程
 * ================================================================ */

async function main() {
  const argv = process.argv.slice(2);
  const onlyShapes = argv.includes('--only-shapes');
  const onlyAirports = argv.includes('--only-airports');

  await mkdir(DATA_DIR, { recursive: true });

  let airports;
  if (onlyShapes) {
    const mod = await import(new URL('../src/data/airports.js', import.meta.url).href);
    airports = mod.AIRPORTS;
    console.log(`复用现有 airports.js：${airports.length} 个机场`);
  } else {
    airports = await buildAirports();
  }

  if (!onlyAirports) await buildShapes(airports);

  console.log('\n完成。');
}

main().catch((e) => {
  console.error('\n构建失败：', e.message);
  process.exit(1);
});
