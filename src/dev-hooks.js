/**
 * Pixel Radar · 验证钩子
 * ---------------------------------------------------------------
 * 把内部状态暴露到 `window.__PIXEL_RADAR__`，供 `scripts/e2e.mjs`
 * 在真实浏览器里读取真值。
 *
 * 为什么需要它：端到端断言不能只看截图，也不能靠 DOM 文本去猜内部状态。
 * 例如「扫描线在转吗」只能靠读扫描角；「点中的是不是同一架飞机」
 * 需要拿到渲染层算出的目标屏幕坐标。这些都是渲染层的私有真相。
 *
 * 边界（重要）：这里**只读 + 少量测试用动作**，不承载任何业务逻辑。
 * 生产路径完全不依赖它，删掉这个文件页面照常运行。
 */

import { PHASE_LABEL } from './data/phases.js';
import { AIRPORTS } from './data/airports.js';

export function installDevHooks({ store, stage, pipeline, actions, getFrame, isReady }) {
  const snapshot = () => {
    const frame = getFrame();
    const s = store.get();
    return {
      mode: pipeline.status().mode,
      count: frame.length,
      airport: s.airport.icao,
      resolution: stage.resolution,
      view: stage.view,
      ready: isReady(),
      stats: s.stats,
      ringKm: s.ringKm,
      feed: s.feed,
      /** 各飞行阶段的架数分布 —— 用来验证阶段判定在真实数据路径上也生效 */
      phases: frame.reduce((acc, f) => {
        const k = f.plane.phase || 'unknown';
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
      withTrail: frame.filter((f) => f.trail && f.trail.length > 1).length,
      airborne: frame.filter((f) => !f.plane.onGround).length,
      onGround: frame.filter((f) => f.plane.onGround).length,
      trailPoints: pipeline.getTracker().trailPointCount(),
      /** 前几架样本，供断言核对字段 */
      sample: frame.slice(0, 5).map((f) => ({
        callsign: f.plane.callsign,
        hex: f.plane.hex,
        lat: +f.lat.toFixed(5),
        lon: +f.lon.toFixed(5),
        altFt: Math.round(f.altFt),
        gsKt: f.plane.gsKt,
        trackDeg: f.plane.trackDeg == null ? null : Math.round(f.plane.trackDeg),
        onGround: f.plane.onGround,
        phase: PHASE_LABEL[f.plane.phase] || f.plane.phase,
        trail: f.trail ? f.trail.length : 0,
      })),
    };
  };

  window.__PIXEL_RADAR__ = {
    version: '0.1.0',
    store,
    stage,
    pipeline,
    status: () => pipeline.status(),
    snapshot,

    /**
     * 屏内第一个可见目标在**客户端坐标系**下的位置。
     * 真实点击测试不能用 snapshot().sample —— 它只取前几架，很可能都在屏外。
     */
    firstVisibleTarget: () => {
      const s = stage.resolution;
      const canvas = document.querySelector('canvas');
      const rect = canvas.getBoundingClientRect();
      for (const f of getFrame()) {
        const p = stage.proj.toPixel(f.lat, f.lon);
        if (p.x > 20 && p.y > 20 && p.x < s.w - 20 && p.y < s.h - 20) {
          return {
            x: rect.left + p.x * s.scale,
            y: rect.top + p.y * s.scale,
            callsign: f.plane.callsign,
            hex: f.hex,
            onGround: f.plane.onGround,
          };
        }
      }
      return null;
    },

    selectFirst: () => {
      const frame = getFrame();
      if (!frame.length) return null;
      actions.setSelected(frame[0].hex);
      return frame[0].hex;
    },
    setRing: (km) => actions.setRing(km),
    zoomBy: (d) => actions.zoomBy(d),
    togglePause: () => actions.togglePause(),
    resetView: () => actions.resetView(),
    setToggle: (k, v) => actions.setToggle(k, v),
    setScale: (v) => actions.setScale(v),
    airports: AIRPORTS.length,
  };
}
