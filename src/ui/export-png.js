/**
 * Pixel Radar · 截图导出
 * ---------------------------------------------------------------
 * 把当前雷达屏导出为 PNG，并在下方拼一条信息栏（机场代码、城市、
 * 数据来源、量程、时间戳）—— 规格要求「带机场代码和日期」。
 *
 * 导出用的是系统字体而不是屏内的 5×7 位图字体：信息栏不属于 CRT 屏内容，
 * 是「相纸边缘的说明文字」，用正常字体反而更易读。
 *
 * 倍率固定 3×：保证导入到任何地方都不会糊，同时体积仍在几百 KB 量级。
 */

const OUT_SCALE = 3;
const FOOTER_H = 30;
const PAD = 10;

export function exportPng({ canvas, resolution, airport, ringKm, feed }) {
  const { w, h } = resolution;
  const footerPx = FOOTER_H * OUT_SCALE;

  const out = document.createElement('canvas');
  out.width = w * OUT_SCALE;
  out.height = h * OUT_SCALE + footerPx;
  const ctx = out.getContext('2d');

  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0a0b0c';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0, w, h, 0, 0, w * OUT_SCALE, h * OUT_SCALE);

  /* ── 信息栏 ── */
  ctx.fillStyle = '#131517';
  ctx.fillRect(0, h * OUT_SCALE, out.width, footerPx);
  ctx.fillStyle = '#25292d';
  ctx.fillRect(0, h * OUT_SCALE, out.width, 1);

  const fontSize = 13 * OUT_SCALE / 3;
  const pad = PAD * OUT_SCALE / 3;
  ctx.font = `${fontSize}px ui-monospace, Consolas, monospace`;
  ctx.textBaseline = 'middle';
  const midY = h * OUT_SCALE + footerPx / 2;

  ctx.textAlign = 'left';
  ctx.fillStyle = '#7fff7f';
  ctx.fillText(`${airport.icao} / ${airport.iata}`, pad, midY);

  ctx.fillStyle = '#d9d5ce';
  ctx.fillText(`${airport.cn} · ${airport.en}`, pad + 76 * OUT_SCALE / 3, midY);

  const srcName = feed.state === 'simulation' ? '模拟数据'
    : feed.state === 'snapshot' ? '静态快照' : '实时 ADS-B';

  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} `
    + `${two(d.getHours())}:${two(d.getMinutes())}`;

  ctx.textAlign = 'right';
  ctx.fillStyle = '#989ea3';
  ctx.fillText(`${srcName} · ${ringKm}km 量程 · ${stamp}`, out.width - pad, midY);

  /* ── 下载 ── */
  out.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pixel-radar-${airport.icao}-${stamp.replace(/[: ]/g, '')}.png`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');

  return { width: out.width, height: out.height };
}
