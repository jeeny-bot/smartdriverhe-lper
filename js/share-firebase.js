// Firebase(Firestore) 로 콜 위치를 공유합니다. 라이브러리 없이 REST 주소를 직접 부르는 방식이라 설치할 게 없어요.
//   로그인: 구글 (anonymous 옵션을 켜면 예전처럼 익명도 가능). 공유 문서에는 이메일·이름이 아니라 임의의 사용자 번호(uid)만 들어가요
//   저장:   Firestore 컬렉션 "points" — 문서 하나 = 콜 하나 { lat, lng, t, k:'s', u, up }
//           lat/lng 는 약 100m 단위, t 는 시(hour) 단위 시각, u 는 올린 사용자 번호, up 은 서버가 찍는 올린 시각
// 보안은 firestore.rules(규칙)가 맡습니다. apiKey 는 공개돼도 되는 값이에요 (규칙이 막아 줘요).

const DEFAULT_ENDPOINTS = {
  auth: 'https://identitytoolkit.googleapis.com/v1',
  token: 'https://securetoken.googleapis.com/v1',
  fs: 'https://firestore.googleapis.com/v1',
};
const PAGE = 1000;
const MAX_PAGES = 5;

export class ShareError extends Error {
  constructor(message, { code = '', hint = '' } = {}) {
    super(hint ? `${message} — ${hint}` : message);
    this.code = code;
  }
}

/** Google 오류 응답 → 초보자도 따라 할 수 있는 한국어 안내 */
export function explainError(status, body, where) {
  const e = body?.error ?? {};
  const msg = String(e.message ?? '');
  const st = String(e.status ?? '');
  const text = `${msg} ${st} ${JSON.stringify(e.details ?? '')}`;
  if (String(where).startsWith('이메일')) {
    if (/EMAIL_EXISTS/.test(text)) return new ShareError('이미 가입된 이메일이에요', { code: 'exists', hint: '로그인하거나 "비밀번호를 잊었어요"를 눌러 보세요' });
    if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND/.test(text)) return new ShareError('이메일 또는 비밀번호가 맞지 않아요', { code: 'cred' });
    if (/WEAK_PASSWORD/.test(text)) return new ShareError('비밀번호가 너무 약해요', { code: 'weak', hint: '6자 이상으로 만드세요' });
    if (/INVALID_EMAIL|MISSING_EMAIL/.test(text)) return new ShareError('이메일 주소를 확인해 주세요', { code: 'email' });
    if (/TOO_MANY_ATTEMPTS/.test(text)) return new ShareError('시도가 너무 많아요', { code: 'many', hint: '잠시 뒤에 다시 해 보세요' });
    if (/OPERATION_NOT_ALLOWED/.test(text)) return new ShareError('이메일 가입이 꺼져 있어요', { code: 'email-off', hint: '콘솔 → Authentication → 로그인 방법 → "이메일/비밀번호"를 사용 설정' });
  }
  if (/API key not valid|API_KEY_INVALID|INVALID_API_KEY/i.test(text))
    return new ShareError('apiKey 가 올바르지 않아요', { code: 'apikey', hint: 'js/firebase-config.js 의 apiKey 를 Firebase 콘솔에서 다시 복사하세요' });
  if (/OPERATION_NOT_ALLOWED|ADMIN_ONLY_OPERATION/i.test(text))
    return new ShareError('익명 로그인이 꺼져 있어요', { code: 'anon-off', hint: '콘솔 → Authentication → 로그인 방법 → "익명"을 사용 설정' });
  if (/CONFIGURATION_NOT_FOUND/i.test(text))
    return new ShareError('Authentication 을 아직 시작하지 않았어요', { code: 'auth-off', hint: '콘솔 → Authentication → "시작하기"' });
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(text) && /firestore/i.test(text))
    return new ShareError('Firestore 데이터베이스를 아직 만들지 않았어요', { code: 'fs-off', hint: '콘솔 → Firestore Database → "데이터베이스 만들기"' });
  if (status === 404 || /NOT_FOUND/.test(st))
    return new ShareError('프로젝트 또는 Firestore 데이터베이스를 찾지 못했어요', { code: 'notfound', hint: 'projectId 와 "데이터베이스 만들기"를 확인하세요' });
  if (status === 403 || /PERMISSION_DENIED/.test(st))
    return new ShareError('Firestore 규칙이 허용하지 않아요', { code: 'rules', hint: '콘솔 → Firestore → 규칙 탭에 firestore.rules 내용을 붙여넣고 "게시". 이미 했다면 콜지도 탭의 "연결 테스트"를 눌러 보세요(성공하면 규칙은 정상이고, 콜 시각이 너무 오래됐거나 이상한 경우예요)' });
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(st))
    return new ShareError('오늘 무료 사용량을 넘었어요', { code: 'quota', hint: '내일 다시 시도하거나 요금제를 확인하세요' });
  return new ShareError(`${where} 오류 (${status}${msg ? `: ${msg}` : ''})`, { code: 'other' });
}

