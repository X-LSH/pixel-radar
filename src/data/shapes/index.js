/**
 * Pixel Radar · 地理形状索引
 * ==================================================================
 * 由 scripts/build-data.mjs 生成，请勿手工编辑。
 * 生成时间：2026-09-17T03:22:07.796Z
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
];

export const SHAPE_SIZE_KB = {"RKSI":41.3,"ZGSZ":36.7,"VHHH":36.3,"ZGGG":36.2,"EGLL":32.3,"EDDF":31.7,"KJFK":29.6,"ZSPD":29.3,"RJTT":28.3,"KSEA":24.9,"KSFO":22.3,"RJAA":22.2,"LFPG":20.4,"ZBAA":19.8,"KLAX":18.9,"WSSS":16.8,"OMDB":13.2,"YSSY":11.2,"YMML":10.7,"ZUUU":3.5};

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
};

/** 按需加载某机场的地理形状；未知机场返回 null 而不是抛错 */
export function loadShapes(icao) {
  const fn = LOADERS[icao];
  return fn ? fn() : Promise.resolve(null);
}

export function hasShapes(icao) {
  return Object.prototype.hasOwnProperty.call(LOADERS, icao);
}
