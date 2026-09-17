/**
 * Pixel Radar · ICAO24 地址国别
 * ---------------------------------------------------------------
 * 上游（adsb.lol）的点位查询不返回 origin_country 字段，
 * 而信息卡需要「国家」。可行的做法是按 ICAO 24 位地址的分块归属反查 ——
 * 这是真实的、可核实的对应关系，不是猜测。
 *
 * 但这里只收录**我们能确认的**区块（覆盖 20 个预设机场周边的主要注册地），
 * 查不到一律返回 null，界面显示「—」而不是编一个国名。
 * 若上游提供了 origin_country（如 OpenSky），则优先采用上游值。
 *
 * 参考：ICAO Annex 10 Volume III 的 24-bit 地址分配表。
 * 说明：中国区块（780000–7BFFFF）按官方分配包含中国内地与港澳地区，
 *       因此统一标注为中国。
 */

/** [起始, 结束, 国家] —— 升序排列，便于二分查找 */
const BLOCKS = [
  [0x300000, 0x33ffff, 'Italy'],
  [0x340000, 0x37ffff, 'Spain'],
  [0x380000, 0x3bffff, 'France'],
  [0x3c0000, 0x3fffff, 'Germany'],
  [0x400000, 0x43ffff, 'United Kingdom'],
  [0x440000, 0x447fff, 'Austria'],
  [0x448000, 0x44ffff, 'Belgium'],
  [0x458000, 0x45ffff, 'Denmark'],
  [0x460000, 0x467fff, 'Finland'],
  [0x468000, 0x46ffff, 'Greece'],
  [0x470000, 0x477fff, 'Hungary'],
  [0x478000, 0x47ffff, 'Norway'],
  [0x480000, 0x487fff, 'Netherlands'],
  [0x488000, 0x48ffff, 'Poland'],
  [0x490000, 0x497fff, 'Portugal'],
  [0x498000, 0x49ffff, 'Czechia'],
  [0x4a0000, 0x4a7fff, 'Romania'],
  [0x4a8000, 0x4affff, 'Sweden'],
  [0x4b0000, 0x4b7fff, 'Switzerland'],
  [0x4b8000, 0x4bffff, 'Turkey'],
  [0x680000, 0x6803ff, 'Singapore'],
  [0x710000, 0x717fff, 'Saudi Arabia'],
  [0x718000, 0x71ffff, 'Republic of Korea'],
  [0x738000, 0x73ffff, 'Israel'],
  [0x750000, 0x757fff, 'Malaysia'],
  [0x758000, 0x75ffff, 'Philippines'],
  [0x760000, 0x767fff, 'Pakistan'],
  [0x768000, 0x76ffff, 'Singapore'],
  [0x780000, 0x7bffff, 'China'],
  [0x7c0000, 0x7fffff, 'Australia'],
  [0x800000, 0x83ffff, 'India'],
  [0x840000, 0x87ffff, 'Japan'],
  [0x880000, 0x887fff, 'Thailand'],
  [0x888000, 0x88ffff, 'Viet Nam'],
  [0x896000, 0x896fff, 'United Arab Emirates'],
  [0x8a0000, 0x8a7fff, 'Indonesia'],
  [0xa00000, 0xafffff, 'United States'],
  [0xc00000, 0xc3ffff, 'Canada'],
  [0xc80000, 0xc87fff, 'New Zealand'],
  [0xe40000, 0xe7ffff, 'Brazil'],
];

/** 常见国名 → 简体中文（用于界面显示；查不到则回退英文原名） */
const CN = {
  China: '中国',
  'Hong Kong, China': '中国香港',
  'Macao, China': '中国澳门',
  Taiwan: '中国台湾',
  'United States': '美国',
  'United Kingdom': '英国',
  France: '法国',
  Germany: '德国',
  Italy: '意大利',
  Spain: '西班牙',
  Netherlands: '荷兰',
  Switzerland: '瑞士',
  Austria: '奥地利',
  Belgium: '比利时',
  Denmark: '丹麦',
  Finland: '芬兰',
  Greece: '希腊',
  Hungary: '匈牙利',
  Norway: '挪威',
  Poland: '波兰',
  Portugal: '葡萄牙',
  Czechia: '捷克',
  Romania: '罗马尼亚',
  Sweden: '瑞典',
  Turkey: '土耳其',
  Japan: '日本',
  'Republic of Korea': '韩国',
  Singapore: '新加坡',
  Malaysia: '马来西亚',
  Philippines: '菲律宾',
  Thailand: '泰国',
  'Viet Nam': '越南',
  Indonesia: '印度尼西亚',
  India: '印度',
  Pakistan: '巴基斯坦',
  Australia: '澳大利亚',
  'New Zealand': '新西兰',
  Canada: '加拿大',
  Brazil: '巴西',
  'Saudi Arabia': '沙特阿拉伯',
  'United Arab Emirates': '阿联酋',
  Israel: '以色列',
};

/**
 * 由 ICAO24 十六进制地址推断注册国。
 * @param {string} hex 六位十六进制（小写或大写均可）
 * @returns {string|null} 英文国名；无法确定时返回 null
 */
export function countryOfHex(hex) {
  if (typeof hex !== 'string' || hex.length !== 6) return null;
  const v = parseInt(hex, 16);
  if (!Number.isFinite(v)) return null;

  let lo = 0;
  let hi = BLOCKS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b, name] = BLOCKS[mid];
    if (v < a) hi = mid - 1;
    else if (v > b) lo = mid + 1;
    else return name;
  }
  return null;
}

/** 国名 → 简体中文显示名 */
export function countryLabel(name) {
  if (!name) return null;
  return CN[name] || name;
}

/**
 * 综合取国别：上游给了就用上游的（更权威），否则按地址块推断。
 * @returns {{name:string|null, source:'upstream'|'hexblock'|null}}
 */
export function resolveCountry(plane) {
  if (plane && plane.originCountry) {
    return { name: plane.originCountry, source: 'upstream' };
  }
  const byHex = countryOfHex(plane && plane.hex);
  if (byHex) return { name: byHex, source: 'hexblock' };
  return { name: null, source: null };
}

export const COUNTRY_BLOCK_COUNT = BLOCKS.length;
