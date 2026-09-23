/**
 * Pixel Radar · 快照采集
 * ===============================================================
 * 为什么需要它：上游 ADS-B 聚合源不发 CORS 头，浏览器直连不了。
 * 但「服务端去取」完全没有这个问题 —— 于是我们把实时数据
 * 定期落成静态 JSON，前端同源读取，零后端、零跨域、零密钥。
 *
 * 这是本项目唯一的网络出口，所以它对上游要足够礼貌：
 *   · 串行请求，默认间隔 1.1 秒（上游建议 1 req/s）；
 *   · 失败指数退避，不重试风暴；
 *   · 逐机场写入，某个机场失败不影响其它机场。
 *
 * 用法：
 *   node scripts/collect.mjs                        采集全部 20 个机场
 *   node scripts/collect.mjs --icao=ZBAA,ZSPD       只采指定的
 *   node scripts/collect.mjs --radius=80            指定半径（海里）
 *   node scripts/collect.mjs --watch=300            每 300 秒循环采集
 *   node scripts/collect.mjs --out=../data/branch   自定义输出目录
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* 复用前端的归一化与几何（纯函数、零依赖，Node 可直接导入）：
 * OpenSky 的 states 行要转成与 readsb 同构的原始帧，绝不另写一份映射 ——
 * 两份映射迟早会漂移，而漂移只表现为「兜底数据字段莫名缺失」。 */
import { openSkyToRaw } from '../src/data/normalize.js';
import { bboxAround } from '../src/data/units.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ── 参数 ── */
const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const ONLY = (argOf('icao') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const RADIUS_NM = Math.max(5, Math.min(250, Number(argOf('radius', 50)) || 50));
const OUT_DIR = resolve(ROOT, argOf('out', 'data/snapshots'));
const WATCH = argOf('watch');
const WATCH_SEC = WATCH === null ? 0 : Math.max(60, Number(WATCH) || 300);
/**
 * 请求间隔。默认 2 秒，比上游「1 req/s」的建议更保守 —— 原因见下方
 * EMPTY_PROBE_MS 的注释：轻度过载时上游不报错，而是悄悄返回空集，
 * 所以宁可慢一点，也不要在采集结果里混进「假空域」。
 */
const INTERVAL_MS = Math.max(200, Number(argOf('interval', 2000)) || 2000);
const MAX_RETRY = 3;
/** 收到空结果时的复核等待（毫秒）：用来区分「限流」与「真的没覆盖」 */
const EMPTY_PROBE_MS = 6000;
/**
 * 重试轮：主轮结束后，对「出错」与「全空」的机场再补采的次数与间隔。
 *
 * 为什么必须有：实测一轮 20 个机场里 KSFO/YSSY 会吃到 HTTP 403
 * （adsb.lol 静默限流的硬形态），而 ZSPD/ZUUU 在 adsb.lol 上是真空集 ——
 * 旧代码对这两种情况都直接定稿，前端拿到空快照就降级到「模拟数据」，
 * 于是这两个机场**永远显示假数据**。失败是暂态的，隔半分钟再问一次
 * 通常就能救回来；救不回来的才让它带着 error 进 index。
 */
const RETRY_PASSES = 2;
const RETRY_DELAY_MS = 30000;
/** 上游聚合源；按顺序尝试，第一个出数据的即用 */
const UPSTREAMS = [
  { id: 'adsb.lol', url: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${nm}` },
  { id: 'airplanes.live', url: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${nm}` },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/* ── 机场清单 ──
 * Windows 上动态 import 只接受 file:// URL，直接给绝对路径会报
 * ERR_UNSUPPORTED_ESM_URL_SCHEME，必须过 pathToFileURL。 */
const { AIRPORTS } = await import(pathToFileURL(resolve(ROOT, 'src/data/airports.js')).href);

/* ── 单次拉取 ── */
/** 对单个上游拉取（含重试与退避）。空结果**不算失败**，由上层决定怎么换源。 */
async function fetchOne(ap, up) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      const res = await fetch(up.url(ap.lat, ap.lon, RADIUS_NM), {
        signal: ctl.signal,
        headers: { 'User-Agent': 'pixel-radar/0.1 (static radar snapshot collector)' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.ac)) throw new Error('响应结构异常：缺少 ac 数组');
      return { ac: json.ac, total: json.total ?? json.ac.length };
    } catch (e) {
      lastErr = e;
      /**
       * airplanes.live 的 403 是「未报备客户端」的准入拒绝，不是限流 ——
       * 重试只会白烧几十秒退避（5s→10s→20s），所以见到 403 立即放弃该上游。
       * adsb.lol 的 403 则是限流的硬形态，仍按退避重试。
       */
      if (up.id === 'airplanes.live' && /\b403\b/.test(e.message)) break;
      // 403 / 429 是明确的限流信号，退避要更狠
      const isThrottle = /\b(403|429)\b/.test(e.message);
      if (attempt < MAX_RETRY - 1) await sleep((isThrottle ? 5000 : 1000) * 2 ** attempt);
    }
  }
  throw lastErr || new Error('上游失败');
}

