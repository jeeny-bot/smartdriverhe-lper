import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirebaseShare, docIdFor, explainError } from '../js/share-firebase.js';
import { createMockFirebase } from './helpers/mock-firebase.mjs';

const HOUR = 3_600_000;
let clock = new Date(2026, 9, 17, 14, 30).getTime();
const cfg = { apiKey: 'test-key', projectId: 'demo-proj' };
const pt = (o = {}) => ({ lat: 37.498, lng: 127.028, t: Math.floor(clock / HOUR) * HOUR - 2 * HOUR, k: 's', ...o });
function user(mock, config = cfg) {
  return createFirebaseShare({ config, storage: mock.storage(), fetchFn: mock.fetchFn, now: () => clock });
}

test('docIdFor: 같은 입력은 같고 사용자·점이 다르면 달라진다', () => {
  assert.equal(docIdFor('u1', pt()), docIdFor('u1', pt()));
  assert.notEqual(docIdFor('u1', pt()), docIdFor('u2', pt()));
  assert.notEqual(docIdFor('u1', pt()), docIdFor('u1', pt({ lat: 37.5 })));
  assert.match(docIdFor('u1', pt()), /^[0-9a-f]{24}$/);
});

test('올리기 → 다른 사용자가 받기, 내가 올린 건 제외', async () => {
  const mock = createMockFirebase({ now: () => clock });
  const A = user(mock);
  const B = user(mock);
  assert.deepEqual(await A.push([pt(), pt({ lat: 37.26 })]), { sent: 2, duplicates: 0 });
  const got = await B.pull();
  assert.equal(got.points.length, 2);
  assert.deepEqual(Object.keys(got.points[0]).sort(), ['id', 'k', 'lat', 'lng', 't']);
  assert.equal((await A.pull()).points.length, 0); // 내 것은 빠짐
  assert.ok(got.cursor.endsWith('Z'));
});

test('증분 가져오기: 커서 이후 새 점만', async () => {
  const mock = createMockFirebase({ now: () => clock });
  const A = user(mock);
  const B = user(mock);
  await A.push([pt()]);
  const first = await B.pull();
  clock += 5 * 60_000;
  await A.push([pt({ lat: 37.3 })]);
  const second = await B.pull(first.cursor);
  const ids = new Set(first.points.map((p) => p.id));
  const fresh = second.points.filter((p) => !ids.has(p.id));
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].lat, 37.3);
});

test('중복 올리기는 오류 없이 건너뛴다', async () => {
  const mock = createMockFirebase({ now: () => clock });
  const A = user(mock);
  await A.push([pt()]);
  const r = await A.push([pt(), pt({ lat: 37.31 })]);
  assert.deepEqual(r, { sent: 1, duplicates: 1 });
});

test('로그인 토큰을 저장해 두고 재사용, 만료되면 갱신', async () => {
  const mock = createMockFirebase({ now: () => clock });
  const A = user(mock);
  await A.push([pt()]);
  const signups = () => mock.log.filter((l) => l.includes('signUp')).length;
  assert.equal(signups(), 1);
  await A.pull();
  assert.equal(signups(), 1);
  clock += 2 * HOUR; // 토큰 만료
  await A.pull();
  assert.equal(signups(), 1);
  assert.ok(mock.log.some((l) => l.includes('securetoken')));
});

test('규칙 위반(해외 좌표, 남의 uid, 미래 시각)은 서버가 거절 → 한국어 오류', async () => {
  const mock = createMockFirebase({ now: () => clock });
  const A = user(mock);
  await assert.rejects(() => A.push([pt({ lat: 10 })]), /규칙/);
  await assert.rejects(() => A.push([pt({ t: clock + 10 * HOUR })]), /규칙/);
});

test('설정 문제별 안내: 키 오류 / 익명 꺼짐 / DB 없음 / 규칙 미게시 / 설정 비어 있음', async () => {
  const wrongKey = user(createMockFirebase({ now: () => clock }), { apiKey: 'bad', projectId: 'demo-proj' });
  await assert.rejects(() => wrongKey.selfTest(), /apiKey/);
  await assert.rejects(() => user(createMockFirebase({ now: () => clock, anonEnabled: false }), cfg).selfTest(), /익명 로그인/);
  await assert.rejects(() => user(createMockFirebase({ now: () => clock, firestoreCreated: false }), cfg).selfTest(), /데이터베이스를 아직 만들지/);
  await assert.rejects(() => user(createMockFirebase({ now: () => clock, rulesPublished: false }), cfg).selfTest(), /규칙/);
  const empty = user(createMockFirebase(), { apiKey: '여기에 apiKey 붙여넣기', projectId: '여기에 projectId 붙여넣기' });
  assert.equal(empty.configured(), false);
  await assert.rejects(() => empty.push([pt()]), /설정이 비어/);
});

test('연결 테스트 성공', async () => {
  const mock = createMockFirebase({ now: () => clock });
  const r = await user(mock).selfTest();
  assert.match(r.uid, /anon$/);
});

test('explainError: 네트워크/한도', () => {
  assert.match(explainError(429, { error: { status: 'RESOURCE_EXHAUSTED' } }, 'x').message, /무료 사용량/);
});

test('네트워크가 끊기면 연결 안내', async () => {
  const A = createFirebaseShare({ config: cfg, storage: { get: () => null, set() {} }, fetchFn: async () => { throw new TypeError('fail'); } });
  await assert.rejects(() => A.pull(), /연결하지 못했어요/);
});
