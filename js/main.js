import { parseCallCard, resolveCallTime, maskPhones, PLATFORMS, platformLabel } from './core/parser.js';
import { settle, resolveEditedFee, BusinessDay, summarize, byDay } from './core/ledger.js';
import { store } from './store.js';
import { recognize, hashFile, setProgressListener } from './ocr.js';
import { initMapTab } from './map-tab.js';
import { initShare } from './share-ui.js';
import { initAuth } from './auth-ui.js';
import { shortLabel } from './core/address.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- 표시용 도우미 ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const fmtTime = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}(${DAYS[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtDuration = (ms) => `${Math.floor(ms / 3_600_000)}시간 ${Math.floor((ms % 3_600_000) / 60_000)}분`;
const toLocalInput = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const parseMoney = (s) => {
  const digits = String(s ?? '').replace(/\D/g, '');
  return digits ? Number.parseInt(digits, 10) : null;
};

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http 주소(폰에서 같은 와이파이로 접속)에서는 clipboard API 를 쓸 수 없어서 예전 방식으로 대신합니다.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// ---------- 데이터 → 계산 ----------
const cutoff = () => store.state.settings.cutoffHour;
const callLines = (calls) => calls.map((c) => ({ fare: c.fare, fee: c.fee, at: c.at }));
const expLines = (es) => es.map((e) => ({ amount: e.amount, at: e.at }));

// ---------- 화면 조각 ----------
const num = (n) => Math.round(n).toLocaleString('ko-KR');
const fmtClock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtHM = (ms) => `${Math.floor(ms / 3_600_000)}:${pad(Math.floor((ms % 3_600_000) / 60_000))}`;
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const dayLabel = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return `${m}/${d} (${DAYS[new Date(y, m - 1, d).getDay()]})`;
};

function callHtml(c) {
  const when = sameDay(c.at, Date.now()) ? fmtClock(c.at) : fmtTime(c.at);
  const stop = (cls, text, empty) => `<span class="stop ${cls}${text ? '' : ' none'}">${esc(text ?? empty)}</span>`;
  return `<article class="call" data-action="edit-call" data-id="${c.id}" tabindex="0" role="button" aria-label="콜 수정">
    <div class="meta"><span>${when}</span>${share.badge(c)}<span class="plat">${esc(platformLabel(c.platform))}</span></div>
    <div class="route">${stop('s', c.startAddr, '출발지 미확인')}${stop('e', c.endAddr, '도착지 미확인')}</div>
    <div class="amount">
      <div class="net">${num(c.fare - c.fee)}<small>원</small></div>
      <div class="calc">${num(c.fare)} − ${num(c.fee)}${c.feeEstimated ? ' <span class="est">수수료 예상</span>' : ''}</div>
    </div>
    ${c.needsReview ? '<div class="foot"><span class="tag review">확인 필요</span><svg class="ico sm muted" aria-hidden="true"><use href="#i-gear" /></svg></div>' : ''}
  </article>`;
}

const kpi = (label, value) => `<div class="kpi"><div class="k">${label}</div><div class="v">${value}</div></div>`;
const minor = (items) => `<div class="minor">${items.map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('')}</div>`;
const bigNum = (n) => `<div class="big${n < 0 ? ' neg' : ''}">${num(n)}<span class="u">원</span></div>`;

