// 게임 요소: 레벨(경험치)·연속 기록·오늘의 미션·배지·지도 기여.
// 모두 일지(콜·지출)에서 "그때그때 계산"해요. 저장된 점수를 더하는 방식이 아니라서 중복 집계가 없고, 일지를 고치면 점수도 맞게 바뀝니다.
//
// 점수는 "진짜 데이터"일 때만 줍니다: 같은 이미지(중복)는 저장 단계에서 이미 막히고, 60일이 지난 콜과 미래 시각 콜은 점수가 없고,
// 하루에 점수를 받는 콜·지출 수에 상한이 있어요. 손으로 직접 입력한 콜은 점수가 적습니다.
// ※ 이 점수는 내 기기에서만 계산돼서 순위·보상에는 쓸 수 없어요. 순위나 보상을 붙이려면 서버에서 검증하는 단계가 따로 필요합니다.

import { BusinessDay } from './ledger.js';
import { cellOf } from './geo.js';

export const MAP_CELL_KM = 1.5;

/** 내가 공유한 콜 출발지가 채운 칸들 [{i,j,count}] (지도 표시와 배지가 같은 기준을 씁니다) */
export function mineCells(calls, cellKm = MAP_CELL_KM) {
  const m = new Map();
  for (const c of calls) {
    if (c.shareState !== 'shared' || !c.startPos) continue;
    const cell = cellOf(c.startPos, cellKm);
    const k = `${cell.i}:${cell.j}`;
    const e = m.get(k);
    if (e) e.count++;
    else m.set(k, { ...cell, count: 1 });
  }
  return [...m.values()];
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const XP = { card: 10, manualCard: 4, shared: 5, expense: 3, cardPerDay: 30, expensePerDay: 10, maxAgeDays: 60 };

// 레벨 시작 경험치. 마지막 이후로는 레벨마다 600씩 늘어요.
const STEPS = [0, 30, 80, 150, 250, 400, 600, 850, 1150, 1500, 2000];
const NAMES = ['초행길', '골목길', '동네길', '시내도로', '국도', '간선도로', '고속도로', '야간 운행가', '콜밭 지킴이', '도로의 베테랑'];

export function levelOf(xp) {
  let lv = 1;
  while (true) {
    const next = lv < STEPS.length ? STEPS[lv] : STEPS.at(-1) + (lv - STEPS.length + 1) * 600;
    if (xp < next) {
      const start = STEPS[lv - 1] ?? STEPS.at(-1) + (lv - STEPS.length) * 600;
      return { level: lv, name: NAMES[lv - 1] ?? NAMES.at(-1), start, next, into: xp - start, span: next - start };
    }
    lv++;
  }
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shiftDay = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n, 12));
};

/**
 * @param {Array} calls 일지의 콜
 * @param {Array} expenses 지출
 * @param {{now?:number, cutoffHour?:number}} ctx
 */
export function gameState(calls, expenses, { now = Date.now(), cutoffHour = 6 } = {}) {
  const dayOf = (t) => BusinessDay.dateOf(t, cutoffHour);
  const today = dayOf(now);
  const fresh = (c) => Number.isFinite(c.at) && c.at >= now - XP.maxAgeDays * DAY && c.at <= now + HOUR;

  // 하루 상한을 지키며 경험치 계산
  const perDay = new Map(); // `${kind}|${day}` → 개수
  const take = (kind, day, cap) => {
    const k = `${kind}|${day}`;
    const n = perDay.get(k) ?? 0;
    if (n >= cap) return false;
    perDay.set(k, n + 1);
    return true;
  };
  let xp = 0;
  const sorted = [...calls].sort((a, b) => a.at - b.at);
  let validCards = 0;
  for (const c of sorted) {
    if (!fresh(c) || !take('card', dayOf(c.at), XP.cardPerDay)) continue;
    validCards++;
    xp += c.source === 'manual' ? XP.manualCard : XP.card;
    if (c.shareState === 'shared') xp += XP.shared;
  }
  let validExpenses = 0;
  for (const e of [...expenses].sort((a, b) => a.at - b.at)) {
    if (!Number.isFinite(e.at) || e.at < now - XP.maxAgeDays * DAY || e.at > now + HOUR || !take('exp', dayOf(e.at), XP.expensePerDay)) continue;
    validExpenses++;
    xp += XP.expense;
  }

  // 연속 기록: 콜이나 지출이 한 건이라도 있는 영업일이 이어진 날 수
  const active = new Set([...calls.filter((c) => Number.isFinite(c.at)).map((c) => dayOf(c.at)), ...expenses.filter((e) => Number.isFinite(e.at)).map((e) => dayOf(e.at))]);
  let streak = 0;
  for (let d = active.has(today) ? today : shiftDay(today, -1); active.has(d); d = shiftDay(d, -1)) streak++;
  let best = 0;
  for (const d of active) {
    if (active.has(shiftDay(d, -1))) continue; // 연속 구간의 첫 날만 시작점
    let n = 0;
    for (let x = d; active.has(x); x = shiftDay(x, 1)) n++;
    best = Math.max(best, n);
  }

  // 오늘의 미션 (영업일 기준)
  const todayCalls = calls.filter((c) => Number.isFinite(c.at) && dayOf(c.at) === today);
  const mission = (key, label, have, need) => ({ key, label, have: Math.min(have, need), need, done: have >= need });
  const missions = [
    mission('cards', '콜카드', todayCalls.length, 3),
    mission('expense', '지출', expenses.filter((e) => Number.isFinite(e.at) && dayOf(e.at) === today).length, 1),
    mission('share', '공유', todayCalls.filter((c) => c.shareState === 'shared').length, 1),
  ];

  // 지도 기여: 내가 공유한 콜 출발지가 채운 1.5km 칸 수
  const cells = mineCells(calls);
  const shared = calls.filter((c) => c.shareState === 'shared').length;
  const night = calls.filter((c) => Number.isFinite(c.at) && new Date(c.at).getHours() < 5).length;

  const badge = (key, num, caption, have, need) => ({ key, num, caption, have: Math.min(have, need), need, earned: have >= need });
  const badges = [
    badge('c1', '1', '첫 콜카드', calls.length, 1),
    badge('c10', '10', '콜카드 10건', calls.length, 10),
    badge('c50', '50', '콜카드 50건', calls.length, 50),
    badge('c100', '100', '콜카드 100건', calls.length, 100),
    badge('c300', '300', '콜카드 300건', calls.length, 300),
    badge('s1', '1', '첫 공유', shared, 1),
    badge('s30', '30', '공유 30건', shared, 30),
    badge('m10', '10', '지도 10칸', cells.length, 10),
    badge('d3', '3일', '3일 연속', best, 3),
    badge('d7', '7일', '7일 연속', best, 7),
    badge('d30', '30일', '30일 연속', best, 30),
    badge('e7', '7', '지출 7건', expenses.length, 7),
    badge('n10', '밤10', '심야 콜 10건', night, 10),
  ];

  return { xp, ...levelOf(xp), streak, bestStreak: best, missions, missionsDone: missions.filter((m) => m.done).length, badges, earned: badges.filter((b) => b.earned).length, mapCells: cells.length, validCards, validExpenses, today };
}
