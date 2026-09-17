/**
 * Pixel Radar · 主控
 * ---------------------------------------------------------------
 * 职责：把 store / stage / pipeline / 界面 / 输入缝合起来，并驱动主循环。
 *
 * 启动顺序是有讲究的：
 *   1. 先按「时区推荐」或上次选择确定机场；
 *   2. 再加载该机场的地理形状（按需动态 import，只有它自己的那份）；
 *   3. 然后给数据管线一个有限预算尝试真实源，失败才上模拟；
 *   4. 最后撤掉启动幕。
 * 这样用户看到的是一块已经就位的雷达屏，而不是「先空转再慢慢长出来」。
 */

import { PERF, VIEW, CLAMP } from './config.js';
import { createStore } from './state/store.js';
import { createStage } from './render/stage.js';
import { computeStats } from './render/planes.js';
import { createPipeline } from './data/pipeline.js';
import { createChrome } from './ui/chrome.js';
import { createInfoCard } from './ui/infocard.js';
import { createPicker, recommendAirport } from './ui/picker.js';
import { bindInputs } from './ui/inputs.js';
import { exportPng } from './ui/export-png.js';
import { installDevHooks } from './dev-hooks.js';
import { AIRPORT_BY_ICAO } from './data/airports.js';
import { loadShapes } from './data/shapes/index.js';
import { kmToNm } from './data/units.js';

const $ = (id) => document.getElementById(id);

/**
 * 推断当前站点所属的 GitHub 仓库，用于直读 data 分支的快照。
 *
 * 为什么放到运行时推断而不是写死：同一份源码要同时跑在
 * `localhost`（只用同源快照）和 `x-lsh.github.io/pixel-radar`
 * （要读 data 分支）上，任何写死的仓库名都会让其中一个环境失效。
 * 非 github.io 域名一律返回空串，此时快照只走同源路径。
 */
function detectRepo() {
  const m = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
  if (!m) return '';
  const seg = location.pathname.split('/').filter(Boolean);
  // 用户主页仓库（x-lsh.github.io/）与项目仓库（x-lsh.github.io/repo/）两种情况
  return seg.length ? `${m[1]}/${seg[0]}` : `${m[1]}/${m[1]}.github.io`;
}

