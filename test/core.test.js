// 실행: npm test   (node --test)
// 아래 콜카드 샘플은 일반적인 라벨 형태를 가정해 만든 예시입니다. 실제 콜카드 샘플로 보강하세요.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCallCard, maskPhones } from '../js/core/parser.js';
import { settle, resolveEditedFee, BusinessDay, summarize, byDay, EMPTY_SUMMARY } from '../js/core/ledger.js';

// 시간대와 상관없이 통과하도록, 모든 시각을 "기기 현지 시간"으로 만듭니다.
const ms = (date, hour, min = 0) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, hour, min).getTime();
};

test('라벨이 줄바꿈으로 분리된 카드', () => {
  const p = parseCallCard(`카카오T 대리
출발지
수원시 팔달구 인계동 123
도착지
용인시 수지구 풍덕천동
요금 25,000원
수수료 20%`);
  assert.equal(p.platform, 'kakao');
  assert.equal(p.start, '수원시 팔달구 인계동 123');
  assert.equal(p.end, '용인시 수지구 풍덕천동');
  assert.equal(p.fare, 25000);
  assert.equal(p.feeAmount, null);
  assert.equal(p.feeRatePercent, 20);
  assert.equal(p.isCallCard, true);
});

test('라벨과 값이 같은 줄, 수수료 금액', () => {
  const p = parseCallCard(`로지 콜
출발: 수원역 4번 출구
도착: 광교중앙역
운임 18,000원 (수수료 3,600원)`);
  assert.equal(p.platform, 'logi');
  assert.equal(p.start, '수원역 4번 출구');
  assert.equal(p.end, '광교중앙역');
  assert.equal(p.fare, 18000);
  assert.equal(p.feeAmount, 3600);
});

test('화살표 경로와 라벨 없는 요금', () => {
  const p = parseCallCard(`대리운전 콜 도착
수원 인계동 → 화성 동탄
30,000원
포인트 적립 500원`);
  assert.equal(p.start, '수원 인계동');
  assert.equal(p.end, '화성 동탄');
  assert.equal(p.fare, 30000);
  assert.equal(p.isCallCard, true);
});

test('OCR이 화살표를 다른 글자로 잘못 읽어도 경로를 찾는다', () => {
  for (const arrow of ['ㅜㅠ', '=', '->', '-']) {
    const p = parseCallCard(`대리운전 콜 도착\n수원 인계동 ${arrow} 화성 동탄\n30,000원`);
    assert.equal(p.start, '수원 인계동', arrow);
    assert.equal(p.end, '화성 동탄', arrow);
  }
});

test('요금·수수료 줄을 경로로 잘못 읽지 않는다', () => {
  const p = parseCallCard('콜 정산\n요금 - 25,000원\n수수료 - 5,000원');
  assert.equal(p.start, null);
  assert.equal(p.end, null);
  assert.equal(p.fare, 25000);
});

test('출발시간/도착시간 줄은 경로로 읽지 않는다', () => {
  const p = parseCallCard(`출발시간 23:10
출발지 영통구 영통동
도착시간 23:50
도착지 팔달구 매탄동
요금 15,000원`);
  assert.equal(p.start, '영통구 영통동');
  assert.equal(p.end, '팔달구 매탄동');
});

test('수수료 금액이 다음 줄에 있는 경우', () => {
  const p = parseCallCard('출발지 A동\n도착지 B동\n요금 20,000원\n수수료\n4,000원');
  assert.equal(p.feeAmount, 4000);
});

test('OCR이 글자 사이에 공백을 넣은 라벨도 읽는다', () => {
  const p = parseCallCard('출 발 지 수원시 인계동\n도 착 지 용인시 수지구\n요 금 22,000원\n수 수 료 4,400원');
  assert.equal(p.start, '수원시 인계동');
  assert.equal(p.end, '용인시 수지구');
  assert.equal(p.fare, 22000);
});

