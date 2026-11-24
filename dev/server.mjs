// Serves public/ locally. The game itself talks through the public relays, so there is no backend.
//   npm run dev     then open http://localhost:3000 in a few tabs or on phones on the same wifi
//   Add ?broker=ws://localhost:9001 to use your own MQTT broker instead of the public ones.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const PORT = Number(process.env.PORT) || 3000;
const ROOT = resolve('public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

http
  .createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
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
