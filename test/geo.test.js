import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, inKorea, cellKey, roundPos, circularHourDiff, dayTypeOf, roughPlace } from '../js/core/geo.js';
import { recommend, landingRisk, pointWeight } from '../js/core/hotspot.js';
import { addressCandidates, normalizeAddress, shortLabel } from '../js/core/address.js';

const at = (y, m, d, h, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = at(2026, 10, 16, 23, 30); // 금요일 밤
const HUB_A = { lat: 37.4979, lng: 127.0276 }; // 강남역 부근
const HUB_B = { lat: 37.2636, lng: 127.0286 }; // 수원 인계동 부근
const FAR = { lat: 37.1, lng: 127.45 }; // 외곽

function cluster(center, n, hour, { jitter = 0.004, daysAgo = 3 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    lat: center.lat + ((i % 5) - 2) * jitter * 0.5,
    lng: center.lng + ((Math.floor(i / 5) % 5) - 2) * jitter * 0.5,
    t: at(2026, 10, 16 - daysAgo, hour, (i * 7) % 60),
  }));
}

test('haversine: 강남역~수원 인계동은 약 25~30km', () => {
  const d = haversineKm(HUB_A, HUB_B);
  assert.ok(d > 24 && d < 32, String(d));
  assert.equal(haversineKm(HUB_A, HUB_A), 0);
});

test('inKorea / roundPos / cellKey', () => {
  assert.ok(inKorea(HUB_A));
  assert.ok(!inKorea({ lat: 0, lng: 0 }));
  assert.ok(!inKorea({ lat: NaN, lng: 127 }));
  assert.deepEqual(roundPos({ lat: 37.49791, lng: 127.02763 }), { lat: 37.498, lng: 127.028 });
  assert.equal(cellKey(HUB_A, 1.5), cellKey({ lat: HUB_A.lat + 0.0005, lng: HUB_A.lng }, 1.5));
  assert.notEqual(cellKey(HUB_A, 1.5), cellKey(HUB_B, 1.5));
});

test('시간 도우미: 23시와 1시는 2시간 차이, 금요일 새벽 1시는 평일 영업', () => {
  assert.equal(circularHourDiff(23, 1), 2);
  assert.equal(circularHourDiff(6, 18), 12);
  assert.equal(dayTypeOf(at(2026, 10, 17, 1)), 'weekday'); // 토요일 01시 = 금요일 영업
  assert.equal(dayTypeOf(at(2026, 10, 17, 22)), 'weekend');
  assert.equal(dayTypeOf(at(2026, 10, 19, 2)), 'weekend'); // 월요일 02시 = 일요일 영업
});

test('roughPlace: 상세 주소를 빼고 시·구·동까지만', () => {
  assert.equal(roughPlace('경기 용인시 처인구 양지읍 남곡리 524-8 고기구워먹는마당'), '용인시 처인구 양지읍');
  assert.equal(roughPlace('서울 서초구 반포동 110'), '서초구 반포동');
  assert.equal(roughPlace(null), '');
});

test('pointWeight: 같은 시간대·최근일수록 큼', () => {
  const sameHour = { lat: 0, lng: 0, t: at(2026, 10, 15, 23) };
  const noon = { lat: 0, lng: 0, t: at(2026, 10, 15, 12) };
  const old = { lat: 0, lng: 0, t: at(2026, 7, 15, 23) };
  assert.ok(pointWeight(sameHour, NOW, NOW) > pointWeight(noon, NOW, NOW) * 3);
  assert.ok(pointWeight(sameHour, NOW, NOW) > pointWeight(old, NOW, NOW) * 5);
});

test('recommend: 가까운 곳 + 같은 시간대에 콜이 많은 곳이 먼저', () => {
  const points = [...cluster(HUB_A, 30, 23), ...cluster(HUB_B, 30, 23), ...cluster(FAR, 3, 23)];
  const nearA = { lat: 37.5, lng: 127.03 };
  const r = recommend(points, { now: NOW, user: nearA, limit: 3 });
  assert.ok(Math.abs(r[0].lat - HUB_A.lat) < 0.02);
  assert.equal(r[0].confidence, 'high');
  assert.ok(r[0].distKm < 3);
  const nearB = { lat: 37.27, lng: 127.03 };
  const r2 = recommend(points, { now: NOW, user: nearB, limit: 3 });
  assert.ok(Math.abs(r2[0].lat - HUB_B.lat) < 0.02);
});