function renderHome() {
  const now = Date.now();
  const { state } = store;
  const range = BusinessDay.rangeFor(now, cutoff());
  const inRange = (t) => t >= range.start && t < range.end;
  const calls = state.calls.filter((c) => inRange(c.at)).sort((a, b) => b.at - a.at);
  const exps = state.expenses.filter((e) => inRange(e.at)).sort((a, b) => b.at - a.at);
  const s = summarize(callLines(state.calls), expLines(state.expenses), state.sessions.map((x) => ({ start: x.start, end: x.end })), range, now);

  $('#todayCard').innerHTML = `
    <div class="cap"><span>오늘 순수익</span><span>${dayLabel(BusinessDay.dateOf(now, cutoff()))} · 새벽 ${cutoff()}시 기준</span></div>
    ${bigNum(s.profit)}
    <div class="centerline"></div>
    <div class="kpis">
      ${kpi('수행', `${s.count}<small>건</small>`)}
      ${kpi('시간당 순익', s.hourlyProfit == null ? '-' : `${num(s.hourlyProfit)}<small>원</small>`)}
      ${kpi('근무', `${fmtHM(s.workedMillis)}`)}
    </div>
    ${minor([['총수입', won(s.totalFare)], ['수수료', won(s.totalFee)], ['지출', won(s.expenses)]])}`;

  const open = state.sessions.find((x) => x.end == null);
  const work = $('#workBtn');
  work.classList.toggle('on', Boolean(open));
  work.innerHTML = open ? `근무 중 <span class="t">${fmtHM(now - open.start)}</span>` : '출근하기';
  work.setAttribute('aria-label', open ? '퇴근하기' : '출근하기');

  $('#todayCalls').innerHTML = calls.length
    ? calls.slice(0, 5).map(callHtml).join('') +
      (calls.length > 5 ? `<a class="btn ghost" href="#journal">오늘 콜 ${calls.length}건 모두 보기</a>` : '')
    : '<div class="empty"><svg class="ico" aria-hidden="true"><use href="#i-inbox" /></svg><b>오늘 콜 없음</b></div>';
  $('#todayExpenses').innerHTML = exps.length
    ? `<div class="section-head"><h2>오늘 지출</h2></div>` +
      exps
        .map(
          (e) => `<div class="panel row between"><span>${esc(e.category)} <b>${won(e.amount)}</b>${e.memo ? `<br><span class="muted small">${esc(e.memo)}</span>` : ''}</span>
            <button class="btn small danger" data-action="del-expense" data-id="${e.id}">삭제</button></div>`,
        )
        .join('')
    : '';
}

function renderJournal() {
  const calls = [...store.state.calls].sort((a, b) => b.at - a.at).slice(0, 300);
  if (!calls.length) {
    $('#journalList').innerHTML = '<div class="empty"><svg class="ico" aria-hidden="true"><use href="#i-inbox" /></svg><b>기록 없음</b></div>';
    return;
  }
  const groups = [];
  for (const c of calls) {
    const key = BusinessDay.dateOf(c.at, cutoff());
    const g = groups.at(-1);
    if (g?.key === key) g.calls.push(c);
    else groups.push({ key, calls: [c] });
  }
  $('#journalList').innerHTML = groups
    .map((g) => {
      const net = g.calls.reduce((a, c) => a + (c.fare - c.fee), 0);
      return `<div class="daygroup"><div class="daytitle"><h3>${dayLabel(g.key)}</h3><span>${g.calls.length}건 · <b>${num(net)}</b>원</span></div>
        <div class="stack">${g.calls.map(callHtml).join('')}</div></div>`;
    })
    .join('');
}

let month = (() => {
  const [y, m] = BusinessDay.dateOf(Date.now(), store.state.settings.cutoffHour).split('-').map(Number);
  return { y, m };
})();

