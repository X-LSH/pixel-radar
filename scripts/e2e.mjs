/**
 * Pixel Radar · 真实浏览器端到端验证
 * ===============================================================
 * 不是 DOM 模拟 —— 走真实 Chrome、真实输入事件管线、真实渲染结果。
 * 覆盖：首屏就绪、画面非空白、真实点击命中目标、真实键盘暂停、
 *       控件状态一致、机场切换往返、响应式、控制台零报错。
 *
 * 本机环境有三个坑（都在代码里处理了）：
 *   1. 无头 Chrome 会走系统代理，导致 127.0.0.1 被送进代理隧道 ——
 *      必须加 --no-proxy-server --proxy-bypass-list=<-loopback>；
 *   2. Chrome 在两次 Bash 调用之间无法存活，所以启动与验证必须同一个脚本；
 *   3. 前台 Bash 有约 60 秒硬上限，所以本脚本要用 run_in_background 跑。
 *
 * 用法：
 *   node scripts/e2e.mjs                       默认 http://127.0.0.1:5173/
 *   BASE=http://127.0.0.1:4173/pixel-radar/ node scripts/e2e.mjs
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'shots');
const BASE = process.env.BASE || 'http://127.0.0.1:5173/';
const PORT = Number(process.env.CDP_PORT || 9351);
const PROFILE = process.env.CDP_PROFILE
  || `C:/Users/${process.env.USERNAME || 'LSH'}/AppData/Local/Temp/pixel-radar-cdp-${Date.now()}`;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isLocal = /(127\.0\.0\.1|localhost|\[::1\])/.test(BASE);

/* ── 断言框架 ── */
const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures++;
  const mark = ok ? '  ✓' : '  ✗';
  console.log(`${mark} ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── Chrome ── */
const portOpen = async () => {
  try { return (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { return false; }
};

async function launchChrome() {
  if (await portOpen()) return null;
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
  ];
  if (isLocal) args.push('--no-proxy-server', '--proxy-bypass-list=<-loopback>');
  const child = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await portOpen()) return child.pid;
    await sleep(500);
  }
  throw new Error('Chrome 未能在 30 秒内开启调试端口');
}

/* ── CDP ── */
function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => res(ws);
    ws.onerror = rej;
  });
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  console.log(`目标：${BASE}\n`);

  const chromePid = await launchChrome();

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到可用页面目标');

  const ws = await connect(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const pageErrors = [];

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      pageErrors.push(d?.exception?.description || d?.text || 'unknown exception');
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      consoleErrors.push(m.params.entry.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };

  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
    }
    return r.result?.result?.value;
  };

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const path = resolve(SHOTS, `${name}.png`);
    await writeFile(path, Buffer.from(r.result.data, 'base64'));
    return path;
  };

  const click = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
      });
      await sleep(40);
    }
    await sleep(220);
  };

  const key = async (k, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: k === ' ' ? ' ' : undefined });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(220);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 950, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url: BASE });

  /* ── 等待就绪 ── */
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = await evaluate('!!(window.__PIXEL_RADAR__ && window.__PIXEL_RADAR__.snapshot().ready)');
    } catch { ready = false; }
    if (ready) break;
    await sleep(500);
  }
  check('应用完成启动（__PIXEL_RADAR__.snapshot().ready）', ready, ready ? '' : '60 次轮询内未就绪');
  if (!ready) throw new Error('应用未就绪，中止后续断言');

  await sleep(1200);

  /* ── 1. 首屏 ── */
  const title = await evaluate('document.title');
  check('页面标题含机场代码', /ZBAA|PEK/.test(title), title);

  const domCounts = await evaluate(`({
    canvas: document.querySelectorAll('canvas').length,
    toggles: document.querySelectorAll('.tg').length,
    rings: document.querySelectorAll('#ringSeg button').length,
    chain: document.querySelectorAll('#chain li').length,
    stats: document.querySelectorAll('.stat').length,
  })`);
  check('关键 DOM 齐备',
    domCounts.canvas >= 1 && domCounts.toggles === 7 && domCounts.rings === 4 && domCounts.chain === 4 && domCounts.stats === 6,
    JSON.stringify(domCounts));

  const s0 = await evaluate('JSON.stringify(window.__PIXEL_RADAR__.snapshot())').then(JSON.parse);
  check('空域有目标', s0.count > 0, `${s0.count} 架`);
  check('数据源已确定', !!s0.feed.state && s0.feed.state !== 'boot', `${s0.feed.state} / ${s0.feed.sourceId}`);
  // 像素尺寸必须是 2–6 的整数，且 canvas 至少铺满视口（余量不足 1 个像素）
  const cover = await evaluate(`(() => {
    const cv = document.querySelector('canvas');
    const r = cv.getBoundingClientRect();
    const host = document.getElementById('viewport').getBoundingClientRect();
    return { w: r.width, h: r.height, hw: host.width, hh: host.height };
  })()`);
  check('像素尺寸为 2–6 的整数倍',
    Number.isInteger(s0.resolution.scale) && s0.resolution.scale >= 2 && s0.resolution.scale <= 6,
    `${s0.resolution.scale}×`);
  check('整数倍放大铺满视口（余量 < 1 像素）',
    cover.w >= cover.hw - 0.5 && cover.w < cover.hw + s0.resolution.scale
    && cover.h >= cover.hh - 0.5 && cover.h < cover.hh + s0.resolution.scale,
    `canvas ${cover.w.toFixed(0)}×${cover.h.toFixed(0)} / 视口 ${cover.hw.toFixed(0)}×${cover.hh.toFixed(0)}`);

  const phaseKinds = Object.keys(s0.phases || {}).length;
  check('飞行阶段判定生效', phaseKinds >= 2 && !s0.phases.unknown,
    Object.entries(s0.phases).map(([k, v]) => `${k}:${v}`).join(' '));
  check('每个目标都带阶段（无 unknown）',
    !Object.prototype.hasOwnProperty.call(s0.phases, 'unknown'), JSON.stringify(s0.phases));

  /**
   * 线上环境额外要求：数据必须是**真实**的，不能是兜底的模拟数据。
   *
   * 为什么单独设一道：默认断言只检查「有目标」，而模拟数据同样有目标 ——
   * 于是「快照为空 → 降级到模拟」这种最需要被发现的故障，反而会被判为通过。
   * 用 REQUIRE_REAL=1 显式开启这条严格检查。
   */
  if (process.env.REQUIRE_REAL === '1') {
    check('数据源为真实通路（非模拟兜底）',
      s0.feed.state === 'snapshot' || s0.feed.state === 'live',
      `${s0.feed.state} / ${s0.feed.sourceId}`);
    check('目标来自真实快照（未被判定为空）',
      s0.count > 0 && !!s0.feed.fetchedAt && s0.feed.sourceId !== '模拟',
      `${s0.count} 架 · 源 ${s0.feed.sourceId}`);
  }

  /* ── 2. 渲染非空白 ── */
  const colorStat = await evaluate(`(() => {
    const cv = document.querySelector('canvas');
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    const set = new Set();
    let lit = 0;
    for (let i = 0; i < d.length; i += 4 * 37) {
      set.add((d[i] >> 3) + ',' + (d[i+1] >> 3) + ',' + (d[i+2] >> 3));
      if (d[i] + d[i+1] + d[i+2] > 150) lit++;
    }
    return { distinct: set.size, litRatio: lit / (d.length / (4*37)) };
  })()`);
  check('画面已绘制（颜色数 > 20）', colorStat.distinct > 20, `distinct=${colorStat.distinct}`);
  check('画面有发光内容（亮像素 > 1%）', colorStat.litRatio > 0.01,
    `litRatio=${(colorStat.litRatio * 100).toFixed(2)}%`);

  await shot('01-boot');

  /* ── 2b. 雷达扫描必须真的在转 ──
   * 这条断言是补的：第一版 `sweep.update()` 根本没被调用，扫描线永远停在
   * 000 度，而「画面有亮像素」这类断言完全抓不到它 —— 只有看渲染结果才发现。 */
  const a0 = await evaluate('window.__PIXEL_RADAR__.stage.sweep.getAngle()');
  await sleep(1500);
  const a1 = await evaluate('window.__PIXEL_RADAR__.stage.sweep.getAngle()');
  const delta = ((a1 - a0) % 360 + 360) % 360;
  // 规格：周期 4 秒 → 1.5 秒应转约 135°；给 ±40° 容差吸收帧调度抖动
  check('雷达扫描线持续旋转（4 秒周期）', delta > 95 && delta < 175, `1.5s 内转了 ${delta.toFixed(1)}°`);
  check('扫描角归一在 [0,360)', a1 >= 0 && a1 < 360, `${a1.toFixed(1)}°`);

  /* ── 4. 真实点击命中目标 ── */
  const targetPos = await evaluate('window.__PIXEL_RADAR__.firstVisibleTarget()');
  check('屏内存在可点击目标', !!targetPos,
    targetPos ? `${targetPos.callsign} @ ${Math.round(targetPos.x)},${Math.round(targetPos.y)}` : '无目标落在视口内');

  /* ── 3b. 尾迹需要时间累积 —— 采样间隔 5 秒，等够两个采样点 ── */
  console.log('  · 等待尾迹累积（采样间隔 5 秒）…');
  await sleep(13000);
  const trailStat = await evaluate('JSON.stringify(window.__PIXEL_RADAR__.snapshot())').then(JSON.parse);
  check('尾迹已在记录', trailStat.withTrail > 0, `${trailStat.withTrail} 架有尾迹`);
  const trailPts = await evaluate('window.__PIXEL_RADAR__.pipeline.getTracker().trailPointCount()');
  check('尾迹点数在增长', trailPts > 0, `${trailPts} 个轨迹点`);
  check('尾迹点数未失控（< 20000）', trailPts < 20000, `${trailPts}`);

  if (targetPos) {
    await click(targetPos.x, targetPos.y);
    const card = await evaluate(`({
      visible: !document.getElementById('cardBody').hidden,
      callsign: document.getElementById('cCallsign').textContent,
      rows: document.querySelectorAll('#cFields .kv__row').length,
      phase: document.getElementById('cPhase').textContent,
      airline: document.getElementById('cAirline').textContent,
    })`);
    check('点击后信息卡弹出', card.visible, JSON.stringify(card));
    check('信息卡呼号与点击目标一致', card.callsign === targetPos.callsign,
      `期望 ${targetPos.callsign}，实得 ${card.callsign}`);
    check('信息卡字段数符合规格（11 行）', card.rows === 11, `${card.rows} 行`);
    check('信息卡显示承运人与阶段', !!card.phase && !!card.airline, `${card.phase} / ${card.airline}`);
    await shot('02-infocard');

    // 统计口径必须自洽：空中 + 地面 = 总数
    await sleep(700);
    const st = await evaluate(`({
      count: document.getElementById('stCount').textContent,
      air: document.getElementById('stAir').textContent,
      ground: document.getElementById('stGround').textContent,
      top: document.getElementById('stTop').textContent,
      fast: document.getElementById('stFast').textContent,
      hdg: document.getElementById('stHdg').textContent,
    })`);
    check('空域统计自洽（空中 + 地面 = 总数）',
      Number(st.air) + Number(st.ground) === Number(st.count) && Number(st.count) > 0,
      JSON.stringify(st));
    check('统计给出最高与最快读数', st.top !== '—' && st.fast !== '—', `${st.top} / ${st.fast} / ${st.hdg}`);
  }

  /* ── 4. 真实键盘：空格暂停 ── */
  await key(' ', 'Space', 32);
  const paused = await evaluate(`({
    paused: window.__PIXEL_RADAR__.store.get().paused,
    status: document.getElementById('sbMode').textContent,
    btn: document.getElementById('pauseBtn').textContent.trim(),
  })`);
  check('空格键暂停生效', paused.paused === true, JSON.stringify(paused));
  check('暂停时状态栏有明确提示', /暂停/.test(paused.status), paused.status);

  // 暂停时扫描线必须真的停住，而不是继续慢慢转
  const p0 = await evaluate('window.__PIXEL_RADAR__.stage.sweep.getAngle()');
  await sleep(900);
  const p1 = await evaluate('window.__PIXEL_RADAR__.stage.sweep.getAngle()');
  check('暂停时扫描线静止', p0 === p1, `${p0.toFixed(1)}° → ${p1.toFixed(1)}°`);

  await shot('03-paused');

  await key(' ', 'Space', 32);
  const resumed = await evaluate('window.__PIXEL_RADAR__.store.get().paused');
  check('再次空格恢复运行', resumed === false, `paused=${resumed}`);

  /* ── 5. 控件：距离环 ── */
  await click(...(await evaluate(`(() => {
    const r = document.querySelector('#ringSeg button[data-ring="5"]').getBoundingClientRect();
    return [r.left + r.width/2, r.top + r.height/2];
  })()`)));
  const ring = await evaluate(`({
    store: window.__PIXEL_RADAR__.store.get().ringKm,
    active: document.querySelector('#ringSeg button.is-on')?.dataset.ring,
  })`);
  check('距离环切换到 5km', ring.store === 5 && ring.active === '5', JSON.stringify(ring));

  /* ── 6. 像素粒度 ── */
  await click(...(await evaluate(`(() => {
    const r = document.querySelector('#scaleSeg button[data-scale="5"]').getBoundingClientRect();
    return [r.left + r.width/2, r.top + r.height/2];
  })()`)));
  const scaleNow = await evaluate(`window.__PIXEL_RADAR__.stage.resolution`);
  check('像素粒度切换到 5×', scaleNow.scale === 5, JSON.stringify(scaleNow));

  /* ── 7. CRT 开关 ── */
  await click(...(await evaluate(`(() => {
    const r = document.querySelector('.tg input[data-tg="crt"]').closest('.tg').getBoundingClientRect();
    return [r.left + 20, r.top + r.height/2];
  })()`)));
  const crt = await evaluate(`({
    store: window.__PIXEL_RADAR__.store.get().crt,
    attr: document.getElementById('app').dataset.crt,
  })`);
  check('CRT 效果可关闭', crt.store === false && crt.attr === 'off', JSON.stringify(crt));
  await shot('04-crt-off');
  // 复原
  await click(...(await evaluate(`(() => {
    const r = document.querySelector('.tg input[data-tg="crt"]').closest('.tg').getBoundingClientRect();
    return [r.left + 20, r.top + r.height/2];
  })()`)));

  await evaluate('window.__PIXEL_RADAR__.setScale(0)');
  await sleep(400);

  /* ── 8. 机场切换往返 ── */
  await click(...(await evaluate(`(() => {
    const r = document.getElementById('airportBtn').getBoundingClientRect();
    return [r.left + r.width/2, r.top + r.height/2];
  })()`)));
  const pickerOpen = await evaluate('!document.querySelector(".picker").hidden');
  check('机场选择器可打开', pickerOpen === true, `hidden=${!pickerOpen}`);

  await evaluate(`(() => {
    const i = document.querySelector('.picker__input');
    i.value = 'KJFK';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(250);
  const pickerHits = await evaluate('document.querySelectorAll(".picker__item").length');
  check('选择器搜索生效', pickerHits >= 1 && pickerHits <= 3, `命中 ${pickerHits} 项`);

  await key('Enter', 'Enter', 13);
  for (let i = 0; i < 40; i++) {
    const icao = await evaluate('window.__PIXEL_RADAR__.store.get().airport.icao');
    if (icao === 'KJFK') break;
    await sleep(300);
  }
  await sleep(2500);
  const kj = await evaluate('JSON.stringify(window.__PIXEL_RADAR__.snapshot())').then(JSON.parse);
  check('机场切换到 KJFK', kj.airport === 'KJFK', kj.airport);
  check('切换后有目标（KJFK 真实快照）', kj.count > 0, `${kj.count} 架 · 源 ${kj.feed.sourceId}`);
  if (process.env.REQUIRE_REAL === '1') {
    check('切换机场后仍走真实通路',
      kj.feed.state === 'snapshot' || kj.feed.state === 'live',
      `${kj.feed.state} / ${kj.feed.sourceId}`);
  }
  const kjTitle = await evaluate('document.title');
  check('标题同步更新', /KJFK/.test(kjTitle), kjTitle);

  // 控件高亮、状态栏、内部状态三者必须指向同一个量程 ——
  // 换机场不会重置量程，若某处漏了同步就会「面板显示 20km、状态栏显示 5km」。
  const ringConsistency = await evaluate(`({
    store: window.__PIXEL_RADAR__.store.get().ringKm,
    panelOn: document.querySelector('#ringSeg button.is-on')?.dataset.ring,
    statusBar: document.getElementById('sbView').textContent,
  })`);
  check('换机场后量程三处一致（内部/面板/状态栏）',
    String(ringConsistency.store) === ringConsistency.panelOn
    && ringConsistency.statusBar.startsWith(`${ringConsistency.store}km`),
    JSON.stringify(ringConsistency));

  await shot('05-kjfk');

  /* ── 9. 响应式 ── */
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(900);
  const mobile = await evaluate(`({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    res: window.__PIXEL_RADAR__.stage.resolution,
    panelVisible: getComputedStyle(document.getElementById('panel')).display !== 'none',
  })`);
  check('移动端无横向溢出', mobile.sw <= mobile.iw + 1, `scrollWidth=${mobile.sw} innerWidth=${mobile.iw}`);
  check('移动端分辨率自适应', mobile.res.w > 0 && mobile.res.w < 300, JSON.stringify(mobile.res));
  await shot('06-mobile');

  await send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 950, deviceScaleFactor: 1, mobile: false });
  await sleep(700);

  /* ── 10. 截图导出 ── */
  await evaluate('window.__PIXEL_RADAR__.togglePause()'); // 暂停让画面稳定
  await sleep(300);
  await evaluate('window.__PIXEL_RADAR__.togglePause()');

  /* ── 11. 控制台零报错 ── */
  check('无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || '0 条');
  check('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '0 条');

  /* ── 汇总 ── */
  console.log(`\n${'─'.repeat(58)}`);
  console.log(`通过 ${results.length - failures} / ${results.length}`);
  console.log(`截图目录：${SHOTS}`);
  if (pageErrors.length) console.log('\n异常明细：\n' + pageErrors.slice(0, 6).map((e) => '  · ' + String(e).split('\n')[0]).join('\n'));
  if (consoleErrors.length) console.log('\n控制台错误：\n' + consoleErrors.slice(0, 6).map((e) => '  · ' + e).join('\n'));
  await writeFile(resolve(SHOTS, 'report.json'), JSON.stringify({ base: BASE, results, pageErrors, consoleErrors }, null, 2));

  ws.close();
  if (chromePid) { try { process.kill(chromePid); } catch { /* 已退出 */ } }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\n验证脚本异常：', e.message);
  try {
    await writeFile(resolve(SHOTS, 'report.json'), JSON.stringify({ fatal: e.message, results }, null, 2));
  } catch { /* 忽略 */ }
  process.exit(2);
});
