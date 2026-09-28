/**
 * 慢网络确定性复现 · 给整页注入 LATENCY_MS(默认5000) 的 RTT
 * 复刻「镜像全部慢过单候选超时」的网络（本机直连 raw 实测 712ms~7.9s 抖动）：
 *   · 超时 4s 时代：候选全被掐死 → 停留数据中断（旧版此处为模拟态）
 *   · 现行 8s 超时 + 五镜像：慢而活的候选在 8s 内返回 → 预期真实快照
 * 用法：node scripts/probe-slow.mjs [BASE]   需本地 serve 已启动（node scripts/serve.mjs）
 * 环境变量：EXPECT=snapshot|down  LATENCY_MS  WATCH_MS  BOOT_MS
 *          CDP_PORT（默认随机空闲端口）
 *          RECOVER_AFTER_READY_MS=<ms>  就绪后解除延迟（验证「中断 → 自动恢复」）
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:5173/';
const LATENCY = Number(process.env.LATENCY_MS || 5000);
const WATCH = Number(process.env.WATCH_MS || 30000);
const BOOT_MS = Number(process.env.BOOT_MS || 120000);
const EXPECT = process.env.EXPECT || '';
/** CDP_PORT 显式给定时固定；否则每次挑空闲随机端口 —— 固定端口会被上一次中断
 * 残留的 Chrome 占住，后续运行会连上旧浏览器（与 e2e 曾踩过的串线同源）。 */