function renderStats() {
  const { state } = store;
  const range = BusinessDay.monthRange(month.y, month.m, cutoff());
  const inRange = (t) => t >= range.start && t < range.end;
  const calls = state.calls.filter((c) => inRange(c.at));
  const exps = state.expenses.filter((e) => inRange(e.at));
  const t = summarize(callLines(calls), expLines(exps), [], range, 0);

  $('#monthTitle').textContent = `${month.y}년 ${month.m}월`;
  $('#monthCard').innerHTML = `
    <div class="cap"><span>월 순수익</span><span>${t.count}건 수행</span></div>
    ${bigNum(t.profit)}
    <div class="centerline"></div>
    ${minor([['총수입', won(t.totalFare)], ['수수료', won(t.totalFee)], ['지출', won(t.expenses)]])}`;

  const days = byDay(callLines(calls), expLines(exps), cutoff());
  const profitOf = new Map(days.map((d) => [d.date, d.summary.profit]));
  const last = new Date(month.y, month.m, 0).getDate();
  const keys = Array.from({ length: last }, (_, i) => `${month.y}-${pad(month.m)}-${pad(i + 1)}`);
  const max = Math.max(1, ...keys.map((k) => profitOf.get(k) ?? 0));
  $('#dayChart').innerHTML = days.length
    ? keys
        .map((k, i) => {
          const v = Math.max(0, profitOf.get(k) ?? 0);
          const label = [1, 5, 10, 15, 20, 25, last].includes(i + 1) ? i + 1 : '';
          return `<div class="col" title="${dayLabel(k)} ${num(v)}원"><i style="height:${v ? Math.max(3, (v / max) * 82) : 0}px"></i><span>${label}</span></div>`;
        })
        .join('')
    : '<div class="empty-bars">기록 없음</div>';
  $('#dayList').innerHTML = [...days]
    .reverse()
    .map(({ date, summary: d }) => `<div class="dayrow"><span class="d">${dayLabel(date)}</span><span class="c">${d.count}건</span><span class="p">${num(d.profit)}<small class="muted">원</small></span></div>`)
    .join('');
}

