import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createShareApi, LIMITS } from '../server/share-api.mjs';

const HOUR = 3_600_000;
let clock = new Date(2026, 9, 17, 14, 30).getTime();

async function start(opts = {}) {
  const api = createShareApi({ now: () => clock, ...opts });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!(await api.handle(req, res, url))) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { api, base, close: () => new Promise((r) => server.close(r)) };
}
const post = (base, body) => fetch(`${base}/api/points`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const pt = (o = {}) => ({ lat: 37.49791, lng: 127.02763, t: clock - 2 * HOUR + 123456, k: 's', ...o });

test('health와 업로드→조회: 좌표는 100m, 시각은 시 단위로 뭉개진다', async () => {
  const s = await start();
  assert.equal((await (await fetch(`${s.base}/api/health`)).json()).app, 'call-share');
  const r = await post(s.base, { cid: 'device-aaaa1111', points: [pt()] });
  assert.deepEqual(await r.json(), { added: 1, skipped: 0 });
  const list = await (await fetch(`${s.base}/api/points`)).json();
  assert.equal(list.points.length, 1);
  assert.equal(list.points[0].lat, 37.498);
  assert.equal(list.points[0].t % HOUR, 0);
  assert.deepEqual(Object.keys(list.points[0]).sort(), ['k', 'lat', 'lng', 't']); // cid 는 내려주지 않는다
  await s.close();
});

test('같은 점 중복 무시, 내가 올린 건 exclude 로 제외', async () => {
  const s = await start();
  await post(s.base, { cid: 'device-aaaa1111', points: [pt()] });
  const again = await (await post(s.base, { cid: 'device-aaaa1111', points: [pt()] })).json();
  assert.equal(again.added, 0);
  await post(s.base, { cid: 'device-bbbb2222', points: [pt({ lat: 37.26, lng: 127.03 })] });
  const forA = await (await fetch(`${s.base}/api/points?exclude=device-aaaa1111`)).json();
  assert.equal(forA.points.length, 1);
  assert.equal(forA.points[0].lat, 37.26);
  await s.close();
});

test('잘못된 점은 걸러진다 (해외 좌표, 도착지 종류, 미래, 너무 오래됨)', async () => {
  const s = await start();
  const r = await (await post(s.base, { cid: 'device-aaaa1111', points: [pt({ lat: 10 }), pt({ k: 'e' }), pt({ t: clock + 5 * HOUR }), pt({ t: clock - 200 * 24 * HOUR }), pt({ lat: 'x' })] })).json();
  assert.equal(r.added, 0);
  assert.equal(s.api.size, 0);
  await s.close();
});

test('잘못된 요청: cid 없음, 점 없음, 너무 많음, JSON 아님, 너무 큼', async () => {
  const s = await start();
  assert.equal((await post(s.base, { points: [pt()] })).status, 400);
  assert.equal((await post(s.base, { cid: 'device-aaaa1111', points: [] })).status, 400);
  assert.equal((await post(s.base, { cid: 'device-aaaa1111', points: Array.from({ length: 201 }, () => pt()) })).status, 413);
  assert.equal((await fetch(`${s.base}/api/points`, { method: 'POST', body: 'nope' })).status, 400);
  assert.equal((await fetch(`${s.base}/api/points`, { method: 'POST', body: 'x'.repeat(LIMITS.maxBodyBytes + 10) })).status, 413);
  assert.equal((await fetch(`${s.base}/api/unknown`)).status, 404);
  await s.close();
});

test('속도 제한: 한 기기가 하루 한도를 넘기면 429', async () => {
  const s = await start({ limits: { ...LIMITS, perCidPerDay: 5, perIpPerHour: 1000 } });
  const mk = (n) => Array.from({ length: n }, (_, i) => pt({ lat: 37.4 + i * 0.01 }));
  assert.equal((await post(s.base, { cid: 'device-aaaa1111', points: mk(5) })).status, 200);
  assert.equal((await post(s.base, { cid: 'device-aaaa1111', points: [pt({ lat: 37.9 })] })).status, 429);
  assert.equal((await post(s.base, { cid: 'device-cccc3333', points: [pt({ lat: 37.9 })] })).status, 200);
  await s.close();
});

test('CORS 허용과 OPTIONS', async () => {
  const s = await start();
  const r = await fetch(`${s.base}/api/points`, { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  await s.close();
});
