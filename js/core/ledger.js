// 정산·영업일·통계 계산 (안드로이드 core 의 Settler / Stats 의 JS 버전)
// 날짜는 모두 "기기의 현지 시간" 기준이며, 영업일은 'YYYY-MM-DD' 문자열로 표현합니다.

/** 요금과 수수료 정산. 콜카드의 금액 > 콜카드의 비율 > 설정 수수료율 순으로 씁니다. */
export function settle(fare, cardFee, cardRatePercent, defaultRatePercent) {
  const pct = (p) => Math.round((fare * p) / 100);
  if (cardFee != null && cardFee >= 0 && cardFee <= fare) {
    return { fare, fee: cardFee, source: 'card_amount', estimated: false, net: fare - cardFee };
  }
  if (cardRatePercent != null && cardRatePercent >= 0 && cardRatePercent <= 100) {
    const fee = pct(cardRatePercent);
    return { fare, fee, source: 'card_rate', estimated: false, net: fare - fee };
  }
  const fee = pct(Math.min(100, Math.max(0, defaultRatePercent)));
  return { fare, fee, source: 'default_rate', estimated: true, net: fare - fee };
}

/**
 * 일지에서 요금/수수료를 고칠 때의 수수료 결정.
 * - 수수료칸을 비우면 설정 수수료율로 다시 계산
 * - 예상 수수료를 그대로 둔 채 요금만 고치면 새 요금에 맞춰 다시 계산
 */
export function resolveEditedFee({ fare, feeInput, initial, rateFor }) {
  const auto = settle(fare, null, null, rateFor).fee;
  const recompute =
    feeInput == null || (initial != null && initial.feeEstimated && feeInput === initial.fee && fare !== initial.fare);
  return recompute ? { fee: auto, feeEstimated: true } : { fee: feeInput, feeEstimated: false };
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => s.split('-').map(Number);

/**
 * 대리기사는 자정을 넘겨 일하므로 "하루"를 새벽 cutoffHour 시 기준 영업일로 계산합니다.
 * 예: 기준 6시면 10/12 02:00 의 콜은 10/11 영업일에 들어갑니다.
 */
export const BusinessDay = {
  dateOf(epochMs, cutoffHour) {
    const d = new Date(epochMs);
    d.setHours(d.getHours() - cutoffHour);
    return ymd(d);
  },
  rangeOf(dateStr, cutoffHour) {
    const [y, m, d] = parseYmd(dateStr);
    return {
      start: new Date(y, m - 1, d, cutoffHour, 0, 0, 0).getTime(),
      end: new Date(y, m - 1, d + 1, cutoffHour, 0, 0, 0).getTime(),
    };
  },
  rangeFor(epochMs, cutoffHour) {
    return this.rangeOf(this.dateOf(epochMs, cutoffHour), cutoffHour);
  },
  /** month: 1~12 */
  monthRange(year, month, cutoffHour) {
    return {
      start: new Date(year, month - 1, 1, cutoffHour, 0, 0, 0).getTime(),
      end: new Date(year, month, 1, cutoffHour, 0, 0, 0).getTime(),
    };
  },
};

export const EMPTY_SUMMARY = Object.freeze(makeSummary(0, 0, 0, 0, 0));

/**
 * 기간 요약. 용어:
 * - 총수입 = 요금 합계 / 정산액 = 총수입 - 수수료 / 순수익 = 정산액 - 지출
 */
function makeSummary(count, totalFare, totalFee, expenses, workedMillis) {
  const afterFee = totalFare - totalFee;
  const profit = afterFee - expenses;
  return {
    count,
    totalFare,
    totalFee,
    expenses,
    workedMillis,
    afterFee,
    profit,
    // 시간당 순수익(원/h). 근무 기록이 1분 미만이면 null
    hourlyProfit: workedMillis < 60_000 ? null : Math.round((profit * 3_600_000) / workedMillis),
  };
}

const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

export function summarize(calls, expenses, sessions, range, now) {
  const inRange = (t) => t >= range.start && t < range.end;
  const c = calls.filter((x) => inRange(x.at));
  const e = expenses.filter((x) => inRange(x.at));
  const worked = sum(sessions, (s) => {
    const a = Math.max(s.start, range.start);
    const b = Math.min(s.end ?? now, range.end);
    return Math.max(0, b - a);
  });
  return makeSummary(c.length, sum(c, (x) => x.fare), sum(c, (x) => x.fee), sum(e, (x) => x.amount), worked);
}

/** 영업일별 요약(근무시간 제외), 최신 날짜가 먼저 옵니다. 반환: [{date, summary}] */
export function byDay(calls, expenses, cutoffHour) {
  const group = (items) => {
    const m = new Map();
    for (const it of items) {
      const k = BusinessDay.dateOf(it.at, cutoffHour);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(it);
    }
    return m;
  };
  const cg = group(calls);
  const eg = group(expenses);
  return [...new Set([...cg.keys(), ...eg.keys()])]
    .sort()
    .reverse()
    .map((date) => {
      const cs = cg.get(date) ?? [];
      const es = eg.get(date) ?? [];
      return {
        date,
        summary: makeSummary(cs.length, sum(cs, (x) => x.fare), sum(cs, (x) => x.fee), sum(es, (x) => x.amount), 0),
      };
    });
}