function renderSettings() {
  auth.renderAccount();
  mapTab.renderSettingsBox();
  share.renderSettingsBox();
  const s = store.state.settings;
  const field = (id, label, value, placeholder = '') =>
    `<label>${label}<input id="${id}" type="number" inputmode="decimal" min="0" max="100" step="0.1" value="${value ?? ''}" placeholder="${placeholder}" /></label>`;
  $('#feeForm').innerHTML =
    field('fee-default', '기본 수수료율(%)', s.defaultFeeRate) +
    PLATFORMS.filter((p) => p.key !== 'unknown')
      .map((p) => field(`fee-${p.key}`, `${p.label} 수수료율(%)`, s.platformRates[p.key], '비우면 기본값'))
      .join('');
  $('#cutoff').value = s.cutoffHour;
  let pref = 'auto';
  try {
    pref = localStorage.getItem('call-assistant-theme') || 'auto';
  } catch {}
  $('#themePref').value = pref;
  const fp = $('#fontPref');
  if (fp && window.FontPref) {
    if (!fp.options.length) fp.innerHTML = Object.entries(FontPref.FONTS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
    fp.value = FontPref.saved();
  }
}

function renderAll() {
  renderChips();
  $('#storageWarn').hidden = store.persistent;
  renderHome();
  if (!$('#tab-journal').hidden) renderJournal();
  if (!$('#tab-stats').hidden) renderStats();
  renderResults();
}

const mapTab = initMapTab({ toast, copyText, esc, download, fmtTime, pullShared: () => share.pullNow(true) });
// ---------- 홈: 도착지 한 번에 확인 ----------
let lastCheck = null;
let lastQuery = '';

function renderChips() {
  const seen = new Set();
  const chips = [];
  for (const c of [...store.state.calls].sort((a, b) => b.at - a.at)) {
    const q = (c.endAddr ?? '').trim();
    const label = q ? shortLabel(q) : '';
    if (!label || seen.has(label)) continue;
    seen.add(label);
    chips.push(`<button type="button" class="chip pick" data-action="check-pick" data-q="${esc(q)}">${esc(label)}</button>`);
    if (chips.length >= 6) break;
  }
  $('#checkChips').innerHTML = chips.join('');
}

function checkHtml(r) {
  const box = (inner) => `<div class="checkcard analysis">${inner}</div>`;
  if (r.error === 'consent')
    return box('<div class="where"><span>주소를 좌표로 바꿀까요?</span></div><p class="small muted">주소 글자만 지도 검색 서버로 보내요. 이름·전화번호는 보내지 않아요.</p><button class="btn primary small" data-action="check-consent">동의하고 확인</button>');
  if (r.error === 'notfound') return box('<div class="where"><span>찾지 못했어요</span></div><p class="small muted">동 이름까지 적어 보세요. 예) 분당 정자동</p>');
  if (r.error === 'network') return box(`<div class="where"><span>연결에 실패했어요</span></div><p class="small muted">${esc(r.message ?? '인터넷을 확인해 주세요')}</p>`);
  const lv = r.level;
  const exit = r.risk.exit;
  const j = r.judge;
  const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
  const facts = [
    j
      ? `<span class="fact">대기 ${j.waitBasis === 'measured' ? `${j.waitMin}분 · 실측 ${j.waitSamples}건` : `약 ${j.waitMin}분 · 추정`}</span>`
      : r.wait
        ? `<span class="fact">평균 대기 ${r.wait.minutes}분 · 실측 ${r.wait.n}건</span>`
        : '',
    j && j.returnCost ? `<span class="fact warn">귀환 ${won(j.returnCost)}</span>` : '',
    j ? `<span class="fact">${j.benchmarkBasis === 'own' ? '내 평균' : '기본 기준'} ${won(j.benchmark)}/시</span>` : '',
    j && r.risk.level !== 'unknown' ? `<span class="fact">${lv.text}</span>` : '',
    !j && r.risk.ratio != null ? `<span class="fact">콜밭 대비 ${Math.round(r.risk.ratio * 100)}%</span>` : '',
    !j && r.risk.nearCount ? `<span class="fact">주변 ${r.risk.nearCount}건</span>` : '',
    `<span class="fact">데이터 ${r.dataCount}건</span>`,
  ].join('');
  const VERDICT = { go: ['잡아요', 'hot'], ok: ['보통', ''], pass: ['패스', 'remote'] };
  const sign = j
    ? `<div class="sign ${VERDICT[j.verdict][1]}"><b>${VERDICT[j.verdict][0]}</b><small>시간당 약 ${won(j.hourly)}</small></div>`
    : `<div class="sign ${r.risk.level}"><b>${lv.text}</b><small>${lv.tip}</small></div>`;
  return box(`
    <div class="where"><span>${esc(r.label)}</span>${j ? `<span class="muted small">요금 ${won(j.net + j.fee)}</span>` : ''}</div>
    ${sign}
    <div class="facts">${facts}</div>
    ${exit ? `<a class="exitrow" href="${r.exitNav}" target="_blank" rel="noopener"><svg class="ico sm" aria-hidden="true"><use href="#i-map" /></svg><span>가까운 콜밭 <b>${esc(exit.label ?? '추천 지점')}</b></span><span class="d">${exit.distKm.toFixed(1)}km</span></a>` : ''}
    ${r.risk.level === 'unknown' && !r.shared ? '<button class="btn small" data-action="check-share"><svg class="ico sm" aria-hidden="true"><use href="#i-share" /></svg>공유 콜 켜고 다시 보기</button>' : ''}
    <div class="acts">
      <button class="btn small" data-action="check-together">함께가기 복사</button>
      <button class="btn small" data-action="map-taxi">택시 호출</button>
      <button class="btn small" data-action="check-map">지도</button>
    </div>`);
}

async function runCheck(q) {
  q = String(q ?? '').trim();
  if (!q) return;
  lastQuery = q;
  $('#checkInput').value = q;
  $('#checkResult').innerHTML = '<div class="checkcard analysis"><div class="sign unknown skel"><b>확인 중…</b></div></div>';
  const fare = Number(String($('#checkFare').value).replace(/[^\d]/g, '')) || 0;
  const r = await mapTab.quickCheck(q, { fare });
  lastCheck = r.error ? null : r;
  $('#checkResult').innerHTML = checkHtml(r);
}

const share = initShare({ toast, esc, onChange: () => renderResults() });
const auth = initAuth({ esc, toast, onLogin: () => { share.pullNow(true); renderSettings(); } });

// ---------- 탭 이동 ----------
function showTab(name) {
  const valid = ['home', 'map', 'journal', 'stats', 'settings'];
  const tab = valid.includes(name) ? name : 'home';
  $$('.tab').forEach((el) => (el.hidden = el.dataset.tab !== tab));
  $$('[data-nav]').forEach((a) => (a.dataset.nav === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (tab === 'settings') renderSettings();
  if (tab === 'map') {
    mapTab.onShow();
    share.renderStatus();
    share.pullNow(false);
  }
  renderAll();
  window.scrollTo(0, 0);
}
$('#checkForm').addEventListener('submit', (e) => {
  e.preventDefault();
  runCheck($('#checkInput').value);
});
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

// ---------- 콜카드 이미지 처리 ----------
const jobs = [];
let jobSeq = 0;
let activeJob = null;

setProgressListener((m) => {
  if (!activeJob) return;
  if (m.status === 'recognizing text') {
    activeJob.progress = m.progress;
    activeJob.note = '글자 읽는 중';
  } else if (m.status?.includes('loading')) {
    activeJob.note = m.status.includes('language') ? '한국어 데이터 불러오는 중 (처음 한 번만 오래 걸려요)' : 'OCR 엔진 준비 중';
  }
  renderResults();
});

function buildRecord(parsed, rawMasked, file, hash) {
  const fare = parsed.fare;
  const when = resolveCallTime(parsed.when, file.lastModified || Date.now());
  const base = {
    at: when.at,
    atBasis: when.basis,
    startAddr: parsed.start,
    endAddr: parsed.end,
    platform: parsed.platform,
    rawText: rawMasked,
    source: 'upload',
    imgHash: hash,
  };
  if (fare == null) return { ...base, fare: 0, fee: 0, feeEstimated: false, needsReview: true };
  const s = settle(fare, parsed.feeAmount, parsed.feeRatePercent, store.rateFor(parsed.platform));
  return {
    ...base,
    fare,
    fee: s.fee,
    feeEstimated: s.estimated,
    needsReview: parsed.start == null || parsed.end == null || when.basis === 'reference',
    shareState: share.initialState(Boolean(parsed.start)),
  };
}

async function processFile(file) {
  const job = { id: ++jobSeq, name: file.name || '붙여넣은 이미지', phase: 'queued', progress: 0, note: '대기 중' };
  jobs.unshift(job);
  renderResults();
  try {
    const hash = await hashFile(file);
    if (store.hasImage(hash)) {
      job.phase = 'dup';
      return;
    }
    const text = await recognize(file, () => {
      activeJob = job;
      job.phase = 'ocr';
      job.note = '글자 읽는 중';
      renderResults();
    });
    const parsed = parseCallCard(text);
    const raw = maskPhones(text);
    job.file = { lastModified: file.lastModified };
    job.pending = { parsed, raw, hash, file: { lastModified: file.lastModified } };
    if (parsed.isCallCard) {
      const rec = store.addCall(buildRecord(parsed, raw, file, hash));
      job.recId = rec?.id ?? null;
      job.phase = 'saved';
    } else {
      job.raw = raw;
      job.phase = 'notcard';
    }
  } catch (e) {
    job.phase = 'error';
    job.error = e?.message ?? String(e);
  } finally {
    if (activeJob === job) activeJob = null;
    renderAll();
  }
}

async function handleFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return toast('이미지 파일을 선택해 주세요');
  if (location.hash !== '#home' && location.hash !== '') location.hash = '#home';
  await Promise.all(images.map(processFile));
}

function resultHtml(job) {
  const head = (state) =>
    `<div class="head"><span>${esc(job.name)}</span><span>${state}</span></div>`;
  const close = `<button class="btn small" data-action="dismiss-job" data-job="${job.id}">닫기</button>`;
  switch (job.phase) {
    case 'queued':
      return `<div class="card job">${head('대기 중')}</div>`;
    case 'ocr':
      return `<div class="card job">${head(esc(job.note))}<div class="bar"><i style="width:${Math.round(job.progress * 100)}%"></i></div></div>`;
    case 'dup':
      return `<div class="card job">${head('<span class="muted">이미 저장한 이미지</span>')}<div class="row end">${close}</div></div>`;
    case 'error':
      return `<div class="card job">${head('<span class="bad">읽지 못했어요</span>')}<div class="small">${esc(job.error)}</div><div class="row end">${close}</div></div>`;
    case 'saved': {
      const rec = store.state.calls.find((c) => c.id === job.recId);
      if (!rec) return `<div class="card job">${head('<span class="muted">삭제됨</span>')}<div class="row end">${close}</div></div>`;
      return `<div class="card job">${head('<span class="ok">✓ 일지에 저장했어요</span>')}${callHtml(rec)}${share.promptHtml(rec)}
        <details><summary>OCR 원문 보기</summary><pre>${esc(rec.rawText)}</pre></details>
        <div class="row end">${close}</div></div>`;
    }
    case 'notcard':
      return `<div class="card job">${head('<span class="bad">콜카드로 인식하지 못했어요</span>')}
        <div class="small muted">아래 원문을 확인하고, 콜카드가 맞으면 그대로 저장한 뒤 직접 고쳐 주세요.</div>
        <details open><summary>OCR 원문 보기</summary><pre>${esc(job.raw)}</pre></details>
        <div class="row between"><button class="btn small" data-action="save-job" data-job="${job.id}">그래도 저장</button>${close}</div></div>`;
    default:
      return '';
  }
}

function renderResults() {
  $('#results').innerHTML = jobs.map(resultHtml).join('');
}

// ---------- 콜 수정/추가 창 ----------
const callDlg = $('#callDlg');
const callForm = $('#callForm');
let editingId = null;

function openCallDialog(id) {
  editingId = id;
  const rec = id == null ? null : store.state.calls.find((c) => c.id === id);
  $('#callDlgTitle').textContent = rec ? '콜 수정' : '콜 직접 추가';
  $('select[name=platform]', callForm).innerHTML = PLATFORMS.map(
    (p) => `<option value="${p.key}">${esc(p.label)}</option>`,
  ).join('');
  callForm.start.value = rec?.startAddr ?? '';
  callForm.end.value = rec?.endAddr ?? '';
  callForm.fare.value = rec ? rec.fare : '';
  callForm.fee.value = rec ? rec.fee : '';
  callForm.platform.value = rec?.platform ?? 'unknown';
  callForm.at.value = toLocalInput(rec?.at ?? Date.now());
  $('#rawText').value = rec?.rawText ?? '';
  $('#rawBox').hidden = !rec?.rawText;
  $('#callDelete').hidden = !rec;
  $('#callAnalyze').hidden = !rec?.endAddr;
  callDlg.showModal();
}

callForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const fare = parseMoney(callForm.fare.value) ?? 0;
  const feeInput = parseMoney(callForm.fee.value);
  const platform = callForm.platform.value;
  const rec = editingId == null ? null : store.state.calls.find((c) => c.id === editingId);
  const { fee, feeEstimated } = resolveEditedFee({ fare, feeInput, initial: rec, rateFor: store.rateFor(platform) });
  const at = callForm.at.value ? new Date(callForm.at.value).getTime() : Date.now();
  const startAddr = callForm.start.value.trim() || null;
  const endAddr = callForm.end.value.trim() || null;
  const patch = {
    startAddr,
    endAddr,
    // 주소를 고치면 좌표를 다시 구합니다
    ...(startAddr !== (rec?.startAddr ?? null) ? { startPos: null, startGeoFail: false } : {}),
    ...(endAddr !== (rec?.endAddr ?? null) ? { endPos: null, endGeoFail: false } : {}),
    fare,
    fee,
    feeEstimated,
    platform,
    at: Number.isFinite(at) ? at : Date.now(),
    needsReview: false,
    ...(rec && (rec.shareState === 'stale' || rec.shareState === 'future') ? { shareState: 'queued' } : {}),
  };
  if (rec) store.updateCall(rec.id, patch);
  else store.addCall({ ...patch, rawText: null, source: 'manual' });
  callDlg.close();
});
$('#callCancel').addEventListener('click', () => callDlg.close());
$('#callAnalyze').addEventListener('click', () => {
  const id = editingId;
  callDlg.close();
  if (id != null) mapTab.analyzeCall(id);
});
$('#callDelete').addEventListener('click', () => {
  if (editingId != null && confirm('이 기록을 삭제할까요?')) {
    store.deleteCall(editingId);
    callDlg.close();
  }
});