test('콜카드가 아닌 일반 화면은 거른다', () => {
  assert.equal(parseCallCard('오늘의 쇼핑\n맛있는 사과 12,000원 할인').isCallCard, false);
});

test('고객 전화번호 지우기', () => {
  assert.equal(maskPhones('고객 010-1234-5678 호출'), '고객 [전화번호] 호출');
  assert.equal(maskPhones('01012345678'), '[전화번호]');
});

test('정산: 카드 금액 > 카드 비율 > 설정 비율', () => {
  assert.deepEqual(settle(20000, 3000, 10, 20), { fare: 20000, fee: 3000, source: 'card_amount', estimated: false, net: 17000 });
  assert.equal(settle(20000, null, 10, 20).fee, 2000);
  const d = settle(20000, null, null, 20);
  assert.equal(d.fee, 4000);
  assert.equal(d.net, 16000);
  assert.equal(d.estimated, true);
  // 요금보다 큰 수수료 금액은 잘못 읽은 값으로 보고 무시
  assert.equal(settle(20000, 30000, null, 20).source, 'default_rate');
});

test('일지 수정 시 수수료 결정', () => {
  const initial = { fare: 20000, fee: 4000, feeEstimated: true };
  // 예상 수수료를 그대로 두고 요금만 고치면 다시 계산
  assert.deepEqual(resolveEditedFee({ fare: 30000, feeInput: 4000, initial, rateFor: 20 }), { fee: 6000, feeEstimated: true });
  // 수수료를 직접 고쳤으면 그 값을 유지
  assert.deepEqual(resolveEditedFee({ fare: 30000, feeInput: 5000, initial, rateFor: 20 }), { fee: 5000, feeEstimated: false });
  // 비우면 자동 계산
  assert.deepEqual(resolveEditedFee({ fare: 10000, feeInput: null, initial, rateFor: 20 }), { fee: 2000, feeEstimated: true });
});

test('영업일은 새벽 6시에 바뀐다', () => {
  assert.equal(BusinessDay.dateOf(ms('2026-10-12', 2), 6), '2026-10-11');
  assert.equal(BusinessDay.dateOf(ms('2026-10-12', 6), 6), '2026-10-12');
  assert.equal(BusinessDay.dateOf(ms('2026-10-12', 23, 30), 6), '2026-10-12');
});

test('하루 요약과 시간당 순익', () => {
  const range = BusinessDay.rangeOf('2026-10-11', 6);
  const calls = [
    { fare: 25000, fee: 5000, at: ms('2026-10-11', 22) },
    { fare: 30000, fee: 6000, at: ms('2026-10-12', 1) }, // 같은 영업일(자정 넘김)
    { fare: 10000, fee: 2000, at: ms('2026-10-12', 7) }, // 다음 영업일
  ];
  const expenses = [{ amount: 4000, at: ms('2026-10-12', 2) }];
  const sessions = [{ start: ms('2026-10-11', 21), end: ms('2026-10-12', 3) }];
  const s = summarize(calls, expenses, sessions, range, ms('2026-10-12', 4));
  assert.equal(s.count, 2);
  assert.equal(s.totalFare, 55000);
  assert.equal(s.totalFee, 11000);
  assert.equal(s.afterFee, 44000);
  assert.equal(s.profit, 40000);
  assert.equal(s.workedMillis, 6 * 3_600_000);
  assert.equal(s.hourlyProfit, 6667); // 40,000 / 6h
});

test('근무 중인 기록은 지금까지로 계산, 근무 기록이 없으면 시간당 순익 없음', () => {
  const range = BusinessDay.rangeOf('2026-10-11', 6);
  const s = summarize([], [], [{ start: ms('2026-10-11', 20), end: null }], range, ms('2026-10-11', 22));
  assert.equal(s.workedMillis, 2 * 3_600_000);
  assert.equal(EMPTY_SUMMARY.hourlyProfit, null);
});

