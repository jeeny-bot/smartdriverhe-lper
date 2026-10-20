// 착지 후 대기시간: "콜을 마친 뒤 다음 콜을 잡기까지 몇 분 걸렸나"를 일지에서 계산합니다.
//
// 콜카드에는 "콜 시각"만 있고 "도착 시각"은 없어서 이렇게 추정해요:
//   대기 = (다음 콜 시각 − 이번 콜 시각) − 운행시간(추정)
// 정확한 값은 아니지만, 같은 방식으로 여러 번 모으면 "어디가 빨리 잡히나"를 비교하기엔 충분해요.
//
// 공유할 때는 "다음 콜의 출발지(이미 공유하는 위치) + 직전 대기 분"만 붙입니다. 도착지는 어디에도 올리지 않아요.

import { haversineKm, inKorea } from './geo.js';
import { pointWeight } from './hotspot.js';
import { shortLabel } from './address.js';

const MIN = 60_000;
export const WAIT = {
  maxGapMin: 240, // 콜 사이가 이보다 길면 쉬었다고 보고 제외
  maxWaitMin: 180,
  sameAreaKm: 3, // 다음 콜 출발지가 이전 착지에서 이 거리 안이어야 "그 자리에서 기다린 것"
  roadFactor: 1.35, // 직선거리 → 도로거리
  speedKmh: 30,
  defaultTripMin: 30,
  minTripMin: 10,
  minSamples: 3, // 이보다 적으면 "측정값 없음"
  nearKm: 3,
  midKm: 7,
  midWeight: 0.35,
};

/** 운행시간 추정(분): 출발·도착 좌표가 있으면 거리로, 없으면 기본값 */
export function tripMinutes(call, o = WAIT) {
  if (call.startPos && call.endPos && inKorea(call.startPos) && inKorea(call.endPos)) {
    const km = haversineKm(call.startPos, call.endPos) * o.roadFactor;
    return Math.max(o.minTripMin, Math.round((km / o.speedKmh) * 60));
  }
  return o.defaultTripMin;
}

/**
 * 연속한 두 콜(a → b)마다 대기시간을 계산합니다. b 를 기준으로 돌려줘요.
 * @returns {Array<{id:number, prevId:number, waitMin:number, endPos:{lat:number,lng:number}, t:number, near:boolean}>}
 *   near: 다음 콜 출발지가 이전 착지 근처인지(그 자리에서 기다린 경우). 좌표가 없으면 false.
 *   t: 이전 콜을 마친 시각(추정, ms)
 */
export function computeWaits(calls, o = WAIT) {
  const sorted = [...calls].filter((c) => Number.isFinite(c.at)).sort((x, y) => x.at - y.at);
  const out = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const gapMin = (b.at - a.at) / MIN;
    if (gapMin <= 0 || gapMin > o.maxGapMin) continue;
    const trip = tripMinutes(a, o);
    const waitMin = Math.round(gapMin - trip);
    if (waitMin < 0 || waitMin > o.maxWaitMin) continue; // 겹치거나 너무 긴 건 추정이 틀렸을 가능성이 커서 뺍니다
    const near = Boolean(a.endPos && b.startPos && haversineKm(a.endPos, b.startPos) <= o.sameAreaKm);
    out.push({ id: b.id, prevId: a.id, waitMin, endPos: a.endPos ?? null, t: a.at + trip * MIN, near });
  }
  return out;
}

/** 공유할 때 붙일 대기 분 (5분 단위로 뭉갬). 공유 못 하는 경우 null */
export function shareableWait(wait) {
  if (!wait || !wait.near) return null;
  return Math.min(180, Math.round(wait.waitMin / 5) * 5);
}

const median = (pairs) => {
  // 가중 중앙값
  const arr = [...pairs].sort((a, b) => a.v - b.v);
  const total = arr.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const x of arr) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return arr.at(-1)?.v ?? 0;
};

/**
 * 도착지 주변의 "예상 대기시간(분)"을 계산합니다.
 * 내 기록(착지 위치 기준)과 공유받은 기록(다음 콜 출발지 + w)을 같이 씁니다.
 * @param {{lat:number,lng:number}} dest
 * @param {{own?:Array, shared?:Array, now?:number, target?:number}} src
 *   own: computeWaits 결과(endPos 있는 것만 씀) / shared: {lat,lng,t,w} (w 가 있는 것만 씀)
 * @returns {{minutes:number, n:number, ownN:number}|null} 표본이 minSamples 미만이면 null
 */
export function expectedWait(dest, { own = [], shared = [], now = Date.now(), target = now } = {}, o = WAIT) {
  const items = [];
  const add = (pos, t, v, isOwn) => {
    if (!pos || !Number.isFinite(v)) return;
    const d = haversineKm(dest, pos);
    const space = d <= o.nearKm ? 1 : d <= o.midKm ? o.midWeight : 0;
    if (!space) return;
    items.push({ v, w: space * pointWeight({ t }, now, target), isOwn });
  };
  for (const s of own) add(s.endPos, s.t, s.waitMin, true);
  for (const p of shared) if (Number.isFinite(p.w)) add(p, p.t, p.w, false);
  const usable = items.filter((x) => x.w > 0);
  if (usable.length < o.minSamples) return null;
  return { minutes: Math.round(median(usable)), n: usable.length, ownN: usable.filter((x) => x.isOwn).length };
}


/**
 * 착지 동네별 대기시간 순위 (내 일지 기준). 같은 동네가 minN 번 이상 나온 곳만, 중앙값이 짧은 순으로.
 * @returns {Array<{label:string, minutes:number, n:number}>}
 */
export function waitByPlace(calls, { now = Date.now(), days = 60, minN = 2 } = {}, o = WAIT) {
  const since = now - days * 86_400_000;
  const byId = new Map(calls.map((c) => [c.id, c]));
  const groups = new Map();
  for (const w of computeWaits(calls.filter((c) => c.at >= since), o)) {
    const addr = byId.get(w.prevId)?.endAddr;
    const label = addr ? shortLabel(addr) : '';
    if (!label) continue;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(w.waitMin);
  }
  const mid = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const h = s.length >> 1;
    return s.length % 2 ? s[h] : Math.round((s[h - 1] + s[h]) / 2);
  };
  return [...groups]
    .filter(([, v]) => v.length >= minN)
    .map(([label, v]) => ({ label, minutes: mid(v), n: v.length }))
    .sort((a, b) => a.minutes - b.minutes || b.n - a.n);
}
