/**
 * Pixel Radar · 全局配置
 * ---------------------------------------------------------------
 * 这里集中所有「魔法数字」：调色板、逻辑分辨率策略、缩放档位、
 * 距离环、轮询与退避、存储键。其它模块一律从这里取值，不得就地硬编码。
 */

export const APP = {
  name: 'Pixel Radar',
  nameCn: '像素航班雷达',
  version: '0.1.0',
};

/* ================================================================
 * 调色板 —— 「老式 CRT 磷光屏」
 * ----------------------------------------------------------------
 * 分组原则（每个材质给 3~4 阶明暗，而不是单色平涂）：
 *   墨 / 底 → 网格 → 陆地与海岸 → 跑道结构 → 荧光 12 阶
 * 色相纪律：全屏以磷光绿为主，非绿只承担「真实状态语义」
 *   （选中=琥珀、下降=警示红、上升=青、地面=灰）。
 * ================================================================ */
export const PAL = {
  ink: '#000000',
  bgDeep: '#050a05',
  bg: '#0a0f0a', // 规格指定背景
  bgLift: '#0d150e',

  gridDim: '#11240f',
  grid: '#1a3a1a', // 规格指定网格
  gridHot: '#24521f',

  city: '#1d3f21', // 建成区网点纹理的点色（配合 50% 网点，感知亮度只有实心的三分之一）
  cityHot: '#2a5c2c',
  land: '#1b3a1e',
  landEdge: '#2a5a2a', // 规格指定地图轮廓
  coast: '#3a7a3a',
  coastHot: '#54a854',

  apron: '#28512a',
  taxi: '#3a7a3a',
  runway: '#5fbf5f',
  runwayHot: '#8fe88f',

  ring: '#1f4420',
  ringHot: '#2f6a2f',
  compass: '#2d5f2e',

  sweepCore: '#8fffa0',
  sweepBody: '#4fbf4f',
  sweepTail: '#1d4a20',

  hudDim: '#3d7f3d',
  hud: '#6ee06e',
  hudHot: '#b6ffb6',

  // —— 飞机状态色（真实语义，不参与装饰）——
  ground: '#7d8a7d', // 地面 / 滑行：灰
  altLow: '#8fff8f', // 低空亮
  altMid: '#63d963',
  altHigh: '#3f9f6f', // 高空暗绿偏青
  selected: '#ffff7f', // 规格指定选中色
  climb: '#7fffff', // 规格指定上升色
  descent: '#ff4d4d', // 规格指定下降 / 告警色
  unknown: '#9fd8a0',

  trailLow: '#8fff8f',
  trailHigh: '#2f6f4a',
};

/* ================================================================
 * 逻辑分辨率策略
 * ----------------------------------------------------------------
 * 不固定 480×360 —— 而是「锁定整数倍像素尺寸，反推逻辑分辨率」。
 * 这样任意宽高比都能铺满且永远没有半像素，同时保留像素粒度控制。
 * ================================================================ */
export const RES = {
  scaleSteps: [2, 3, 4, 5, 6],
  /** 参考分辨率，用于自动挑选像素尺寸 */
  refW: 480,
  refH: 360,
  minScale: 2,
  maxScale: 6,
  /** 硬上限，防止超宽屏把缓冲撑爆内存 */
  maxLogicalPixels: 700 * 520,
};

/* ================================================================
 * 视图
 * ================================================================ */
export const VIEW = {
  /** 距离环档位（km） */
  rings: [5, 10, 20, 50],
  defaultRing: 20,
  /** 缩放 = 基准值 × 倍率。基准值由「当前距离环恰好装进短边」反推。 */
  zoomMults: [0.25, 0.35, 0.5, 0.7, 1, 1.4, 2, 2.8, 4],
  defaultZoomIndex: 4,
  /** 距离环占短边半宽的比例，留出屏幕边缘余量 */
  fitFill: 0.82,
  minKmPerPx: 0.02,
  maxKmPerPx: 8,
};

/* ================================================================
 * 雷达扫描
 * ================================================================ */
export const SWEEP = {
  periodMs: 4000, // 规格指定的 4 秒周期
  /** 扇形张角（度） */
  arcDeg: 46,
  /** 扫过飞机后的余辉时长 */
  pingMs: 620,
  /** 扫描前沿线宽（逻辑像素） */
  edgeWidth: 1,
};

/* ================================================================
 * 数据轮询与降级
 * ================================================================ */
export const POLL = {
  visibleMs: 5000,
  hiddenMs: 30000,
  backoffMs: [5000, 10000, 20000, 60000],
  timeoutMs: 12000,
  /** 数据超过该时长即视为陈旧，界面标注 */
  staleMs: 45000,
  /** 中继模式下请求半径上限（海里） */
  maxRadiusNm: 250,
};

/* ================================================================
 * 尾迹
 * ----------------------------------------------------------------
 * 规格把尾迹放在 P1，但「没有尾迹的雷达屏」观感上是残缺的，
 * 因此 M1 就带上一条精简版：记录间隔与容量均小于 P1 规格。
 * ================================================================ */
export const TRAIL = {
  sampleMs: 5000,
  maxPoints: 180,
  /** 速度 → 尾迹长度映射（逻辑像素） */
  minLen: 3,
  maxLen: 20,
  speedLowKt: 0,
  speedHighKt: 520,
};

