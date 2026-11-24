// Local stand-in for Vercel: serves public/ and routes /api/room to the same function.
// Without Redis credentials in the environment the room lives in memory.
//   npm run dev            then open http://localhost:3000 in a few tabs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { GET, POST } from '../api/room.js';

const PORT = Number(process.env.PORT) || 3000;
const ROOT = resolve('public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

const readBody = (req) =>
  new Promise((ok, fail) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/api/room') {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const request = new Request(url, { method: req.method, headers: req.headers, body });
      const response = await (req.method === 'POST' ? POST(request) : GET(request));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
      return;
    }
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(join(ROOT, path));
    if (!file.startsWith(ROOT + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  })
  .listen(PORT, () => console.log(`Yo UnCrillion running at http://localhost:${PORT}`));