async function boot() {
  const store = createStore();
  const settings = store.get();

  /* ── 1) 机场 ── */
  const saved = AIRPORT_BY_ICAO[settings.airportIcao];
  const airport = saved || recommendAirport();
  store.set({ airportIcao: airport.icao }, { silent: true });
  store.set({ airport }, { silent: true });

  /* ── 2) 舞台 ── */
  const canvas = $('screen');
  const stage = createStage({ canvas, settings });

  /* ── 3) 界面 ──
   * actions 必须先以**同一个对象引用**交给 chrome，之后再填充实现。
   * 如果在这里传字面量 {}，chrome 闭包捕获的就是那个空对象，
   * 后定义的 actions 根本无法被感知 —— 所有按钮都会静默失效。 */
  const actions = {};
  const chrome = createChrome({ store, actions });
  const card = createInfoCard({ store });
  const viewport = $('viewport');

  /* ── 会话态 ── */
  let frame = [];
  let hoverHex = null;
  let selectedHex = store.get().selectedHex;
  let followHex = store.get().followHex;
  let statsAcc = 0;
  let fps = 60;
  let booted = false;

  /* ── 4) 数据管线 ── */
  const pipeline = createPipeline({
    store,
    getRelayUrl: () => store.get().relayUrl,
    getAirport: () => store.get().airport,
    getSnapshotConfig: () => ({ repo: detectRepo(), branch: 'data' }),
    getRadiusNm: () => {
      const v = stage.view;
      const r = stage.resolution;
      const viewRadiusKm = Math.hypot(r.w / 2, r.h / 2) * v.kmPerPx;
      return CLAMP(Math.round(kmToNm(viewRadiusKm) * 1.15), 10, 250);
    },
  });

  /* ── 5) 动作 ── */
  Object.assign(actions, {
    openPicker: () => picker.open(),
    togglePause: () => {
      const next = !store.get().paused;
      store.set({ paused: next });
      chrome.setStatus(statusOf());
    },
    resetView: () => {
      stage.resetView();
      setFollow(null);
      chrome.setStatus(statusOf());
    },
    screenshot: () => exportPng({
      canvas,
      resolution: stage.resolution,
      airport: store.get().airport,
      ringKm: store.get().ringKm,
      feed: store.get().feed,
    }),
    toggleFullscreen: () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {
          chrome.refs.fullBtn.title = '浏览器拒绝了全屏请求';
        });
      } else {
        document.exitFullscreen?.();
      }
    },
    setPanelOpen: (open) => {
      store.set({ panelOpen: open });
      chrome.setPanelOpen(open);
      requestAnimationFrame(() => handleResize());
    },
    setRing: (km) => {
      if (!VIEW.rings.includes(km)) return;
      store.set({ ringKm: km });
      stage.setRing(km);
      chrome.syncControls(store.get());
      chrome.setStatus(statusOf());
    },
    zoomBy: (dir, anchor) => {
      const idx = store.get().zoomIndex + dir;
      const clamped = CLAMP(idx, 0, VIEW.zoomMults.length - 1);
      if (clamped === store.get().zoomIndex && dir !== 0) return;
      store.set({ zoomIndex: clamped });
      stage.zoomTo(clamped, anchor);
      chrome.setStatus(statusOf());
    },
    setScale: (v) => {
      store.set({ scale: v });
      handleResize();
      chrome.syncControls(store.get());
    },
    setToggle: (key, val) => {
      store.set({ [key]: val });
      if (key === 'crt') chrome.setCrtEnabled(val);
    },
    saveRelay: (url) => {
      store.set({ relayUrl: url });
      chrome.syncControls(store.get());
      pipeline.notifyConfigChanged();
    },
    getRelayUrl: () => store.get().relayUrl,
    getFollow: () => followHex,
    setFollow: (hex) => setFollow(hex),
    setSelected: (hex) => setSelected(hex),
    hover: (x, y, clientX, clientY) => {
      const item = stage.pick(x, y, frame, 14);
      const next = item ? item.hex : null;
      if (next !== hoverHex) {
        hoverHex = next;
        canvas.style.cursor = next ? 'pointer' : '';
      }
    },
    pickAtClient: (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const s = stage.resolution.scale;
      return stage.pick((clientX - rect.left) / s, (clientY - rect.top) / s, frame, 16);
    },
    zoom: (dir, anchor) => actions.zoomBy(dir, anchor),
  });

  const picker = createPicker({
    current: () => store.get().airport.icao,
    onPick: (ap) => selectAirport(ap),
  });

  bindInputs({
    canvas,
    stage,
    actions,
    isPickerOpen: () => picker.isOpen(),
  });

  $('unfollowBtn').addEventListener('click', () => setFollow(null));

  /* ── 选择 / 跟随 ── */
  function setSelected(hex) {
    selectedHex = hex;
    store.set({ selectedHex: hex }, { silent: true });
    if (!hex) hoverHex = null;
  }

  function setFollow(hex) {
    followHex = hex;
    store.set({ followHex: hex }, { silent: true });
    card.setFollowVisible(!!hex);
  }

  /* ── 机场切换 ── */
  async function selectAirport(ap) {
    store.set({ airportIcao: ap.icao });
    store.set({ airport: ap }, { silent: true });
    setSelected(null);
    setFollow(null);
    chrome.setAirport(ap);
    chrome.setBoot('正在载入地景数据…', 40);

    const mod = await loadShapes(ap.icao);
    const shapes = mod
      ? { COASTLINE: mod.COASTLINE, URBAN: mod.URBAN, LAKES: mod.LAKES }
      : { COASTLINE: [], URBAN: [], LAKES: [] };

    // 把地景裁剪半径一并交给舞台，它据此限制平移范围（拖不到无数据区）
    stage.setAirport(ap, shapes, mod && mod.CLIP_DEG);
    pipeline.setAirport();
    chrome.setStatus(statusOf());
  }

  /* ── 状态快照（给界面用） ── */
  function statusOf() {
    const s = store.get();
    return {
      feed: s.feed,
      view: stage.view,
      resolution: stage.resolution,
      fps,
      paused: s.paused,
    };
  }

  /* ── 尺寸 ── */
  function handleResize() {
    const rect = viewport.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    const changed = stage.resize(rect.width, rect.height);
    store.patch('resolution', stage.resolution, true);
    if (changed) chrome.setStatus(statusOf());
  }

  const ro = new ResizeObserver(() => handleResize());
  ro.observe(viewport);
  window.addEventListener('orientationchange', () => setTimeout(handleResize, 120));

  /* ── 主循环 ── */
  let last = performance.now();
  let acc = 0;
  let rafId = 0;

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    const rawDt = now - last;
    last = now;

    if (document.hidden) return;

    const paused = store.get().paused;
    const targetFps = paused ? PERF.fpsIdle : PERF.fpsActive;
    const interval = 1000 / targetFps;
    acc += Math.min(200, rawDt);
    if (acc < interval) return;
    const step = acc;
    acc = 0;

    const dtSec = Math.min(0.5, step / 1000);
    fps += (1000 / step - fps) * 0.08;

    // 暂停时不推进模拟、不重算外推 —— 画面必须真的静止，而不是慢慢漂
    if (!paused) frame = pipeline.update(now, dtSec);

    // 跟随：把镜头平滑推向目标
    if (followHex) {
      const item = frame.find((f) => f.hex === followHex);
      if (item) stage.centerOn(item.lat, item.lon, true);
      else setFollow(null); // 目标已消失
    }

    const selected = selectedHex ? frame.find((f) => f.hex === selectedHex) : null;

    stage.render(frame, {
      now,
      dtMs: step,
      feed: store.get().feed,
      selectedHex: selectedHex,
      hoverHex,
      paused,
    });

    // 信息卡与统计按低频更新，避免每帧改 DOM
    card.update(selected ? selected.plane : null, {
      airport: store.get().airport,
      followHex,
      now,
    });

    statsAcc += step;
    if (statsAcc >= 500) {
      statsAcc = 0;
      const s = computeStats(frame);
      chrome.setStats(s);
      store.patch('stats', s, true);
      chrome.setStatus(statusOf());
    }
  }

  /* ── 生命周期 ── */
  document.addEventListener('visibilitychange', () => {
    pipeline.setVisible(!document.hidden);
    if (!document.hidden) {
      last = performance.now();
      acc = 0;
    }
  });

  document.addEventListener('fullscreenchange', () => setTimeout(handleResize, 80));

  /**
   * store 广播适配。
   * 数据管线每帧都会 patch feed，若不设防就会每帧重写一次侧栏 DOM，
   * 这里用一个便宜的指纹把重复广播挡在 DOM 之外。
   */
  let lastFeedKey = '';
  store.subscribe((s, changed) => {
    if (changed.includes('relayUrl')) chrome.syncControls(s);
    if (!changed.includes('feed')) return;
    const f = s.feed;
    const key = `${f.state}|${f.sourceId}|${f.count}|${Math.round((f.fetchedAt || 0) / 1000)}|${f.lastError || ''}|${(f.trail || []).map((t) => t.state).join(',')}`;
    if (key === lastFeedKey) return;
    lastFeedKey = key;
    chrome.setFeed(f);
  });

  /* ── 启动 ── */
  // 小屏默认收起侧栏：面板在窄屏会占掉 42dvh，把雷达屏挤成一条缝。
  // 这里不改用户偏好（不写 store），只在首次渲染时决定面板的展开状态。
  chrome.setAirport(airport);
  const narrow = window.matchMedia('(max-width: 940px)').matches;
  chrome.setPanelOpen(narrow ? false : store.get().panelOpen);
  chrome.setCrtEnabled(store.get().crt);
  chrome.syncControls(store.get());
  chrome.setFeed(store.get().feed);
  chrome.setBoot('正在初始化扫描阵列…', 8);

  handleResize();
  chrome.setBoot('正在载入地景数据…', 30);

  const shapesMod = await loadShapes(airport.icao);
  const shapes = shapesMod
    ? { COASTLINE: shapesMod.COASTLINE, URBAN: shapesMod.URBAN, LAKES: shapesMod.LAKES }
    : { COASTLINE: [], URBAN: [], LAKES: [] };
  stage.setAirport(airport, shapes, shapesMod && shapesMod.CLIP_DEG);
  chrome.setBoot('正在接入空域数据…', 62);

  await pipeline.start();
  chrome.setBoot('雷达就位', 100);

  requestAnimationFrame(loop);
  setTimeout(() => {
    chrome.hideBoot();
    booted = true;
  }, 220);

  // 验证钩子（真实浏览器 E2E 用；不参与任何业务逻辑，删除后页面照常运行）
  installDevHooks({
    store,
    stage,
    pipeline,
    actions,
    getFrame: () => frame,
    isReady: () => booted,
  });
}

boot().catch((e) => {
  console.error('[pixel-radar] 启动失败', e);
  const boot = document.getElementById('boot');
  const log = document.getElementById('bootLog');
  if (log) log.textContent = `启动失败：${e && e.message ? e.message : e}`;
  if (boot) boot.querySelector('.boot__bar').style.background = '#ff4d4d';
});
