// 콜 위치 공유 파일. 다른 기사와 주고받는 것은 "어디서 언제쯤 콜이 났는지"뿐입니다.
//  - 좌표는 약 100m 단위로 뭉개고, 시각은 시(hour) 단위로 내림합니다.
//  - 요금·고객 이름·전화번호·상세 주소·이미지는 들어가지 않습니다.

import { inKorea, roundPos } from './geo.js';

const HOUR = 3_600_000;
export const PACK_TYPE = 'call-points';

/** 내 콜 기록(좌표가 있는 것)을 공유용 점 목록으로 바꿉니다 */
export function buildPack(calls, now = Date.now()) {
  const points = [];
  for (const c of calls) {
    for (const [pos, k] of [[c.startPos, 's'], [c.endPos, 'e']]) {
      if (!pos || !inKorea(pos)) continue;
      const r = roundPos(pos);
      points.push({ lat: r.lat, lng: r.lng, t: Math.floor(c.at / HOUR) * HOUR, k });
    }
  }
  return { app: 'call-assistant-web', type: PACK_TYPE, version: 1, exportedAt: now, points };
}

/** 받은 파일 내용을 검증해 쓸 수 있는 점만 돌려줍니다. 잘못된 파일이면 오류를 던집니다. */
export function parsePack(text, { max = 20000 } = {}) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('JSON 파일이 아니에요');
  }
  if (obj?.type !== PACK_TYPE || !Array.isArray(obj.points)) throw new Error('콜 위치 공유 파일이 아니에요 (백업 파일과 달라요)');
  const out = [];
  for (const p of obj.points.slice(0, max)) {
    if ((p.k !== 's' && p.k !== 'e') || !Number.isFinite(p.t) || !inKorea(p)) continue;
    out.push({ lat: Number(p.lat), lng: Number(p.lng), t: Number(p.t), k: p.k });
  }
  return { points: out, skipped: Math.min(obj.points.length, max) - out.length, truncated: obj.points.length > max };
}

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 서버로 올릴 점 하나 (출발지만). 좌표는 서버에서도 한 번 더 뭉갭니다. */
export function toSharePoint(call) {
  const r = roundPos(call.startPos);
  return { lat: r.lat, lng: r.lng, t: Math.floor(call.at / HOUR) * HOUR, k: 's' };
}

/** 공유 전에 사용자에게 보여줄 "정확히 무엇이 나가는지" 문구 재료 */
export function previewOf(call, roughPlace) {
  const d = new Date(call.at);
  return {
    place: roughPlace(call.startAddr) || '출발지',
    when: `${d.getMonth() + 1}/${d.getDate()}(${DAYS[d.getDay()]}) ${d.getHours()}시대`,
  };
}

export const MAX_AGE_DAYS = 60; // 서버 규칙은 90일까지 받지만, 앱은 여유를 두고 60일까지만 공유합니다.

/** 이 콜을 공유할 수 있는지: 'ok' | 'old'(너무 오래됨) | 'future'(미래 시각) | 'nopos'(좌표 없음) */
export function shareability(call, now = Date.now()) {
  if (call.at < now - MAX_AGE_DAYS * 24 * HOUR) return 'old';
  if (call.at > now + HOUR) return 'future';
  return 'ok';
}