// ---------- 지출 창 ----------
const expDlg = $('#expDlg');
const expForm = $('#expForm');
const EXP_CATS = ['킥보드', '택시', '기름', '기타'];
let expCat = EXP_CATS[0];

function openExpenseDialog() {
  expCat = EXP_CATS[0];
  expForm.reset();
  $('#expCats').innerHTML = EXP_CATS.map(
    (c) => `<button type="button" class="chip" data-action="exp-cat" data-cat="${c}" aria-pressed="${c === expCat}">${c}</button>`,
  ).join('');
  expDlg.showModal();
}
expForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const amount = parseMoney(expForm.amount.value);
  if (!amount) return toast('금액을 입력해 주세요');
  store.addExpense({ at: Date.now(), category: expCat, amount, memo: expForm.memo.value.trim() });
  expDlg.close();
});
$('#expCancel').addEventListener('click', () => expDlg.close());

// ---------- 클릭 처리 ----------
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = Number(el.dataset.id);
  switch (el.dataset.action) {
    case 'toggle-work':
      store.toggleWork();
      break;
    case 'check-pick':
      runCheck(el.dataset.q);
      break;
    case 'check-consent':
      store.setSettings({ geoConsent: true });
      runCheck(lastQuery);
      break;
    case 'check-share':
      store.setSettings({ showShared: true });
      share.pullNow(true).finally(() => runCheck(lastQuery));
      break;
    case 'check-map':
      if (lastCheck) mapTab.showOnMap(lastCheck);
      break;
    case 'check-together': {
      if (!lastCheck) break;
      const text = lastCheck.together;
      if (navigator.share) {
        try {
          await navigator.share({ text });
          break;
        } catch {
          /* 취소하면 복사 */
        }
      }
      toast((await copyText(text)) ? '함께가기 문구를 복사했어요' : '복사하지 못했어요');
      break;
    }
    case 'add-expense':
      openExpenseDialog();
      break;
    case 'exp-cat':
      expCat = el.dataset.cat;
      $$('[data-action=exp-cat]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cat === expCat)));
      break;
    case 'del-expense':
      store.deleteExpense(id);
      break;
    case 'add-call':
      openCallDialog(null);
      break;
    case 'edit-call':
      openCallDialog(id);
      break;
    case 'month-prev':
    case 'month-next': {
      const d = new Date(month.y, month.m - 1 + (el.dataset.action === 'month-next' ? 1 : -1), 1);
      month = { y: d.getFullYear(), m: d.getMonth() + 1 };
      renderStats();
      break;
    }
    case 'dismiss-job': {
      const i = jobs.findIndex((j) => j.id === Number(el.dataset.job));
      if (i >= 0) jobs.splice(i, 1);
      renderResults();
      break;
    }
    case 'save-job': {
      const job = jobs.find((j) => j.id === Number(el.dataset.job));
      if (!job?.pending) break;
      const { parsed, raw, hash, file } = job.pending;
      const rec = store.addCall({ ...buildRecord(parsed, raw, file, hash), needsReview: true });
      job.recId = rec?.id ?? null;
      job.phase = 'saved';
      renderAll();
      break;
    }
    case 'copy-this-raw':
      toast((await copyText($('#rawText').value)) ? '복사했어요' : '복사하지 못했어요');
      break;
    case 'copy-raw': {
      const texts = store.state.calls.filter((c) => c.rawText).map((c, i) => `----- ${i + 1} (${fmtTime(c.at)}) -----\n${c.rawText}`);
      if (!texts.length) return toast('복사할 OCR 원문이 아직 없어요');
      toast((await copyText(texts.join('\n\n'))) ? `원문 ${texts.length}건을 복사했어요` : '복사하지 못했어요');
      break;
    }
    case 'export': {
      const d = new Date();
      download(`call-assistant-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`, store.exportJson(), 'application/json');
      break;
    }
    case 'import':
      $('#importInput').click();
      break;
    case 'clear-all':
      if (confirm('모든 기록과 설정을 삭제할까요? 되돌릴 수 없어요.\n(먼저 백업 파일을 내려받는 걸 권장해요)')) {
        store.clearAll();
        renderSettings();
        toast('모두 삭제했어요');
      }
      break;
  }
});

