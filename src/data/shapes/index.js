/**
 * Pixel Radar · 地理形状索引
 * ==================================================================
 * 由 scripts/build-data.mjs 生成，请勿手工编辑。
 * 生成时间：2026-09-28T03:00:20.090Z
 *
 * 每个机场一个模块，动态 import 按需加载。
 * 顺序即机场清单顺序；SHAPE_SIZE_KB 供性能预算自检使用。
 */

export const SHAPE_ICAS = [
  'ZBAA',
  'ZSPD',
  'ZGGG',
  'ZGSZ',
  'ZUUU',
  'VHHH',
  'RJAA',
  'RJTT',
  'RKSI',
  'WSSS',
  'OMDB',
  'EGLL',
  'LFPG',
  'EDDF',
  'KJFK',
  'KLAX',
  'KSFO',
  'KSEA',
  'YSSY',
  'YMML',
  'ZSQD',
  'ZSHC',
  'ZSAM',
  'ZHHH',
  'ZUCK',
  'ZPPP',
  'ZLXY',
  'ZSNJ',
  'KATL',
  'EHAM',
];

export const SHAPE_SIZE_KB = {"EHAM":47.5,"RKSI":41.3,"ZSHC":38.6,"ZGSZ":36.7,"VHHH":36.3,"ZGGG":36.2,"EGLL":32.3,"EDDF":31.7,"KJFK":29.6,"ZSPD":29.3,"ZSNJ":29.1,"RJTT":28.3,"ZSAM":26.1,"KSEA":24.9,"KSFO":22.3,"RJAA":22.2,"LFPG":20.4,"ZSQD":19.9,"ZBAA":19.8,"ZHHH":19.7,"KLAX":18.9,"WSSS":16.8,"OMDB":13.2,"KATL":12.1,"YSSY":11.2,"YMML":10.7,"ZPPP":7.6,"ZLXY":6.2,"ZUUU":3.5,"ZUCK":2.8};

const LOADERS = {
  ZBAA: () => import('./ZBAA.js'),
  ZSPD: () => import('./ZSPD.js'),
  ZGGG: () => import('./ZGGG.js'),
  ZGSZ: () => import('./ZGSZ.js'),
  ZUUU: () => import('./ZUUU.js'),
  VHHH: () => import('./VHHH.js'),
  RJAA: () => import('./RJAA.js'),
  RJTT: () => import('./RJTT.js'),
  RKSI: () => import('./RKSI.js'),
  WSSS: () => import('./WSSS.js'),
  OMDB: () => import('./OMDB.js'),
  EGLL: () => import('./EGLL.js'),
  LFPG: () => import('./LFPG.js'),
  EDDF: () => import('./EDDF.js'),
  KJFK: () => import('./KJFK.js'),
  KLAX: () => import('./KLAX.js'),
  KSFO: () => import('./KSFO.js'),
  KSEA: () => import('./KSEA.js'),
  YSSY: () => import('./YSSY.js'),
  YMML: () => import('./YMML.js'),
  ZSQD: () => import('./ZSQD.js'),
  ZSHC: () => import('./ZSHC.js'),
  ZSAM: () => import('./ZSAM.js'),
  ZHHH: () => import('./ZHHH.js'),
  ZUCK: () => import('./ZUCK.js'),
  ZPPP: () => import('./ZPPP.js'),
  ZLXY: () => import('./ZLXY.js'),
  ZSNJ: () => import('./ZSNJ.js'),
  KATL: () => import('./KATL.js'),
  EHAM: () => import('./EHAM.js'),
};

/** 按需加载某机场的地理形状；未知机场返回 null 而不是抛错 */
export function loadShapes(icao) {
  const fn = LOADERS[icao];
  return fn ? fn() : Promise.resolve(null);
}

export function hasShapes(icao) {
  return Object.prototype.hasOwnProperty.call(LOADERS, icao);
}
