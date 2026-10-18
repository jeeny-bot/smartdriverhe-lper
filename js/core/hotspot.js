// 콜 발생 지점들로부터 "지금 어디로 가야 콜이 많은지"와 "도착지가 콜밭인지 오지인지"를 계산합니다.
//
// 입력 점(point): { lat, lng, t(ms), label? }  ← 콜의 "출발지" 좌표. 사람들이 콜을 부른 곳이 곧 수요입니다.
// 점수 = 최근일수록 × 같은 시간대일수록 × 같은 요일 종류(평일/주말)일수록 크게 칩니다.
// 데이터가 적을수록 불확실하다는 점을 confidence 로 함께 돌려줍니다.

import { cellOf, cellKey, haversineKm, hourOf, circularHourDiff, dayTypeOf } from './geo.js';

export const DEFAULTS = {
  cellKm: 1.5, // 추천 칸 크기
  halfLifeDays: 30, // 이 기간이 지나면 가중치가 절반
  hourSigma: 2.0, // 같은 시간대로 치는 폭(시간)
  hourFloor: 0.15, // 다른 시간대여도 완전히 0은 아니게
  dayTypeMismatch: 0.6, // 평일/주말이 다를 때 가중치
  distScaleKm: 6, // 이 거리쯤에서 점수가 절반 근처로
  maxKm: 40, // 이보다 먼 곳은 추천하지 않음
  nearKm: 3, // 착지 평가: 가까운 반경
  midKm: 7, // 착지 평가: 중간 반경
  midWeight: 0.35,
  minDataPoints: 15, // 이보다 적으면 착지 평가는 "데이터 부족"
  hotRatio: 1.0, // 기준 대비 이 이상이면 콜밭
  remoteRatio: 0.25, // 기준 대비 이 미만이면 오지
  maxPoints: 6000,
};

export function pointWeight(p, now, target, o = DEFAULTS) {
  const ageDays = Math.max(0, (now - p.t) / 86_400_000);
  const recency = 0.5 ** (ageDays / o.halfLifeDays);
  const dh = circularHourDiff(hourOf(p.t), hourOf(target));
  const hour = o.hourFloor + (1 - o.hourFloor) * Math.exp(-(dh * dh) / (2 * o.hourSigma * o.hourSigma));
  const day = dayTypeOf(p.t) === dayTypeOf(target) ? 1 : o.dayTypeMismatch;
  return recency * hour * day;
}

const confidenceOf = (count) => (count >= 8 ? 'high' : count >= 3 ? 'mid' : 'low');

/**
 * 가까우면서 콜이 많은 칸을 순서대로 추천합니다.
 * @param {Array<{lat:number,lng:number,t:number,label?:string}>} points
 * @param {{now?:number,target?:number,user?:{lat:number,lng:number},limit?:number}} ctx
 */
export function recommend(points, ctx = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = ctx.now ?? Date.now();
  const target = ctx.target ?? now;
  const cells = new Map();
  for (const p of points.slice(-o.maxPoints)) {
    const w = pointWeight(p, now, target, o);
    const key = cellKey(p, o.cellKm);
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { score: 0, count: 0, sLat: 0, sLng: 0, hours: new Array(24).fill(0), labels: new Map() }));
    c.score += w;
    c.count += 1;
    c.sLat += p.lat * w;
    c.sLng += p.lng * w;
    c.hours[Math.floor(hourOf(p.t)) % 24] += 1;
    if (p.label) c.labels.set(p.label, (c.labels.get(p.label) ?? 0) + 1);
  }
  const out = [];
  for (const [key, c] of cells) {
    if (c.score <= 0) continue;
    const center = { lat: c.sLat / c.score, lng: c.sLng / c.score };
    const distKm = ctx.user ? haversineKm(ctx.user, center) : 0;
    if (ctx.user && distKm > o.maxKm) continue;
    const final = ctx.user ? c.score / (1 + (distKm / o.distScaleKm) ** 2) : c.score;
    let peakHour = 0;
    let bestSum = -1;
    for (let h = 0; h < 24; h++) {
      const s = c.hours[h] + 0.5 * (c.hours[(h + 23) % 24] + c.hours[(h + 1) % 24]);
      if (s > bestSum) [bestSum, peakHour] = [s, h];
    }
    const label = [...c.labels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    out.push({ key, ...center, score: c.score, final, count: c.count, distKm, peakHour, label, confidence: confidenceOf(c.count) });
  }
  out.sort((a, b) => b.final - a.final);
  return ctx.limit ? out.slice(0, ctx.limit) : out;
}