/**
 * 带「空结果复核」的单上游采集。
 *
 * 为什么需要复核：实测 adsb.lol 在轻度过载时**不返回错误码**，
 * 而是 HTTP 200 + 空 ac 数组（`{"ac":[],"msg":"No error","total":0}`）。
 * 这与「该空域真的没有接收站覆盖」在响应上完全无法区分。
 * 若不复核，采集结果里会混进一批「假空域」快照，前端会显示成空白雷达。
 * 因此收到空结果先等 6 秒再问一次：两次都空才认定是**该上游**无数据。
 */
async function fetchWithEmptyCheck(ap, up) {
  const first = await fetchOne(ap, up);
  if (first.total > 0) return { ...first, coverageGap: false };

  await sleep(EMPTY_PROBE_MS);
  const second = await fetchOne(ap, up);
  if (second.total > 0) return { ...second, coverageGap: false, recoveredFromEmpty: true };

  return { ...second, coverageGap: true };
}

/**
 * OpenSky 兜底（bbox 查询）：匿名额度 400 credits/天，字段略少但真实。
 * 只在 adsb.lol / airplanes.live 都空或都失败时才动用 ——
 * 这正是 ZSPD/ZUUU 的情况（adsb.lol 对华东无覆盖），没有它这两个
 * 机场的快照恒为空，前端只能降级到模拟数据。
 */
async function fetchOpenSky(ap) {
  const b = bboxAround(ap.lat, ap.lon, RADIUS_NM * 1.852);
  const url = `https://opensky-network.org/api/states/all`
    + `?lamin=${b.latMin.toFixed(4)}&lomin=${b.lonMin.toFixed(4)}`
    + `&lamax=${b.latMax.toFixed(4)}&lomax=${b.lonMax.toFixed(4)}`;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { 'User-Agent': 'pixel-radar/0.1 (static radar snapshot collector)' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const rows = Array.isArray(json.states) ? json.states : [];
      const ac = rows.map(openSkyToRaw).filter(Boolean);
      return { ac, total: ac.length };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRY - 1) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr || new Error('OpenSky 失败');
}

/**
 * 单个机场的完整取数链：
 *   adsb.lol（含空复核）→ airplanes.live（含空复核）→ OpenSky bbox
 * 任一上游给出非空数据立即返回；全部为空才算 coverageGap；
 * 全部出错（如限流 403 贯穿始终）才抛错，交给重试轮。
 *
 * 旧实现的缺陷：空结果直接定稿、从不换源 —— 「adsb.lol 对上海是空集」
 * 与「adsb.lol 正在静默限流」被混为一谈，前者换源能救，后者重试能救，
 * 唯独「不换源也不重试」救不了。
 */
async function collectAirport(ap) {
  const empties = [];
  let lastErr = null;

  for (const up of UPSTREAMS) {
    try {
      const r = await fetchWithEmptyCheck(ap, up);
      if (r.total > 0) {
        return {
          upstream: up.id, ac: r.ac, total: r.total,
          coverageGap: false, recoveredFromEmpty: !!r.recoveredFromEmpty,
        };
      }
      empties.push(up.id);
    } catch (e) {
      lastErr = e;
    }
  }

  try {
    const os = await fetchOpenSky(ap);
    if (os.total > 0) {
      return { upstream: 'opensky', ac: os.ac, total: os.total, coverageGap: false, viaOpensky: true };
    }
    empties.push('opensky');
  } catch (e) {
    lastErr = e;
  }

  if (empties.length) {
    return { upstream: empties.join('+'), ac: [], total: 0, coverageGap: true };
  }
  throw lastErr || new Error('全部上游失败');
}

