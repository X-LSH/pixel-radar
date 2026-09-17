/**
 * Pixel Radar · 界面外壳
 * ---------------------------------------------------------------
 * 把 DOM 与状态绑定起来。原则：**这里不做任何业务判断**，
 * 只负责把 store 里的状态画到界面上，以及把用户操作转成 actions 调用。
 * 页面文案统一简体中文；屏内是 ASCII（CRT 字符发生器的能力边界）。
 */

import { VIEW } from '../config.js';
import { resText, agoText, group } from '../data/units.js';
import { compass16 } from '../core/geo.js';

const el = (id) => document.getElementById(id);

export function createChrome({ store, actions }) {
  const refs = {
    airportBtn: el('airportBtn'),
    airportIcao: el('airportIcao'),
    airportIata: el('airportIata'),
    airportName: el('airportName'),
    feedChip: el('feedChip'),
    feedLabel: el('feedLabel'),
    pauseBtn: el('pauseBtn'),
    resetBtn: el('resetBtn'),
    shareBtn: el('shareBtn'),
    fullBtn: el('fullBtn'),
    setBtn: el('setBtn'),
    panel: el('panel'),
    boot: el('boot'),
    bootLog: el('bootLog'),
    bootBar: el('bootBar'),
    screenBox: el('screenBox'),
    sbs: {
      source: el('sbSource'),
      age: el('sbAge'),
      count: el('sbCount'),
      view: el('sbView'),
      res: el('sbRes'),
      fps: el('sbFps'),
      mode: el('sbMode'),
    },
    stats: {
      count: el('stCount'),
      air: el('stAir'),
      ground: el('stGround'),
      top: el('stTop'),
      fast: el('stFast'),
      hdg: el('stHdg'),
    },
    ringSeg: el('ringSeg'),
    zoomSeg: el('zoomSeg'),
    zoomRead: el('zoomRead'),
    scaleSeg: el('scaleSeg'),
    resNote: el('resNote'),
    toggles: el('toggles'),
    chain: el('chain'),
    relayInput: el('relayInput'),
    relaySave: el('relaySave'),
    relayNote: el('relayNote'),
  };

  /* ── 屏角「模拟数据」标记 ──
   * 屏内是 CRT 字符发生器，画不了中文；但这个提示必须一眼看到，
   * 所以用一层贴在画布上方的 DOM 徽标，跟随画布缩放。 */
  const simBadge = document.createElement('div');
  simBadge.className = 'sim-badge';
  simBadge.hidden = true;
  simBadge.textContent = '模拟数据';
  refs.screenBox.append(simBadge);

  /* ── 事件绑定 ── */
  refs.airportBtn.addEventListener('click', () => actions.openPicker());

  refs.pauseBtn.addEventListener('click', () => actions.togglePause());
  refs.resetBtn.addEventListener('click', () => actions.resetView());
  refs.shareBtn.addEventListener('click', () => actions.screenshot());
  refs.fullBtn.addEventListener('click', () => actions.toggleFullscreen());
  refs.setBtn.addEventListener('click', () => {
    const open = store.get().panelOpen;
    actions.setPanelOpen(!open);
  });

  refs.ringSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-ring]');
    if (btn) actions.setRing(Number(btn.dataset.ring));
  });

  refs.zoomSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-zoom]');
    if (btn) actions.zoomBy(Number(btn.dataset.zoom));
  });

  refs.scaleSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scale]');
    if (btn) actions.setScale(Number(btn.dataset.scale));
  });

  refs.toggles.addEventListener('change', (e) => {
    const input = e.target.closest('input[data-tg]');
    if (input) actions.setToggle(input.dataset.tg, input.checked);
  });

  refs.relaySave.addEventListener('click', () => {
    const v = refs.relayInput.value.trim();
    actions.saveRelay(v);
  });
  refs.relayInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      actions.saveRelay(refs.relayInput.value.trim());
    }
  });

  /* ── 渲染 ── */

  function setAirport(airport) {
    refs.airportIcao.textContent = airport.icao;
    refs.airportIata.textContent = airport.iata;
    refs.airportName.textContent = airport.cn;
    refs.airportBtn.title = `${airport.cn} · ${airport.en}（${airport.icao}/${airport.iata}）`;
    document.title = `${airport.icao} ${airport.cn} · Pixel Radar`;
  }

  function setBoot(text, pct) {
    if (refs.boot.hidden) return;
    if (refs.bootLog.textContent !== text) refs.bootLog.textContent = text;
    refs.bootBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  function hideBoot() {
    if (refs.boot.hidden) return;
    refs.boot.classList.add('is-out');
    setTimeout(() => { refs.boot.hidden = true; }, 280);
  }

  function setFeed(feed) {
    const chip = refs.feedChip;
    chip.className = 'chip';
    if (feed.state === 'live') chip.classList.add('chip--live');
    else if (feed.state === 'snapshot') chip.classList.add('chip--snap');
    else if (feed.state === 'simulation') chip.classList.add('chip--sim');
    else if (feed.state === 'down') chip.classList.add('chip--down');
    refs.feedLabel.textContent = feed.label;

    chip.title = [
      `数据源：${feed.sourceId || '—'}`,
      feed.fetchedAt ? `获取于：${new Date(feed.fetchedAt).toLocaleTimeString('zh-CN')}` : '',
      feed.lastError ? `最近错误：${feed.lastError}` : '',
    ].filter(Boolean).join('\n');

    simBadge.hidden = feed.state !== 'simulation';

    // 侧栏链路
    const items = refs.chain.querySelectorAll('li');
    for (const li of items) {
      const id = li.dataset.src;
      const hit = (feed.trail || []).find((t) => t.id === id);
      li.removeAttribute('data-state');
      const em = li.querySelector('em');
      if (!hit) continue;
      if (hit.state === 'active') li.dataset.state = 'active';
      else if (hit.state === 'fail') li.dataset.state = 'fail';
      else if (hit.state === 'skip') li.dataset.state = 'skip';

      if (id === 'relay') em.textContent = actions.getRelayUrl() ? (hit.state === 'active' ? '使用中' : '已配置') : '未配置';
      else if (id === 'snapshot') em.textContent = hit.state === 'active' ? '使用中' : (hit.state === 'fail' ? '不可用' : '待探测');
      else if (id === 'direct') em.textContent = hit.state === 'active' ? '使用中' : (hit.state === 'fail' ? '被跨域拦截' : '待探测');
      else if (id === 'simulation') em.textContent = feed.state === 'simulation' ? '使用中' : '兜底';
    }
  }

  function setStats(s) {
    refs.stats.count.textContent = String(s.count);
    refs.stats.air.textContent = String(s.air);
    refs.stats.ground.textContent = String(s.ground);
    refs.stats.top.textContent = s.topAlt == null ? '—' : `${group(s.topAlt)} ft`;
    refs.stats.fast.textContent = s.fastestKt == null ? '—' : `${group(s.fastestKt)} kt`;
    refs.stats.hdg.textContent = s.busiestHdg == null ? '—' : `${compass16(s.busiestHdg)} ${s.busiestHdg}\u00b0`;
  }

  function setStatus(o) {
    const { feed, view, resolution, fps, paused } = o;
    refs.sbs.source.textContent = `源 ${feed.sourceId || '—'}`;
    refs.sbs.age.textContent = feed.fetchedAt ? `更新 ${agoText(feed.fetchedAt)}` : '更新 —';
    refs.sbs.count.textContent = `目标 ${feed.count || 0}`;
    refs.sbs.view.textContent = `${view.ringKm}km · ${(view.kmPerPx * 1000).toFixed(0)} m/px`;
    refs.sbs.res.textContent = resText(resolution.w, resolution.h, resolution.scale);
    refs.sbs.fps.textContent = `${Math.round(fps)} fps`;

    refs.sbs.mode.hidden = false;
    if (paused) refs.sbs.mode.textContent = '已暂停';
    else if (feed.state === 'simulation') refs.sbs.mode.textContent = '模拟数据 · 非真实航班';
    else refs.sbs.mode.textContent = '';

    refs.zoomRead.textContent = `${view.zoomMult.toFixed(view.zoomMult < 1 ? 2 : 1)}×`;
    refs.resNote.textContent = `逻辑分辨率 ${resolution.w}×${resolution.h} · ${resolution.scale}× 放大`;

    refs.pauseBtn.textContent = paused ? '\u25b6' : '\u275a\u275a';
    refs.pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
  }

  /** 把设置回填到控件（启动时与恢复默认时调用） */
  function syncControls(s) {
    for (const btn of refs.ringSeg.querySelectorAll('button')) {
      btn.classList.toggle('is-on', Number(btn.dataset.ring) === s.ringKm);
    }
    for (const btn of refs.scaleSeg.querySelectorAll('button')) {
      btn.classList.toggle('is-on', Number(btn.dataset.scale) === s.scale);
    }
    for (const input of refs.toggles.querySelectorAll('input[data-tg]')) {
      input.checked = !!s[input.dataset.tg];
    }
    if (refs.relayInput.value !== s.relayUrl) refs.relayInput.value = s.relayUrl || '';
    refs.relayNote.textContent = s.relayUrl
      ? '已保存，将优先使用该中继。'
      : '留空则使用静态快照；快照不可用时回落到模拟数据。';
  }

  function setPanelOpen(open) {
    document.getElementById('app').dataset.panel = open ? 'open' : 'collapsed';
    refs.setBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function setCrtEnabled(on) {
    document.getElementById('app').dataset.crt = on ? 'on' : 'off';
  }

  return {
    refs,
    setAirport, setBoot, hideBoot, setFeed, setStats, setStatus,
    syncControls, setPanelOpen, setCrtEnabled,
  };
}