// 키보드로도 카드를 열 수 있게
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-action=edit-call]')) {
    e.preventDefault();
    e.target.click();
  }
});

// ---------- 설정 입력 ----------
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'fee-default') {
    const v = Number.parseFloat(t.value);
    if (Number.isFinite(v) && v >= 0 && v <= 100) store.setSettings({ defaultFeeRate: v });
    else t.value = store.state.settings.defaultFeeRate;
  } else if (t.id?.startsWith('fee-')) {
    const key = t.id.slice(4);
    const v = Number.parseFloat(t.value);
    if (t.value.trim() === '') store.setPlatformRate(key, null);
    else if (Number.isFinite(v) && v >= 0 && v <= 100) store.setPlatformRate(key, v);
    else t.value = store.state.settings.platformRates[key] ?? '';
  } else if (t.id === 'fontPref') {
    FontPref.save(t.value);
  } else if (t.id === 'themePref') {
    try {
      if (t.value === 'auto') localStorage.removeItem('call-assistant-theme');
      else localStorage.setItem('call-assistant-theme', t.value);
    } catch {}
    if (t.value === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t.value;
  } else if (t.id === 'cutoff') {
    const v = Number.parseInt(t.value, 10);
    if (Number.isInteger(v) && v >= 0 && v <= 12) store.setSettings({ cutoffHour: v });
    else t.value = store.state.settings.cutoffHour;
  } else if (t.id === 'importInput' && t.files?.[0]) {
    t.files[0]
      .text()
      .then((text) => {
        store.importJson(text);
        renderSettings();
        toast('백업을 불러왔어요');
      })
      .catch((err) => toast(err.message ?? '불러오지 못했어요'))
      .finally(() => (t.value = ''));
  }
});

// ---------- 이미지 올리기: 선택 · 끌어놓기 · 붙여넣기 ----------
const drop = $('#drop');
const fileInput = $('#fileInput');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (files.length) handleFiles(files);
});
for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      drop.classList.add('over');
    }
  });
}
for (const type of ['dragleave', 'drop']) {
  document.addEventListener(type, () => drop.classList.remove('over'));
}
document.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  }
});
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    handleFiles(files);
  }
});

// ---------- 시작 ----------
store.subscribe(() => {
  renderAll();
  mapTab.refresh();
  share.refresh();
});
setInterval(() => {
  if (store.isWorking() && !$('#tab-home').hidden && !document.hidden) renderHome();
}, 15_000);
showTab(location.hash.slice(1));
share.refresh();