function neighborhoodScore(center, points, now, target, o) {
  let near = 0;
  let nearCount = 0;
  for (const p of points) {
    const d = haversineKm(center, p);
    if (d <= o.nearKm) {
      near += pointWeight(p, now, target, o);
      nearCount += 1;
    } else if (d <= o.midKm) {
      near += o.midWeight * pointWeight(p, now, target, o);
    }
  }
  return { score: near, nearCount };
}

/**
 * 도착지가 콜밭인지 오지인지 평가합니다.
 * 기준: 같은 시간대에 "이미 콜이 나온 칸들"의 주변 점수 상위권과 비교한 비율.
 * @returns {{level:'hot'|'normal'|'remote'|'unknown', ratio:number|null, nearCount:number, exit:object|null, reason:string}}
 */
export function landingRisk(dest, points, ctx = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = ctx.now ?? Date.now();
  const target = ctx.target ?? now;
  const pts = points.slice(-o.maxPoints);
  if (pts.length < o.minDataPoints) {
    return { level: 'unknown', ratio: null, nearCount: 0, exit: null, reason: `콜 위치 데이터가 ${pts.length}건뿐이라 판단하기 어려워요 (${o.minDataPoints}건 이상 필요)` };
  }
  // 기준값: 데이터 전체에서 가장 바쁜 시간대에, 콜이 나온 칸들의 주변 점수 중 60번째 백분위.
  // 바쁜 시간대를 기준으로 삼아야 "낮에는 어디나 한산함"처럼 시간대 차이가 점수에 그대로 드러납니다.
  const busyMs = new Date(target);
  let busyHour = 0;
  let busyScore = -1;
  for (let h = 0; h < 24; h++) {
    busyMs.setHours(h, 0, 0, 0);
    let sum = 0;
    for (const p of pts) sum += pointWeight(p, now, busyMs.getTime(), o);
    if (sum > busyScore) [busyScore, busyHour] = [sum, h];
  }
  busyMs.setHours(busyHour, 0, 0, 0);
  const busyTarget = busyMs.getTime();
  const cellCenters = recommend(pts, { now, target: busyTarget }, o);
  const refs = cellCenters.map((c) => neighborhoodScore(c, pts, now, busyTarget, o).score).sort((a, b) => a - b);
  const ref = refs.length ? refs[Math.floor(refs.length * 0.6)] : 0;
  const here = neighborhoodScore(dest, pts, now, target, o);
  const ratio = ref > 0 ? here.score / ref : 0;
  const level = ratio >= o.hotRatio ? 'hot' : ratio >= o.remoteRatio ? 'normal' : 'remote';

  // 가장 가까운 "콜밭"(추천 상위 칸) — 걸어가거나 택시로 빠져나갈 곳
  const top = recommend(pts, { now, target, user: dest, limit: 5 }, { ...o, maxKm: 120 }).filter((c) => c.confidence !== 'low' || c.count >= 2);
  const exit = top[0] ? { lat: top[0].lat, lng: top[0].lng, distKm: top[0].distKm, label: top[0].label } : null;

  const reason =
    level === 'hot'
      ? '이 시간대에 주변에서 콜이 자주 나온 곳이에요'
      : level === 'normal'
        ? '주변 콜이 보통 수준이에요'
        : '이 시간대 주변 콜이 콜밭에 비해 많이 적어요. 복귀가 어려울 수 있어요';
  return { level, ratio, nearCount: here.nearCount, exit, reason };
}

/** 서로 가까운 칸이 줄줄이 나오지 않도록, 이미 고른 곳에서 sepKm 이상 떨어진 곳만 순서대로 고릅니다. */
export function diversify(recs, sepKm = 3, limit = 5) {
  const out = [];
  for (const r of recs) {
    if (out.every((o) => haversineKm(o, r) >= sepKm)) out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** 원하는 시각(hour)에 활발한 시간대를 점 주변에서 뽑습니다 (참고용) */
export function activeHoursNear(dest, points, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const hours = new Array(24).fill(0);
  for (const p of points) if (haversineKm(dest, p) <= o.nearKm) hours[Math.floor(hourOf(p.t)) % 24] += 1;
  return hours;
}

export { cellOf };
