// 콜 위치 공유 화면·동작. 콜카드를 저장하면 "공유할까요?"를 묻고, 동의한 콜의 출발지(대략)·시각(시 단위)만 서버로 올립니다.
// 다른 기사들이 올린 점은 주기적으로 받아 콜지도에 합칩니다.

import { store } from './store.js';
import { sharePush, sharePull, backendOf, firebase } from './share-sync.js';
import { toSharePoint, previewOf, shareability, MAX_AGE_DAYS } from './core/share.js';
import { roughPlace } from './core/geo.js';
import { computeWaits, shareableWait } from './core/wait.js';

const $ = (sel) => document.querySelector(sel);
const PULL_EVERY_MS = 5 * 60_000;
const RETRY_AFTER_ERROR_MS = 30_000;

export function initShare({ toast, esc, onChange }) {
  let status = { state: 'idle', msg: '', lastPull: 0, lastTry: 0, others: 0 };
  let pushing = false;
  let pulling = false;
  let testMsg = '';
  const settings = () => store.state.settings;
  const changed = () => {
    renderStatus();
    onChange?.();
  };

  const queued = () => store.state.calls.filter((c) => c.shareState === 'queued');
  const undecided = () => store.state.calls.filter((c) => c.startAddr && !c.shareState && c.source !== 'manual');

  async function pushQueued() {
    // 서버 규칙은 너무 오래됐거나 미래인 시각을 거절해요. 미리 걸러서 "규칙 오류"로 오해하지 않게 합니다.
    for (const c of queued()) {
      const why = shareability(c);
      if (why !== 'ok') store.updateCall(c.id, { shareState: why === 'old' ? 'stale' : 'future' });
    }
    const ready = queued().filter((c) => c.startPos);
    if (pushing || !ready.length) return;
    if (status.state === 'error' && Date.now() - status.lastTry < RETRY_AFTER_ERROR_MS) return;
    pushing = true;
    status.lastTry = Date.now();
    try {
      const cid = store.ensureCid();
      for (let i = 0; i < ready.length; i += 200) {
        const batch = ready.slice(i, i + 200);
        const waits = new Map(computeWaits(store.state.calls).map((w) => [w.id, w]));
        await sharePush(settings(), cid, batch.map((c) => toSharePoint(c, shareableWait(waits.get(c.id)))));
        for (const c of batch) store.updateCall(c.id, { shareState: 'shared' });
      }
      status = { ...status, state: 'ok', msg: '' };
      toast(`콜 ${ready.length}건을 공유했어요`);
    } catch (e) {
      status = { ...status, state: 'error', msg: e.message };
    } finally {
      pushing = false;
      changed();
    }
  }

  async function pullNow(force = false) {
    if (pulling) return;
    if (!settings().showShared) return; // 공유 콜 보기가 꺼져 있으면 받아오지 않아요 (읽기 횟수도 아낌)
    if (!force && Date.now() - status.lastPull < PULL_EVERY_MS) return;
    pulling = true;
    try {
      const backend = backendOf(settings());
      const meta = store.state.shareMeta;
      const cursor = meta.cursorFor === backend ? meta.cursor : null; // 공유 방식이 바뀌면 처음부터
      const r = await sharePull(settings(), store.ensureCid(), cursor);
      if (r.mode === 'merge') {
        if (meta.cursorFor !== backend) store.replaceShared('server', []);
        store.mergeShared('server', r.points);
        store.setShareMeta({ cursor: r.cursor, cursorFor: backend });
      } else {
        store.replaceShared('server', r.points);
        store.setShareMeta({ cursor: null, cursorFor: backend });
      }
      status = { ...status, state: 'ok', msg: '', lastPull: Date.now(), others: store.state.sharedPoints.filter((p) => p.src === 'server').length };
    } catch (e) {
      status = { ...status, state: 'error', msg: e.message, lastPull: Date.now() };
    } finally {
      pulling = false;
      changed();
    }
  }

  // ---------- 화면 ----------
  /** 저장 직후 결과 카드에 붙는 공유 영역 */
  function promptHtml(rec) {
    if (!rec?.startAddr) return '';
    if (rec.shareState === 'shared') return '<div class="sharebox done small">✓ 다른 기사님들과 공유했어요</div>';
    if (rec.shareState === 'queued') {
      if (rec.startGeoFail) return '<div class="sharebox small"><span class="bad">출발지 주소를 좌표로 바꾸지 못해 공유할 수 없어요.</span> 일지에서 출발지를 고쳐 주세요.</div>';
      const wait = rec.startPos ? '보내는 중…' : '주소를 좌표로 바꾸는 중… (끝나면 자동으로 공유돼요)';
      const err = status.state === 'error' ? `<div class="bad small">${esc(status.msg)}</div>` : '';
      return `<div class="sharebox small">공유 대기 · ${wait}${err}</div>`;
    }
    if (rec.shareState === 'stale') return `<div class="sharebox small"><span class="bad">${MAX_AGE_DAYS}일이 지난 콜이라 공유할 수 없어요.</span> 콜 시각이 맞는지 확인해 보세요. (일지에서 콜을 눌러 시각을 고칠 수 있어요)</div>`;
    if (rec.shareState === 'future') return '<div class="sharebox small"><span class="bad">콜 시각이 미래로 되어 있어 공유할 수 없어요.</span> 일지에서 콜을 눌러 시각을 고쳐 주세요.</div>';
    if (rec.shareState === 'declined' || settings().shareMode !== 'ask') return '';
    if (shareability(rec) !== 'ok') return `<div class="sharebox small muted">${MAX_AGE_DAYS}일이 지났거나 시각이 이상한 콜은 공유할 수 없어요. 일지에서 시각을 확인해 주세요.</div>`;
    const pv = previewOf(rec, roughPlace);
    return `<div class="sharebox">
      <strong>이 콜 위치를 공유할까요?</strong>
      <div class="small"><svg class="ico sm" aria-hidden="true"><use href="#i-map" /></svg> <b>${esc(pv.place)}</b> 부근 · ${esc(pv.when)}</div>
      <div class="muted small"><svg class="ico sm" aria-hidden="true"><use href="#i-lock" /></svg> 요금·이름·연락처·도착지·이미지는 제외</div>
      <div class="row gap wrap">
        <button class="btn primary small" data-action="share-call" data-id="${rec.id}">공유하기</button>
        <button class="btn small" data-action="share-skip" data-id="${rec.id}">이번엔 안 함</button>
        <button class="btn small" data-action="share-auto" data-id="${rec.id}">항상 공유</button>
      </div>
    </div>`;
  }

  function badge(c) {
    if (c.shareState === 'shared') return '<span class="tag">공유됨</span>';
    if (c.shareState === 'queued') return '<span class="tag wait">공유 대기</span>';
    if (c.shareState === 'stale' || c.shareState === 'future') return '<span class="tag wait">공유 불가(시각)</span>';
    return '';
  }

  function renderStatus() {
    const el = $('#shareStatus');
    if (!el) return;
    const mode = { ask: '콜마다 물어보기', auto: '자동 공유', off: '보내지 않기(받기만)' }[settings().shareMode];
    const waiting = queued().length;
    const todo = undecided().length;
    const mins = status.lastPull ? Math.max(0, Math.round((Date.now() - status.lastPull) / 60_000)) : null;
    const line =
      !settings().showShared
        ? '<div class="muted small">공유 콜 보기가 꺼져 있어요 (지도에서 켜기)</div>'
        : status.state === 'error'
        ? `<div class="bad small">${esc(status.msg)}</div>`
        : status.state === 'ok'
          ? `<div class="ok small">● 연결됨 · 받은 콜 ${status.others}건${mins != null ? ` (${mins === 0 ? '방금' : `${mins}분 전`})` : ''}</div>`
          : '<div class="muted small">연결 안 됨</div>';
    const setup = firebase.configured() ? '' : '<div class="small warn-text">Firebase 설정이 비어 있어요. js/firebase-config.js 를 채우면 여러 기사님과 공유할 수 있어요 (README 참고)</div>';
    el.innerHTML = `${line}${setup}${testMsg}
      <div class="small muted"><svg class="ico sm" aria-hidden="true"><use href="#i-share" /></svg> ${mode}${waiting ? ` · 공유 대기 ${waiting}건` : ''}</div>
      <div class="row gap wrap">
        <button class="btn small" data-action="share-refresh">새로고침</button>
        ${firebase.configured() ? '<button class="btn small" data-action="share-test">연결 테스트</button>' : ''}
        ${todo ? `<button class="btn small primary" data-action="share-all">내 콜 ${todo}건 공유</button>` : ''}
      </div>`;
  }

  function renderSettingsBox() {
    const s = settings();
    $('#shareSettings').innerHTML = `
      <label>내 콜 공유 방식
        <select id="shareMode">
          <option value="ask"${s.shareMode === 'ask' ? ' selected' : ''}>콜카드를 저장할 때마다 물어보기</option>
          <option value="auto"${s.shareMode === 'auto' ? ' selected' : ''}>자동으로 공유</option>
          <option value="off"${s.shareMode === 'off' ? ' selected' : ''}>내 콜은 보내지 않기 (다른 기사 콜만 받기)</option>
        </select></label>
      ${firebase.configured() ? `<label>공유 방식
        <select id="shareBackend">
          <option value="firebase"${s.shareBackend !== 'server' ? ' selected' : ''}>Firebase</option>
          <option value="server"${s.shareBackend === 'server' ? ' selected' : ''}>직접 만든 서버</option>
        </select></label>` : ''}
      ${!firebase.configured() || s.shareBackend === 'server' ? `<label>서버 주소 (비우면 이 화면을 연 서버)
        <input id="shareServer" type="text" inputmode="url" autocomplete="off" placeholder="예: https://example.com" value="${esc(s.shareServer)}" /></label>` : ''}`;
  }

  // ---------- 동작 ----------
  function ensureGeoConsent() {
    if (settings().geoConsent) return true;
    if (
      confirm(
        '공유하려면 출발지 주소를 좌표로 바꿔야 해요.\n주소 글자만 지도 검색 서버(OpenStreetMap)로 보내고, 이름·전화번호·이미지는 보내지 않아요.\n\n동의할까요?',
      )
    ) {
      store.setSettings({ geoConsent: true });
      return true;
    }
    return false;
  }

  function queueCalls(ids) {
    for (const id of ids) store.updateCall(id, { shareState: 'queued' });
    pushQueued();
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action^="share-"]');
    if (!el) return;
    const id = Number(el.dataset.id);
    switch (el.dataset.action) {
      case 'share-call':
        if (!ensureGeoConsent()) return;
        queueCalls([id]);
        break;
      case 'share-auto':
        if (!ensureGeoConsent()) return;
        store.setSettings({ shareMode: 'auto' });
        queueCalls([id]);
        toast('앞으로 저장하는 콜은 자동으로 공유해요. 설정에서 바꿀 수 있어요');
        break;
      case 'share-skip':
        store.updateCall(id, { shareState: 'declined' });
        break;
      case 'share-all':
        if (!ensureGeoConsent()) return;
        if (confirm(`내 콜 ${undecided().length}건의 출발지(대략 위치)와 시각(시 단위)을 공유할까요?\n요금·이름·전화번호·도착지·상세 주소·이미지는 공유되지 않아요. (직전 대기시간 분만 함께 올라가요)`)) queueCalls(undecided().map((c) => c.id));
        break;
      case 'share-refresh':
        pullNow(true);
        break;
      case 'share-test':
        testMsg = '<div class="muted small">연결 테스트 중…</div>';
        renderStatus();
        firebase
          .selfTest()
          .then(() => (testMsg = '<div class="ok small">✓ Firebase 연결 테스트 성공 (로그인·쓰기·읽기 모두 됐어요)</div>'))
          .catch((e) => (testMsg = `<div class="bad small">✗ ${esc(e.message)}</div>`))
          .finally(renderStatus);
        break;
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'shareMode') store.setSettings({ shareMode: t.value });
    else if (t.id === 'shareBackend') {
      store.setSettings({ shareBackend: t.value });
      pullNow(true);
    }
    else if (t.id === 'shareServer') {
      store.setSettings({ shareServer: t.value.trim() });
      status = { ...status, state: 'idle', lastPull: 0 };
      pullNow(true);
    }
  });

  return {
    promptHtml,
    badge,
    renderStatus,
    renderSettingsBox,
    /** 저장소가 바뀔 때마다: 보낼 게 있으면 보내고, 오래됐으면 새로 받기 */
    refresh() {
      pushQueued();
      pullNow(false);
    },
    pullNow,
    /** 새로 저장한 콜에 적용할 초기 공유 상태 (자동 공유 모드면 바로 대기열로) */
    initialState(hasStartAddr) {
      return settings().shareMode === 'auto' && hasStartAddr ? 'queued' : undefined;
    },
  };
}
