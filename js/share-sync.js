// 공유 서버와 주고받는 부분. 서버 주소는 설정에서 바꿀 수 있고, 비워 두면 이 화면을 내려준 서버(같은 주소)를 씁니다.

import { createFirebaseShare } from './share-firebase.js';
import { firebaseConfig } from './firebase-config.js';

const TIMEOUT_MS = 8000;
const FB_KEY = 'call-assistant-fb'; // 로그인 토큰. 백업 파일에는 넣지 않으려고 따로 저장합니다.
const fbStorage = {
  get() {
    try {
      return JSON.parse(localStorage.getItem(FB_KEY));
    } catch {
      return null;
    }
  },
  set(v) {
    try {
      localStorage.setItem(FB_KEY, JSON.stringify(v));
    } catch {
      /* 저장 불가 환경 */
    }
  },
};
export const firebase = createFirebaseShare({ config: firebaseConfig, storage: fbStorage });

/**
 * Firebase 설정(js/firebase-config.js)이 채워져 있으면 Firebase 를 씁니다.
 * 직접 만든 서버는 "서버 주소를 직접 적었을 때"나 내 컴퓨터(localhost)에서 실행할 때만 씁니다.
 * (Cloudflare Pages 같은 정적 배포 주소에는 공유 서버가 없어서 405 오류가 났습니다)
 */
const isLocal = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
export const backendOf = (settings) => {
  if (!firebase.configured()) return 'server';
  if (settings.shareBackend !== 'server') return 'firebase';
  if (isLocal()) return 'server';
  // 서버 주소가 비었거나 이 사이트 주소와 같으면(정적 배포라 공유 서버가 없음) Firebase 로 보냅니다.
  const own = (settings.shareServer || '').trim().replace(/\/+$/, '');
  return own && own !== location.origin ? 'server' : 'firebase';
};

export const serverBase = (settings) => (settings.shareServer || '').trim().replace(/\/+$/, '') || location.origin;

async function call(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* JSON 아님 */
    }
    if (res.status === 404 || res.status === 405 || (res.ok && body == null)) {
      throw new Error('이 주소에는 공유 서버가 없어요. 설정 → 공유에서 서버 주소를 확인하세요');
    }
    if (!res.ok) throw new Error(body?.error ?? `공유 서버 오류 (${res.status})`);
    return body;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('공유 서버가 응답하지 않아요');
    if (e instanceof TypeError) throw new Error('공유 서버에 연결하지 못했어요 (인터넷·주소 확인)');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function push(base, cid, points) {
  return call(`${base}/api/points`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cid, points }) });
}

/** 다른 기사들이 올린 점 (내가 올린 것은 서버가 빼고 줍니다) */
export async function pull(base, cid) {
  const body = await call(`${base}/api/points?exclude=${encodeURIComponent(cid)}&days=60`);
  return Array.isArray(body.points) ? body.points : [];
}

/** 어느 쪽이든 같은 모양으로: 올리기 */
export async function sharePush(settings, cid, points) {
  if (backendOf(settings) === 'firebase') return firebase.push(points);
  return push(serverBase(settings), cid, points);
}

/** 가져오기. firebase 는 새 점만(merge), 서버는 전체(replace) */
export async function sharePull(settings, cid, cursor) {
  if (backendOf(settings) === 'firebase') {
    const r = await firebase.pull(cursor);
    return { mode: 'merge', points: r.points, cursor: r.cursor };
  }
  return { mode: 'replace', points: await pull(serverBase(settings), cid), cursor: null };
}
