/**
 * Pixel Radar · 目标信息卡
 * ---------------------------------------------------------------
 * 规格要求的信息卡字段：呼号、航班号、ICAO24、注册号、机型、航空公司、
 * 国家、高度、地速、航向、垂直速度、经纬度、距机场距离、最后更新、数据源。
 *
 * 两条纪律：
 *  1. **缺字段显示「—」并说明原因**，绝不用 0 假装有值
 *     （0 英尺和「没有高度数据」是两件事）。
 *  2. 更新节流到 1 秒（规格要求），否则每帧改 DOM 会明显掉帧。
 */

import { PERF } from '../config.js';
import { PHASE_LABEL, altText, vsText, vsArrow } from '../data/phases.js';
import { airlineOf, flightNumberOf } from '../data/normalize.js';
import { resolveCountry, countryLabel } from '../data/countries.js';
import { distKm } from '../core/geo.js';
import { agoText, group } from '../data/units.js';

const el = (id) => document.getElementById(id);

export function createInfoCard({ store }) {
  const cardEmpty = el('cardEmpty');
  const cardBody = el('cardBody');
  const cCallsign = el('cCallsign');
  const cPhase = el('cPhase');
  const cAirline = el('cAirline');
  const cFields = el('cFields');
  const cBarFill = el('cBarFill');
  const cSource = el('cSource');
  const cAge = el('cAge');
  const unfollowBtn = el('unfollowBtn');

  let lastRender = 0;
  let lastHex = null;

  const TYPE_CLASS_CN = {
    wide: '宽体', narrow: '窄体', prop: '螺旋桨', heli: '旋翼', unknown: '未识别',
  };

  /** 行定义：k 为标签，get 取值，cls/vs 决定强调色 */
  const ROWS = [
    { k: '航班号', get: (p) => flightNumberOf(p.callsign) || '—' },
    { k: 'ICAO24', get: (p) => p.hex.toUpperCase() },
    { k: '注册号', get: (p) => p.registration || '—' },
    { k: '机型', get: (p) => (p.typeCode ? `${p.typeCode}（${TYPE_CLASS_CN[p.typeClass] || '未识别'}）` : '—') },
    { k: '国家', get: (p) => {
      const c = resolveCountry(p);
      return c.name ? countryLabel(c.name) : '—';
    } },
    { k: '高度', cls: 'accent', get: (p) => altText(p.altFt, p.altIsGeom) },
    { k: '地速', cls: 'accent', get: (p) => (p.gsKt == null ? '—' : `${group(p.gsKt)} kt`) },
    { k: '航向', get: (p) => (p.has && p.has.track ? `${Math.round(p.trackDeg)}\u00b0` : '—') },
    { k: '垂直速度', vs: true, get: (p) => (p.has && p.has.vs ? `${vsArrow(p.vsFpm)} ${vsText(p.vsFpm)}`.trim() : '—') },
    { k: '经纬度', get: (p) => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`, small: true },
    { k: '距机场', get: (p, airport) => (airport ? `${distKm(airport.lat, airport.lon, p.lat, p.lon).toFixed(1)} km` : '—') },
  ];

  function renderEmpty() {
    cardEmpty.hidden = false;
    cardBody.hidden = true;
    unfollowBtn.hidden = true;
  }

  function buildRows(plane, airport) {
    const frag = document.createDocumentFragment();
    for (const row of ROWS) {
      const wrap = document.createElement('div');
      wrap.className = 'kv__row';

      const k = document.createElement('span');
      k.className = 'kv__k';
      k.textContent = row.k;

      const v = document.createElement('span');
      v.className = 'kv__v';
      if (row.cls === 'accent') v.classList.add('kv__v--accent');
      if (row.vs) {
        if (plane.vsFpm > 500) v.classList.add('kv__v--climb');
        else if (plane.vsFpm < -500) v.classList.add('kv__v--descent');
      }
      if (row.small) v.style.fontSize = '11px';
      v.textContent = row.get(plane, airport);
      v.title = v.textContent;

      wrap.append(k, v);
      frag.append(wrap);
    }
    cFields.replaceChildren(frag);
  }

  /**
   * @param {object|null} plane 当前选中的目标（归一化模型）
   * @param {object} ctx { airport, followHex, now }
   */
  function update(plane, ctx) {
    const now = ctx.now || Date.now();
    const switched = plane && plane.hex !== lastHex;
    const due = now - lastRender >= PERF.cardThrottleMs;

    if (!plane) {
      if (lastHex !== null) {
        renderEmpty();
        lastHex = null;
      }
      return;
    }

    // 换目标立即刷新（不能等节流）；同一目标则按 1 秒节流
    if (!switched && !due) return;
    lastRender = now;
    lastHex = plane.hex;

    cardEmpty.hidden = true;
    cardBody.hidden = false;
    unfollowBtn.hidden = !ctx.followHex;
    if (ctx.followHex) unfollowBtn.textContent = '取消跟随';

    cCallsign.textContent = plane.callsign || plane.hex.toUpperCase();

    const phaseLabel = PHASE_LABEL[plane.phase] || '—';
    cPhase.textContent = plane.sim ? `${phaseLabel} · 模拟` : phaseLabel;
    cPhase.dataset.phase = plane.phase || 'unknown';

    const airline = airlineOf(plane.callsign);
    cAirline.textContent = airline
      ? airline
      : plane.callsign
        ? `承运人 ${plane.callsign.slice(0, 3)}（未收录）`
        : '未识别承运人';

    buildRows(plane, ctx.airport);

    // 高度进度条：以 0–41000ft 映射，直观表达「高度层」
    const altPct = plane.altFt == null ? 0 : Math.max(0, Math.min(100, (plane.altFt / 41000) * 100));
    cBarFill.style.width = `${altPct.toFixed(1)}%`;

    const country = resolveCountry(plane);
    const srcLabel = plane.sim ? '模拟数据' : (plane.source || '未知来源');
    cSource.textContent = country.source === 'hexblock' ? `${srcLabel} · 国别按地址块推断` : srcLabel;
    cAge.textContent = plane.obsAt ? agoText(plane.obsAt, now) : '实时';
  }

  function setFollowVisible(on) {
    unfollowBtn.hidden = !on;
  }

  return { update, renderEmpty, setFollowVisible };
}
