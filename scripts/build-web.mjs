// 배포용 폴더(dist)를 만듭니다. 화면에 필요한 파일만 복사해서 test/·server/·data/ 같은 것이 인터넷에 올라가지 않게 해요.
// 실행: node scripts/build-web.mjs      → dist 폴더가 생깁니다 (Cloudflare Pages 등에 이 폴더를 올리세요)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const INCLUDE = ['index.html', 'css', 'js', 'vendor'];
const MAX_FILE = 25 * 1024 * 1024; // Cloudflare Pages 는 파일 하나 25MiB 까지

// 1) Firebase 설정이 채워져 있는지 확인 — 비어 있으면 배포해도 공유가 안 돼요.
const cfg = fs.readFileSync(path.join(root, 'js', 'firebase-config.js'), 'utf8');
const placeholder = /여기에|YOUR_|xxxx/i.test(cfg);
if (placeholder) {
  console.error('\n✗ js/firebase-config.js 에 apiKey, projectId 가 아직 채워져 있지 않아요.\n  채운 뒤 다시 실행하세요. (이 폴더를 올리면 공유가 동작하지 않아요)\n');
  process.exit(1);
}

// 2) dist 새로 만들기
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
let count = 0;
let bytes = 0;
const biggest = { size: 0, file: '' };
function copy(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) if (!name.startsWith('.')) copy(path.join(src, name), path.join(dst, name));
    return;
  }
  if (st.size > MAX_FILE) {
    console.error(`✗ ${path.relative(root, src)} 가 25MB 를 넘어 Cloudflare 에 올릴 수 없어요`);
    process.exit(1);
  }
  fs.copyFileSync(src, dst);
  count++;
  bytes += st.size;
  if (st.size > biggest.size) Object.assign(biggest, { size: st.size, file: path.relative(root, src) });
}
for (const item of INCLUDE) copy(path.join(root, item), path.join(dist, item));

// 3) 캐시 규칙: 내가 고친 파일(html/js/css)은 항상 새로 받고, 크고 안 바뀌는 vendor 는 일주일 캐시
fs.writeFileSync(
  path.join(dist, '_headers'),
  `/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/js/*
  Cache-Control: no-cache
/css/*
  Cache-Control: no-cache
/vendor/*
  Cache-Control: public, max-age=604800
`,
);

console.log(`\n✓ dist 폴더를 만들었어요: 파일 ${count}개, ${(bytes / 1048576).toFixed(1)}MB (가장 큰 파일: ${biggest.file} ${(biggest.size / 1048576).toFixed(1)}MB)`);
console.log('  이제 dist 폴더를 Cloudflare Pages 에 올리세요.\n');