const fnv = (str, seed) => {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
};
/** 같은 사용자의 같은 점은 같은 문서 번호가 되도록 (중복 업로드 방지) */
export const docIdFor = (uid, p) => {
  const s = `${uid}|${p.lat}|${p.lng}|${p.t}`;
  return fnv(s, 0x811c9dc5) + fnv(s, 0x01000193 ^ 0x9e3779b1) + fnv(s.split('').reverse().join(''), 0x2545f491);
};

export function createFirebaseShare({ config, storage, endpoints = {}, now = () => Date.now(), fetchFn = (...a) => fetch(...a), anonymous = true, origin = () => (typeof location === 'undefined' ? 'http://localhost' : location.origin) }) {
  const ep = { ...DEFAULT_ENDPOINTS, ...endpoints };
  const configured = () => Boolean(config?.apiKey && config?.projectId && !/여기에|YOUR_|xxxx/i.test(`${config.apiKey}${config.projectId}`));
  const dbPath = () => `projects/${config.projectId}/databases/(default)/documents`;
  const base = () => `${ep.fs}/${dbPath()}`;

  async function request(url, init, where) {
    let res;
    try {
      res = await fetchFn(url, init);
    } catch {
      throw new ShareError('Firebase 에 연결하지 못했어요', { code: 'network', hint: '인터넷 연결을 확인하세요' });
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* JSON 아님 */
    }
    if (!res.ok) throw explainError(res.status, body, where);
    return body;
  }

  // ---------- 로그인 (익명) ----------
  const saved = () => storage.get() ?? {};
  async function signUp() {
    const b = await request(`${ep.auth}/accounts:signUp?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    }, '로그인');
    const tok = { uid: b.localId, idToken: b.idToken, refreshToken: b.refreshToken, exp: now() + Number(b.expiresIn ?? 3600) * 1000 };
    storage.set(tok);
    return tok;
  }
  /** 구글 로그인 결과(ID 토큰)를 Firebase 로그인으로 바꿉니다. 이메일·이름은 이 기기에만 저장해 화면에 보여줍니다. */
  async function signInWithGoogle(googleIdToken) {
    if (!configured()) throw new ShareError('Firebase 설정이 비어 있어요', { code: 'noconfig', hint: 'js/firebase-config.js 에 apiKey 와 projectId 를 넣으세요' });
    const b = await request(`${ep.auth}/accounts:signInWithIdp?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        postBody: `id_token=${encodeURIComponent(googleIdToken)}&providerId=google.com`,
        requestUri: origin(),
        returnSecureToken: true,
        returnIdpCredential: true,
      }),
    }, '구글 로그인');
    const tok = {
      uid: b.localId,
      idToken: b.idToken,
      refreshToken: b.refreshToken,
      exp: now() + Number(b.expiresIn ?? 3600) * 1000,
      provider: 'google.com',
      emailVerified: true,
      profile: { email: b.email ?? '', name: b.displayName ?? '', photo: b.photoUrl ?? '' },
    };
    storage.set(tok);
    return tok;
  }
  // ---------- 이메일 가입·로그인 ----------
  const post = (path, payload, where) =>
    request(`${ep.auth}/${path}?key=${encodeURIComponent(config.apiKey)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, where);
  const keep = (b, extra) => {
    const tok = { uid: b.localId, idToken: b.idToken, refreshToken: b.refreshToken, exp: now() + Number(b.expiresIn ?? 3600) * 1000, provider: 'password', emailVerified: false, ...extra };
    storage.set(tok);
    return tok;
  };
  async function sendVerification() {
    const tok = saved();
    await post('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: tok.idToken }, '이메일 인증 메일');
  }
  /** 이름·이메일·비밀번호로 가입하고, 본인 확인용 인증 메일을 보냅니다 */
  async function signUpEmail({ email, password, name }) {
    if (!configured()) throw new ShareError('Firebase 설정이 비어 있어요', { code: 'noconfig' });
    const b = await post('accounts:signUp', { email, password, returnSecureToken: true }, '이메일 가입');
    keep(b, { profile: { email: b.email ?? email, name: name ?? '', photo: '' } });
    if (name) await post('accounts:update', { idToken: b.idToken, displayName: name, returnSecureToken: false }, '이메일 가입');
    await sendVerification();
    return account();
  }
  async function signInEmail({ email, password }) {
    if (!configured()) throw new ShareError('Firebase 설정이 비어 있어요', { code: 'noconfig' });
    const b = await post('accounts:signInWithPassword', { email, password, returnSecureToken: true }, '이메일 로그인');
    keep(b, { profile: { email: b.email ?? email, name: b.displayName ?? '', photo: '' } });
    await checkVerified();
    return account();
  }
  const sendPasswordReset = (email) => post('accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email }, '이메일 비밀번호 재설정');
  /** 메일의 인증 링크를 눌렀는지 확인하고, 눌렀다면 로그인 정보를 새로 받아 둡니다 */
  async function checkVerified() {
    const tok = saved();
    if (tok.provider !== 'password') return true;
    if (tok.emailVerified) return true;
    const fresh = tok.exp - now() > 60_000 ? tok : await refresh(tok);
    const b = await post('accounts:lookup', { idToken: fresh.idToken }, '이메일 인증 확인');
    if (!b.users?.[0]?.emailVerified) return false;
    const renewed = await refresh({ ...fresh });
    storage.set({ ...renewed, emailVerified: true });
    return true;
  }
  const isLoggedIn = () => Boolean(saved().refreshToken && saved().provider);
  const account = () => (isLoggedIn() ? { uid: saved().uid, provider: saved().provider, verified: saved().emailVerified !== false, ...(saved().profile ?? {}) } : null);
  const signOut = () => storage.set(null);

  async function refresh(tok) {
    const b = await request(`${ep.token}/token?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(tok.refreshToken)}`,
    }, '로그인 갱신');
    const next = { ...tok, uid: b.user_id ?? tok.uid, idToken: b.id_token, refreshToken: b.refresh_token ?? tok.refreshToken, exp: now() + Number(b.expires_in ?? 3600) * 1000 };
    storage.set(next);
    return next;
  }
  async function auth() {
    if (!configured()) throw new ShareError('Firebase 설정이 비어 있어요', { code: 'noconfig', hint: 'js/firebase-config.js 에 apiKey 와 projectId 를 넣으세요' });
    const tok = saved();
    if (!anonymous && !tok.provider) throw new ShareError('로그인이 필요해요', { code: 'login', hint: '설정에서 로그인하세요' });
    if (!anonymous && tok.provider === 'password' && tok.emailVerified === false) throw new ShareError('이메일 인증이 필요해요', { code: 'verify', hint: '메일의 인증 링크를 누른 뒤 설정 → 계정에서 "인증했어요"를 눌러 주세요' });
    if (tok.idToken && tok.exp - now() > 60_000) return tok;
    if (tok.refreshToken) {
      try {
        return await refresh(tok);
      } catch (e) {
        if (e.code !== 'other' && e.code !== 'apikey') throw e;
      }
    }
    if (!anonymous) throw new ShareError('로그인이 만료됐어요', { code: 'login', hint: '다시 구글로 로그인하세요' });
    return signUp();
  }
  const headers = (tok) => ({ authorization: `Bearer ${tok.idToken}`, 'content-type': 'application/json' });
  const write = (tok, p) => ({
    update: {
      name: `${dbPath()}/points/${docIdFor(tok.uid, p)}`,
      fields: {
        lat: { doubleValue: p.lat },
        lng: { doubleValue: p.lng },
        t: { integerValue: String(p.t) },
        k: { stringValue: 's' },
        u: { stringValue: tok.uid },
        ...(Number.isInteger(p.w) ? { w: { integerValue: String(p.w) } } : {}),
      },
    },
    updateTransforms: [{ fieldPath: 'up', setToServerValue: 'REQUEST_TIME' }],
    currentDocument: { exists: false },
  });

  async function commit(tok, writes) {
    return request(`${base()}:commit`, { method: 'POST', headers: headers(tok), body: JSON.stringify({ writes }) }, '저장');
  }

  /** @returns {Promise<{sent:number, duplicates:number}>} */
  async function push(points) {
    const tok = await auth();
    let sent = 0;
    let duplicates = 0;
    for (let i = 0; i < points.length; i += 200) {
      const batch = points.slice(i, i + 200);
      try {
        await commit(tok, batch.map((p) => write(tok, p)));
        sent += batch.length;
      } catch (e) {
        if (e.code !== 'rules') throw e;
        // 이미 올린 점이 섞여 있으면 규칙상 "수정"이라 거절돼요. 하나씩 나눠서 중복만 건너뜁니다.
        for (const p of batch) {
          try {
            await commit(tok, [write(tok, p)]);
            sent++;
          } catch (e2) {
            if (e2.code !== 'rules') throw e2;
            const exists = await fetchFn(`${base()}/points/${docIdFor(tok.uid, p)}`, { headers: headers(tok) }).then((r) => r.ok, () => false);
            if (!exists) throw e2;
            duplicates++;
          }
        }
      }
    }
    return { sent, duplicates };
  }

  const num = (v) => (v?.doubleValue ?? (v?.integerValue != null ? Number(v.integerValue) : NaN));
  /**
   * cursor(올린 시각) 이후의 점을 가져옵니다. 처음(cursor 없음)에는 최근 60일.
   * 이미 받은 것은 다시 읽지 않도록 커서를 돌려줘요 (무료 읽기 사용량 절약).
   * @returns {Promise<{points:Array, cursor:string}>}
   */
  async function pull(cursor) {
    const tok = await auth();
    let cur = cursor || new Date(now() - 60 * 86_400_000).toISOString();
    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await request(`${base()}:runQuery`, {
        method: 'POST',
        headers: headers(tok),
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'points' }],
            where: { fieldFilter: { field: { fieldPath: 'up' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: cur } } },
            orderBy: [{ field: { fieldPath: 'up' }, direction: 'ASCENDING' }],
            limit: PAGE,
          },
        }),
      }, '불러오기');
      const docs = (Array.isArray(rows) ? rows : []).map((r) => r.document).filter(Boolean);
      let last = cur;
      for (const d of docs) {
        const f = d.fields ?? {};
        const up = f.up?.timestampValue;
        if (up && up > last) last = up;
        if (f.u?.stringValue === tok.uid) continue; // 내가 올린 건 이미 내 기록에 있어요
        const p = { lat: num(f.lat), lng: num(f.lng), t: num(f.t), k: f.k?.stringValue, id: d.name.split('/').pop() };
        const w = num(f.w);
        if (Number.isFinite(w)) p.w = w;
        if (Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.t) && p.k === 's') out.push(p);
      }
      if (docs.length < PAGE || last === cur) {
        cur = last;
        break;
      }
      cur = last;
    }
    return { points: out, cursor: cur };
  }

  /** 설정 확인용: 로그인 → 내 확인 문서 쓰기 → 읽기. 어디서 막혔는지 한국어로 알려줍니다. */
  async function selfTest() {
    const tok = await auth();
    const doc = `${dbPath()}/selftest/${tok.uid}`;
    await request(`${base()}:commit`, {
      method: 'POST',
      headers: headers(tok),
      body: JSON.stringify({ writes: [{ update: { name: doc, fields: { ok: { booleanValue: true } } } }] }),
    }, '쓰기 확인');
    await pull(new Date(now() - 60_000).toISOString());
    return { uid: tok.uid };
  }

  return { configured, push, pull, selfTest, signInWithGoogle, signUpEmail, signInEmail, sendVerification, sendPasswordReset, checkVerified, signOut, account, isLoggedIn, uid: () => saved().uid ?? null };
}
