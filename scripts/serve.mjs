/**
 * Pixel Radar · 本地静态服务
 * ===============================================================
 * 本项目是「零构建」的 ES Modules 站点，浏览器不允许从 file:// 加载模块，
 * 所以本地开发需要一个极简静态服务器。刻意不依赖任何 npm 包 ——
 * 引入 express 只为了让开发者能双击一个脚本，不划算。
 *
 * 用法：
 *   node scripts/serve.mjs [端口]     默认 5173
 *
 * 行为特点：
 *   · 强制 `Cache-Control: no-store`，改完源码刷新即可生效；
 *   · 对 .js 显式声明 `text/javascript`（少一个字符某些浏览器就拒绝加载模块）；
 *   · 目录请求回落 index.html；未知路径返回 404 而不是首页（便于发现路径写错）。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2]) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** 阻止 ../ 穿越到项目之外 */
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const p = normalize(join(root, decoded));
  if (!p.startsWith(root + sep) && p !== root) return null;
  return p;
}

const server = createServer(async (req, res) => {
  try {
    let target = safeJoin(ROOT, req.url || '/');
    if (!target) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let info = await stat(target).catch(() => null);
    if (info && info.isDirectory()) {
      target = join(target, 'index.html');
      info = await stat(target).catch(() => null);
    }
    if (!info) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 Not Found: ${req.url}`);
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`500 ${e.message}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Pixel Radar 本地服务已启动`);
  console.log(`  http://127.0.0.1:${PORT}/`);
  console.log(`  根目录 ${ROOT}`);
  console.log(`  按 Ctrl+C 停止`);
});