test('recommend: 시간대가 다르면 순위가 바뀐다 (낮 콜 vs 밤 콜)', () => {
  const day = cluster(HUB_A, 25, 12);
  const night = cluster(HUB_B, 25, 23);
  const user = { lat: 37.38, lng: 127.03 }; // 두 곳 사이
  const atNight = recommend([...day, ...night], { now: NOW, target: NOW, user, limit: 1 });
  assert.ok(Math.abs(atNight[0].lat - HUB_B.lat) < 0.02);
  const noon = at(2026, 10, 16, 12);
  const atNoon = recommend([...day, ...night], { now: NOW, target: noon, user, limit: 1 });
  assert.ok(Math.abs(atNoon[0].lat - HUB_A.lat) < 0.02);
});

test('recommend: 너무 먼 곳은 제외, 점수 없음이면 빈 배열', () => {
  const far = cluster({ lat: 35.16, lng: 129.06 }, 20, 23); // 부산
  assert.equal(recommend(far, { now: NOW, user: HUB_A }).length, 0);
  assert.deepEqual(recommend([], { now: NOW, user: HUB_A }), []);
});

test('landingRisk: 데이터가 적으면 unknown', () => {
  const r = landingRisk(HUB_A, cluster(HUB_A, 5, 23), { now: NOW });
  assert.equal(r.level, 'unknown');
  assert.match(r.reason, /데이터/);
});

test('landingRisk: 콜밭 / 오지 구분과 탈출 후보', () => {
  const points = [...cluster(HUB_A, 40, 23), ...cluster(HUB_B, 40, 23)];
  const hot = landingRisk(HUB_A, points, { now: NOW });
  assert.equal(hot.level, 'hot');
  const remote = landingRisk(FAR, points, { now: NOW });
  assert.equal(remote.level, 'remote');
  assert.ok(remote.exit && remote.exit.distKm > 10);
  // 낮 시간대로 보면 밤에만 콜이 나오는 곳은 오지에 가깝다
  const noon = landingRisk(HUB_A, points, { now: NOW, target: at(2026, 10, 16, 12) });
  assert.notEqual(noon.level, 'hot');
});

test('addressCandidates: 붙은 행정구역을 나누고 구체적→대략적 순서', () => {
  const c = addressCandidates('경기 수원시영통구 이의동)광교자연앤자이(/국민카');
  assert.ok(c[0].startsWith('경기도 수원시 영통구'));
  assert.ok(c.every((s, i) => c.indexOf(s) === i));
  assert.ok(c.at(-1).split(' ').length >= 2);
  const d = addressCandidates('경기 용인시 처인구 양지읍 남곡리 524-8 고기구워먹는마당', { max: 6 });
  assert.equal(d[0], '경기도 용인시 처인구 양지읍 남곡리 524-8 고기구워먹는마당');
  assert.ok(d.includes('경기도 용인시 처인구 양지읍 남곡리'));
  assert.deepEqual(addressCandidates('수원'), []);
});

test('normalizeAddress / shortLabel', () => {
  assert.equal(normalizeAddress('서울 서초구 반포동 반포동 110'), '서울 서초구 반포동 110');
  assert.equal(normalizeAddress('경기 이천시 모가면두미리'), '경기 이천시 모가면 두미리');
  assert.equal(shortLabel('경기 용인시 처인구 양지읍 남곡리 524-8'), '용인시 처인구 양지읍');
});

import { buildPack, parsePack } from '../js/core/share.js';
import { makeDemoPoints } from '../js/core/demo.js';

