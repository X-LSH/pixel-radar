/**
 * Pixel Radar · 飞行阶段识别
 * ---------------------------------------------------------------
 * 规格给定的判定规则（原文照录，含顺序）：
 *   on_ground = true                     → 地面 / 滑行
 *   高度 < 3000ft 且 垂直速度 > 500fpm   → 起飞 / 爬升
 *   高度 > 3000ft 且 |垂直速度| < 300fpm → 巡航
 *   高度 < 5000ft 且 垂直速度 < -500fpm  → 下降 / 进近
 *   速度 < 50kt 且在地面                → 滑行
 *
 * 需要处理的边界：
 *  1. 「地面/滑行」与「滑行」重复 —— 按「更具体者优先」处理，
 *     所以先判滑行（地面 + 低速），再判地面。
 *  2. 规则存在空档：例如 3200ft 下降 400fpm 不满足任何一条。
 *     此时按高度与垂直速率的符号兜底，保证每个目标都有阶段，
 *     否则界面上会出现「无阶段」这种破窗。
 */

export const PHASES = {
  TAXI: 'taxi',
  GROUND: 'ground',
  CLIMB: 'climb',
  CRUISE: 'cruise',
  DESCENT: 'descent',
  APPROACH: 'approach',
};

/** 阶段 → 界面标签（简体中文） */
export const PHASE_LABEL = {
  [PHASES.TAXI]: '滑行',
  [PHASES.GROUND]: '地面',
  [PHASES.CLIMB]: '爬升',
  [PHASES.CRUISE]: '巡航',
  [PHASES.DESCENT]: '下降',
  [PHASES.APPROACH]: '进近',
};

export const PHASE_THRESHOLDS = {
  /** 低空判定 */
  lowFt: 3000,
  /** 进近判定上限 */
  approachFt: 5000,
  /** 滑行速度上限（节） */
  taxiKt: 50,
  /** 显著爬升率（英尺/分） */
  climbFpm: 500,
  /** 显著下降率（英尺/分） */
  descentFpm: -500,
  /** 巡航的垂直速率死区（英尺/分） */
  cruiseDeadbandFpm: 300,
};

/**
 * 判定飞行阶段。
 * @param {{onGround:boolean, altFt:number|null, vsFpm:number, gsKt:number|null}} p
 * @returns {string} PHASES 之一
 */
export function detectPhase(p) {
  const T = PHASE_THRESHOLDS;
  const alt = p.altFt == null ? 0 : p.altFt;
  const vs = p.vsFpm || 0;
  const gs = p.gsKt == null ? 0 : p.gsKt;

  if (p.onGround) {
    return gs < T.taxiKt ? PHASES.TAXI : PHASES.GROUND;
  }

  if (alt < T.lowFt && vs > T.climbFpm) return PHASES.CLIMB;
  if (alt > T.lowFt && Math.abs(vs) < T.cruiseDeadbandFpm) return PHASES.CRUISE;
  if (alt < T.approachFt && vs < T.descentFpm) return PHASES.APPROACH;

  // —— 规则空档兜底：保证阶段完备 ——
  if (vs > T.cruiseDeadbandFpm) return PHASES.CLIMB;
  if (vs < -T.cruiseDeadbandFpm) {
    return alt < T.approachFt ? PHASES.APPROACH : PHASES.DESCENT;
  }
  return PHASES.CRUISE;
}

/** 阶段是否为「空中」 */
export function isAirborne(phase) {
  return phase !== PHASES.GROUND && phase !== PHASES.TAXI;
}

/** 阶段 → 飞机基色键（交给调色板解析） */
export function phaseColorKey(phase, altFt) {
  switch (phase) {
    case PHASES.TAXI:
    case PHASES.GROUND:
      return 'ground';
    case PHASES.CLIMB:
      return 'climb';
    case PHASES.APPROACH:
    case PHASES.DESCENT:
      return 'descent';
    default:
      // 巡航按高度分档：低空亮、高空暗偏青
      if (altFt == null) return 'altMid';
      if (altFt < 10000) return 'altLow';
      if (altFt < 26000) return 'altMid';
      return 'altHigh';
  }
}

/**
 * 垂直速率箭头符号：|vs| 超过阈值才有箭头。
 * 用位图字体的专用字形，保证与屏内字体同一套象形。
 */
export function vsArrow(vsFpm) {
  if (vsFpm > PHASE_THRESHOLDS.climbFpm) return '\u2191';
  if (vsFpm < PHASE_THRESHOLDS.descentFpm) return '\u2193';
  return '';
}

/** 高度 → 飞行高度层显示（FL350）；低于过渡高度直接显示英尺 */
export function altText(altFt, isGeom) {
  if (altFt == null) return '—';
  if (altFt === 0) return 'GND';
  const proxy = isGeom ? '~' : '';
  if (altFt >= 18000) {
    const fl = Math.round(altFt / 100);
    return `${proxy}FL${String(fl).padStart(3, '0')}`;
  }
  return `${proxy}${altFt} ft`;
}

/** 垂直速率文本 */
export function vsText(vsFpm) {
  if (!vsFpm) return '0 fpm';
  const sign = vsFpm > 0 ? '+' : '';
  return `${sign}${vsFpm} fpm`;
}
