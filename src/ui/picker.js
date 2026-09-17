/**
 * Pixel Radar · 机场选择器
 * ---------------------------------------------------------------
 * 规格要求：预设 20 个国际机场，支持 IATA / ICAO 搜索，
 * 默认根据时区推荐。
 *
 * 「按时区推荐」的实现：候选机场各自换算本地时间，
 * 取本地时间最接近下午高峰（14:30）的那个 —— 理由是这个时段
 * 到发最密集，点进去看到的空域最有内容；大枢纽另有权重加成。
 * 这不是随机猜，也不是写死某个机场。
 */

import { AIRPORTS } from '../data/airports.js';

/** 机场规模权重（越大越繁忙，推荐时加权） */
const HUB_WEIGHT = {
  ZBAA: 3, ZSPD: 3, ZGGG: 2.5, ZGSZ: 2, ZUUU: 1.5,
  VHHH: 3, RJAA: 2.5, RJTT: 3, RKSI: 2.5, WSSS: 2.5,
  OMDB: 3, EGLL: 3, LFPG: 3, EDDF: 3,
  KJFK: 3, KLAX: 3, KSFO: 2.5, KSEA: 1.5,
  YSSY: 2, YMML: 1.5,
};

/** ICAO 首字母 → 分组名 */
const REGION_BY_PREFIX = {
  Z: '中国内地',
  V: '中国港澳',
  R: '日本 · 韩国',
  W: '东南亚',
  O: '中东',
  E: '欧洲',
  L: '欧洲',
  K: '美国',
  C: '加拿大',
  Y: '大洋洲',
};

const REGION_ORDER = ['中国内地', '中国港澳', '日本 · 韩国', '东南亚', '中东', '欧洲', '美国', '大洋洲', '其它'];

/** 取某时区当前的本地小时（含小数，用于细腻排序） */
function localHour(tz, date) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return h + m / 60;
  } catch {
    return 12;
  }
}

/** 某时区当前本地时间字符串 */
export function localTimeText(tz, date = new Date()) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  } catch {
    return '--:--';
  }
}

/** UTC 偏移文本（DST 感知） */
export function utcOffsetText(tz, date = new Date()) {
  try {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || '';
    return s.replace('GMT', 'UTC');
  } catch {
    return '';
  }
}

/** 推荐机场：本地时间接近 14:30 且枢纽权重高者胜出 */
export function recommendAirport(date = new Date()) {
  const PEAK = 14.5;
  let best = AIRPORTS[0];
  let bestScore = -Infinity;
  for (const ap of AIRPORTS) {
    const h = localHour(ap.tz, date);
    const d = Math.min(Math.abs(h - PEAK), 24 - Math.abs(h - PEAK));
    const score = -d + (HUB_WEIGHT[ap.icao] || 0);
    if (score > bestScore) {
      bestScore = score;
      best = ap;
    }
  }
  return best;
}

function regionOf(icao) {
  return REGION_BY_PREFIX[icao[0]] || '其它';
}

/** 搜索匹配：ICAO / IATA / 中文名 / 英文名 / 城市 / 时区 */
function matches(ap, q) {
  if (!q) return true;
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return ap.icao.toLowerCase().includes(s)
    || ap.iata.toLowerCase().includes(s)
    || ap.cn.includes(s)
    || ap.en.toLowerCase().includes(s)
    || (ap.city || '').toLowerCase().includes(s)
    || ap.tz.toLowerCase().includes(s);
}

export function createPicker({ current, onPick }) {
  const root = document.createElement('div');
  root.className = 'picker';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', '选择机场');
  root.innerHTML = `
    <div class="picker__box">
      <div class="picker__head">
        <input class="picker__input" type="text" spellcheck="false" autocomplete="off"
               placeholder="搜索 ICAO / IATA / 城市名，例如 ZBAA、PEK、东京">
      </div>
      <div class="picker__hint"></div>
      <div class="picker__list"></div>
    </div>`;
  document.body.append(root);

  const input = root.querySelector('.picker__input');
  const list = root.querySelector('.picker__list');
  const hint = root.querySelector('.picker__hint');

  let cursor = 0;
  let visible = [];
  let currentIcao = current;
  let recommended = recommendAirport();

  function build(query) {
    const hits = AIRPORTS.filter((ap) => matches(ap, query));
    const groups = new Map();
    for (const ap of hits) {
      const g = regionOf(ap.icao);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(ap);
    }

    // 「推荐」置顶：只有未搜索时才出现
    const ordered = [];
    if (!query.trim()) {
      ordered.push({ group: '推荐', items: [recommended] });
    }
    for (const g of REGION_ORDER) {
      if (groups.has(g)) ordered.push({ group: g, items: groups.get(g) });
    }
    for (const [g, items] of groups) {
      if (!REGION_ORDER.includes(g)) ordered.push({ group: g, items });
    }

    visible = ordered.flatMap((o) => o.items);
    if (!visible.length) {
      list.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'picker__empty',
        textContent: '没有匹配的机场。试试 ICAO（ZBAA）或 IATA（PEK）代码。',
      }));
      hint.textContent = '';
      return;
    }

    const frag = document.createDocumentFragment();
    let idx = 0;
    for (const o of ordered) {
      const gh = document.createElement('div');
      gh.className = 'picker__group';
      gh.textContent = o.group;
      frag.append(gh);

      for (const ap of o.items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'picker__item';
        btn.dataset.icao = ap.icao;
        btn.dataset.index = String(idx++);
        if (ap.icao === currentIcao) btn.classList.add('is-current');

        const isReco = ap.icao === recommended.icao && !query.trim();
        const code = document.createElement('span');
        code.className = 'picker__code';
        code.innerHTML = `<b>${ap.icao}</b> <s>${ap.iata}</s>`;

        const nm = document.createElement('span');
        nm.className = 'picker__nm';
        nm.textContent = isReco ? `${ap.cn} · 当前时段推荐` : `${ap.cn} · ${ap.en}`;

        const tz = document.createElement('span');
        tz.className = 'picker__tz';
        tz.textContent = `${localTimeText(ap.tz)} ${utcOffsetText(ap.tz)}`;

        btn.append(code, nm, tz);
        frag.append(btn);
      }
    }
    list.replaceChildren(frag);
    hint.textContent = `${hits.length} 个机场 · ↑↓ 选择 · Enter 确认 · Esc 关闭`;
    cursor = 0;
    paintCursor();
  }

  function paintCursor() {
    const items = list.querySelectorAll('.picker__item');
    items.forEach((it) => it.classList.toggle('is-cursor', Number(it.dataset.index) === cursor));
    const cur = items[cursor];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    currentIcao = current();
    recommended = recommendAirport();
    root.hidden = false;
    input.value = '';
    build('');
    // 焦点放到搜索框，键盘用户可以直接打字
    setTimeout(() => input.focus(), 0);
  }

  function close() {
    root.hidden = true;
  }

  function pick(icao) {
    const ap = AIRPORTS.find((a) => a.icao === icao);
    if (!ap) return;
    close();
    onPick(ap);
  }

  input.addEventListener('input', () => build(input.value));
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.picker__item');
    if (item) pick(item.dataset.icao);
  });
  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = list.querySelectorAll('.picker__item').length;
      if (!n) return;
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      paintCursor();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const cur = list.querySelectorAll('.picker__item')[cursor];
      if (cur) pick(cur.dataset.icao);
    }
  });

  return { open, close, isOpen: () => !root.hidden, recommendAirport };
}
