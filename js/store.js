// 일지 데이터 저장소. 브라우저(localStorage)에만 저장하며 서버로 보내지 않습니다.
// localStorage 를 쓸 수 없는 환경(시크릿 창 등)에서는 메모리에만 저장하고 화면에 경고를 띄웁니다.

const KEY = 'call-assistant-v1';

const DEFAULT_SETTINGS = {
  defaultFeeRate: 20, // 임의의 초기값입니다. 본인의 실제 수수료율로 바꿔 주세요.
  platformRates: {}, // { kakao: 18, ... }
  cutoffHour: 6, // 영업일이 바뀌는 새벽 시각
  geocoder: 'nominatim', // 주소→좌표 제공자: nominatim | kakao
  kakaoKey: '',
  taxiUrl: 'kakaot://', // 택시 호출 앱 열기 주소 (카카오T 기본). 실제 폰에서 확인 후 바꾸세요.
  shareMode: 'ask', // ask: 콜마다 물어보기 | auto: 자동 공유 | off: 보내지 않기(받기만)
  shareServer: '', // 비우면 이 화면을 내려준 서버
  geoConsent: false, // 주소를 외부 지도 검색 서버로 보내 좌표로 바꿔도 되는지 (처음엔 꺼짐)
  showShared: false, // 다른 기사님이 공유한 콜(과 테스트·파일 데이터)을 지도·추천에 보여줄지. 꺼져 있으면 내 콜만 씁니다
};

function emptyState() {
  return { calls: [], expenses: [], sessions: [], sharedPoints: [], geoCache: {}, shareMeta: {}, settings: { ...DEFAULT_SETTINGS }, nextId: 1 };
}

let persistent = true;
let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    return normalize(JSON.parse(raw));
  } catch {
    persistent = false;
    return emptyState();
  }
}

function normalize(obj) {
  const base = emptyState();
  return {
    calls: Array.isArray(obj.calls) ? obj.calls : base.calls,
    expenses: Array.isArray(obj.expenses) ? obj.expenses : base.expenses,
    sessions: Array.isArray(obj.sessions) ? obj.sessions : base.sessions,
    sharedPoints: Array.isArray(obj.sharedPoints) ? obj.sharedPoints : base.sharedPoints,
    geoCache: obj.geoCache && typeof obj.geoCache === 'object' ? obj.geoCache : base.geoCache,
    shareMeta: obj.shareMeta && typeof obj.shareMeta === 'object' ? obj.shareMeta : base.shareMeta,
    settings: { ...DEFAULT_SETTINGS, ...(obj.settings ?? {}) },
    nextId: Number.isInteger(obj.nextId) ? obj.nextId : 1,
  };
}

function commit() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    persistent = false;
  }
  listeners.forEach((fn) => fn(state));
}

