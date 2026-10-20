// "콜지도" 탭: 내 위치 기준 콜 많은 곳 추천 + 착지(도착지) 위험도 + 함께가기 문구 + 택시 호출.
// 계산은 js/core/*.js 에 있고, 여기서는 지도 그리기와 버튼 동작만 합니다.

import { store } from './store.js';
import { geocode } from './geocode.js';
import { recommend, landingRisk, diversify } from './core/hotspot.js';
import { haversineKm, roughPlace } from './core/geo.js';
import { shortLabel } from './core/address.js';
import { buildPack, parsePack } from './core/share.js';
import { makeDemoPoints } from './core/demo.js';
import { loginRequired } from './auth-ui.js';
import { computeWaits, expectedWait } from './core/wait.js';
import { judgeCall, ownBenchmark, backtest } from './core/judge.js';
import { summarize } from './core/ledger.js';

const $ = (sel) => document.querySelector(sel);
const abs = (p) => new URL(p, document.baseURI).href;
const LEVEL = {
  hot: { text: '콜밭', cls: 'ok', tip: '콜이 자주 나오는 곳' },
  normal: { text: '보통', cls: '', tip: '평균적인 수준' },
  remote: { text: '오지 주의', cls: 'bad', tip: '복귀가 어려울 수 있어요' },
  unknown: { text: '판단 불가', cls: 'muted', tip: '데이터가 더 필요해요' },
};

