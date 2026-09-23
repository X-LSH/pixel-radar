/**
 * 慢网络确定性复现 · 给整页注入 LATENCY_MS(默认5000) 的 RTT
 * 模拟「三个镜像全部慢过单候选超时」的网络（本机直连 raw 实测 712ms~7.9s 抖动）：
 *   · 改前 snapshotTimeoutMs=4000：所有候选在 5s 响应前被 4s 超时掐死 → 预期停留 simulation
 *   · 改后 snapshotTimeoutMs=8000：慢而活的候选在 8s 内返回 → 预期翻回 snapshot/live
 * 用法：node scripts/probe-slow.mjs [BASE]   需本地 serve 已启动（node scripts/serve.mjs）
 * 环境变量：EXPECT=simulation|snapshot  LATENCY_MS  WATCH_MS  BOOT_MS  CDP_PORT
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:5173/';
const LATENCY = Number(process.env.LATENCY_MS || 5000);
const WATCH = Number(process.env.WATCH_MS || 30000);
const BOOT_MS = Number(process.env.BOOT_MS || 120000);
const EXPECT = process.env.EXPECT || '';
const PORT = Number(process.env.CDP_PORT || 9361);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const PROFILE = mkdtempSync(join(tmpdir(), 'pr-slow-'));
  const CHROME = process.env.CHROME_PATH || detectChrome();
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
  ];
  if (/(127\.0\.0\.1|localhost)/.test(BASE)) args.push('--no-proxy-server', '--proxy-bypass-list=<-loopback>');
  const child = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
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

main().catch((e) => { console.error(e); process.exit(1); });
