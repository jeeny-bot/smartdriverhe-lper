// 주소 → 좌표 변환. 제공자를 바꿔 끼울 수 있게 해 두었습니다.
//  - nominatim: OpenStreetMap 무료 검색. 키가 필요 없지만 초당 1회 제한이 있고, 한국 상세 번지는 잘 못 찾아서
//               "자세한 주소 → 대략적인 주소" 순서로 여러 번 시도합니다. (동·읍·면 수준이면 대부분 찾습니다)
//  - kakao: 카카오 로컬 REST API. 키가 필요하고 정확하지만, 브라우저에서 직접 부를 때 막히면(CORS) 서버를 거쳐야 합니다.
// 같은 주소는 다시 묻지 않도록 결과를 저장소에 기억합니다.

import { addressCandidates } from './core/address.js';
import { inKorea } from './core/geo.js';

const MIN_GAP_MS = 1100; // nominatim 이용 규칙: 초당 1회 이하
let lastCall = 0;
let chain = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 요청을 한 줄로 세워 간격을 지킵니다 */
function throttled(fn) {
  const run = async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastCall = Date.now();
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

async function nominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=kr&accept-language=ko&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`지도 검색 서버 응답 오류 (${res.status})`);
  const arr = await res.json();
  const hit = arr?.[0];
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
}

async function kakao(query, key) {
  const res = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?size=1&query=${encodeURIComponent(query)}`, {
    headers: { Authorization: `KakaoAK ${key}` },
  });
  if (!res.ok) throw new Error(`카카오 검색 오류 (${res.status}) — 키와 도메인 등록을 확인하세요`);
  const doc = (await res.json())?.documents?.[0];
  if (doc) return { lat: Number(doc.y), lng: Number(doc.x) };
  // 주소 검색에 안 잡히면 키워드(건물명 등)로 한 번 더
  const res2 = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?size=1&query=${encodeURIComponent(query)}`, {
    headers: { Authorization: `KakaoAK ${key}` },
  });
  const doc2 = res2.ok ? (await res2.json())?.documents?.[0] : null;
  return doc2 ? { lat: Number(doc2.y), lng: Number(doc2.x) } : null;
}

/**
 * @param {string} addr 콜카드 주소
 * @param {{geocoder?:string,kakaoKey?:string}} settings
 * @param {{provider?:(q:string)=>Promise<{lat:number,lng:number}|null>}} [hooks] 테스트용 대체 제공자
 * @returns {Promise<{lat:number,lng:number,level:number}|null>} level: 몇 번째 후보에서 찾았는지(0이 가장 정확)
 */
export async function geocode(addr, settings = {}, hooks = {}) {
  const candidates = addressCandidates(addr);
  // 직접 입력한 짧은 이름("정자동", "강남역")은 후보가 안 만들어지므로 입력 그대로도 한 번 시도합니다.
  const raw = String(addr ?? '').trim();
  if (hooks.rawFallback && raw && !candidates.includes(raw)) candidates.push(raw);
  const provider =
    hooks.provider ??
    (settings.geocoder === 'kakao' && settings.kakaoKey
      ? (q) => throttled(() => kakao(q, settings.kakaoKey))
      : (q) => throttled(() => nominatim(q)));
  for (let i = 0; i < candidates.length; i++) {
    const pos = await provider(candidates[i]);
    if (pos && inKorea(pos)) return { ...pos, level: i };
  }
  return null;
}