test('공유 파일: 좌표·시각을 뭉개고 금액·주소는 넣지 않는다', () => {
  const calls = [
    { at: at(2026, 10, 16, 23, 41), fare: 40000, startAddr: '비밀 상세주소 1-1', startPos: { lat: 37.49791, lng: 127.02763 }, endPos: { lat: 37.26361, lng: 127.02861 } },
    { at: at(2026, 10, 16, 1, 5), fare: 1, startPos: null, endPos: { lat: 0, lng: 0 } },
  ];
  const pack = buildPack(calls, 123);
  assert.equal(pack.points.length, 2);
  assert.deepEqual(pack.points[0], { lat: 37.498, lng: 127.028, t: at(2026, 10, 16, 23), k: 's' });
  const json = JSON.stringify(pack);
  assert.ok(!json.includes('40000') && !json.includes('비밀'));
});

test('공유 파일 읽기: 검증하고 이상한 점은 버린다', () => {
  const good = buildPack([{ at: NOW, startPos: HUB_A, endPos: HUB_B }]);
  const r = parsePack(JSON.stringify(good));
  assert.equal(r.points.length, 2);
  const bad = { type: 'call-points', points: [{ lat: 1, lng: 1, t: 1, k: 's' }, { lat: 37.5, lng: 127, t: 5, k: 'x' }, { lat: 37.5, lng: 127, t: NOW, k: 'e' }] };
  const r2 = parsePack(JSON.stringify(bad));
  assert.equal(r2.points.length, 1);
  assert.equal(r2.skipped, 2);
  assert.throws(() => parsePack('{"calls":[]}'), /공유 파일/);
  assert.throws(() => parsePack('not json'), /JSON/);
});

test('데모 데이터: 항상 같고, 한국 안에 있으며, 밤 시간대에 몰린다', () => {
  const a = makeDemoPoints({ now: NOW });
  const b = makeDemoPoints({ now: NOW });
  assert.deepEqual(a, b);
  assert.equal(a.length, 300);
  assert.ok(a.every((p) => inKorea(p)));
  const night = a.filter((p) => { const h = new Date(p.t).getHours(); return h >= 21 || h <= 2; }).length;
  assert.ok(night > a.length * 0.6, String(night));
  const r = recommend(a, { now: NOW, user: HUB_A, limit: 1 });
  assert.ok(r[0].distKm < 5);
});

import { diversify } from '../js/core/hotspot.js';
test('diversify: 가까운 칸은 건너뛰고 서로 떨어진 곳만', () => {
  const points = [...cluster(HUB_A, 40, 23, { jitter: 0.03 }), ...cluster(HUB_B, 30, 23)];
  const all = recommend(points, { now: NOW, user: HUB_A });
  const spread = diversify(all, 5, 5);
  assert.ok(spread.length >= 2);
  for (let i = 0; i < spread.length; i++) for (let j = i + 1; j < spread.length; j++) assert.ok(haversineKm(spread[i], spread[j]) >= 5);
});

import { toSharePoint, previewOf } from '../js/core/share.js';
test('공유 점/미리보기: 출발지 대략 위치+시 단위만', () => {
  const call = { at: at(2026, 10, 16, 23, 41), startPos: { lat: 37.49791, lng: 127.02763 }, startAddr: '경기 용인시 처인구 양지읍 남곡리 524-8 고기구워먹는마당', fare: 50000 };
  assert.deepEqual(toSharePoint(call), { lat: 37.498, lng: 127.028, t: at(2026, 10, 16, 23), k: 's' });
  const pv = previewOf(call, roughPlace);
  assert.equal(pv.place, '용인시 처인구 양지읍');
  assert.equal(pv.when, '10/16(금) 23시대');
});

import { shareability } from '../js/core/share.js';
test('shareability: 60일 넘은 콜/미래 콜은 공유 불가', () => {
  assert.equal(shareability({ at: NOW - 3_600_000 }, NOW), 'ok');
  assert.equal(shareability({ at: NOW - 61 * 24 * 3_600_000 }, NOW), 'old');
  assert.equal(shareability({ at: NOW + 5 * 3_600_000 }, NOW), 'future');
});
