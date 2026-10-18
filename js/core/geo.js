// 지도 계산에 쓰는 순수 함수 모음 (화면·네트워크와 무관해서 테스트하기 쉽습니다).

const EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;
// 한국 위도(약 36°)에서 경도 1°의 길이 비율. 격자 크기를 대략 정사각형으로 맞추는 데만 씁니다.
const LNG_SCALE = Math.cos(rad(36));
const KM_PER_DEG = 111.32;

export function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 대한민국 안의 좌표인지 (잘못된 지오코딩 결과를 걸러냅니다) */
export function inKorea(p) {
  return Number.isFinite(p?.lat) && Number.isFinite(p?.lng) && p.lat >= 33 && p.lat <= 38.9 && p.lng >= 124.5 && p.lng <= 131.9;
}

/** 격자 칸 번호. cellKm 크기의 칸으로 지도를 나눕니다. */
export function cellOf(p, cellKm) {
  const latStep = cellKm / KM_PER_DEG;
  const lngStep = cellKm / (KM_PER_DEG * LNG_SCALE);
  return { i: Math.floor(p.lat / latStep), j: Math.floor(p.lng / lngStep) };
}
export const cellKey = (p, cellKm) => {
  const c = cellOf(p, cellKm);
  return `${c.i}:${c.j}`;
};

/** 공유용으로 좌표를 약 100m 단위로 뭉갭니다 (소수 셋째 자리). */
export const roundPos = (p, digits = 3) => ({ lat: Number(p.lat.toFixed(digits)), lng: Number(p.lng.toFixed(digits)) });

export const hourOf = (ms) => {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60;
};

/** 0~24 시각 사이의 원형 거리 (23시와 1시는 2시간 차이) */
export function circularHourDiff(a, b) {
  const d = Math.abs(a - b) % 24;
  return d > 12 ? 24 - d : d;
}

/** 평일/주말 구분. 새벽 6시 전은 전날 영업으로 봅니다 (금요일 밤 1시 콜 = 금요일). */
export function dayTypeOf(ms) {
  const day = new Date(ms - 6 * 3_600_000).getDay();
  return day === 0 || day === 6 ? 'weekend' : 'weekday';
}

/** 주소 한 줄에서 "시/구/동" 수준까지만 남깁니다. 공유 문구에 상세 주소가 들어가지 않게 하려는 용도. */
export function roughPlace(addr, tokens = 3) {
  if (!addr) return '';
  const parts = addr
    .replace(/\([^)]*\)?/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const keep = [];
  for (const t of parts) {
    if (/\d/.test(t) && /^\d+(-\d+)?$/.test(t)) break;
    keep.push(t);
  }
  // 맨 앞의 도/광역시 이름("경기", "서울특별시")은 빼고 시·구·동 위주로
  const PROV = /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(특별시|광역시|특별자치시|특별자치도|도)?$/;
  const body = PROV.test(keep[0] ?? '') ? keep.slice(1) : keep;
  return body.slice(0, tokens).join(' ');
}