test('일별 묶음은 최신 날짜가 먼저', () => {
  const calls = [
    { fare: 10000, fee: 2000, at: ms('2026-10-10', 23) },
    { fare: 20000, fee: 4000, at: ms('2026-10-11', 22) },
    { fare: 5000, fee: 1000, at: ms('2026-10-12', 1) },
  ];
  const days = byDay(calls, [], 6);
  assert.deepEqual(days.map((d) => d.date), ['2026-10-11', '2026-10-10']);
  assert.equal(days[0].summary.count, 2);
});

test('월 범위는 1일 새벽 기준 시각에서 시작', () => {
  const r = BusinessDay.monthRange(2026, 10, 6);
  assert.equal(r.start, ms('2026-10-01', 6));
  assert.equal(r.end, ms('2026-11-01', 6));
});

// ---- 실제 콜카드 레이아웃을 흉내 낸 익명 사례 (이름·번호·실제 주소 없음) ----
import { resolveCallTime } from '../js/core/parser.js';

test('법인콜: 라벨이 칸 가운데, 값이 위아래 줄, 날짜 오전/오후, 수익금', () => {
  const r = parseCallCard(`출발지  <<<0)후)경기 가나시다라구 마바읍사리
행 18:×0중/법/가나아파트
경기 아자시차카구 타파동)샘플자이(
도착지 샘플오피스텔
요금 50,000원 (예상 수익금:39,500원)
접수시간 2026-05-19 오후05:03:09
배차시간 2026-05-19 오후05:04:06`);
  assert.match(r.start, /가나시다라구/);
  assert.match(r.end, /아자시차카구/);
  assert.equal(r.fare, 50000);
  assert.equal(r.feeAmount, 10500);
  assert.deepEqual(r.when.time, { h: 17, mi: 4 });
  assert.deepEqual(r.when.date, { y: 2026, m: 5, d: 19 });
});

test('수입 및 운행내역: 운행시간만 있으면 시각만, 총 수입이 금액', () => {
  const r = parseCallCard(`운행 상세 정보
출발지        가나시 다라동 샘플식당
도착지     마바구 사아동 샘플아파트
운행시간            00:18 ~ 01:04
총 수입                                39,296원`);
  assert.equal(r.start, '가나시 다라동 샘플식당');
  assert.equal(r.end, '마바구 사아동 샘플아파트');
  assert.equal(r.fare, 39296);
  assert.deepEqual(r.when.time, { h: 0, mi: 18 });
  assert.equal(r.when.date, null);
});

test('운행일자 형식과 도착지만 있는 카드', () => {
  const a = parseCallCard('운행일자 2026.5.19 (화) 15:44 ~ 17:19\n출발지 경기 가나시 다라구 마바읍\n도착지 경기 사아시 자차동\n요금 52,000원');
  assert.deepEqual(a.when.date, { y: 2026, m: 5, d: 19 });
  assert.deepEqual(a.when.time, { h: 15, mi: 44 });
  const b = parseCallCard('운행중\n도착지\n경기 안산 상록구 사동\n그랑시티자이2차아파트\n50,400원\n카드결제');
  assert.equal(b.end, '경기 안산 상록구 사동');
  assert.equal(b.start, null);
  assert.equal(b.fare, 50400);
});

test('resolveCallTime: 카드 날짜·시간 우선, 시간만 있으면 캡처일 기준', () => {
  const ref = new Date(2026, 4, 20, 9, 0).getTime();
  assert.equal(resolveCallTime({ date: { y: 2026, m: 5, d: 19 }, time: { h: 17, mi: 4 } }, ref).at, new Date(2026, 4, 19, 17, 4).getTime());
  const t = resolveCallTime({ date: null, time: { h: 0, mi: 18 } }, ref);
  assert.equal(t.at, new Date(2026, 4, 20, 0, 18).getTime());
  assert.equal(t.basis, 'card-time');
  const prev = resolveCallTime({ date: null, time: { h: 23, mi: 40 } }, ref);
  assert.equal(prev.at, new Date(2026, 4, 19, 23, 40).getTime());
  assert.equal(resolveCallTime({ date: null, time: null }, ref).basis, 'reference');
});