export const store = {
  get state() {
    return state;
  },
  get persistent() {
    return persistent;
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** 같은 이미지(해시)를 이미 저장했으면 null */
  addCall(call) {
    if (call.imgHash && state.calls.some((c) => c.imgHash === call.imgHash)) return null;
    const rec = { ...call, id: state.nextId++ };
    state.calls.push(rec);
    commit();
    return rec;
  },
  hasImage(hash) {
    return state.calls.some((c) => c.imgHash === hash);
  },
  updateCall(id, patch) {
    const i = state.calls.findIndex((c) => c.id === id);
    if (i < 0) return;
    state.calls[i] = { ...state.calls[i], ...patch };
    commit();
  },
  deleteCall(id) {
    state.calls = state.calls.filter((c) => c.id !== id);
    commit();
  },

  addExpense(e) {
    state.expenses.push({ ...e, id: state.nextId++ });
    commit();
  },
  deleteExpense(id) {
    state.expenses = state.expenses.filter((e) => e.id !== id);
    commit();
  },

  /** 출근 중이면 퇴근, 아니면 출근 */
  toggleWork(now = Date.now()) {
    const open = state.sessions.find((s) => s.end == null);
    if (open) open.end = now;
    else state.sessions.push({ id: state.nextId++, start: now, end: null });
    commit();
  },
  isWorking() {
    return state.sessions.some((s) => s.end == null);
  },

  setSettings(patch) {
    state.settings = { ...state.settings, ...patch };
    commit();
  },
  setPlatformRate(key, percent) {
    const rates = { ...state.settings.platformRates };
    if (percent == null) delete rates[key];
    else rates[key] = percent;
    state.settings = { ...state.settings, platformRates: rates };
    commit();
  },
  rateFor(platformKey) {
    return state.settings.platformRates[platformKey] ?? state.settings.defaultFeeRate;
  },

  // ---------- 지도 데이터 ----------
  /** 주소→좌표 캐시. 실패(null)도 기억해서 같은 주소를 계속 묻지 않게 합니다. */
  geoGet(addr) {
    return Object.hasOwn(state.geoCache, addr) ? { hit: true, pos: state.geoCache[addr] } : { hit: false, pos: null };
  },
  geoSet(addr, pos) {
    const keys = Object.keys(state.geoCache);
    if (keys.length > 3000) for (const k of keys.slice(0, 500)) delete state.geoCache[k];
    state.geoCache[addr] = pos ? { lat: pos.lat, lng: pos.lng, level: pos.level ?? 0 } : null;
    commit();
  },
  /** 공유받은/테스트 점을 추가합니다. 같은 점(위치·시각·종류)은 한 번만. */
  addSharedPoints(points, src = 'shared') {
    const seen = new Set(state.sharedPoints.map((p) => `${p.lat},${p.lng},${p.t},${p.k}`));
    let added = 0;
    for (const p of points) {
      const key = `${p.lat},${p.lng},${p.t},${p.k}`;
      if (seen.has(key)) continue;
      seen.add(key);
      state.sharedPoints.push({ lat: p.lat, lng: p.lng, t: p.t, k: p.k, src, ...(p.label ? { label: p.label } : {}) });
      added++;
    }
    if (added) commit();
    return added;
  },
  /** 이 기기의 임의 번호. 서버가 "내가 올린 점"을 빼고 내려주는 데만 쓰고, 이름·전화번호와는 무관합니다. */
  ensureCid() {
    if (!state.shareMeta.cid) {
      const b = crypto.getRandomValues(new Uint8Array(12));
      state.shareMeta.cid = 'd' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      commit();
    }
    return state.shareMeta.cid;
  },
  setShareMeta(patch) {
    state.shareMeta = { ...state.shareMeta, ...patch };
    commit();
  },
  /** 새로 받은 점만 덧붙입니다(문서 번호 id 로 중복 제거). 60일이 지난 점은 지우고, 너무 많으면 오래된 것부터 줄입니다. */
  mergeShared(src, points, { maxAgeDays = 60, cap = 8000, now = Date.now() } = {}) {
    const have = new Set(state.sharedPoints.filter((p) => p.src === src && p.id).map((p) => p.id));
    for (const p of points) {
      if (p.id && have.has(p.id)) continue;
      have.add(p.id);
      state.sharedPoints.push({ lat: p.lat, lng: p.lng, t: p.t, k: p.k, id: p.id, src });
    }
    const min = now - maxAgeDays * 86_400_000;
    state.sharedPoints = state.sharedPoints.filter((p) => p.src !== src || p.t >= min);
    const mine = state.sharedPoints.filter((p) => p.src === src);
    if (mine.length > cap) {
      const drop = new Set(mine.sort((a, b) => a.t - b.t).slice(0, mine.length - cap));
      state.sharedPoints = state.sharedPoints.filter((p) => !drop.has(p));
    }
    commit();
  },
  /** 한 출처(src)의 공유 점을 통째로 바꿉니다 (서버에서 새로 받을 때) */
  replaceShared(src, points) {
    state.sharedPoints = state.sharedPoints.filter((p) => p.src !== src);
    for (const p of points) state.sharedPoints.push({ lat: p.lat, lng: p.lng, t: p.t, k: p.k, src });
    commit();
  },
  removeSharedBySource(src) {
    const before = state.sharedPoints.length;
    state.sharedPoints = state.sharedPoints.filter((p) => p.src !== src);
    if (state.sharedPoints.length !== before) commit();
    return before - state.sharedPoints.length;
  },

  exportJson() {
    return JSON.stringify({ app: 'call-assistant-web', version: 1, exportedAt: Date.now(), ...state }, null, 2);
  },
  importJson(text) {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.calls)) throw new Error('올바른 백업 파일이 아니에요');
    state = normalize(obj);
    commit();
  },
  clearAll() {
    state = emptyState();
    commit();
  },
};
