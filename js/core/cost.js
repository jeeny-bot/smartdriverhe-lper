// 내 실질 비용률: 수수료만이 아니라 월 프로그램비·보험료까지 합쳐서 "매출 100원 중 몇 원이 비용으로 나가는지"를 계산합니다.
//  - 수수료: 일지의 콜별 수수료 합계 (이미 정산된 값)
//  - 월 프로그램비: 그 달에 한 번이라도 쓴 플랫폼에 설정한 금액만 더합니다 (안 쓴 플랫폼은 제외)
//  - 월 보험료: 매출이 있는 달에 한 번만 더합니다. 플랫폼과 무관해서 플랫폼 비교에는 넣지 않아요.

const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const money = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/**
 * @param {Array<{platform?:string,fare:number,fee:number,at:number}>} calls 이미 기간으로 거른 콜
 * @param {{programFees?:Record<string,number>, insuranceMonthly?:number}} fixed
 */
export function costBreakdown(calls, fixed = {}) {
  const groups = new Map();
  for (const c of calls) {
    const k = c.platform || 'unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const platforms = [...groups].map(([key, cs]) => {
    const revenue = sum(cs, (c) => c.fare);
    const fee = sum(cs, (c) => c.fee);
    const program = money(fixed.programFees?.[key]);
    return { key, count: cs.length, revenue, fee, program, rate: revenue > 0 ? (fee + program) / revenue : 0, avgFee: cs.length ? Math.round(fee / cs.length) : 0 };
  });
  platforms.sort((a, b) => a.rate - b.rate);

  const revenue = sum(platforms, (p) => p.revenue);
  const fee = sum(platforms, (p) => p.fee);
  const program = sum(platforms, (p) => p.program);
  const insurance = revenue > 0 ? money(fixed.insuranceMonthly) : 0;
  const total = fee + program + insurance;
  const rate = revenue > 0 ? total / revenue : 0;

  // 같은 매출이라면 가장 비싼 곳이 가장 싼 곳 수준이었을 때 아낄 금액 (표본이 3건 미만인 플랫폼은 비교에서 뺌)
  const comparable = platforms.filter((p) => p.count >= 3 && p.revenue > 0);
  let gap = null;
  if (comparable.length >= 2) {
    const best = comparable[0];
    const worst = comparable.at(-1);
    const diff = Math.round((worst.rate - best.rate) * worst.revenue);
    if (diff > 0) gap = { best: best.key, worst: worst.key, won: diff, pts: (worst.rate - best.rate) * 100 };
  }
  return {
    revenue,
    fee,
    program,
    insurance,
    total,
    rate,
    keep: revenue > 0 ? Math.round((1 - rate) * 100) : null, // 매출 100원당 남는 원
    hasFixed: program > 0 || insurance > 0,
    platforms,
    gap,
  };
}