const PORT = process.env.CDP_PORT
  ? Number(process.env.CDP_PORT)
  : await new Promise((resolvePort) => {
    const probe = net.createServer();
    probe.once('error', () => resolvePort(9361));
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
/** main() 内赋值；异常收尾路径也要能回收它 */
let chromePid = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 清掉上次被中断运行残留的探针 Chrome（只按本脚本 profile 前缀精确认定） */
function sweepStaleChrome() {
  try {
    if (process.platform === 'win32') {
      const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'pixel-radar-probe-|pr-slow-' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
    } else {
      execFileSync('pkill', ['-f', 'pixel-radar-probe-|pr-slow-'], { stdio: 'ignore' });
    }
  } catch { /* 无残留或清理失败：随机端口已兜底 */ }
}

function detectChrome() {
  const candidates = process.platform === 'win32'
    ? [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      `${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`,
      `${process.env['ProgramFiles(x86)']}/Google/Chrome/Application/chrome.exe`,
      `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    ].filter(Boolean)
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  return candidates.find((p) => existsSync(p)) || candidates[0];
}

async function main() {
  sweepStaleChrome();
  const PROFILE = mkdtempSync(join(tmpdir(), 'pr-slow-'));
  const CHROME = process.env.CHROME_PATH || detectChrome();
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
  ];
  if (/(127\.0\.0\.1|localhost)/.test(BASE)) args.push('--no-proxy-server', '--proxy-bypass-list=<-loopback>');
  const child = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
  chromePid = child.pid;
  child.on('error', (e) => console.error('[chrome spawn error]', e.message));
  child.on('exit', (c, sig) => console.error('[chrome exited]', c, sig));
  child.unref();

  const portOpen = async () => {
    try { return (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { return false; }
  };
  const tPort = Date.now();
  let opened = false;
  for (let i = 0; i < 180; i++) {
    if (await portOpen()) { opened = true; break; }
    await sleep(500);
  }
  if (!opened) throw new Error(`Chrome ${((Date.now() - tPort) / 1000).toFixed(0)}s 未开调试端口 ${PORT}（chrome=${CHROME}）`);
  console.log(`chrome 就绪 ${((Date.now() - tPort) / 1000).toFixed(1)}s  pid=${child.pid}`);

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到页面目标');

  const ws = await new Promise((res, rej) => {
    const w = new WebSocket(page.webSocketDebuggerUrl);
    w.onopen = () => res(w);
    w.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const snaps = new Map(); // requestId -> {url,t0,status,fail,ms}

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    const p = m.params || {};
    if (m.method === 'Network.requestWillBeSent' && /snapshots|\.json/.test(p.request?.url || '')) {
      snaps.set(p.requestId, { url: p.request.url, t0: Date.now() });
    } else if (m.method === 'Network.responseReceived' && snaps.has(p.requestId)) {
      snaps.get(p.requestId).status = p.response.status;
    } else if (m.method === 'Network.loadingFinished' && snaps.has(p.requestId)) {
      snaps.get(p.requestId).ms = Date.now() - snaps.get(p.requestId).t0;
    } else if (m.method === 'Network.loadingFailed' && snaps.has(p.requestId)) {
      const s = snaps.get(p.requestId);
      s.fail = p.errorText; s.ms = Date.now() - s.t0;
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expr) => {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      return r.result?.result?.value ?? null;
    } catch { return null; }
  };

  await send('Network.enable');
  await send('Network.emulateNetworkConditions', {
    offline: false, latency: LATENCY,
    downloadThroughput: 100 * 1024 * 1024, uploadThroughput: 100 * 1024 * 1024,
  });
  await send('Page.enable');
  await send('Page.navigate', { url: BASE });
  console.log(`BASE=${BASE}  LATENCY=${LATENCY}ms  WATCH=${WATCH}ms  EXPECT=${EXPECT || '(不限)'}`);

  // 等应用就绪（延迟注入会让模块加载多花若干波 ×5s）
  const tBoot = Date.now();
  let snap = null;
  while (Date.now() - tBoot < BOOT_MS) {
    snap = await evaluate('window.__PIXEL_RADAR__ ? window.__PIXEL_RADAR__.snapshot() : null');
    if (snap) break;
    await sleep(400);
  }
  if (!snap) { console.log(`FAIL: ${BOOT_MS}ms 内页面未就绪`); process.exitCode = 1; ws.close(); return; }

  const t0 = Date.now();
  /* 可选：就绪后解除延迟注入 —— 端到端验证「数据中断 → 阶梯重试 → 自动恢复真实数据」 */
  if (process.env.RECOVER_AFTER_READY_MS !== undefined) {
    const d = Number(process.env.RECOVER_AFTER_READY_MS) || 0;
    setTimeout(async () => {
      await send('Network.emulateNetworkConditions', {
        offline: false, latency: 0,
        downloadThroughput: 100 * 1024 * 1024, uploadThroughput: 100 * 1024 * 1024,
      });
      console.log(`\n*** 就绪后 ${d}ms：已解除延迟注入，等待阶梯重试恢复 ***\n`);
    }, d);
  }
  const timeline = [{ ms: 0, mode: snap.mode, state: snap.feed?.state, label: snap.feed?.label, err: snap.feed?.lastError, count: snap.count }];
  let last = `${snap.mode}|${snap.feed?.state}`;
  while (Date.now() - t0 < WATCH) {
    const v = await evaluate('window.__PIXEL_RADAR__.snapshot()');
    if (v) {
      const key = `${v.mode}|${v.feed?.state}`;
      if (key !== last) {
        last = key;
        timeline.push({ ms: Date.now() - t0, mode: v.mode, state: v.feed?.state, label: v.feed?.label, err: v.feed?.lastError, count: v.count });
      }
      snap = v;
    }
    await sleep(400);
  }

  console.log('\n状态时间线（就绪后）:');
  for (const t of timeline) {
    console.log(`  +${String(t.ms).padStart(5)}ms  mode=${t.mode}  state=${t.state}  label=${t.label}  count=${t.count}${t.err ? `  err=${t.err}` : ''}`);
  }
  console.log('\n快照类请求:');
  for (const s of snaps.values()) {
    let host = s.url;
    try { host = new URL(s.url).host + new URL(s.url).pathname.slice(-24); } catch { /* 保底原样 */ }
    console.log(`  ${host}  ${s.status ?? ('FAILED ' + s.fail)}  ${s.ms ?? '-'}ms`);
  }
  const finalState = snap.feed?.state;
  const age = snap.feed?.fetchedAt ? Math.round((Date.now() - snap.feed.fetchedAt) / 60000) : '?';
  console.log(`\n最终: mode=${snap.mode}  state=${finalState}  label=${snap.feed?.label}  count=${snap.count}  快照年龄=${age}min`);

  if (EXPECT) {
    const pass = finalState === EXPECT;
    console.log(pass ? `PASS: 最终态符合预期 ${EXPECT}` : `FAIL: 期望最终态 ${EXPECT}，实际 ${finalState}`);
    process.exitCode = pass ? 0 : 1;
  }
  ws.close();
  try { spawn('taskkill', ['/t', '/f', '/pid', String(child.pid)], { stdio: 'ignore' }); } catch { /* 非 Windows 忽略 */ }
}

main().catch((e) => {
  console.error(e);
  if (chromePid) { try { process.kill(chromePid); } catch { /* 已退出 */ } }
  process.exit(1);
});
