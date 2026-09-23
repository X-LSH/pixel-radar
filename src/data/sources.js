/**
 * Pixel Radar · 数据源适配层
 * ---------------------------------------------------------------
 * 每个数据源都实现同一个契约，管线只按顺序试，不关心细节：
 *
 *   {
 *     id, label, license,
 *     kind: 'remote' | 'static' | 'local',
 *     run(ctx, signal) -> Promise<{ records, sourceId, fetchedAt, note? }>
 *   }
 *
 * ⚠ 关于 CORS 的现实（2026-09 实测，见 README「数据源现状」一节）：
 *   上游 ADS-B 聚合源（adsb.lol / airplanes.live）**不发送
 *   Access-Control-Allow-Origin**，浏览器无法直连。
 *   airplanes.live 已对未报备客户端返回 403，OpenSky 只允许自身来源。
 *   因此「直接聚合源」这条路径保留但预期失败，真正的实时通路是
 *   用户自备中继；静态快照则用于零配置开箱可用。
 */

import { POLL, SOURCES } from '../config.js';
import { extractRecords, openSkyToRaw } from './normalize.js';
import { bboxAround } from './units.js';

/* ================================================================
 * 通用 fetch
 * ================================================================ */

export class FetchError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'FetchError';
    this.kind = kind || 'network';
  }
}

/**
 * 带超时的 JSON 拉取。
 * 明确区分「网络失败」与「被 CORS 拦截」—— 后者在浏览器里
 * 只能看到一个笼统的 TypeError，因此这里把它翻译成可读原因。
 */
export async function fetchJson(url, { signal, timeoutMs = POLL.timeoutMs, headers } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctl.abort(signal && signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers,
    });
    if (!res.ok) throw new FetchError(`HTTP ${res.status}`, res.status === 429 ? 'ratelimit' : 'http');
    return await res.json();
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if (e && e.name === 'AbortError') {
      // 区分「我们主动超时」与「上层取消」
      if (signal && signal.aborted) throw new FetchError('已取消', 'abort');
      throw new FetchError('请求超时', 'timeout');
    }
    // 浏览器把 CORS 失败也报成 TypeError，无法进一步区分
    throw new FetchError('网络不可达或被跨域策略拦截', 'cors');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/* ================================================================
 * 各数据源
 * ================================================================ */

/**
 * 自备中继（推荐通路）。
 * 契约：GET {relay}?lat=<lat>&lon=<lon>&nm=<radius>
 *       返回上游原始 JSON（含 ac 数组）或 { planes: [...] } 或裸数组。
 * 若 URL 内含 {lat}/{lon}/{nm} 占位符，则按占位符拼接（兼容现成 Worker）。
 */
export function relaySource(getUrl) {
  return {
    id: 'relay',
    label: '自备中继',
    kind: 'remote',
    license: '由中继指向的上游决定',
    available: () => !!getUrl(),
    async run(ctx, signal) {
      const base = getUrl();
      if (!base) throw new FetchError('未配置中继地址', 'config');
      const lat = ctx.lat.toFixed(4);
      const lon = ctx.lon.toFixed(4);
      const nm = String(Math.min(POLL.maxRadiusNm, Math.round(ctx.radiusNm)));

      const url = /\{lat\}|\{lon\}|\{nm\}/.test(base)
        ? base.replace(/\{lat\}/g, lat).replace(/\{lon\}/g, lon).replace(/\{nm\}/g, nm)
        : `${base}${base.includes('?') ? '&' : '?'}lat=${lat}&lon=${lon}&nm=${nm}`;

      const json = await fetchJson(url, { signal });
      const records = Array.isArray(json) ? json
        : Array.isArray(json.planes) ? json.planes
          : extractRecords(json);
      if (!records.length && !Array.isArray(json)) {
        throw new FetchError('中继返回了无法识别的结构', 'shape');
      }
      return {
        records,
        sourceId: String(json && json.source ? json.source : 'relay'),
        fetchedAt: Date.now(),
        note: `中继 · ${nm}nm`,
      };
    },
  };
}

/**
 * 静态快照。
 *
 * 取数策略（2026-09 重写，原因见下）：
 *   1. **多镜像并行竞速**：raw / jsDelivr / ghproxy 三个模板同时请求，
 *      先返回且足够新鲜（< snapshotFreshMs）的结果直接胜出；
 *      全部返回后仍未分出胜负，则取 fetchedAt 最新的一份。
 *   2. **仓库名推断不出时**（localhost 等），镜像用 fallbackRepo，
 *      同源快照一并参与竞速 —— 本地刚 collect 出的新鲜文件应当赢，
 *      6 天前的本地残留不应当赢（fetchedAt 比较天然解决）。
 *   3. **仓库名已知时**（GitHub Pages）不请求同源：线上必然 404，
 *      省掉每次加载一条控制台报错。
 *
 * 为什么从「先同源、再单个 raw 镜像」改成这样，两条实测教训：
 *   · raw.githubusercontent.com 在部分网络整体不可达 —— 单镜像 = 快照
 *     链路整体瘫痪 = 前端永远显示「模拟数据」（用户报的核心故障）；
 *   · 本地 data/snapshots 被 .gitignore 忽略，全新 clone 的同源路径
 *     必然 404，且旧代码在本地**不尝试镜像** —— 本地开发 100% 落模拟。
 */
/**
 * 已知不存在的快照路径与目录前缀（模块级：换机场 / 重建源链后
 * 「某 URL 404」依然成立，不该每个周期重复撞一次）。
 * 只记 404（路径不存在）；网络错误与超时属暂态，仍照常重试。
 */
const deadSnapshotUrls = new Set();
const deadSnapshotDirs = new Set();