/* ================================================================
 * 性能护栏
 * ================================================================ */
export const PERF = {
  /** 超过该架数即自动隐藏尾迹（drawTrails 据此直接返回） */
  trailCutoff: 320,
  /** 超过该架数即按距机场由近及远剔除远处目标（cullByDistance，渲染前调用） */
  hardCutoff: 500,
  /** 信息卡刷新节流 */
  cardThrottleMs: 1000,
  /** 播放帧率 / 空闲帧率 */
  fpsActive: 60,
  fpsIdle: 8,
};

/* ================================================================
 * 数据源
 * ================================================================ */
export const SOURCES = {
  /** 上游实时聚合源（浏览器直连会因缺 CORS 头失败，需中继） */
  direct: {
    id: 'adsb.lol',
    label: 'adsb.lol',
    point: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${nm}`,
    license: 'ODbL · adsb.lol',
  },
  /** 同源静态快照目录（由 scripts/collect.mjs 或 Actions 生成） */
  snapshotDir: 'data/snapshots',
  /**
   * 快照镜像模板（并行竞速，择优取用）：{repo} 与 {branch} 运行时注入。
   *
   * 为什么是五个而不是一个：`raw.githubusercontent.com` 在部分网络
   * 环境（尤其中国大陆）不可达或剧烈抖动 —— 本机直连实测 0.7~7.9s，
   * 单候选一挂就意味着「快照链路不可达 → 永远落模拟数据」。
   * 五个候选全部带 `Access-Control-Allow-Origin: *`，按故障域互补：
   *   · raw              —— 官方、缓存 5 分钟，与采集节奏吻合（首选）
   *   · cdn.jsdelivr     —— jsDelivr 主边缘（Cloudflare），国内通常可达
   *   · fastly.jsdelivr  —— jsDelivr 多 CDN 的 Fastly 边缘（独立故障域）
   *   · gcore.jsdelivr   —— jsDelivr 多 CDN 的 Gcore 边缘（独立故障域）
   *   · ghproxy.net      —— raw 的反代，GitHub 直连被墙时的兜底
   */
  mirrorTemplates: [
    'https://raw.githubusercontent.com/{repo}/{branch}/data/snapshots/{icao}.json',
    'https://cdn.jsdelivr.net/gh/{repo}@{branch}/data/snapshots/{icao}.json',
    'https://fastly.jsdelivr.net/gh/{repo}@{branch}/data/snapshots/{icao}.json',
    'https://gcore.jsdelivr.net/gh/{repo}@{branch}/data/snapshots/{icao}.json',
    'https://ghproxy.net/https://raw.githubusercontent.com/{repo}/{branch}/data/snapshots/{icao}.json',
  ],
  /**
   * 仓库名推断失败（localhost / 自定义静态托管）时的兜底仓库。
   * 没有它，本地开发只有一条「同源快照」路 —— 而 data/snapshots 被
   * .gitignore 忽略，全新 clone 必然 404 → 100% 落到模拟数据。
   */
  fallbackRepo: 'X-LSH/pixel-radar',
  /**
   * 单个快照候选的超时。必须盖住慢网直连的尾部延迟（本机直连 raw 实测
   * 0.7~7.9s）：曾经的 4s 会把「慢而活」的候选全部掐死 —— CDP 注入 5s RTT
   * 的复现探针里四个候选齐齐 ERR_ABORTED@4s → 每轮必败 → 永久模拟数据。
   * 启动预算仍是 6s：超预算先给模拟兜底，迟到成功的候选会自动翻回真实。
   */
  snapshotTimeoutMs: 8000,
  /** 快照年龄小于该值即「足够新鲜」，先到先得，不必等更慢的候选 */
  snapshotFreshMs: 10 * 60 * 1000,
  /**
   * 首个成功响应回来后，再等这么久才收口择优。
   * 不设窗口 → 谁快谁赢，3 小时前的残留可能压过 10 分钟前的正主；
   * 无限等全量 → 最慢的镜像（ghproxy 数秒）会把整条链拖过启动预算
   * 与 e2e 的切换等待窗。600ms 足够让其余镜像（通常 <300ms）赶到。
   */
  snapshotGraceMs: 600,
  /** 元数据源（实测支持 CORS，可浏览器直连） */
  meta: {
    route: (cs) => `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`,
    hex: (hex) => `https://hexdb.io/api/v1/aircraft/${encodeURIComponent(hex)}`,
  },
  sourceOrder: ['relay', 'snapshot', 'direct', 'simulation'],
};

/* ================================================================
 * 持久化
 * ================================================================ */
export const STORE_KEYS = {
  settings: 'pixel-radar/settings@1',
  trails: 'pixel-radar/trails@1',
};

export const DEFAULTS = {
  airportIcao: 'ZBAA',
  ringKm: VIEW.defaultRing,
  zoomIndex: VIEW.defaultZoomIndex,
  scale: 0, // 0 = 自动
  crt: true,
  scanlines: true,
  vignette: true,
  noise: true,
  sweepOn: true,
  trailsOn: true,
  labelsOn: true,
  relayUrl: '', // 用户自备中继（如 Cloudflare Worker）
  followHex: null,
  soundOn: false,
  paused: false,
};

export const CLAMP = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
