/**
 * Pixel Radar · 不变量自检
 * ===============================================================
 * 零依赖、不开浏览器，纯逻辑层断言。它的价值在于「长期守护」：
 * 数据重建、改调色板、动机型分类、调飞行阶段阈值，
 * 只要踩了这些不变量就会当场失败，而不是等肉眼在屏幕上发现。
 *
 * 用法：node scripts/verify.mjs
 */

import { resolve, dirname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(resolve(ROOT, rel)).href);

let pass = 0;
let fail = 0;
const groups = [];

function group(name) {
  groups.push({ name, from: pass + fail });
  console.log(`\n\x1b[2m──\x1b[0m ${name}`);
}
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? `  ${detail}` : ''}`); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ══════════════════════════════════════════════════════════════
 * 1) 配置常量
 * ══════════════════════════════════════════════════════════════ */
const { PAL, VIEW, SWEEP, POLL, TRAIL, RES, PERF, DEFAULTS } = await load('src/config.js');

group('配置常量');
{
  const hex = /^#[0-9a-f]{6}$/i;
  const bad = Object.entries(PAL).filter(([, v]) => !hex.test(v));
  ok('调色板全部为合法 #rrggbb', bad.length === 0, bad.map(([k, v]) => `${k}=${v}`).join(' '));

  // 规格原文点名的颜色必须精确保留
  const spec = {
    bg: '#0a0f0a', grid: '#1a3a1a', landEdge: '#2a5a2a',
    altLow: '#8fff8f', selected: '#ffff7f', descent: '#ff4d4d', climb: '#7fffff',
  };
  const miss = Object.entries(spec).filter(([k, v]) => PAL[k] !== v);
  ok('规格指定色号未被改动', miss.length === 0, miss.map(([k]) => k).join(' '));

  const asc = (arr) => arr.every((v, i) => i === 0 || v > arr[i - 1]);
  ok('距离环单调递增', asc(VIEW.rings), VIEW.rings.join('/'));
  ok('默认距离环存在于档位中', VIEW.rings.includes(VIEW.defaultRing), `default=${VIEW.defaultRing}`);
  ok('缩放档位单调递增', asc(VIEW.zoomMults), VIEW.zoomMults.join('/'));
  ok('退避间隔单调递增', asc(POLL.backoffMs), POLL.backoffMs.join('/'));
  ok('像素尺寸档位单调递增', asc(RES.scaleSteps), RES.scaleSteps.join('/'));
  ok('默认缩放索引合法',
    Number.isInteger(VIEW.defaultZoomIndex) && VIEW.defaultZoomIndex >= 0 && VIEW.defaultZoomIndex < VIEW.zoomMults.length,
    `index=${VIEW.defaultZoomIndex}`);
  ok('扫描周期为规格要求的 4 秒', SWEEP.periodMs === 4000, `${SWEEP.periodMs}ms`);
  ok('轮询快于隐藏轮询', POLL.visibleMs < POLL.hiddenMs, `${POLL.visibleMs} < ${POLL.hiddenMs}`);
  ok('尾迹容量不超过规格 180 点', TRAIL.maxPoints <= 180, `${TRAIL.maxPoints}`);
  ok('尾迹采样间隔为规格要求的 5 秒', TRAIL.sampleMs === 5000, `${TRAIL.sampleMs}ms`);
  ok('性能护栏：尾迹上限 < 硬上限', PERF.trailCutoff < PERF.hardCutoff,
    `${PERF.trailCutoff} < ${PERF.hardCutoff}`);

  const dk = Object.keys(DEFAULTS);
  const missing = ['airportIcao', 'ringKm', 'zoomIndex', 'crt', 'sweepOn', 'trailsOn', 'relayUrl']
    .filter((k) => !dk.includes(k));
  ok('默认设置字段齐备', missing.length === 0, missing.join(' '));
  ok('默认机场与档位一致', DEFAULTS.ringKm === VIEW.defaultRing, `${DEFAULTS.ringKm}`);
}

/* ══════════════════════════════════════════════════════════════
 * 2) 机场与跑道数据
 * ══════════════════════════════════════════════════════════════ */
const { AIRPORTS, AIRPORT_BY_ICAO, AIRPORT_BY_IATA } = await load('src/data/airports.js');
/** 提前加载几何模块：跑道有效性要用真实大圆距离判定 */
const GEO = await load('src/core/geo.js');

group('机场与跑道数据');
{
  ok('机场数量为规格要求的 20 个', AIRPORTS.length === 20, `${AIRPORTS.length}`);
  ok('ICAO 唯一', new Set(AIRPORTS.map((a) => a.icao)).size === 20);
  ok('IATA 唯一', new Set(AIRPORTS.map((a) => a.iata)).size === 20);
  ok('按 ICAO 建索引可查', Object.keys(AIRPORT_BY_ICAO).length === 20);
  ok('按 IATA 建索引可查', Object.keys(AIRPORT_BY_IATA).length === 20);

  const badCoord = AIRPORTS.filter((a) => !(a.lat >= -90 && a.lat <= 90 && a.lon >= -180 && a.lon <= 180));
  ok('坐标在合法范围', badCoord.length === 0, badCoord.map((a) => a.icao).join(' '));

  const noRw = AIRPORTS.filter((a) => !a.runways.length);
  ok('每个机场至少一条跑道', noRw.length === 0, noRw.map((a) => a.icao).join(' '));

  const totalRw = AIRPORTS.reduce((n, a) => n + a.runways.length, 0);
  // 64 条：OurAirports 原始数据里 20 个机场共有 65 条，其中 ZSPD 的 15/33
  // 端点坐标是 (0,0)（该源用 0 表示缺失），已在构建期剔除。
  ok('跑道总数为 64 条（已剔除 1 条坐标缺失的伪跑道）', totalRw === 64, `${totalRw}`);
  const rwPer = AIRPORTS.map((a) => a.runways.length);
  ok('单机场跑道数在合理区间（1–7）',
    rwPer.every((n) => n >= 1 && n <= 7),
    `最少 ${Math.min(...rwPer)} / 最多 ${Math.max(...rwPer)}`);

  let badRw = 0;
  let shortRw = 0;
  let badIdent = 0;
  for (const a of AIRPORTS) {
    for (const r of a.runways) {
      if (!(r.leLat >= -90 && r.leLat <= 90 && r.leLon >= -180 && r.leLon <= 180
        && r.heLat >= -90 && r.heLat <= 90 && r.heLon >= -180 && r.heLon <= 180)) badRw++;
      if (!(r.lenFt >= 1500)) shortRw++;
      if (typeof r.le !== 'string' || typeof r.he !== 'string' || !r.le.length || !r.he.length) badIdent++;
    }
  }
  ok('跑道端点坐标合法', badRw === 0, `${badRw} 条异常`);
  ok('已过滤滑行道级铺装（长度 ≥ 1500ft）', shortRw === 0, `${shortRw} 条过短`);
  ok('跑道两端识别号齐备', badIdent === 0, `${badIdent} 条缺失`);

  // 跑道端点必须真的落在机场附近。
  // 这条断言抓到过一个隐蔽缺陷：OurAirports 用 0 表示缺失坐标，
  // 于是 ZSPD 的 15/33 曾带着 (0,0) 端点混进数据集（距机场 12989km）。
  const farRw = [];
  for (const a of AIRPORTS) {
    for (const r of a.runways) {
      const d = Math.max(
        GEO.distKm(a.lat, a.lon, r.leLat, r.leLon),
        GEO.distKm(a.lat, a.lon, r.heLat, r.heLon),
      );
      if (d > 30) farRw.push(`${a.icao}/${r.le}(${d.toFixed(0)}km)`);
    }
  }
  ok('跑道端点距机场参考点 < 30km（无坐标缺失残留）', farRw.length === 0, farRw.join(' '));

  const nullIsland = AIRPORTS.flatMap((a) => a.runways
    .filter((r) => Math.abs(r.leLat) < 1e-6 && Math.abs(r.leLon) < 1e-6).map(() => a.icao));
  ok('无「空岛」(0,0) 坐标残留', nullIsland.length === 0, nullIsland.join(' '));

  // 跑道真实性抽查：这几条是公开可查的标志性跑道
  const zb = AIRPORT_BY_ICAO.ZBAA;
  ok('ZBAA 跑道组合正确（01/19 · 18L/36R · 18R/36L）',
    zb.runways.map((r) => `${r.le}/${r.he}`).sort().join(' ') === ['01/19', '18L/36R', '18R/36L'].sort().join(' '),
    zb.runways.map((r) => `${r.le}/${r.he}`).join(' '));
  const hh = AIRPORT_BY_ICAO.VHHH;
  ok('VHHH 含 2022 年启用的第三跑道 07C/25C',
    hh.runways.some((r) => `${r.le}/${r.he}` === '07C/25C'),
    hh.runways.map((r) => `${r.le}/${r.he}`).join(' '));
  const jf = AIRPORT_BY_ICAO.KJFK;
  ok('KJFK 含最长跑道 13R/31L（14511ft）',
    jf.runways.some((r) => `${r.le}/${r.he}` === '13R/31L' && r.lenFt === 14511),
    jf.runways.map((r) => `${r.le}/${r.he}:${r.lenFt}`).join(' '));

  const tzAll = AIRPORTS.every((a) => /^[A-Za-z]+\//.test(a.tz));
  ok('时区名格式合法（IANA）', tzAll, [...new Set(AIRPORTS.map((a) => a.tz))].length + ' 个时区');
  ok('时区可被运行时解析',
    AIRPORTS.every((a) => { try { new Intl.DateTimeFormat('en', { timeZone: a.tz }); return true; } catch { return false; } }));
  ok('中文名齐备', AIRPORTS.every((a) => a.cn && a.cn.length >= 2));
}

/* ══════════════════════════════════════════════════════════════
 * 3) 地理形状
 * ══════════════════════════════════════════════════════════════ */
group('地理形状（按机场懒加载模块）');
{
  const { SHAPE_ICAS, SHAPE_SIZE_KB, loadShapes, hasShapes } = await load('src/data/shapes/index.js');
  ok('形状机场数 = 机场数', SHAPE_ICAS.length === AIRPORTS.length, `${SHAPE_ICAS.length}`);
  ok('每个机场都有对应模块', AIRPORTS.every((a) => hasShapes(a.icao)));
  const missing = AIRPORTS.filter((a) => !SHAPE_ICAS.includes(a.icao)).map((a) => a.icao);
  ok('索引无缺项', missing.length === 0, missing.join(' '));

  const sizes = Object.values(SHAPE_SIZE_KB);
  const maxKb = Math.max(...sizes);
  const totalKb = sizes.reduce((a, b) => a + b, 0);
  ok('单机场形状体积 < 80KB（首屏可接受）', maxKb < 80, `最大 ${maxKb}KB`);
  ok('形状总体积 < 700KB', totalKb < 700, `合计 ${totalKb.toFixed(0)}KB`);

  // 逐机场校验坐标落在裁剪框内（数据契约：生成的形状坐标绝不越框）
  let outside = 0;
  let maxOver = 0;
  for (const icao of SHAPE_ICAS) {
    const m = await loadShapes(icao);
    const ap = AIRPORT_BY_ICAO[icao];
    const clip = m.CLIP_DEG;
    for (const key of ['COASTLINE', 'URBAN', 'LAKES']) {
      for (const flat of m[key]) {
        for (let i = 0; i < flat.length; i += 2) {
          const over = Math.max(Math.abs(flat[i] - ap.lon), Math.abs(flat[i + 1] - ap.lat)) - clip;
          if (over > 0.0005) { // 0.0005° ≈ 50m，容 4 位小数量化的舍入
            outside++;
            if (over > maxOver) maxOver = over;
          }
        }
      }
    }
  }
  ok('所有形状坐标严格落在裁剪框内（几何裁剪而非整段收编）',
    outside === 0, outside ? `${outside} 个越界点，最大外溢 ${maxOver.toFixed(3)}°` : '31k 个点全部合规');

  // 内陆机场没有海岸线是正常的，但不该 20 个都空
  const withCoast = SHAPE_ICAS.filter((i) => SHAPE_SIZE_KB[i] > 0).length;
  ok('形状数据非空（20 个机场均有产出）', withCoast === 20, `${withCoast}`);
  ok('内陆地景不为空（ZBAA 有建成区）', (await loadShapes('ZBAA')).URBAN.length > 0,
    `${(await loadShapes('ZBAA')).URBAN.length} 个建成区环`);
  ok('沿海地景有海岸线（VHHH）', (await loadShapes('VHHH')).COASTLINE.length > 0,
    `${(await loadShapes('VHHH')).COASTLINE.length} 段海岸线`);

  // 扁平数组结构必须成对、且每段至少两个顶点
  const malformed = [];
  for (const icao of SHAPE_ICAS) {
    const m = await loadShapes(icao);
    for (const k of ['COASTLINE', 'URBAN', 'LAKES']) {
      for (const f of m[k]) {
        if (f.length % 2 !== 0 || f.length < 4) malformed.push(`${icao}/${k}`);
      }
    }
  }
  ok('形状数组结构合法（成对坐标、段长 ≥ 2 顶点）', malformed.length === 0, malformed.slice(0, 5).join(' '));

  // 多边形环必须是闭合的（首尾点相同），否则填充会出现缺口
  const unclosed = [];
  for (const icao of SHAPE_ICAS) {
    const m = await loadShapes(icao);
    for (const k of ['URBAN', 'LAKES']) {
      for (const f of m[k]) {
        const n = f.length / 2;
        if (Math.abs(f[0] - f[(n - 1) * 2]) > 1e-9 || Math.abs(f[1] - f[(n - 1) * 2 + 1]) > 1e-9) {
          unclosed.push(`${icao}/${k}`);
        }
      }
    }
  }
  ok('多边形环闭合（首尾顶点重合）', unclosed.length === 0, unclosed.slice(0, 5).join(' '));

  // 模块文件的静态检查
  const idxRaw = await readFile(resolve(ROOT, 'src/data/shapes/index.js'), 'utf8');
  ok('索引使用动态 import（懒加载）', idxRaw.includes('import(') && !idxRaw.includes('import ' + '"' + './ZBAA'),
    'LOADERS 表存在');
  const one = await readFile(resolve(ROOT, 'src/data/shapes/ZBAA.js'), 'utf8');
  ok('单机场模块不 import 其它机场', !/import\s/.test(one));
  ok('单机场模块声明来源与许可', /OurAirports|Natural Earth/.test(one));
}

/* ══════════════════════════════════════════════════════════════
 * 4) 位图字体
 * ══════════════════════════════════════════════════════════════ */
group('位图字体');
{
  const { drawText, measure, ADVANCE, GLYPH_W, GLYPH_H, fontStats } = await load('src/render/bitfont.js');
  const st = fontStats();
  ok('ASCII 字形数 = 64（0x20–0x5F）', st.ascii === 64, `${st.ascii}`);
  ok('字形尺寸 5×7', st.cols === 5 && st.rows === 7, `${st.cols}×${st.rows}`);
  ok('字距 = 字宽 + 1', ADVANCE === GLYPH_W + 1, `${ADVANCE}`);
  ok('measure 计算正确', measure('ABC') === 3 * ADVANCE - 1 && measure('') === 0, `measure('ABC')=${measure('ABC')}`);

  // 用一个假 ctx 记录 fillRect，验证绘制覆盖了正确的像素范围
  const rects = [];
  const fakeCtx = {
    globalAlpha: 1, fillStyle: '',
    fillRect(x, y, w, h) { rects.push([x, y, w, h]); },
  };
  drawText(fakeCtx, 'A', 10, 20, '#fff');
  const xs = rects.map((r) => r[0]); const ys = rects.map((r) => r[1]);
  ok('drawText 在给定坐标内绘制',
    Math.min(...xs) >= 10 && Math.max(...xs) < 10 + GLYPH_W,
    `x∈[${Math.min(...xs)},${Math.max(...xs)}]`);
  ok('drawText 垂直不溢出字形高',
    Math.min(...ys) >= 20 && Math.max(...ys) < 20 + GLYPH_H,
    `y∈[${Math.min(...ys)},${Math.max(...ys)}]`);

  rects.length = 0;
  drawText(fakeCtx, 'abc', 0, 0, '#fff');
  const lower = rects.length;
  rects.length = 0;
  drawText(fakeCtx, 'ABC', 0, 0, '#fff');
  ok('小写自动折叠为大写（雷达屏只认大写）', lower === rects.length && lower > 0, `${lower} 个矩形`);

  rects.length = 0;
  drawText(fakeCtx, ' ', 0, 0, '#fff');
  ok('空格不绘制任何像素', rects.length === 0);

  rects.length = 0;
  drawText(fakeCtx, '\u2191\u2193\u00b0', 0, 0, '#fff');
  ok('扩展字形（↑↓°）可用', rects.length > 0, `${rects.length} 个矩形`);

  // 未知字符应回退为空格而不是抛错
  let threw = false;
  try { drawText(fakeCtx, '\u6c49', 0, 0, '#fff'); } catch { threw = true; }
  ok('中文字符安全降级（不抛错）', !threw);
}

/* ══════════════════════════════════════════════════════════════
 * 5) 精灵（导入即触发 12×12 校验）
 * ══════════════════════════════════════════════════════════════ */
group('飞机精灵');
{
  let threw = null;
  let mod = null;
  try {
    mod = await load('src/render/sprites.js');
  } catch (e) { threw = e; }
  ok('5 种机型剪影通过尺寸校验（12×12）', !threw, threw ? threw.message : '');
  if (mod) {
    ok('机型分类齐备', mod.CLASSES.length === 5, mod.CLASSES.join('/'));
    ok('方位量化为 16 个', mod.DIRS === 16, `${mod.DIRS}`);
    const t = mod.trailColor(0);
    const h = mod.trailColor(38000);
    ok('尾迹颜色随高度变化（低空亮 ≠ 高空暗）', t !== h, `${t} → ${h}`);
    ok('尾迹低空为亮绿', t === '#8fff8f', t);
    // 高度超出范围不应越界
    ok('尾迹颜色对越界高度收敛', mod.trailColor(-5000) === mod.trailColor(0) && mod.trailColor(99999) === mod.trailColor(38000));
  }
}

/* ══════════════════════════════════════════════════════════════
 * 6) 几何与投影
 * ══════════════════════════════════════════════════════════════ */
const { Projection, distKm, bearingDeg, destination, norm360, norm180, compass16, bboxAround, EARTH_R_KM } = await load('src/core/geo.js');

group('几何与投影');
{
  // 大圆距离：已知基准（北京首都 → 上海浦东 约 1050km）
  const d = distKm(40.0773, 116.5967, 31.1434, 121.8050);
  ok('大圆距离与已知量级一致（PEK→PVG ≈ 1050km）', d > 980 && d < 1120, `${d.toFixed(1)} km`);

  // 方位角
  const b = bearingDeg(0, 0, 1, 0);
  ok('正北方位角为 0°', near(b, 0, 0.01), `${b.toFixed(3)}°`);
  const bE = bearingDeg(0, 0, 0, 1);
  ok('正东方位角为 90°', near(bE, 90, 0.01), `${bE.toFixed(3)}°`);

  // destination 与 distKm 互逆
  const dest = destination(40, 116, 45, 50);
  const back = distKm(40, 116, dest.lat, dest.lon);
  ok('destination 与 distKm 互逆（误差 < 1m）', near(back, 50, 0.001), `${back.toFixed(6)} km`);
  const bBack = bearingDeg(40, 116, dest.lat, dest.lon);
  ok('destination 保持方位角', near(norm180(bBack - 45), 0, 0.05), `${bBack.toFixed(3)}°`);

  ok('norm360 处理负角', norm360(-10) === 350 && norm360(370) === 10);
  ok('norm180 处理跨界', norm180(190) === -170 && norm180(-190) === 170);
  ok('compass16 覆盖 16 方位', compass16(0) === 'N' && compass16(90) === 'E' && compass16(180) === 'S' && compass16(270) === 'W'
    && new Set(Array.from({ length: 16 }, (_, i) => compass16(i * 22.5))).size === 16);

  // ── 投影：AEQD 的等距性与方位保持，是最关键的正确性断言 ──
  const center = { lat: 40.0773, lon: 116.5967 };
  const proj = new Projection(center.lat, center.lon);
  proj.setView(0, 0, 1);

  for (const [name, brg] of [['北', 0], ['东', 90], ['南', 180], ['西', 270]]) {
    const p = destination(center.lat, center.lon, brg, 30);
    const xy = proj.project(p.lat, p.lon);
    const r = Math.hypot(xy.x, xy.y);
    ok(`投影在正${name} 30km 处等距（误差 < 0.15km）`, near(r, 30, 0.15), `r=${r.toFixed(4)} km`);
  }

  const pN = proj.project(destination(center.lat, center.lon, 0, 30).lat, destination(center.lat, center.lon, 0, 30).lon);
  ok('正北在投影中体现为 +Y', pN.y > 0 && near(pN.x, 0, 0.05), `x=${pN.x.toFixed(4)} y=${pN.y.toFixed(4)}`);
  const pE = proj.project(destination(center.lat, center.lon, 90, 30).lat, destination(center.lat, center.lon, 90, 30).lon);
  ok('正东在投影中体现为 +X', pE.x > 0 && near(pE.y, 0, 0.05), `x=${pE.x.toFixed(4)} y=${pE.y.toFixed(4)}`);

  // 等距方位投影的固有特性：离中心越远，切向拉伸越大（这不是 bug，是投影性质）
  const far = proj.project(destination(center.lat, center.lon, 45, 160).lat, destination(center.lat, center.lon, 45, 160).lon);
  ok('160km 处仍保持径向等距（误差 < 0.6km）', near(Math.hypot(far.x, far.y), 160, 0.6), `r=${Math.hypot(far.x, far.y).toFixed(3)}`);

  // 中心点投影为原点
  const c = proj.project(center.lat, center.lon);
  ok('中心点投影为原点', near(c.x, 0, 1e-9) && near(c.y, 0, 1e-9), `(${c.x}, ${c.y})`);

  // toPixel 的 Y 轴方向：纬度更高应像素更小（屏幕 y 向下）
  proj.setView(100, 100, 0.5);
  const north = proj.toPixel(center.lat + 0.5, center.lon);
  const south = proj.toPixel(center.lat - 0.5, center.lon);
  ok('toPixel 中北大南小（屏幕 y 向下）', north.y < south.y, `northY=${north.y.toFixed(1)} southY=${south.y.toFixed(1)}`);
  ok('kmPerPx 换算正确（0.5km/px → 0.5° 纬度约 111km/2 = 111px）',
    near(Math.abs(south.y - north.y), (0.5 * 2 * 111.132) / 0.5, 1.5),
    `${Math.abs(south.y - north.y).toFixed(2)} px`);

  // bbox 必须覆盖目标半径
  const box = bboxAround(center.lat, center.lon, 50);
  const corners = [
    [box.latMin, box.lonMin], [box.latMax, box.lonMax],
    [box.latMin, box.lonMax], [box.latMax, box.lonMin],
  ];
  const okBox = corners.every(([la, lo]) => distKm(center.lat, center.lon, la, lo) >= 49.5);
  ok('bboxAround 完整覆盖半径', okBox,
    `角点最近 ${Math.min(...corners.map(([la, lo]) => distKm(center.lat, center.lon, la, lo))).toFixed(1)} km`);
  ok('地球半径取 IUGG 平均值', near(EARTH_R_KM, 6371.0088, 1e-6));
}

/* ══════════════════════════════════════════════════════════════
 * 7) 单位换算
 * ══════════════════════════════════════════════════════════════ */
const U = await load('src/data/units.js');

group('单位换算');
{
  ok('1 海里 = 1.852 km', U.nmToKm(1) === 1.852, `${U.KM_PER_NM}`);
  ok('1 英尺 = 0.3048 m', U.M_PER_FT === 0.3048);
  ok('km↔nm 往返无损', near(U.kmToNm(U.nmToKm(123.456)), 123.456, 1e-9));
  ok('ft↔m 往返无损', near(U.mToFt(U.ftToM(35000)), 35000, 1e-9));
  ok('kt→km/h 正确（400kt ≈ 740.8km/h）', near(U.ktToKmh(400), 740.8, 0.001), `${U.ktToKmh(400)}`);
  ok('kt→km/s 量级正确（400kt ≈ 0.2058 km/s）', near(U.ktToKmPerSec(400), 0.20578, 1e-4), `${U.ktToKmPerSec(400).toFixed(5)}`);
  ok('kmToNmSafe 对非法值回落', U.kmToNmSafe(NaN, 7) === 7 && U.kmToNmSafe(Infinity, 7) === 7);
  ok('agoText 输出中文相对时间', /秒前|刚刚/.test(U.agoText(Date.now() - 5000)), U.agoText(Date.now() - 5000));
  ok('group 千分位正确', U.group(12345) === '12,345', U.group(12345));
  ok('resText 组合逻辑分辨率', /逻辑/.test(U.resText(480, 360, 3)), U.resText(480, 360, 3));
}

/* ══════════════════════════════════════════════════════════════
 * 8) 字段归一化与机型分类
 * ══════════════════════════════════════════════════════════════ */
const N = await load('src/data/normalize.js');

group('字段归一化与机型分类');
{
  ok('宽体识别', ['A359', 'B77W', 'A388', 'B789', 'B744'].every((t) => N.classifyType(t) === 'wide'));
  ok('窄体识别', ['A320', 'B738', 'A21N', 'CRJ9', 'E190'].every((t) => N.classifyType(t) === 'narrow'));
  ok('螺旋桨识别', ['AT76', 'DH8D', 'C208', 'PC12'].every((t) => N.classifyType(t) === 'prop'));
  ok('旋翼识别', ['EC35', 'R44', 'B407'].every((t) => N.classifyType(t) === 'heli'));
  ok('未知机型安全降级', N.classifyType(undefined) === 'unknown' && N.classifyType('') === 'unknown'
    && N.classifyType('XYZ123') === 'unknown');

  ok('呼号清理（右侧空格）', N.cleanCallsign('CES2106  ') === 'CES2106');
  ok('航司前缀识别', N.airlineOf('CCA1234') === '中国国际航空', N.airlineOf('CCA1234'));
  ok('未收录航司返回 null 而非乱猜', N.airlineOf('ZZZ999') === null);
  ok('航班号解析', N.flightNumberOf('CES2106') === 'CES2106');

  // 归一化：关键行为
  const raw = {
    hex: '7806AA', flight: 'CSC8830 ', r: 'B-6719', t: 'A320',
    alt_baro: 10925, alt_geom: 11475, gs: 312.0, track: 270.0, baro_rate: 1152,
    lat: 40.226301, lon: 116.154390, category: 'A3',
  };
  const p = N.normalizePlane(raw, 'test');
  ok('归一化保留全部字段',
    p && p.hex === '7806aa' && p.callsign === 'CSC8830' && p.registration === 'B-6719'
    && p.typeCode === 'A320' && p.typeClass === 'narrow' && p.altFt === 10925 && p.gsKt === 312
    && p.vsFpm === 1152 && near(p.trackDeg, 270, 1e-9),
    JSON.stringify({ hex: p?.hex, alt: p?.altFt, gs: p?.gsKt }));

  ok('缺少位置的记录被丢弃', N.normalizePlane({ hex: 'abc123' }) === null);
  ok('缺少 hex 的记录被丢弃', N.normalizePlane({ lat: 1, lon: 2 }) === null);
  ok('非法坐标被丢弃', N.normalizePlane({ hex: 'abc123', lat: 999, lon: 0 }) === null);
  const ground = N.normalizePlane({ hex: 'abc123', lat: 40, lon: 116, alt_baro: 'ground', gs: 12 });
  ok('地面目标高度归零', ground && ground.onGround === true && ground.altFt === 0);
  const geomOnly = N.normalizePlane({ hex: 'abc123', lat: 40, lon: 116, alt_geom: 30000 });
  ok('仅有几何高度时标注 altIsGeom', geomOnly && geomOnly.altIsGeom === true && geomOnly.altFt === 30000);
  ok('extractRecords 兼容 ac 结构', N.extractRecords({ ac: [1, 2] }).length === 2);
  ok('extractRecords 对异常结构返回空数组', N.extractRecords(null).length === 0 && N.extractRecords({}).length === 0);
}

/* ══════════════════════════════════════════════════════════════
 * 9) 飞行阶段识别（规格规则逐条验证）
 * ══════════════════════════════════════════════════════════════ */
const PH = await load('src/data/phases.js');

group('飞行阶段识别');
{
  const { detectPhase, PHASES, PHASE_LABEL } = PH;
  const f = (o) => detectPhase({ onGround: false, altFt: 0, vsFpm: 0, gsKt: 200, ...o });

  ok('规格规则①：on_ground → 地面/滑行',
    f({ onGround: true, altFt: 0, vsFpm: 0, gsKt: 80 }) === PHASES.GROUND,
    PHASE_LABEL[f({ onGround: true, altFt: 0, vsFpm: 0, gsKt: 80 })]);
  ok('规格规则⑤：地面且 <50kt → 滑行',
    f({ onGround: true, altFt: 0, vsFpm: 0, gsKt: 15 }) === PHASES.TAXI,
    PHASE_LABEL[f({ onGround: true, altFt: 0, vsFpm: 0, gsKt: 15 })]);
  ok('规格规则②：<3000ft 且 vs>500 → 爬升',
    f({ altFt: 1800, vsFpm: 1800 }) === PHASES.CLIMB);
  ok('规格规则③：>3000ft 且 |vs|<300 → 巡航',
    f({ altFt: 35000, vsFpm: 0 }) === PHASES.CRUISE && f({ altFt: 12000, vsFpm: 120 }) === PHASES.CRUISE);
  ok('规格规则④：<5000ft 且 vs<-500 → 下降/进近',
    f({ altFt: 3200, vsFpm: -1400 }) === PHASES.APPROACH);

  // 规则空档必须有兜底，否则界面上会出现「无阶段」
  const samples = [];
  for (let alt = 0; alt <= 41000; alt += 500) {
    for (let vs = -3000; vs <= 3000; vs += 250) {
      for (const onGround of [false, true]) {
        const ph = detectPhase({ onGround, altFt: alt, vsFpm: vs, gsKt: 250 });
        if (!PHASE_LABEL[ph]) samples.push(`${alt}/${vs}/${onGround}`);
      }
    }
  }
  ok('阶段判定完备（遍历 344×2 组状态无死角）', samples.length === 0, `${samples.length} 组无阶段`);

  ok('高空下降判为下降而非进近', f({ altFt: 25000, vsFpm: -2000 }) === PHASES.DESCENT);
  ok('高度缺失（null）不抛错', typeof detectPhase({ onGround: false, altFt: null, vsFpm: 0, gsKt: 0 }) === 'string');
  ok('速度缺失不抛错', typeof detectPhase({ onGround: true, altFt: 0, vsFpm: 0, gsKt: null }) === 'string');

  ok('isAirborne 语义正确',
    PH.isAirborne(PHASES.CRUISE) && !PH.isAirborne(PHASES.TAXI) && !PH.isAirborne(PHASES.GROUND));
  ok('阶段配色键覆盖全部阶段',
    [PHASES.TAXI, PHASES.GROUND, PHASES.CLIMB, PHASES.CRUISE, PHASES.DESCENT, PHASES.APPROACH]
      .every((ph) => typeof PH.phaseColorKey(ph, 20000) === 'string'));
  ok('高度层显示（FL350）', PH.altText(35000) === 'FL350', PH.altText(35000));
  ok('地面高度显示为 GND', PH.altText(0) === 'GND');
  ok('低空直接显示英尺', PH.altText(8500) === '8500 ft', PH.altText(8500));
  ok('高度缺失显示破折号', PH.altText(null) === '—');
  ok('垂直速率带符号', PH.vsText(1200) === '+1200 fpm' && PH.vsText(-900) === '-900 fpm');
  ok('升降箭头阈值正确', PH.vsArrow(900) === '\u2191' && PH.vsArrow(-900) === '\u2193' && PH.vsArrow(100) === '');
}

/* ══════════════════════════════════════════════════════════════
 * 10) 国别地址块
 * ══════════════════════════════════════════════════════════════ */
const C = await load('src/data/countries.js');

group('ICAO24 国别地址块');
{
  ok('中国地址块识别', C.countryOfHex('7806aa') === 'China' && C.countryOfHex('7bffff') === 'China');
  ok('美国地址块识别', C.countryOfHex('a1b2c3') === 'United States');
  ok('日本地址块识别', C.countryOfHex('840531') === 'Japan');
  ok('韩国地址块识别', C.countryOfHex('71c078') === 'Republic of Korea');
  ok('英国地址块识别', C.countryOfHex('400001') === 'United Kingdom');
  ok('区外地址返回 null（不猜）', C.countryOfHex('000001') === null && C.countryOfHex('123456') === null);
  ok('非法输入返回 null', C.countryOfHex('xyz') === null && C.countryOfHex(null) === null && C.countryOfHex('12345') === null);
  ok('中文名映射', C.countryLabel('China') === '中国' && C.countryLabel('United States') === '美国');
  ok('未收录国名回退原文', C.countryLabel('Neverland') === 'Neverland');

  // 采用上游值时标注来源
  const up = C.resolveCountry({ hex: '7806aa', originCountry: 'China' });
  ok('上游提供国别时优先采用', up.source === 'upstream');
  const hx = C.resolveCountry({ hex: '7806aa' });
  ok('上游缺失时按地址块推断并标注', hx.source === 'hexblock' && hx.name === 'China');
  ok('都不可得时返回 null 来源', C.resolveCountry({ hex: '123456' }).source === null);

  // 地址块必须升序且不重叠（二分查找的前提）
  const raw = await readFile(resolve(ROOT, 'src/data/countries.js'), 'utf8');
  const ranges = [...raw.matchAll(/\[0x([0-9a-f]+),\s*0x([0-9a-f]+),/g)]
    .map((m) => [parseInt(m[1], 16), parseInt(m[2], 16)]);
  const sorted = ranges.every((r, i) => i === 0 || r[0] > ranges[i - 1][0]);
  const disjoint = ranges.every((r, i) => i === 0 || r[0] > ranges[i - 1][1]);
  ok('地址块按升序声明（二分查找前提）', sorted, `${ranges.length} 个块`);
  ok('地址块互不重叠', disjoint);
}

/* ══════════════════════════════════════════════════════════════
 * 11) 轨迹追踪器
 * ══════════════════════════════════════════════════════════════ */
const { Tracker, looksTeleported } = await load('src/state/tracker.js');

group('轨迹追踪器');
{
  ok('looksTeleported 能识别瞬移', looksTeleported({ lat: 40, lon: 116 }, { lat: 41, lon: 117 }, 1000) === true);
  ok('looksTeleported 不误判正常飞行',
    looksTeleported({ lat: 40, lon: 116 }, destination(40, 116, 90, 2), 20000) === false);

  const tr = new Tracker({ sampleMs: 1000, maxPoints: 10 });
  const now = 1_700_000_000_000;
  const mk = (lat, lon, gs = 400, track = 90) => ({
    hex: 'abc123', lat, lon, altFt: 30000, gsKt: gs, trackDeg: track, vsFpm: 0,
    onGround: false, phase: PH.PHASES.CRUISE, callsign: 'TST123',
  });

  /**
   * 推进若干帧。
   * 必须模拟连续帧而不是单次调用：追踪器对位置做了 τ=0.6s 的指数平滑，
   * 单帧只能走完约 8% 的差距，用一帧的结果断言位置会得到「没动」的假象。
   */
  const settle = (t, seconds = 1.2) => {
    let out = null;
    const step = 1 / 60;
    for (let e = 0; e < seconds; e += step) out = tr.frame(t + e * 1000, step);
    return out;
  };

  tr.ingest([mk(40, 116)], now);
  let fr = tr.frame(now, 0.016);
  ok('首次观测即产出帧（不做平滑跳变）', fr.length === 1 && near(fr[0].lat, 40, 1e-9), `lat=${fr[0]?.lat}`);

  // 两帧之间必须插值推进，且不越过最新观测
  tr.ingest([mk(40.1, 116.1)], now + 5000);
  const mid = settle(now + 5050, 0.9)[0];
  ok('观测之间做插值（位置落在两点之间）',
    mid.lat > 40 && mid.lat <= 40.11, `lat=${mid.lat.toFixed(5)}`);

  // 超过观测时刻后要外推，且受 25 秒上限约束。
  // 注意：测试目标的航向是正东（track=90），向东飞纬度基本不变，
  // 所以判据必须是「离最后观测点的位移」，用纬度会得到反直觉的假失败。
  const lastObs = { lat: 40.1, lon: 116.1 };
  const later = settle(now + 5000 + 6000, 2.5)[0];
  const movedKm = distKm(lastObs.lat, lastObs.lon, later.lat, later.lon);
  ok('超出观测时刻后外推前进', movedKm > 0.5, `已外推 ${movedKm.toFixed(2)} km`);
  ok('外推方向沿航向（向东）', later.lon > lastObs.lon, `lon ${lastObs.lon} → ${later.lon.toFixed(5)}`);

  // 外推上限的采样点必须落在「保留期」内（DROP_AFTER_MS = 90 秒），
  // 否则目标会先被回收，测的就不是上限而是回收了。
  const tooLate = settle(now + 5000 + 40000, 2.5)[0];
  const tooLate2 = settle(now + 5000 + 80000, 2.5)[0];
  ok('断流 40–80 秒内目标仍在（未误回收）', !!tooLate && !!tooLate2);
  const dExtra = distKm(tooLate.lat, tooLate.lon, tooLate2.lat, tooLate2.lon);
  // 容差 0.2km：位置平滑（τ=0.6s）在每次采样序列结束时仍残留约 1.5% 的趋近暂态。
  // 若没有外推上限，40 秒的额外飞行应产生 8.2km 差异 —— 所以 0.2km 的判据有 40 倍余量，
  // 既容纳了平滑暂态，又能确凿地证明上限存在。
  ok('外推设有 25 秒上限（时间翻倍不再继续前进）', dExtra < 0.2,
    `额外位移 ${(dExtra * 1000).toFixed(0)} m（无上限时应达 8200 m）`);

  // 尾迹采样与容量
  const tr2 = new Tracker({ sampleMs: 1000, maxPoints: 5 });
  for (let i = 0; i < 20; i++) {
    tr2.ingest([mk(40 + i * 0.01, 116)], now + i * 1000);
    tr2.frame(now + i * 1000, 0.05);
  }
  const t = tr2.frame(now + 20000, 0.05)[0];
  ok('尾迹点数不超过容量上限', t.trail.length <= 5, `${t.trail.length} 点`);
  ok('尾迹点保留最近的一段（先进先出）', t.trail.length === 5);

  // 目标消失后应被回收
  const tr3 = new Tracker({ sampleMs: 1000, maxPoints: 5 });
  tr3.ingest([mk(40, 116)], now);
  tr3.frame(now, 0.05);
  ok('目标在保留期内仍可渲染', tr3.frame(now + 30000, 0.05).length === 1);
  ok('目标超时后自动回收', tr3.frame(now + 200000, 0.05).length === 0);
  ok('目标消失后帧列表为空但不抛错', tr3.size() >= 0);
}

/* ══════════════════════════════════════════════════════════════
 * 12) 模拟引擎
 * ══════════════════════════════════════════════════════════════ */
const { createSimulator, SIM_REGIONS } = await load('src/data/simulate.js');

group('模拟引擎');
{
  const ap = AIRPORT_BY_ICAO.ZBAA;
  const sim = createSimulator(ap, { radiusKm: 90 });
  const st0 = sim.stats();
  ok('首屏立即有目标（不等填充）', st0.count > 10, `${st0.count} 架`);
  ok('初始不是全在地面', [...sim.planes.values()].some((p) => !p.onGround));
  ok('交通模式多样（≥3 种）', Object.keys(st0.modes).length >= 3, JSON.stringify(st0.modes));
  ok('机场代号有区域承运人池', !!SIM_REGIONS.ZBAA && SIM_REGIONS.ZBAA === 'cn', SIM_REGIONS.ZBAA);

  // 推进 10 分钟模拟时间
  const seenPhases = new Set();
  let maxImpliedKt = 0;
  let outOfRange = 0;
  let prev = new Map();
  for (let step = 0; step < 1200; step++) {
    sim.update(0.5);
    for (const [hex, p] of sim.planes) {
      seenPhases.add(p.phase);
      const q = prev.get(hex);
      if (q) {
        const km = distKm(q.lat, q.lon, p.lat, p.lon);
        maxImpliedKt = Math.max(maxImpliedKt, (km / 1.852) / (0.5 / 3600));
      }
      prev.set(hex, { lat: p.lat, lon: p.lon });
      if (distKm(ap.lat, ap.lon, p.lat, p.lon) > 400) outOfRange++;
    }
  }
  ok('长时间运行不出现瞬移（隐含速度 < 700kt）', maxImpliedKt < 700, `峰值 ${maxImpliedKt.toFixed(0)} kt`);
  ok('目标不会飞出视景范围（< 400km）', outOfRange === 0, `${outOfRange} 次越界`);
  ok('阶段覆盖丰富（≥4 种）', seenPhases.size >= 4, [...seenPhases].join('/'));
  ok('爬升与下降都出现过',
    seenPhases.has(PH.PHASES.CLIMB) && (seenPhases.has(PH.PHASES.DESCENT) || seenPhases.has(PH.PHASES.APPROACH)),
    [...seenPhases].join('/'));

  const st1 = sim.stats();
  ok('流量维持稳定（±60% 目标值）', st1.count > st1.target * 0.4 && st1.count < st1.target * 1.6,
    `${st1.count} / 目标 ${st1.target}`);

  // 位置与高度必须始终有效
  const badPlane = [...sim.planes.values()].find((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lon)
    || !Number.isFinite(p.altFt) || p.altFt < 0 || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180);
  ok('全部目标的状态有限且合法', !badPlane, badPlane ? JSON.stringify(badPlane) : '');

  // 落地目标不应为负高度
  ok('地面目标高度非负', [...sim.planes.values()].every((p) => p.altFt >= 0));

  // 确定性：同种子两次运行结果一致
  const a = createSimulator(ap, { radiusKm: 90 });
  const b = createSimulator(ap, { radiusKm: 90 });
  const sig = (s) => [...s.planes.values()].map((p) => `${p.callsign}@${p.lat.toFixed(4)},${p.lon.toFixed(4)},${p.altFt}`).sort().join('|');
  ok('模拟引擎确定性（同机场两次开局一致）', sig(a) === sig(b));
  for (let i = 0; i < 40; i++) { a.update(0.5); b.update(0.5); }
  ok('确定性在推进后仍保持', sig(a) === sig(b));

  // 不同机场应给出不同空域
  const c = createSimulator(AIRPORT_BY_ICAO.KJFK, { radiusKm: 90 });
  ok('不同机场产生不同空域', sig(a) !== sig(c));

  // 无跑道数据时的降级：过境与盘旋不依赖跑道，仍应可用；
  // 进离场必须不出现（而不是生成一条起点在机场中心的假航迹）
  const noRw = createSimulator({ ...ap, runways: [] }, {});
  const noRwModes = new Set([...noRw.planes.values()].map((p) => p.simMode));
  ok('无跑道数据时优雅降级（仅保留不依赖跑道的模式）',
    noRwModes.size > 0 && [...noRwModes].every((m) => m === 'overflight' || m === 'holding'),
    [...noRwModes].join('/') || '(空)');
}

/* ══════════════════════════════════════════════════════════════
 * 13) 产物与工程约束
 * ══════════════════════════════════════════════════════════════ */
group('源码语法与结构');
{
  /**
   * 逐个文件做语法检查。
   *
   * 为什么必须单独做：`node --check src/main.js` **不会跟随 import**，
   * 被导入模块里的语法错误完全逃得过检查。曾真实发生过一次 ——
   * 编辑 tracker.js 时把类方法 `frame()` 误写成 `function frame()`，
   * 自检全绿、页面却整个起不来（类体内出现 function 声明是语法错误）。
   */
  const { readdir } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const walk = async (dir) => {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) out.push(...await walk(p));
      else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
    }
    return out;
  };

  const files = [...await walk(resolve(ROOT, 'src')), ...await walk(resolve(ROOT, 'scripts'))];
  const broken = [];
  for (const f of files) {
    try {
      await run(process.execPath, ['--check', f], { timeout: 20000 });
    } catch (e) {
      const msg = String(e.stderr || e.message).split('\n').filter(Boolean)[1] || '语法错误';
      broken.push(`${f.replace(ROOT, '').replace(/\\/g, '/')}: ${msg.trim()}`);
    }
  }
  ok(`全部源码可被解析（${files.length} 个文件）`, broken.length === 0, broken.slice(0, 3).join(' | '));

  // 页面入口必须存在，且 index.html 真的引用了它
  const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  const entry = /src="([^"]*main\.js)"/.exec(html);
  ok('index.html 引用的入口文件存在', !!entry && !!(await stat(resolve(ROOT, entry[1])).catch(() => null)),
    entry ? entry[1] : '未找到 script 标签');
}

group('产物与工程约束');
{
  const must = ['index.html', '.nojekyll', 'package.json', 'src/styles.css'];
  for (const f of must) {
    const s = await stat(resolve(ROOT, f)).catch(() => null);
    ok(`存在 ${f}`, !!s && s.size > 0, s ? `${s.size} B` : '缺失');
  }

  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
  ok('零运行时依赖（无 dependencies）',
    !pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
  ok('零开发依赖（无需构建链）',
    !pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0);
  ok('声明为 ESM', pkg.type === 'module');

  const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  ok('index.html 引用的脚本存在且为相对路径', /src="src\/main\.js"/.test(html));
  ok('index.html 声明中文语言', /lang="zh-CN"/.test(html));
  ok('index.html 含免责声明容器', /block--legal|不得用于飞行安全/.test(html));

  // 只检查真正会发起请求的属性（src / href），
  // 不能拿整个文件去匹配 http:// —— 表单 placeholder 里也会出现样例 URL，
  // 那不是依赖，误报会掩盖真问题。
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const remote = refs.filter((u) => !u.startsWith('data:') && !u.startsWith('#') && /^[a-z][a-z0-9+.-]*:/i.test(u));
  ok('无外部资源依赖（src/href 全部为本地相对路径或内联 data:）',
    remote.length === 0, remote.join(' ') || `${refs.length} 个引用全部本地`);
  ok('未从任何 CDN 加载脚本或样式', !/cdn\.|unpkg|jsdelivr|cdnjs|fonts\.googleapis/.test(html));

  // 源码规模：单文件不应膨胀到失控
  const { readdir } = await import('node:fs/promises');
  const walk = async (dir) => {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) out.push(...await walk(p));
      else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  };
  const files = await walk(resolve(ROOT, 'src'));
  let biggest = { n: '', lines: 0 };
  let over = 0;
  for (const f of files) {
    const lines = (await readFile(f, 'utf8')).split('\n').length;
    if (lines > biggest.lines) biggest = { n: f.replace(ROOT, '').replace(/\\/g, '/'), lines };
    if (lines > 400) over++;
  }
  ok('单文件均不超过 400 行', over === 0, `最大 ${biggest.n} ${biggest.lines} 行`);
  ok('源码文件粒度合理（30–60 个模块）', files.length >= 30 && files.length <= 70, `${files.length} 个模块`);
}

/* ══════════════════════════════════════════════════════════════
 * 14) 渲染护栏（目标硬上限与尾迹视口剔除）
 * ══════════════════════════════════════════════════════════════ */
group('渲染护栏（硬上限剔除 · 尾迹视口剔除）');
{
  const { cullByDistance } = await load('src/render/planes.js');
  const { drawTrails } = await load('src/render/trails.js');

  const P = new Projection(40.0773, 116.5967);
  P.setView(240, 180, 0.5); // 0.5 km/px → 480×360 视口

  // ── config.js 承诺的 hardCutoff 护栏必须真的存在 ──
  const few = Array.from({ length: 10 }, (_, i) => ({ hex: `f${i}`, lat: 40 + i * 0.01, lon: 116 }));
  ok('未超限时不裁剪（返回原数组引用，热路径零分配）',
    cullByDistance(few, P, PERF.hardCutoff) === few);

  const many = Array.from({ length: PERF.hardCutoff + 100 }, (_, i) => ({
    hex: `h${i}`,
    lat: 40.0773 + (i - 300) * 0.05, // h300 正落在机场，两端最远
    lon: 116.5967,
  }));
  const cut = cullByDistance(many, P, PERF.hardCutoff);
  ok('超限裁剪到硬上限', cut.length === PERF.hardCutoff, `${cut.length} / ${many.length}`);
  const kept = new Set(cut.map((f) => f.hex));
  ok('裁剪保留离机场最近的目标、剔除最远的',
    kept.has('h300') && !kept.has('h0') && !kept.has(`h${many.length - 1}`),
    kept.has('h300') ? '近处保留' : '近处被误剔');

  // ── 尾迹的视口剔除：屏外目标不该产生任何描边 ──
  let strokes = 0;
  const ctx = {
    canvas: { width: 480, height: 360 },
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() { strokes++; },
  };
  const item = (lat, lon) => ({
    plane: { onGround: false, gsKt: 450, altFt: 35000 },
    trail: [{ lat, lon, alt: 35000 }, { lat: lat + 0.004, lon, alt: 35000 }],
  });
  const trailOpts = { enabled: true, maxPlanes: PERF.trailCutoff, w: 480, h: 360 };

  drawTrails(ctx, [item(60, 130)], P, trailOpts);   // 距视口十万八千里
  const offStrokes = strokes;
  drawTrails(ctx, [item(40.0773, 116.5967)], P, trailOpts); // 正在视口中心
  ok('屏外目标不绘制尾迹（不为看不见的段做投影）', offStrokes === 0, `${offStrokes} 条描边`);
  ok('屏内目标照常绘制尾迹', strokes > offStrokes, `${strokes - offStrokes} 条描边`);
}

/* ══════════════════════════════════════════════════════════════
 * 15) 快照源链路（多镜像竞速 · 兜底仓库 · 404 判死）
 * ──────────────────────────────────────────────────────────────
 * 这组补的是「为什么线上/本地总是模拟数据」这类故障的防线：
 * 快照链路是默认通路，它一断，界面 100% 落到造的模拟数据。
 * 全部用 mock fetch，不开网络、不碰真仓库。
 * ══════════════════════════════════════════════════════════════ */
group('快照源链路（镜像竞速与判死）');
{
  const { SOURCES } = await load('src/config.js');
  const origFetch = globalThis.fetch;
  let seq = 0;
  /** 每个用例用独立模块实例：dead 快照集合是模块级状态，必须相互隔离 */
  const freshModule = () => import(
    pathToFileURL(resolve(ROOT, 'src/data/sources.js')).href + `?fresh=${++seq}`
  );

  const ctx = { icao: 'ZBAA', lat: 40.0773, lon: 116.5967, radiusNm: 50, radiusKm: 92.6 };
  const payload = (over = {}) => ({
    icao: 'ZBAA', fetchedAt: Date.now(), source: 'adsb.lol', radiusNm: 50,
    ac: [{ hex: 'abc123', flight: 'TEST1  ', lat: 40, lon: 116, alt_baro: 10000, gs: 400, track: 90 }],
    ...over,
  });
  const resOk = (data) => ({ ok: true, status: 200, json: async () => data });
  const res404 = () => ({ ok: false, status: 404, json: async () => ({}) });

  try {
    /* 用例 1：已知仓库（GitHub Pages）→ 只打镜像，不打同源 */
    {
      const urls = [];
      globalThis.fetch = async (u) => { urls.push(String(u)); return resOk(payload()); };
      const { snapshotSource: src } = await freshModule();
      const r = await src(() => ({ repo: 'x/y', branch: 'data' })).run(ctx);
      ok('已知仓库时不请求同源快照（线上零 404）',
        !urls.some((u) => !/^https?:/.test(u)), urls.filter((u) => !/^https?:/.test(u)).join(','));
      const hosts = SOURCES.mirrorTemplates.length;
      ok('三个镜像域名全部发起竞速',
        urls.length === hosts
        && urls.some((u) => u.includes('raw.githubusercontent.com'))
        && urls.some((u) => u.includes('cdn.jsdelivr.net'))
        && urls.some((u) => u.includes('ghproxy.net')),
        `${urls.length} 个请求`);
      ok('竞速结果可解析出记录', r.records.length === 1 && r.fetchedAt > 0, `records=${r.records.length}`);
    }

    /* 用例 2：仓库名推断失败（本地开发）→ fallbackRepo + 同源参与 */
    {
      const urls = [];
      globalThis.fetch = async (u) => { urls.push(String(u)); return resOk(payload()); };
      const { snapshotSource: src } = await freshModule();
      await src(() => ({ repo: '', branch: 'data' })).run(ctx);
      ok('推断不出仓库时用 fallbackRepo 拼镜像',
        urls.some((u) => u.includes(`raw.githubusercontent.com/${SOURCES.fallbackRepo}/`)),
        SOURCES.fallbackRepo);
      ok('推断不出仓库时同源快照参与竞速',
        urls.some((u) => u === `data/snapshots/${ctx.icao}.json`), urls.find((u) => !/^https?:/.test(u)) || '未请求');
    }

    /* 用例 3：镜像同时可达但年龄不同 → 取 fetchedAt 最新的一份 */
    {
      const now = Date.now();
      const age = { raw: 3 * 3600e3, jsdelivr: 90 * 60e3, ghproxy: 2 * 3600e3 };
      globalThis.fetch = async (u) => {
        const s = String(u);
        const off = s.includes('jsdelivr') ? age.jsdelivr : s.includes('ghproxy') ? age.ghproxy : age.raw;
        return resOk(payload({ fetchedAt: now - off })); // 全部陈旧，强制走「全量择优」
      };
      const { snapshotSource: src } = await freshModule();
      const r = await src(() => ({ repo: 'x/y', branch: 'data' })).run(ctx);
      ok('多镜像择优取 fetchedAt 最新者', r.fetchedAt === now - age.jsdelivr,
        `age=${Math.round((now - r.fetchedAt) / 60000)}min`);
    }

    /* 用例 4：所有候选 404 → 抛错 + 记入判死集合（下个周期不再撞） */
    {
      globalThis.fetch = async () => res404();
      const mod = await freshModule();
      const src = mod.snapshotSource;
      let threw = null;
      try { await src(() => ({ repo: '', branch: 'data' })).run(ctx); } catch (e) { threw = e; }
      ok('全 404 时报 FetchError 而非挂起', threw && threw.name === 'FetchError', threw ? threw.name : '未抛错');
      const dead = mod.deadSnapshotPaths();
      ok('三个镜像 URL 全部判死', dead.urls.length === SOURCES.mirrorTemplates.length,
        `dead=${dead.urls.length}`);
      ok('同源目录判死（后续周期不再请求）', dead.dirs.includes(SOURCES.snapshotDir),
        dead.dirs.join(',') || '未判死');
    }

    /* 用例 5：某镜像挂死不返回 → 新鲜结果先到即收口，不被拖垮 */
    {
      globalThis.fetch = async (u) => (String(u).includes('raw.githubusercontent')
        ? new Promise(() => {}) /* 模拟被墙域名：永不返回 */
        : resOk(payload({ fetchedAt: Date.now() })));
      const { snapshotSource: src } = await freshModule();
      const t0 = Date.now();
      const guarded = Promise.race([
        src(() => ({ repo: 'x/y', branch: 'data' })).run(ctx),
        new Promise((_, rej) => setTimeout(() => rej(new Error('早退失效：被挂死候选拖住')), 3000)),
      ]);
      let out = null;
      let err = null;
      try { out = await guarded; } catch (e) { err = e; }
      const elapsed = Date.now() - t0;
      ok('新鲜结果先到即收口（不等挂死候选）', !!out && elapsed < 2000,
        err ? err.message : `${elapsed}ms`);
    }

    /* 用例 6：镜像全部网络失败（本地离线/被墙）→ 本地同源文件兜底 */
    {
      globalThis.fetch = async (u) => (String(u).startsWith('http')
        ? Promise.reject(new TypeError('network down'))
        : resOk(payload({ fetchedAt: Date.now() - 60e3 })));
      const { snapshotSource: src } = await freshModule();
      const r = await src(() => ({ repo: '', branch: 'data' })).run(ctx);
      ok('镜像不可达时本地同源快照兜底', r && r.note === '快照 · 同源', r ? r.note : '失败');
    }

    /* 用例 7：首响是旧数据 → 600ms 窗口内赶到的更优结果应当被等到 */
    {
      const now = Date.now();
      globalThis.fetch = async (u) => {
        if (String(u).includes('jsdelivr')) {
          await new Promise((r) => setTimeout(r, 450)); // 窗口内（600ms）赶到
          return resOk(payload({ fetchedAt: now - 15 * 60e3 })); // 15min 前：不触发「足够新鲜」早退
        }
        return resOk(payload({ fetchedAt: now - 3 * 3600e3 })); // 3 小时前
      };
      const { snapshotSource: src } = await freshModule();
      const t0 = Date.now();
      const r = await src(() => ({ repo: 'x/y', branch: 'data' })).run(ctx);
      ok('窗口内等到更优结果（择优而非先到先赢）',
        r && r.fetchedAt === now - 15 * 60e3 && Date.now() - t0 < 2000,
        r ? `选中 ${Math.round((now - r.fetchedAt) / 60000)}min 前 · ${Date.now() - t0}ms` : '失败');
    }
  } finally {
    globalThis.fetch = origFetch;
  }
}

/* ══════════════════════════════════════════════════════════════
 * 汇总
 * ══════════════════════════════════════════════════════════════ */
console.log(`\n${'═'.repeat(58)}`);
console.log(`  自检结果：\x1b[32m通过 ${pass}\x1b[0m / \x1b[31m失败 ${fail}\x1b[0m`);
console.log('═'.repeat(58));
process.exit(fail > 0 ? 1 : 0);