export function initMapTab({ toast, copyText, esc, download, fmtTime, pullShared }) {
  let L = null; // Leaflet
  let map = null;
  let layers = null;
  let userPos = null; // { lat, lng, source: 'gps'|'manual' }
  let analysis = null; // { pos, label, startLabel, risk }
  let ready = null;
  let geoBusy = false;
  let geoError = '';
  let fitted = false;
  let whenHours = 0; // 추천 시간대: 지금 / 1~3시간 뒤

  // ---------- 공유 콜 보기 버튼 ----------
  function syncSharedBtn() {
    const b = $('#sharedBtn');
    if (!b) return;
    const on = Boolean(settings().showShared);
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('on', on);
    b.querySelector('span').textContent = '공유 콜';
  }

  // ---------- 데이터 ----------
  const settings = () => store.state.settings;
  function demandPoints() {
    const own = store.state.calls
      .filter((c) => c.startPos)
      .map((c) => ({ lat: c.startPos.lat, lng: c.startPos.lng, t: c.at, label: c.startAddr ? shortLabel(c.startAddr) : null, src: 'own' }));
    const shared = settings().showShared ? store.state.sharedPoints.filter((p) => p.k === 's') : [];
    return [...own, ...shared];
  }
  const targetTime = () => Date.now() + whenHours * 3_600_000;

  // ---------- Leaflet 불러오기 ----------
  function loadLeaflet() {
    if (!ready) {
      ready = new Promise((resolve, reject) => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = abs('vendor/leaflet/leaflet.css');
        document.head.append(css);
        const s = document.createElement('script');
        s.src = abs('vendor/leaflet/leaflet.js');
        s.onload = () => resolve(window.L);
        s.onerror = () => reject(new Error('지도 파일을 불러오지 못했어요 (vendor/leaflet 폴더 확인)'));
        document.head.append(s);
      }).catch((e) => {
        ready = null;
        throw e;
      });
    }
    return ready;
  }

  async function ensureMap() {
    if (map) return map;
    L = await loadLeaflet();
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView([37.4, 127.05], 10);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    layers = { rec: L.layerGroup().addTo(map), pts: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map), ana: L.layerGroup().addTo(map) };
    map.on('click', (e) => analyzePoint({ lat: e.latlng.lat, lng: e.latlng.lng }, { label: '선택한 지점' }));
    return map;
  }

  // ---------- 그리기 ----------
  const heat = (ratio) => `hsl(${Math.round(55 - 55 * ratio)}, 90%, 50%)`; // 노랑 → 빨강

  function renderMap() {
    if (!map) return;
    layers.rec.clearLayers();
    layers.pts.clearLayers();
    layers.me.clearLayers();
    const pts = demandPoints();
    const recs = recommend(pts, { now: Date.now(), target: targetTime(), user: userPos ?? undefined, limit: 40 });
    const maxFinal = recs[0]?.final || 1;
    recs.forEach((r, i) => {
      L.circle([r.lat, r.lng], { radius: 750, color: heat(r.final / maxFinal), weight: i < 3 ? 3 : 1, fillOpacity: 0.18 + 0.35 * (r.final / maxFinal) })
        .addTo(layers.rec)
        .bindTooltip(`${i + 1}위 · ${r.count}건`, { direction: 'top' });
    });
    const spread = diversify(recs, 3, 5);
    spread.slice(0, 3).forEach((r, i) => {
      L.marker([r.lat, r.lng], {
        icon: L.divIcon({ className: 'rank-pin', html: `<span>${i + 1}</span>`, iconSize: [26, 26] }),
        keyboard: false,
      }).addTo(layers.rec);
    });
    if ($('#mapShowPts')?.checked) {
      for (const p of pts.slice(-1500)) L.circleMarker([p.lat, p.lng], { radius: 3, weight: 0, fillColor: p.src === 'own' ? '#1d5fd1' : '#888', fillOpacity: 0.6 }).addTo(layers.pts);
    }
    if (userPos) {
      L.circleMarker([userPos.lat, userPos.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#1d5fd1', fillOpacity: 1 }).addTo(layers.me).bindTooltip('내 위치');
    }
    if (!fitted) {
      const focus = userPos ? [[userPos.lat, userPos.lng], ...spread.slice(0, 3).map((r) => [r.lat, r.lng])] : spread.slice(0, 8).map((r) => [r.lat, r.lng]);
      if (focus.length > 1) map.fitBounds(focus, { padding: [30, 30], maxZoom: 13 });
      else if (focus.length === 1) map.setView(focus[0], 13);
      fitted = true;
    }
    renderRecs(spread, pts.length);
  }

  function navLink(name, p) {
    return `https://map.kakao.com/link/to/${encodeURIComponent(name)},${p.lat},${p.lng}`;
  }

  function renderRecs(recs, total) {
    const own = store.state.calls.filter((c) => c.startPos).length;
    const shared = total - own;
    const pending = pendingJobs().length;
    const st = $('#mapStatus');
    st.className = `chip${userPos ? ' on' : ''}`;
    st.innerHTML = `<svg class="ico sm" aria-hidden="true"><use href="#i-locate" /></svg>${userPos ? (userPos.source === 'gps' ? 'GPS' : '직접') : '위치 없음'}`;
    $('#mapData').innerHTML =
      `<div class="datarow"><span><b>${total}</b>전체</span><span><b>${own}</b>내 콜</span><span><b>${Math.max(0, shared)}</b>공유·테스트</span>${pending ? `<span><b>${pending}</b>변환 대기</span>` : ''}</div>` +
      (geoError ? `<div class="bad small">${esc(geoError)}</div>` : '');
    const hint = $('#mapHint');
    hint.hidden = total >= 15;
    hint.innerHTML = '<svg class="ico sm" aria-hidden="true"><use href="#i-info" /></svg>데이터가 적어 추천이 정확하지 않아요';
    const top = recs[0]?.final || 1;
    $('#recList').innerHTML = recs.length
      ? recs
          .map((r, i) => {
            const name = r.label ?? `${r.lat.toFixed(3)}, ${r.lng.toFixed(3)}`;
            const conf = { high: '신뢰 높음', mid: '신뢰 보통', low: '데이터 적음' }[r.confidence];
            return `<article class="rec">
              <div class="rank">${i + 1}</div>
              <div class="name">${esc(name)}</div>
              <div class="dist">${userPos ? `${r.distKm.toFixed(1)}<small>km</small>` : ''}</div>
              <div class="sub"><span>${r.count}건</span><span><svg class="ico sm" aria-hidden="true"><use href="#i-clock" /></svg>${r.peakHour}시</span><span class="dots" title="${conf}" data-n="${{ high: 3, mid: 2, low: 1 }[r.confidence]}"><i></i><i></i><i></i></span></div>
              <div class="heat" aria-hidden="true"><i style="width:${Math.max(6, Math.round((r.final / top) * 100))}%"></i></div>
              <div class="acts"><button class="btn small" data-action="map-focus" data-i="${i}">지도</button>
              <a class="btn small" href="${navLink(name, r)}" target="_blank" rel="noopener">길찾기</a></div>
            </article>`;
          })
          .join('')
      : '<div class="empty"><svg class="ico" aria-hidden="true"><use href="#i-map" /></svg><b>추천 없음</b></div>';
    lastRecs = recs;
    renderConsent();
  }
  let lastRecs = [];

  function renderConsent() {
    const s = settings();
    $('#geoConsent').hidden = Boolean(s.geoConsent);
  }

  // ---------- 착지 분석 ----------
  function analyzePoint(pos, { label, startLabel } = {}) {
    if (!map) return;
    const pts = demandPoints();
    const risk = landingRisk(pos, pts, { now: Date.now(), target: targetTime() });
    analysis = { pos, label: label ?? '선택한 지점', startLabel: startLabel ?? null, risk };
    layers.ana.clearLayers();
    L.circleMarker([pos.lat, pos.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#c0392b', fillOpacity: 1 }).addTo(layers.ana);
    L.circle([pos.lat, pos.lng], { radius: 3000, color: '#c0392b', weight: 1, fill: false, dashArray: '4 6' }).addTo(layers.ana);
    renderAnalysis();
  }

  function renderAnalysis() {
    const box = $('#analysis');
    if (!analysis) {
      box.hidden = true;
      return;
    }
    const { pos, label, risk } = analysis;
    const lv = LEVEL[risk.level];
    const exit = risk.exit;
    box.hidden = false;
    box.innerHTML = `
      <div class="where"><span>${esc(label)}</span><button class="btn ghost small" data-action="map-close-analysis">닫기</button></div>
      <div class="sign ${risk.level}"><b>${lv.text}</b><small>${lv.tip}</small></div>
      <div class="facts">
        ${risk.ratio != null ? `<span class="fact" title="${esc(risk.reason)}">콜밭 대비 ${Math.round(risk.ratio * 100)}%</span>` : ''}
        ${risk.nearCount ? `<span class="fact">주변 ${risk.nearCount}건</span>` : ''}
      </div>
      ${exit ? `<a class="exitrow" href="${navLink(exit.label ?? '콜밭', exit)}" target="_blank" rel="noopener"><svg class="ico sm" aria-hidden="true"><use href="#i-map" /></svg><span>가까운 콜밭 <b>${esc(exit.label ?? '추천 지점')}</b></span><span class="d">${exit.distKm.toFixed(1)}km</span></a>` : ''}
      <div class="acts">
        <button class="btn small" data-action="map-together">함께가기 복사</button>
        <button class="btn small" data-action="map-taxi">택시 호출</button>
        <a class="btn small" href="${navLink(label, pos)}" target="_blank" rel="noopener">길찾기</a>
      </div>
`;
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function togetherText(a = analysis) {
    const dest = a.label !== '선택한 지점' ? roughPlace(a.label) || a.label : `${a.pos.lat.toFixed(3)}, ${a.pos.lng.toFixed(3)} 부근`;
    const from = a.startLabel ? roughPlace(a.startLabel) || a.startLabel : '현 위치';
    const tag = LEVEL[a.risk.level].text;
    const when = fmtTime(Date.now());
    return `[함께가기] ${from} → ${dest} (${tag}) · ${when} 출발 예정\n같은 방향 가시는 기사님 함께 이동해요.\n도착지 지도: ${navLink('도착지', a.pos)}`;
  }

  // ---------- 내 위치 ----------
  function locate() {
    if (!navigator.geolocation) return toast('이 브라우저는 위치 기능을 지원하지 않아요');
    if (!window.isSecureContext) toast('http 주소에서는 위치가 막힐 수 있어요. localhost 또는 https로 열어 보세요');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        userPos = { lat: p.coords.latitude, lng: p.coords.longitude, source: 'gps' };
        fitted = false;
        renderMap();
        toast('내 위치를 찾았어요');
      },
      (err) => toast(err.code === 1 ? '위치 권한이 거부됐어요. 지도를 길게 보고 "여기를 내 위치로"를 써 보세요' : '위치를 찾지 못했어요'),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  }

  // ---------- 주소 → 좌표 (백그라운드) ----------
  function pendingJobs() {
    const jobs = [];
    for (const c of store.state.calls) {
      if (c.startAddr && !c.startPos && !c.startGeoFail) jobs.push({ id: c.id, field: 'start', addr: c.startAddr });
      if (c.endAddr && !c.endPos && !c.endGeoFail) jobs.push({ id: c.id, field: 'end', addr: c.endAddr });
    }
    return jobs;
  }

  async function pump() {
    if (geoBusy || !settings().geoConsent) return;
    geoBusy = true;
    try {
      for (let job = pendingJobs()[0]; job; job = pendingJobs()[0]) {
        const cached = store.geoGet(job.addr);
        let pos = cached.pos;
        if (!cached.hit) {
          pos = await geocode(job.addr, settings());
          store.geoSet(job.addr, pos);
        }
        store.updateCall(job.id, pos ? { [`${job.field}Pos`]: { lat: pos.lat, lng: pos.lng } } : { [`${job.field}GeoFail`]: true });
      }
      geoError = '';
    } catch (e) {
      geoError = `주소 변환 중단: ${e?.message ?? e} (인터넷 연결 확인 후 "주소 다시 변환"을 눌러 주세요)`;
    } finally {
      geoBusy = false;
      if (map && !$('#tab-map').hidden) renderMap();
    }
  }

  // ---------- 설정 상자 (설정 탭) ----------
  function renderSettingsBox() {
    const s = settings();
    $('#mapSettings').innerHTML = `
      <label>주소 → 좌표 변환 방식
        <select id="geocoder">
          <option value="nominatim"${s.geocoder === 'nominatim' ? ' selected' : ''}>OpenStreetMap (무료, 키 없음)</option>
          <option value="kakao"${s.geocoder === 'kakao' ? ' selected' : ''}>카카오 로컬 API (키 필요)</option>
        </select></label>
      <label>카카오 REST API 키 (카카오 방식일 때만)
        <input id="kakaoKey" type="password" autocomplete="off" value="${esc(s.kakaoKey)}" /></label>
      <label>택시 호출 앱 주소
        <input id="taxiUrl" type="text" autocomplete="off" value="${esc(s.taxiUrl)}" /></label>
      <label class="switch"><input id="geoConsentBox" type="checkbox"${s.geoConsent ? ' checked' : ''} />
        <span>주소를 지도 검색 서버로 보내 좌표로 바꾸기</span></label>`;
  }

  // ---------- 이벤트 ----------
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action^="map-"]');
    if (!el) return;
    switch (el.dataset.action) {
      case 'map-shared': {
        if (!settings().showShared && loginRequired()) {
          toast('로그인한 뒤에 공유 콜을 볼 수 있어요');
          break;
        }
        const on = !settings().showShared;
        store.setSettings({ showShared: on });
        syncSharedBtn();
        if (on) pullShared?.();
        renderMap();
        if (analysis) analyzePoint(analysis.pos, { label: analysis.label, startLabel: analysis.startLabel });
        toast(on ? '공유된 콜 지역을 함께 보여줘요' : '내 콜 지역만 보여줘요');
        break;
      }
      case 'map-when':
        whenHours = Number(el.dataset.v);
        document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('on', b === el));
        renderMap();
        if (analysis) analyzePoint(analysis.pos, { label: analysis.label, startLabel: analysis.startLabel });
        break;
      case 'map-locate':
        await ensureMap().catch((err) => toast(err.message));
        locate();
        break;
      case 'map-set-center': {
        if (!map) return;
        const c = map.getCenter();
        userPos = { lat: c.lat, lng: c.lng, source: 'manual' };
        fitted = true;
        renderMap();
        toast('내 위치로 지정했어요');
        break;
      }
      case 'map-focus': {
        const r = lastRecs[Number(el.dataset.i)];
        if (r && map) {
          map.setView([r.lat, r.lng], 14);
          document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        break;
      }
      case 'map-close-analysis':
        analysis = null;
        layers?.ana.clearLayers();
        renderAnalysis();
        break;
      case 'map-together': {
        if (!analysis) break;
        const text = togetherText();
        if (navigator.share) {
          try {
            await navigator.share({ text });
            break;
          } catch {
            /* 공유 취소 시 아래 복사로 */
          }
        }
        toast((await copyText(text)) ? '함께가기 문구를 복사했어요' : '복사하지 못했어요');
        break;
      }
      case 'map-taxi':
        if (!/^[a-z][a-z0-9+.-]*:/i.test(settings().taxiUrl)) return toast('설정에서 택시 호출 앱 주소를 확인해 주세요');
        toast('택시 앱을 여는 중… 휴대폰에서만 열려요');
        location.href = settings().taxiUrl;
        break;
      case 'map-consent':
        store.setSettings({ geoConsent: true });
        pump();
        break;
      case 'map-regeo': {
        for (const c of store.state.calls) {
          if (c.startGeoFail || c.endGeoFail) store.updateCall(c.id, { startGeoFail: false, endGeoFail: false });
        }
        geoError = '';
        pump();
        break;
      }
      case 'map-demo-add': {
        const n = store.addSharedPoints(makeDemoPoints({ now: Date.now() }), 'demo');
        toast(`테스트 데이터 ${n}건을 넣었어요 (실제 콜이 아니에요)`);
        break;
      }
      case 'map-demo-clear':
        toast(`테스트 데이터 ${store.removeSharedBySource('demo')}건을 지웠어요`);
        break;
      case 'map-export': {
        const pack = buildPack(store.state.calls);
        if (!pack.points.length) return toast('내보낼 콜 위치가 아직 없어요 (주소가 좌표로 바뀐 콜이 필요해요)');
        if (!confirm(`콜 위치 ${pack.points.length}건을 파일로 내보냅니다.\n\n들어가는 것: 대략적인 위치(약 100m 단위), 시간(시 단위), 출발/도착 구분\n들어가지 않는 것: 요금, 고객 이름·전화번호, 상세 주소, 이미지\n\n계속할까요?`)) return;
        const d = new Date();
        download(`call-points-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`, JSON.stringify(pack), 'application/json');
        break;
      }
      case 'map-import':
        $('#packInput').click();
        break;
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'mapShowPts') renderMap();
    else if (t.id === 'geocoder') store.setSettings({ geocoder: t.value });
    else if (t.id === 'kakaoKey') store.setSettings({ kakaoKey: t.value.trim() });
    else if (t.id === 'taxiUrl') store.setSettings({ taxiUrl: t.value.trim() });
    else if (t.id === 'geoConsentBox') {
      store.setSettings({ geoConsent: t.checked });
      if (t.checked) pump();
    } else if (t.id === 'packInput' && t.files?.[0]) {
      t.files[0]
        .text()
        .then((text) => {
          const { points, skipped } = parsePack(text);
          const added = store.addSharedPoints(points, 'shared');
          toast(`콜 위치 ${added}건을 추가했어요${skipped ? ` (이상한 ${skipped}건 제외)` : ''}`);
        })
        .catch((err) => toast(err.message ?? '불러오지 못했어요'))
        .finally(() => (t.value = ''));
    }
  });

  return {
    async onShow() {
      syncSharedBtn();
      try {
        await ensureMap();
        setTimeout(() => {
          map.invalidateSize();
          renderMap();
        }, 0);
      } catch (e) {
        $('#mapStatus').textContent = e.message;
      }
      renderAnalysis();
    },
    refresh() {
      if (map && !$('#tab-map').hidden) renderMap();
      pump();
    },
    renderSettingsBox,
    /** 일지의 콜 도착지를 지도에서 분석 */
    /** 홈의 "도착지 확인": 주소 글자 → 좌표 → 콜밭/오지 판정 (지도는 안 그려도 됨) */
    async quickCheck(text, { fare = 0 } = {}) {
      const q = String(text ?? '').trim();
      if (!q) return { error: 'empty' };
      if (!settings().geoConsent) return { error: 'consent' };
      let pos;
      try {
        pos = await geocode(q, settings(), { rawFallback: true });
      } catch (e) {
        return { error: 'network', message: e.message };
      }
      if (!pos) return { error: 'notfound' };
      const risk = landingRisk(pos, demandPoints(), { now: Date.now(), target: Date.now() });
      const a = { pos, label: q, startLabel: null, risk };
      const now = Date.now();
      const wait = expectedWait(pos, {
        own: computeWaits(store.state.calls).filter((w) => w.endPos),
        shared: settings().showShared ? store.state.sharedPoints.filter((p) => Number.isFinite(p.w)) : [],
        now,
        target: now,
      });
      let judge = null;
      if (fare > 0) {
        const month = summarize(store.state.calls, store.state.expenses, store.state.sessions, { start: now - 30 * 86_400_000, end: now + 1 }, now);
        judge = judgeCall({ fare, feeRate: settings().defaultFeeRate, level: risk.level, exitKm: risk.exit?.distKm ?? null, wait, benchmark: ownBenchmark(month) });
      }
      return { wait, judge, fare, label: q, pos, risk, level: LEVEL[risk.level], dataCount: demandPoints().length, nav: navLink(q, pos), exitNav: risk.exit ? navLink(risk.exit.label ?? '콜밭', risk.exit) : null, together: togetherText(a), shared: Boolean(settings().showShared) };
    },
    /** 통계 탭의 "판정 점검": 내 콜에 판정을 다시 돌려 실제 결과와 비교 */
    runBacktest() {
      const now = Date.now();
      const month = summarize(store.state.calls, store.state.expenses, store.state.sessions, { start: now - 30 * 86_400_000, end: now + 1 }, now);
      return backtest(
        store.state.calls,
        {
          points: demandPoints(),
          shared: settings().showShared ? store.state.sharedPoints.filter((p) => Number.isFinite(p.w)) : [],
          benchmark: ownBenchmark(month),
          feeRate: settings().defaultFeeRate,
          now,
        },
        { computeWaits, expectedWait, landingRisk },
      );
    },
    /** 홈에서 확인한 도착지를 지도 탭에서 크게 보기 */
    async showOnMap(r) {
      location.hash = '#map';
      await ensureMap();
      setTimeout(() => {
        map.invalidateSize();
        map.setView([r.pos.lat, r.pos.lng], 12);
        analyzePoint(r.pos, { label: r.label });
      }, 50);
    },
    async analyzeCall(id) {
      const c = store.state.calls.find((x) => x.id === id);
      if (!c?.endPos) return toast(c?.endAddr ? '도착지 좌표가 아직 없어요. 지도 탭에서 주소 변환이 끝난 뒤 다시 눌러 주세요' : '도착지가 비어 있어요');
      location.hash = '#map';
      await ensureMap();
      setTimeout(() => {
        map.invalidateSize();
        map.setView([c.endPos.lat, c.endPos.lng], 12);
        analyzePoint(c.endPos, { label: c.endAddr, startLabel: c.startAddr });
      }, 50);
    },
    pump,
  };
}
