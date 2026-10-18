// Firebase 의 REST 응답을 흉내 내는 가짜 서버 (테스트 전용). firestore.rules 의 검사도 같은 규칙으로 흉내 냅니다.
// 진짜 Firebase 와 100% 같지는 않아요. 실제 연결은 앱의 "연결 테스트" 버튼으로 확인하세요.

export function createMockFirebase({ apiKey = 'test-key', projectId = 'demo-proj', now = () => Date.now(), anonEnabled = true, rulesPublished = true, firestoreCreated = true } = {}) {
  const docs = new Map(); // 전체 경로 → { fields }
  const users = new Map(); // refreshToken → uid
  const tokens = new Map(); // idToken → { uid, exp }
  let seq = 0;
  const log = [];
  const ts = (ms) => new Date(ms).toISOString().replace('Z', '123Z'); // 마이크로초 흉내

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const err = (status, message, st = '') => json(status, { error: { code: status, message, status: st } });
  const issue = (uid) => {
    const idToken = `id-${uid}-${++seq}`;
    const refreshToken = `rt-${uid}`;
    tokens.set(idToken, { uid, exp: now() + 3600_000 });
    users.set(refreshToken, uid);
    return { idToken, refreshToken };
  };
  const authed = (init) => tokens.get(String(init?.headers?.authorization ?? '').replace('Bearer ', '')) ?? null;
  const val = (f) => f?.doubleValue ?? f?.stringValue ?? (f?.integerValue != null ? Number(f.integerValue) : undefined);

  function rulesAllowCreate(uid, write) {
    const f = write.update.fields;
    const keys = [...Object.keys(f), ...(write.updateTransforms ?? []).map((t) => t.fieldPath)].sort();
    if (write.update.name.includes('/selftest/')) return write.update.name.endsWith(`/${uid}`) && Object.keys(f).join() === 'ok';
    if (keys.join() !== ['k', 'lat', 'lng', 't', 'u', 'up'].sort().join()) return false;
    if (write.updateTransforms?.[0]?.setToServerValue !== 'REQUEST_TIME') return false;
    const [lat, lng, t] = [val(f.lat), val(f.lng), val(f.t)];
    return (
      val(f.u) === uid && val(f.k) === 's' && lat >= 33 && lat <= 38.9 && lng >= 124.5 && lng <= 131.9 &&
      f.t.integerValue !== undefined && t <= now() + 3_600_000 && t >= now() - 90 * 86_400_000
    );
  }

  async function fetchFn(url, init = {}) {
    const u = new URL(url);
    const body = init.body ? (String(init.headers?.['content-type']).includes('json') ? JSON.parse(init.body) : init.body) : null;
    log.push(`${init.method ?? 'GET'} ${u.hostname}${u.pathname}`);
    if (u.searchParams.get('key') !== null && u.searchParams.get('key') !== apiKey) return err(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT');
    if (u.hostname === 'identitytoolkit.googleapis.com' && u.pathname.endsWith('/accounts:signUp')) {
      if (!anonEnabled) return err(400, 'OPERATION_NOT_ALLOWED');
      const uid = `uid${++seq}anon`;
      return json(200, { localId: uid, expiresIn: '3600', ...issue(uid) });
    }
    if (u.hostname === 'securetoken.googleapis.com') {
      const rt = new URLSearchParams(body).get('refresh_token');
      const uid = users.get(rt);
      if (!uid) return err(400, 'INVALID_REFRESH_TOKEN');
      const t = issue(uid);
      return json(200, { user_id: uid, id_token: t.idToken, refresh_token: t.refreshToken, expires_in: '3600' });
    }
    if (u.hostname === 'firestore.googleapis.com') {
      if (!firestoreCreated) return err(403, 'Cloud Firestore API has not been used in project demo-proj before or it is disabled.', 'PERMISSION_DENIED');
      const who = authed(init);
      const root = `/v1/projects/${projectId}/databases/(default)/documents`;
      if (!u.pathname.startsWith(root)) return err(404, 'not found', 'NOT_FOUND');
      const rest = u.pathname.slice(root.length);
      if (rest === ':commit') {
        if (!who || !rulesPublished) return err(403, 'Missing or insufficient permissions.', 'PERMISSION_DENIED');
        for (const w of body.writes) {
          const exists = docs.has(w.update.name);
          if (exists || !rulesAllowCreate(who.uid, w)) return err(403, 'Missing or insufficient permissions.', 'PERMISSION_DENIED');
        }
        for (const w of body.writes) {
          const fields = { ...w.update.fields };
          for (const t of w.updateTransforms ?? []) fields[t.fieldPath] = { timestampValue: ts(now()) };
          docs.set(w.update.name, { name: w.update.name, fields });
        }
        return json(200, { writeResults: body.writes.map(() => ({})), commitTime: ts(now()) });
      }
      if (rest === ':runQuery') {
        if (!who || !rulesPublished) return err(403, 'Missing or insufficient permissions.', 'PERMISSION_DENIED');
        const q = body.structuredQuery;
        const since = q.where.fieldFilter.value.timestampValue;
        const rows = [...docs.values()]
          .filter((d) => d.name.includes('/points/') && d.fields.up.timestampValue >= since)
          .sort((a, b) => (a.fields.up.timestampValue < b.fields.up.timestampValue ? -1 : 1))
          .slice(0, q.limit);
        return json(200, rows.length ? rows.map((d) => ({ document: d, readTime: ts(now()) })) : [{ readTime: ts(now()) }]);
      }
      if (rest.startsWith('/points/')) {
        if (!who) return err(403, 'denied', 'PERMISSION_DENIED');
        const d = docs.get(`projects/${projectId}/databases/(default)/documents${rest}`);
        return d ? json(200, d) : err(404, 'not found', 'NOT_FOUND');
      }
    }
    return err(404, 'unknown', 'NOT_FOUND');
  }
  return { fetchFn, docs, log, setNow: (fn) => (now = fn), storage: () => { let v = null; return { get: () => v, set: (x) => (v = x) }; } };
}
