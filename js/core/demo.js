// 테스트용 가짜 콜 위치 만들기. 실제 데이터가 아니라 "지도가 어떻게 보이는지" 확인하려는 용도입니다.
// 항상 같은 결과가 나오도록 고정된 난수(시드)를 씁니다.

const HUBS = [
  // [이름, 위도, 경도, 가중치, 피크 시각(시)]
  ['강남역', 37.4979, 127.0276, 10, 23],
  ['홍대입구', 37.5563, 126.9236, 8, 0],
  ['건대입구', 37.5404, 127.0692, 5, 23],
  ['잠실', 37.5133, 127.1002, 5, 22],
  ['수원 인계동', 37.2636, 127.0286, 7, 23],
  ['분당 서현', 37.3846, 127.123, 5, 22],
  ['수지', 37.3224, 127.0953, 3, 22],
  ['안양 범계', 37.3897, 126.9506, 4, 23],
  ['부천 상동', 37.5035, 126.7531, 4, 23],
  ['일산 라페스타', 37.6575, 126.7697, 3, 23],
  ['동탄', 37.2005, 127.0975, 3, 22],
];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** @returns {Array<{lat:number,lng:number,t:number,k:'s'|'e',label:string}>} */
export function makeDemoPoints({ now = Date.now(), count = 300, days = 21, seed = 7 } = {}) {
  const rand = rng(seed);
  const total = HUBS.reduce((a, h) => a + h[3], 0);
  const out = [];
  for (let i = 0; i < count; i++) {
    let r = rand() * total;
    const hub = HUBS.find((h) => (r -= h[3]) < 0) ?? HUBS[0];
    const hour = (hub[4] + (rand() + rand() + rand() - 1.5) * 3 + 24) % 24; // 피크 시각 주변에 몰리게
    const day = Math.floor(rand() * days);
    const d = new Date(now);
    d.setDate(d.getDate() - day);
    d.setHours(Math.floor(hour), Math.floor((hour % 1) * 60), 0, 0);
    // 허브 중심에서 반경 1.5km 안쪽에 흩뿌립니다
    const ang = rand() * Math.PI * 2;
    const dist = Math.sqrt(rand()) * 0.014;
    out.push({
      lat: Number((hub[1] + Math.sin(ang) * dist).toFixed(3)),
      lng: Number((hub[2] + (Math.cos(ang) * dist) / 0.8).toFixed(3)),
      t: Math.floor(d.getTime() / 3_600_000) * 3_600_000,
      k: 's',
      label: hub[0],
    });
  }
  return out;
}
