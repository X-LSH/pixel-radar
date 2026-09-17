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
 * 优先同源（本地 collect.mjs 产出 / 未来若提交到站点目录），
 * 再退到 raw.githubusercontent.com 直读 data 分支
 * —— 后者带 `Access-Control-Allow-Origin: *` 且缓存 5 分钟，
 * 与快照产出节奏吻合。
 */
/**
 * 已知不存在的快照路径与目录前缀。
 *
 * 为什么需要：降级链会先试同源路径（本地开发时确实存在），再退到 raw 镜像。
 * 线上站点没有同源快照，于是每次都撞一个 404 —— 既在浏览器控制台刷出报错，
 * 又白费一次请求。
 *
 * 两个设计要点，都是实测踩出来的：
 *  1. 放在**模块级**而不是 source 实例里：换机场 / 改配置 / 模拟态重试都会
 *     重建整条源链，「某路径不存在」是站点属性，不是某次探测的暂态。
 *  2. 按**目录前缀**记，而不是按单个 URL：实际的事实是「这个站点没有同源快照
 *     目录」，而不是「ZBAA 那个文件不在」。按单 URL 记的话，每换一个机场
 *     仍会各撞一次 404（线上实测恰好剩 2 条，就是 ZBAA + KJFK 各一次）。
 *
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
      const sameOrigin = `${SOURCES.snapshotDir}/${ctx.icao}.json`;
      const mirror = cfg.repo
        ? SOURCES.rawTemplate
          .replace('{repo}', cfg.repo)
          .replace('{branch}', cfg.branch || 'data')
          .replace('{icao}', ctx.icao)
        : null;

      /**
       * 顺序是刻意的：**有镜像时先走镜像**。
       *
       * 推断出仓库名意味着当前就在 GitHub Pages 上，而线上站点必然没有同源快照
       * （快照只存在于 data 分支），此时镜像才是权威源。
       * 若仍先试同源，就注定要为每个机场白撞一次 404 —— 那一条报错无法通过
       * 「记住失败」消除，因为不试一次就不知道它不存在。
       *
       * 本地开发时 detectRepo() 返回空串，repo 为 null，于是只走同源路径，
       * 行为与之前完全一致，也不会多出任何请求。
       */
      const candidates = [];
      if (mirror && !deadSnapshotUrls.has(mirror)) candidates.push({ url: mirror, isMirror: true });
      if (!deadSnapshotDirs.has(SOURCES.snapshotDir)) candidates.push({ url: sameOrigin, isMirror: false });

      if (!candidates.length) {
        throw new FetchError('同源路径与镜像均无可用快照', 'notfound');
      }

      let lastErr = null;
      for (const { url, isMirror } of candidates) {
        try {
          const json = await fetchJson(url, { signal, timeoutMs: 8000 });
          const records = extractRecords(json);
          const fetchedAt = Number(json.fetchedAt) || Date.now();
          return {
            records,
            sourceId: `${json.source || 'snapshot'}${json.radiusNm ? ` · ${json.radiusNm}nm` : ''}`,
            fetchedAt,
            note: isMirror ? '快照 · data 分支' : '快照 · 同源',
          };
        } catch (e) {
          if (e instanceof FetchError && e.kind === 'http' && /HTTP 404/.test(e.message)) {
            if (isMirror) deadSnapshotUrls.add(url);
            else deadSnapshotDirs.add(SOURCES.snapshotDir);
          }
          lastErr = e;
        }
      }
      throw lastErr || new FetchError('无可用快照', 'notfound');
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
