// "이 콜 잡을까?" 판정: 요금에서 수수료를 빼고, 도착지에서 다음 콜까지 기다리는 시간과 빠져나오는 비용까지
// 반영해 "이 콜의 실질 시간당 순수익"을 계산합니다. 숫자는 모두 추정이라 근거(측정/추정)를 함께 돌려줘요.

export const JUDGE = {
  tripMinPerWon: 1 / 900, // 요금으로 운행시간을 어림: 요금 ÷ 900원 = 분 (측정값이 없을 때만)
  tripMinRange: [15, 90],
  // 대기 측정값이 없을 때 쓰는 기본 추정(분) — 착지 평가 단계별
  fallbackWait: { hot: 10, normal: 20, remote: 45, unknown: 25 },
  taxiBase: 4800, // 택시 기본요금(원)
  taxiPerKm: 1100, // 심야 할증 감안한 km당 어림값
  exitSpeedKmh: 30,
  defaultBenchmark: 15000, // 내 평균을 모를 때 비교 기준(원/시간)
  goRatio: 1.15, // 기준의 115% 이상이면 "잡아요"
  passRatio: 0.85, // 85% 미만이면 "패스"
};

const roundTo = (n, unit) => Math.round(n / unit) * unit;

/**
 * @param {{
 *   fare:number, feeRate:number,                 // 요금(원), 수수료율(%)
 *   tripMin?:number,                             // 운행시간(분). 없으면 요금으로 어림
 *   level:'hot'|'normal'|'remote'|'unknown',     // 착지 평가
 *   exitKm?:number|null,                         // 가장 가까운 콜밭까지 거리(km)
 *   wait?:{minutes:number,n:number}|null,        // 측정된 예상 대기
 *   benchmark?:number|null                       // 내 평균 시간당 순수익
 * }} i
 */
export function judgeCall(i, o = JUDGE) {
  const fare = Math.max(0, Math.round(i.fare));
  const fee = Math.round((fare * Math.min(100, Math.max(0, i.feeRate))) / 100);
  const net = fare - fee;
  const [lo, hi] = o.tripMinRange;
  const tripMin = i.tripMin ?? Math.min(hi, Math.max(lo, Math.round(fare * o.tripMinPerWon)));

  const measured = Boolean(i.wait);
  const waitMin = measured ? i.wait.minutes : o.fallbackWait[i.level] ?? o.fallbackWait.unknown;

  // 오지면 콜밭까지 빠져나와야 하니 택시비와 이동시간을 더합니다
  let returnCost = 0;
  let returnMin = 0;
  if (i.level === 'remote') {
    const km = i.exitKm ?? 8;
    returnCost = roundTo(o.taxiBase + km * o.taxiPerKm, 100);
    returnMin = Math.round((km / o.exitSpeedKmh) * 60) + 5;
  }

  const totalMin = tripMin + waitMin + returnMin;
  const hourly = Math.round((net - returnCost) / (totalMin / 60));
  const ownBench = i.benchmark != null && i.benchmark > 0;
  const bench = ownBench ? i.benchmark : o.defaultBenchmark;
  const ratio = hourly / bench;
  const verdict = ratio >= o.goRatio ? 'go' : ratio < o.passRatio ? 'pass' : 'ok';
  return {
    verdict,
    hourly: roundTo(hourly, 100),
    net,
    fee,
    tripMin,
    waitMin,
    waitBasis: measured ? 'measured' : 'estimated',
    waitSamples: measured ? i.wait.n : 0,
    returnCost,
    returnMin,
    benchmark: bench,
    benchmarkBasis: ownBench ? 'own' : 'default',
  };
}

/** 최근 days일간 내 평균 시간당 순수익. 근무 5시간 미만이면 null(표본이 너무 적음) */
export function ownBenchmark(summary) {
  if (!summary || summary.hourlyProfit == null || summary.workedMillis < 5 * 3_600_000 || summary.count < 5) return null;
  return summary.hourlyProfit;
}
