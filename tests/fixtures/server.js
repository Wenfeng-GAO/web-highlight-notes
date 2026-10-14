import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const articlePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'article.html');
const NEEDLE = '研究者在图书馆发现了一份手稿';
const REPLACEMENT = '这段文字已经被完全改写';

export function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/article.html') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    let html = fs.readFileSync(articlePath, 'utf8');
    if (url.searchParams.get('variant') === 'changed') {
      html = html.split(NEEDLE).join(REPLACEMENT);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}/article.html`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
