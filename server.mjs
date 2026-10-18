// 의존성 없는 정적 파일 서버. 실행: npm start  (또는 node server.mjs [포트])
// 같은 와이파이의 폰에서 http://<이 컴퓨터 IP>:포트 로 열어 테스트할 수 있습니다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createShareApi } from './server/share-api.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? process.env.PORT ?? 8080);

// 공유 데이터는 data/shared-points.json 에 저장됩니다 (서버를 껐다 켜도 남아요).
const shareApi = createShareApi({ file: path.join(root, 'data', 'shared-points.json') });

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  // 학습데이터(.gz)는 Content-Encoding 없이 그대로 내려줘야 Tesseract 가 직접 풀 수 있습니다.
  '.gz': 'application/gzip',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (await shareApi.handle(req, res, url)) return;
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const rest = path.relative(root, file).split(path.sep);
    if (rest[0] === 'node_modules' || rest[0] === 'test' || rest[0] === 'server' || rest[0] === 'data' || rest[0].startsWith('.')) {
      res.writeHead(404).end('not found');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': types[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    });
  } catch {
    res.writeHead(400).end('bad request');
  }
});

process.on('SIGINT', () => {
  shareApi.flush();
  process.exit(0);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`\n콜비서 일지 (웹) 실행 중`);
  console.log(`  이 컴퓨터:  http://localhost:${port}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  같은 와이파이의 폰:  http://${n.address}:${port}`);
    }
  }
  console.log('\n공유 기능: 이 서버에 접속한 기사들끼리 콜 위치가 공유돼요 (data/shared-points.json)');
  console.log('종료하려면 Ctrl+C\n');
});