/* ── 一轮采集 ── */
async function runOnce(tag) {
  const list = ONLY.length ? AIRPORTS.filter((a) => ONLY.includes(a.icao)) : AIRPORTS;
  if (!list.length) {
    console.error(`没有匹配的机场：${ONLY.join(',')}`);
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });

  const index = [];
  let ok = 0;
  let fail = 0;

  console.log(`[${tag}] 采集 ${list.length} 个机场 · 半径 ${RADIUS_NM}nm · 输出 ${OUT_DIR}`);

  /** 落盘一个机场的快照并返回 index 条目 */
  async function writeAirport(ap, r) {
    const payload = {
      icao: ap.icao,
      iata: ap.iata,
      name: ap.cn,
      fetchedAt: Date.now(),
      fetchedAtIso: new Date().toISOString(),
      source: r.upstream,
      radiusNm: RADIUS_NM,
      center: { lat: ap.lat, lon: ap.lon },
      count: r.ac.length,
      /** true 表示三层上游复核后均为空：该空域确实没有接收覆盖 */
      coverageGap: !!r.coverageGap,
      ac: r.ac,
    };
    await writeFile(resolve(OUT_DIR, `${ap.icao}.json`), JSON.stringify(payload), 'utf8');
    return {
      icao: ap.icao, count: r.ac.length, fetchedAt: payload.fetchedAt,
      source: r.upstream, coverageGap: !!r.coverageGap,
    };
  }

  /** 待重试清单：主轮里「出错」与「全空」的机场，重试轮原位更新 index */
  const pending = [];

  for (let i = 0; i < list.length; i++) {
    const ap = list[i];
    const label = `${String(i + 1).padStart(2)}/${list.length} ${ap.icao}`;
    try {
      const r = await collectAirport(ap);
      const entry = await writeAirport(ap, r);
      index[i] = entry;
      const note = r.coverageGap ? '  ⚠ 无接收覆盖'
        : r.recoveredFromEmpty ? '  ↻ 复核后恢复'
          : r.viaOpensky ? '  ◇ OpenSky 兜底' : '';
      console.log(`  ${label}  ✓ ${String(r.ac.length).padStart(4)} 架  via ${r.upstream}${note}`);
      ok++;
      if (r.coverageGap) pending.push({ i, ap, reason: 'gap' });
    } catch (e) {
      console.log(`  ${label}  ✗ ${e.message}`);
      index[i] = { icao: ap.icao, count: 0, error: e.message };
      fail++;
      pending.push({ i, ap, reason: 'error' });
    }
    if (i < list.length - 1) await sleep(INTERVAL_MS);
  }

  const writeIndex = async () => {
    // 计数不靠增量维护 —— 重试轮里一条记录的状态可能多次翻转
    // （error → 恢复 → 又变 gap），增量迟早错账。以 index 为准重算。
    fail = index.filter((e) => e && e.error).length;
    ok = list.length - fail;
    const meta = {
      generatedAt: Date.now(),
      generatedAtIso: new Date().toISOString(),
      radiusNm: RADIUS_NM,
      ok,
      fail,
      airports: index.filter(Boolean),
    };
    await writeFile(resolve(OUT_DIR, 'index.json'), JSON.stringify(meta, null, 2), 'utf8');
  };
  await writeIndex();

  /**
   * 重试轮：只补「出错」与「全空」的机场，恢复即原位覆盖 index 条目。
   *
   * 为什么单独一轮：主轮里 KSFO/YSSY 吃到 403（限流）、ZSPD/ZUUU 撞上
   * adsb.lol 空集时，旧实现直接定稿 —— 空快照让前端降级到模拟数据，
   * 这两个机场于是**永远显示假数据**。失败多是暂态，隔半分钟再问
   * 通常能救回来；复查仍空才放行（三层上游都空两遍 ≈ 真实覆盖缺口）。
   */
  for (let pass = 1; pass <= RETRY_PASSES && pending.length; pass++) {
    await sleep(RETRY_DELAY_MS);
    console.log(`[${tag}] 重试 ${pass}/${RETRY_PASSES}：${pending.map((p) => p.ap.icao).join(', ')}`);
    for (let k = pending.length - 1; k >= 0; k--) {
      const { i, ap, reason } = pending[k];
      const label = `↻${pass} ${ap.icao}`;
      try {
        const r = await collectAirport(ap);
        index[i] = await writeAirport(ap, r);
        console.log(`  ${label}  ✓ ${String(r.ac.length).padStart(4)} 架  via ${r.upstream}`
          + (r.coverageGap ? '  ⚠ 仍无覆盖' : '  已恢复'));
        if (reason === 'gap' || !r.coverageGap) pending.splice(k, 1);
      } catch (e) {
        console.log(`  ${label}  ✗ ${e.message}`);
        index[i] = { icao: ap.icao, count: 0, error: e.message };
        if (reason === 'gap') pending[k].reason = 'error'; // 空复查中途出错 → 升级为 error 继续下一轮
      }
      await sleep(INTERVAL_MS);
    }
    await writeIndex();
  }

  fail = index.filter((e) => e && e.error).length;
  ok = list.length - fail;
  console.log(`[${tag}] 完成：成功 ${ok} / 失败 ${fail}`);
  return { ok, fail };
}

/* ── 入口 ── */
if (WATCH_SEC > 0) {
  console.log(`守护模式：每 ${WATCH_SEC} 秒采集一轮，Ctrl+C 停止`);
  let round = 0;
  // 用 while 而非 setInterval：一轮没跑完就不开下一轮，避免请求叠加
  for (;;) {
    round++;
    try {
      await runOnce(`第 ${round} 轮 ${stamp()}`);
    } catch (e) {
      console.error('本轮异常：', e.message);
    }
    await sleep(WATCH_SEC * 1000);
  }
} else {
  const { fail } = await runOnce(stamp());
  // 全部失败说明上游或网络有问题，用非零退出码让 CI 察觉
  process.exit(fail > 0 && fail === (ONLY.length || AIRPORTS.length) ? 1 : 0);
}
