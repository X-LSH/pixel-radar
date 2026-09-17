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
/** 上游聚合源；按顺序尝试，第一个成功的即用 */
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
async function fetchUpstream(ap) {
  let lastErr = null;
  for (const up of UPSTREAMS) {
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
        return { upstream: up.id, ac: json.ac, total: json.total ?? json.ac.length };
      } catch (e) {
        lastErr = e;
        // 403 / 429 是明确的限流信号，退避要更狠
        const isThrottle = /\b(403|429)\b/.test(e.message);
        if (attempt < MAX_RETRY - 1) await sleep((isThrottle ? 5000 : 1000) * 2 ** attempt);
      }
    }
  }
  throw lastErr || new Error('全部上游失败');
}

/**
 * 带「空结果复核」的采集。
 *
 * 为什么需要复核：实测 adsb.lol 在轻度过载时**不返回错误码**，
 * 而是 HTTP 200 + 空 ac 数组（`{"ac":[],"msg":"No error","total":0}`）。
 * 这与「该空域真的没有接收站覆盖」在响应上完全无法区分。
 * 若不复核，采集结果里会混进一批「假空域」快照，前端会显示成空白雷达。
 * 因此收到空结果先等 6 秒再问一次：两次都空才认定是真实的覆盖缺口。
 */
async function fetchWithEmptyCheck(ap) {
  const first = await fetchUpstream(ap);
  if (first.total > 0) return { ...first, coverageGap: false };

  await sleep(EMPTY_PROBE_MS);
  const second = await fetchUpstream(ap);
  if (second.total > 0) return { ...second, coverageGap: false, recoveredFromEmpty: true };

  return { ...second, coverageGap: true };
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

  for (let i = 0; i < list.length; i++) {
    const ap = list[i];
    const label = `${String(i + 1).padStart(2)}/${list.length} ${ap.icao}`;
    try {
      const { upstream, ac, coverageGap, recoveredFromEmpty } = await fetchWithEmptyCheck(ap);
      const payload = {
        icao: ap.icao,
        iata: ap.iata,
        name: ap.cn,
        fetchedAt: Date.now(),
        fetchedAtIso: new Date().toISOString(),
        source: upstream,
        radiusNm: RADIUS_NM,
        center: { lat: ap.lat, lon: ap.lon },
        count: ac.length,
        /** true 表示两次探测均为空：该空域在上游网络中确实没有接收覆盖 */
        coverageGap: !!coverageGap,
        ac,
      };
      await writeFile(resolve(OUT_DIR, `${ap.icao}.json`), JSON.stringify(payload), 'utf8');
      const note = coverageGap ? '  ⚠ 无接收覆盖'
        : recoveredFromEmpty ? '  ↻ 复核后恢复' : '';
      console.log(`  ${label}  ✓ ${String(ac.length).padStart(4)} 架  via ${upstream}${note}`);
      index.push({ icao: ap.icao, count: ac.length, fetchedAt: payload.fetchedAt, source: upstream, coverageGap: !!coverageGap });
      ok++;
    } catch (e) {
      console.log(`  ${label}  ✗ ${e.message}`);
      index.push({ icao: ap.icao, count: 0, error: e.message });
      fail++;
    }
    if (i < list.length - 1) await sleep(INTERVAL_MS);
  }

  const meta = {
    generatedAt: Date.now(),
    generatedAtIso: new Date().toISOString(),
    radiusNm: RADIUS_NM,
    ok,
    fail,
    airports: index,
  };
  await writeFile(resolve(OUT_DIR, 'index.json'), JSON.stringify(meta, null, 2), 'utf8');

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