export function snapshotSource(getConfig) {
  return {
    id: 'snapshot',
    label: '静态快照',
    kind: 'static',
    license: 'ODbL · adsb.lol（经快照）',
    available: () => true,
    async run(ctx, signal) {
      const cfg = getConfig();
      const repo = cfg.repo || '';
      const branch = cfg.branch || 'data';
      const sameOrigin = `${SOURCES.snapshotDir}/${ctx.icao}.json`;
      const build = (tpl) => tpl
        .replace('{repo}', repo || SOURCES.fallbackRepo)
        .replace('{branch}', branch)
        .replace('{icao}', ctx.icao);

      const candidates = SOURCES.mirrorTemplates
        .map(build)
        .filter((url) => !deadSnapshotUrls.has(url))
        .map((url) => ({ url, isMirror: true }));
      if ((!repo || !candidates.length) && !deadSnapshotDirs.has(SOURCES.snapshotDir)) {
        candidates.push({ url: sameOrigin, isMirror: false });
      }
      if (!candidates.length) {
        throw new FetchError('同源路径与镜像均无可用快照', 'notfound');
      }

      /** 统一打包返回值（成功候选的收口，早退与全量择优共用） */
      const pack = (win) => {
        const json = win.json;
        return {
          records: extractRecords(json),
          sourceId: `${json.source || 'snapshot'}${json.radiusNm ? ` · ${json.radiusNm}nm` : ''}`,
          fetchedAt: Number(json.fetchedAt) || Date.now(),
          note: win.isMirror ? '快照 · data 分支' : '快照 · 同源',
        };
      };

      /**
       * 并行发出，三层收口：
       *  · 结果足够新鲜（< snapshotFreshMs）→ 立即胜出，不等更慢的候选；
       *  · 首个成功到达 → 再开一个 snapshotGraceMs 的择优窗口，让慢镜像
       *    赶到后按 fetchedAt 择优，窗口到点取当前最优收口；
       *  · 全部 settle（窗口未开时）→ 直接择优。
       * 404 记入判死集合（镜像按 URL、同源按目录），下个周期不再请求。
       */
      return await new Promise((resolveRun, rejectRun) => {
        let pending = candidates.length;
        let best = null;
        let lastErr = null;
        let done = false;
        let graceTimer = 0;

        const markDead = (c, e) => {
          if (e instanceof FetchError && e.kind === 'http' && /HTTP 404/.test(e.message)) {
            if (c.isMirror) deadSnapshotUrls.add(c.url);
            else deadSnapshotDirs.add(SOURCES.snapshotDir);
          }
        };

        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(graceTimer);
          if (best) resolveRun(pack(best));
          else rejectRun(lastErr || new FetchError('无可用快照', 'notfound'));
        };

        const settle = (c, json, err) => {
          if (done) return;
          if (err) {
            markDead(c, err);
            lastErr = err;
          } else {
            const fa = Number(json.fetchedAt) || 0;
            if (!best || fa > best.fa) best = { json, isMirror: c.isMirror, fa };
            if (best.fa && Date.now() - best.fa <= SOURCES.snapshotFreshMs) return finish(); // 足够新鲜，先到先得
            if (!graceTimer) graceTimer = setTimeout(finish, SOURCES.snapshotGraceMs); // 首响开窗择优
          }
          if (--pending === 0) finish();
        };

        for (const c of candidates) {
          fetchJson(c.url, { signal, timeoutMs: SOURCES.snapshotTimeoutMs })
            .then((json) => settle(c, json, null))
            .catch((e) => settle(c, null, e));
        }
      });
    },
  };
}

/** 供自检与调试查看已判死的路径 */
export function deadSnapshotPaths() {
  return { dirs: [...deadSnapshotDirs], urls: [...deadSnapshotUrls] };
}

/**
 * 直接聚合源。
 * 保留这条路径的意义：一旦上游某天补上 CORS 头，或用户在
 * 支持关闭跨域限制的环境下运行，它就能直接工作。
 */
export function directSource() {
  return {
    id: 'direct',
    label: '直接聚合源',
    kind: 'remote',
    license: 'ODbL · adsb.lol',
    available: () => true,
    async run(ctx, signal) {
      const nm = Math.round(ctx.radiusNm);
      const url = SOURCES.direct.point(ctx.lat, ctx.lon, nm);
      const json = await fetchJson(url, { signal });
      return {
        records: extractRecords(json),
        sourceId: SOURCES.direct.label,
        fetchedAt: Date.now(),
        note: `${nm}nm`,
      };
    },
  };
}

/**
 * OpenSky Network（bbox 查询）。
 * 匿名额度 400 credits/天，字段比 adsb.lol 少（无机型、无垂直速率来源细分）。
 * 实测其 ACAO 只允许 opensky-network.org 自身，故浏览器直连通常失败。
 */
export function openSkySource() {
  return {
    id: 'opensky',
    label: 'OpenSky',
    kind: 'remote',
    license: 'CC BY 4.0 · OpenSky Network',
    available: () => true,
    async run(ctx, signal) {
      const b = bboxAround(ctx.lat, ctx.lon, ctx.radiusKm);
      const url = `https://opensky-network.org/api/states/all`
        + `?lamin=${b.latMin.toFixed(4)}&lomin=${b.lonMin.toFixed(4)}`
        + `&lamax=${b.latMax.toFixed(4)}&lomax=${b.lonMax.toFixed(4)}`;
      const json = await fetchJson(url, { signal, timeoutMs: 15000 });
      const rows = Array.isArray(json && json.states) ? json.states : [];
      const records = rows.map(openSkyToRaw).filter(Boolean);
      return {
        records,
        sourceId: 'opensky',
        fetchedAt: (Number(json && json.time) || Math.floor(Date.now() / 1000)) * 1000,
        note: 'bbox',
      };
    },
  };
}
