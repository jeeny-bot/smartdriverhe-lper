// 콜 위치 공유 API (의존성 없음). 기사들이 올린 "출발지 대략 위치 + 시각(시 단위)"를 모아서 다시 내려줍니다.
//   GET  /api/health
//   POST /api/points   { cid, points: [{ lat, lng, t, k:'s' }] }   (한 번에 200개까지)
//   GET  /api/points?exclude=<cid>&days=60
// 저장하는 것: 좌표(약 100m 단위)·시각(시 단위)·올린 기기의 임의 번호(cid). 요금·이름·전화번호·주소·이미지는 받지도 않습니다.
// 익명 서비스라 거짓 데이터를 막지는 못해요. 아래 제한은 "한 기기가 지도를 도배하는 것"을 어렵게 하는 정도입니다.

import fs from 'node:fs';
import path from 'node:path';
import { inKorea, roundPos } from '../js/core/geo.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const LIMITS = {
  maxBodyBytes: 64 * 1024,
  maxPerRequest: 200,
  perIpPerHour: 600, // 한 IP가 한 시간에 올릴 수 있는 점 수
  perCidPerDay: 400, // 한 기기가 하루에 올릴 수 있는 점 수
  keepDays: 90,
  maxStored: 200_000,
  maxReturn: 20_000,
};

const cidOk = (c) => typeof c === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(c);

export function createShareApi({ file = null, now = () => Date.now(), limits = LIMITS } = {}) {
  /** @type {Array<{lat:number,lng:number,t:number,k:string,c:string}>} */
  let points = [];
  const seen = new Set();
  const ipHits = new Map(); // ip → [시각...]
  const cidHits = new Map();
  let saveTimer = null;

  const keyOf = (p, c) => `${p.lat},${p.lng},${p.t},${c}`;
  const prune = () => {
    const min = now() - limits.keepDays * DAY;
    points = points.filter((p) => p.t >= min).slice(-limits.maxStored);
    seen.clear();
    for (const p of points) seen.add(keyOf(p, p.c));
  };
  if (file && fs.existsSync(file)) {
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(obj.points)) points = obj.points.filter((p) => inKorea(p) && Number.isFinite(p.t) && cidOk(p.c));
      prune();
    } catch {
      /* 깨진 파일이면 빈 상태로 시작 */
    }
  }
  const save = () => {
    if (!file) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ points }));
        fs.renameSync(`${file}.tmp`, file);
      } catch (e) {
        console.error('공유 데이터 저장 실패:', e.message);
      }
    }, 500);
  };
  const withinLimit = (map, key, amount, max, windowMs) => {
    const t = now();
    const arr = (map.get(key) ?? []).filter((x) => x.t > t - windowMs);
    const used = arr.reduce((a, x) => a + x.n, 0);
    if (used + amount > max) return false;
    arr.push({ t, n: amount });
    map.set(key, arr);
    return true;
  };

  function add(body, ip) {
    if (!cidOk(body?.cid)) return { status: 400, body: { error: '기기 번호(cid)가 올바르지 않아요' } };
    if (!Array.isArray(body.points) || !body.points.length) return { status: 400, body: { error: '보낼 점이 없어요' } };
    if (body.points.length > limits.maxPerRequest) return { status: 413, body: { error: `한 번에 ${limits.maxPerRequest}개까지 보낼 수 있어요` } };
    const t0 = now();
    const clean = [];
    for (const p of body.points) {
      if (p?.k !== 's' || !Number.isFinite(p.t) || !inKorea(p)) continue;
      const t = Math.floor(p.t / HOUR) * HOUR;
      if (t > t0 + HOUR || t < t0 - limits.keepDays * DAY) continue;
      const r = roundPos({ lat: Number(p.lat), lng: Number(p.lng) });
      clean.push({ lat: r.lat, lng: r.lng, t, k: 's', c: body.cid });
    }
    if (!clean.length) return { status: 200, body: { added: 0, skipped: body.points.length } };
    if (!withinLimit(ipHits, ip, clean.length, limits.perIpPerHour, HOUR) || !withinLimit(cidHits, body.cid, clean.length, limits.perCidPerDay, DAY)) {
      return { status: 429, body: { error: '잠시 후 다시 시도해 주세요 (너무 많이 올렸어요)' } };
    }
    let added = 0;
    for (const p of clean) {
      const key = keyOf(p, p.c);
      if (seen.has(key)) continue;
      seen.add(key);
      points.push(p);
      added++;
    }
    if (points.length > limits.maxStored) prune();
    if (added) save();
    return { status: 200, body: { added, skipped: body.points.length - added } };
  }

  function list(query) {
    const days = Math.min(limits.keepDays, Math.max(1, Number(query.get('days')) || 60));
    const exclude = query.get('exclude');
    const min = now() - days * DAY;
    const out = [];
    for (let i = points.length - 1; i >= 0 && out.length < limits.maxReturn; i--) {
      const p = points[i];
      if (p.t < min || (exclude && p.c === exclude)) continue;
      out.push({ lat: p.lat, lng: p.lng, t: p.t, k: p.k });
    }
    return { status: 200, body: { points: out, serverTime: now() } };
  }

  /** @returns {Promise<boolean>} 처리했으면 true (아니면 정적 파일 서버가 이어서 처리) */
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/')) return false;
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
    };
    const send = (status, body) => {
      res.writeHead(status, headers).end(JSON.stringify(body));
      return true;
    };
    if (req.method === 'OPTIONS') return send(204, {});
    if (url.pathname === '/api/health' && req.method === 'GET') return send(200, { app: 'call-share', v: 1, points: points.length });
    if (url.pathname === '/api/points' && req.method === 'GET') {
      const r = list(url.searchParams);
      return send(r.status, r.body);
    }
    if (url.pathname === '/api/points' && req.method === 'POST') {
      let size = 0;
      const chunks = [];
      for await (const ch of req) {
        size += ch.length;
        if (size > limits.maxBodyBytes) return send(413, { error: '요청이 너무 커요' });
        chunks.push(ch);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { error: 'JSON이 아니에요' });
      }
      const r = add(body, req.socket.remoteAddress ?? 'unknown');
      return send(r.status, r.body);
    }
    return send(404, { error: 'not found' });
  }

  return { handle, add, list, get size() { return points.length; }, flush() { clearTimeout(saveTimer); if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ points })); } } };
}
