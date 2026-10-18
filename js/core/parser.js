// OCR 텍스트에서 콜카드 값(일시·출발지·도착지·요금)을 뽑는 규칙 기반 파서.
//
// 실제 콜카드(법인콜 상세, 수입 및 운행내역, 운행 상세 정보 등)를 보고 다음 특징에 맞췄습니다.
//  - 출발지/도착지 칸은 글자가 여러 줄이고, 라벨("출발지")이 칸의 "가운데"에 있어서 값이 라벨 줄의 위·아래에 나뉘어 읽힙니다.
//  - OCR이 라벨을 못 읽는 경우가 있어서, 라벨이 없으면 주소처럼 생긴 줄로 찾습니다.
//  - 날짜·시간은 카드마다 "접수시간/배차시간/운행일자/운행시간" 등 형식이 다릅니다.
//  - 요금 옆에 "(수익금:84,969원)"처럼 실제 수익이 함께 적힌 카드가 있습니다.
// 새 형식이 나오면 이 파일과 test/core.test.js 에 사례를 추가하는 방식으로 넓혀 가세요.

export const PLATFORMS = [
  { key: 'kakao', label: '카카오T', keywords: ['카카오', 'kakao'] },
  { key: 'logi', label: '로지', keywords: ['로지'] },
  { key: 'collmaner', label: '콜마너', keywords: ['콜마너'] },
  { key: 'tmap', label: '티맵', keywords: ['tmap', '티맵'] },
  { key: 'ilgu', label: '일구대리', keywords: ['일구대리'] },
  { key: 'corporate', label: '법인콜', keywords: ['법인', '지사명'] },
  { key: 'unknown', label: '기타', keywords: [] },
];

export function platformLabel(key) {
  return (PLATFORMS.find((p) => p.key === key) ?? PLATFORMS.at(-1)).label;
}

export function detectPlatform(text) {
  const lower = text.toLowerCase();
  const hit = PLATFORMS.find((p) => p.keywords.some((k) => lower.includes(k)));
  return hit ? hit.key : 'unknown';
}

// ---------- 정규식 재료 ----------
// OCR 이 한글 글자 사이에 공백을 끼워 넣는 경우("출 발 지")를 견디도록 라벨 글자 사이에 공백을 허용합니다.
const sp = (word) => [...word].join('\\s*');
const alt = (words) =>
  words
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(sp)
    .join('|');
const PRE = '[\\s\\[\\](){}<>•·\\-*▶▷◆◇■□●○|]*';
// "출발 전 고객통화", "출발시간 23:10" 같은 줄은 출발지 라벨이 아닙니다.
const NOT_PLACE = '(?!\\s*(?:시간|시각|예정|전(?:\\s|$)|후(?:\\s|$)))';

const startLabel = new RegExp(`^${PRE}(?:${alt(['출발지', '출발', '픽업'])})${NOT_PLACE}\\s*[:：]?\\s*(.*)$`);
const endLabel = new RegExp(`^${PRE}(?:${alt(['도착지', '도착', '목적지', '하차'])})${NOT_PLACE}\\s*[:：]?\\s*(.*)$`);
const otherLabel = new RegExp(
  `^${PRE}(?:${alt([
    '요금', '확정요금', '현금', '입금액', '입금합계', '차감합계', '적요', '출도', '고객정보', '상황실',
    '접수시간', '배차시간', '법인명', '운행번호', '지사명', '고객명', '오더번호', '차량번호', '운행일자',
    '운행시간', '실수익', '총수입', '메모', '고객', '전화', '발주사', '보험종류', '보험사', '수익금',
  ])})`,
);
const fareLabel = new RegExp(
  `^${PRE}(?:(?:${alt(['총', '예상', '최종', '확정'])})\\s*)?(?:${sp('요금')}|${sp('운임')}|${sp('결제')}\\s*${sp('금액')}|${sp('콜비')})(.*)$`,
);
const feeWord = new RegExp(sp('수수료'));
const netLabel = new RegExp(`^${PRE}(?:${alt(['실수익', '총수입'])})(.*)$`);
const netInline = new RegExp(`(?:${sp('예상')}\\s*)?${sp('수익금')}\\s*[:：]?\\s*(\\d{1,3}(?:,\\d{3})+|\\d{4,})`);

const amountReG = /(\d{1,3}(?:,\d{3})+|\d+)\s*원/g;
const commaAmountReG = /(\d{1,3}(?:,\d{3})+)/g; // "50,400P", "52,00002"(P를 0으로 읽은 경우)처럼 원이 없는 금액
const bareAmountRe = /(\d{1,3}(?:,\d{3})+|\d{4,})/;
const percentRe = /(\d+(?:\.\d+)?)\s*%/;
// 화살표: 기호가 제대로 읽힌 경우, 또는 OCR 이 화살표를 "ㅜㅠ", "=", "-" 같은 글자로 잘못 읽은 경우(양쪽에 공백 필요)
const arrowRe = /\s*(?:→|->|=>|–>|—>|▶|▷|➔|➜)\s*|\s+(?:ㅜㅠ|ㅠㅜ|ㅜ|ㅠ|=|-|>)\s+/;
const notRouteRe = /\d\s*원|%|수수료|요금|운임|금액|\d{2,}:\d{2}/;
const labelPrefixRe = new RegExp(`^(?:${alt(['출발지', '출발', '도착지', '도착', '픽업', '목적지', '하차'])})\\s*[:：]?\\s*`);

const KEYWORDS = ['출발', '도착', '수수료', '요금', '운임', '콜', '대리', '정산', '운행', '배차', '접수', '수익'];
const FARE_NOISE = ['지원', '할인', '포인트', '적립', '보너스', '프로모션', '쿠폰', '잔액'];

const validFare = (n) => Number.isFinite(n) && n >= 1000 && n <= 1_000_000;
const toInt = (s) => Number.parseInt(String(s).replaceAll(',', ''), 10);
const firstMatch = (re, s) => {
  re.lastIndex = 0;
  const m = re.exec(s);
  re.lastIndex = 0;
  return m;
};

function amountsIn(s) {
  return [...s.matchAll(amountReG)].map((m) => toInt(m[1])).filter(Number.isFinite);
}
function commaAmountsIn(s) {
  return [...s.matchAll(commaAmountReG)].map((m) => toInt(m[1])).filter(Number.isFinite);
}
/** 줄에서 금액 하나: "40000원"/"39,296원" 우선, 없으면 쉼표 금액("50,400P") */
function firstAmount(s) {
  return amountsIn(s).find(validFare) ?? commaAmountsIn(s).find(validFare) ?? null;
}

function clean(s) {
  return s.trim().replace(/^[:：\-–\s]+/, '').trim();
}

// ---------- 주소 다루기 ----------
const REGIONS = '서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주';
const regionRe = new RegExp(`(?:${REGIONS})(?=\\s|특별|광역|자치|도|시|[가-힣])`);
const adminRe = /[가-힣]{1,6}(?:시|군|구|읍|면|동|리|로|길)(?![가-힣])/g;
const junkChars = /[{}<>_~^|=※@]/g;

/** 앞쪽 잡글자("상세:", "후)", "<<<0)후)")를 지우고 뒤쪽 시각·기호를 정리합니다. */
export function cleanAddress(raw) {
  let s = raw.replace(/\s+/g, ' ').trim();
  const m = regionRe.exec(s);
  if (m && m.index > 0 && m.index <= 12) s = s.slice(m.index);
  else s = s.replace(/^[\s:：\-–_=~*|<>{}\[\]()·•▶▷◆◇■□●○★☆♥♡"'`.,0-9a-zA-Z]{1,6}(?=[가-힣])/, '');
  s = s.replace(/\s*\d{1,2}\s*[:：]\s*\d{2}\s*\/?\s*$/, '');
  s = s.replace(/[\s/()\[\]{}<>@\\|_\-:：,.]+$/, '');
  return s.trim();
}

/** 주소처럼 보이는 정도. 시·구·동 같은 행정구역 낱말, 도/시 이름, 지번이 많을수록 높고 OCR 쓰레기 글자는 깎습니다. */
export function addressScore(text) {
  const s = cleanAddress(text);
  if (!s) return 0;
  let score = (s.match(adminRe) ?? []).length;
  if (regionRe.test(s)) score += 2;
  if (/\d+-\d+/.test(s)) score += 1;
  score -= 0.4 * (s.match(junkChars) ?? []).length;
  return score > 0 ? score : 0;
}

// 화면의 버튼 글자("지도 처리 취소" 등)가 주소로 잘못 뽑히지 않게 거릅니다.
const UI_WORDS = ['지도', '처리', '취소', '전화', '완료', '닫기', '확인', '복사', '길찾기', '내비', '문자', '수정', '상세', '보기', '배차', '이동', '출발', '도착', '운행'];
const uiOnlyRe = new RegExp(`^(?:${UI_WORDS.join('|')})$`);
export function isUiText(text) {
  const words = String(text).replace(/[^가-힣\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => uiOnlyRe.test(w));
}

function pickPlace(lines, i, label, claimed, labelLines) {
  const m = label.exec(lines[i]);
  const own = m ? clean(m[1]) : '';
  const cands = [];
  if (own) cands.push({ idx: i, text: own, kind: 0 });
  // 라벨이 칸의 가운데에 있어서 값이 라벨 줄 바로 아래/위에도 나뉘어 읽힙니다.
  for (const [d, kind] of [[1, 1], [-1, 2]]) {
    const j = i + d;
    if (j < 0 || j >= lines.length || claimed.has(j) || labelLines.has(j)) continue;
    cands.push({ idx: j, text: lines[j], kind });
  }
  for (let k = cands.length - 1; k >= 0; k--) if (isUiText(cands[k].text)) cands.splice(k, 1);
  for (const c of cands) c.score = addressScore(c.text);
  const scored = cands.filter((c) => c.score > 0).sort((a, b) => b.score - a.score || a.kind - b.kind);
  let best = scored[0];
  if (!best) {
    // 행정구역 낱말이 없는 짧은 이름("수원역 4번 출구")은 라벨 바로 옆/아래 줄을 그대로 씁니다.
    best = cands.find((c) => c.kind <= 1 && /[가-힣]/.test(clean(c.text)));
    if (!best) return null;
  }
  claimed.add(best.idx);
  let value = cleanAddress(best.text) || clean(best.text);
  // 칸 안에서 줄이 바뀐 짧은 뒷부분("초장")은 이어 붙입니다.
  const nextIdx = best.idx + 1;
  const next = lines[nextIdx];
  if (best.kind !== 2 && next && !claimed.has(nextIdx) && !labelLines.has(nextIdx) && /^[가-힣]{2,8}$/.test(next)) {
    value = `${value} ${next}`;
    claimed.add(nextIdx);
  }
  return value ? { value, idx: best.idx } : null;
}

// ---------- 날짜·시간 ----------
const dateRe = /(20\d{2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/;
const timeRe = /(?:(오전|오후)\s*)?(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*(\d{2}))?/;

function parseDate(s) {
  const m = dateRe.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d, rest: s.replace(m[0], ' ') };
}

function parseTime(s) {
  const m = timeRe.exec(s);
  if (!m) return null;
  let h = Number(m[2]);
  const mi = Number(m[3]);
  if (m[1] === '오후' && h < 12) h += 12;
  if (m[1] === '오전' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

const TIME_FIELDS = [
  { word: '운행일자', source: 'run' }, // 날짜 + 시작 시각 ("2026.5.19 (화) 15:44 ~ 17:19")
  { word: '배차시간', source: 'dispatch' },
  { word: '접수시간', source: 'receipt' },
  { word: '운행시간', source: 'runtime' }, // 시각만 ("00:18 ~ 01:04")
].map((f) => ({ ...f, re: new RegExp(`^${PRE}${sp(f.word)}\\s*[:：]?\\s*(.*)$`) }));

/** 카드에 적힌 날짜·시간. 우선순위: 운행일자 > 배차시간 > 접수시간 > 운행시간 > 줄 어디든 있는 날짜 */
function extractWhen(lines) {
  const found = [];
  for (const f of TIME_FIELDS) {
    const i = lines.findIndex((l) => f.re.test(l));
    if (i < 0) continue;
    let rest = f.re.exec(lines[i])[1];
    const d = parseDate(rest);
    const t = parseTime(d ? d.rest : rest);
    found.push({ source: f.source, date: d ? { y: d.y, m: d.m, d: d.d } : null, time: t });
  }
  const withTime = found.find((c) => c.time);
  if (withTime) {
    // 고른 항목의 날짜가 안 읽혔으면 같은 카드의 다른 시각 항목에서 날짜를 빌립니다.
    const date = withTime.date ?? found.find((c) => c.date)?.date ?? null;
    return { date, time: withTime.time, source: withTime.source };
  }
  const dateOnly = found.find((c) => c.date);
  if (dateOnly) return { date: dateOnly.date, time: null, source: dateOnly.source };
  for (const line of lines) {
    const d = parseDate(line);
    if (d) return { date: { y: d.y, m: d.m, d: d.d }, time: parseTime(d.rest), source: 'text' };
  }
  return { date: null, time: null, source: null };
}

/**
 * 카드에서 읽은 날짜·시간과 캡처 시각(referenceMs)으로 콜 시각을 정합니다.
 * @returns {{at:number, basis:'card'|'card-time'|'card-date'|'reference'}}
 *   card: 날짜·시간 모두 카드 / card-time: 시간만 카드, 날짜는 캡처 시각 기준 추정 /
 *   card-date: 날짜만 카드 / reference: 캡처 시각 그대로
 */
export function resolveCallTime(when, referenceMs) {
  const ref = new Date(referenceMs);
  if (when?.date && when?.time) {
    const { y, m, d } = when.date;
    return { at: new Date(y, m - 1, d, when.time.h, when.time.mi).getTime(), basis: 'card' };
  }
  if (when?.time) {
    const t = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), when.time.h, when.time.mi);
    // 캡처 시각보다 한참 뒤의 시각이면 어제 일입니다 (예: 새벽 00:18 에 한 콜을 오전에 캡처한 경우는 같은 날)
    if (t.getTime() > referenceMs + 30 * 60_000) t.setDate(t.getDate() - 1);
    return { at: t.getTime(), basis: 'card-time' };
  }
  if (when?.date) {
    const { y, m, d } = when.date;
    return { at: new Date(y, m - 1, d, ref.getHours(), ref.getMinutes()).getTime(), basis: 'card-date' };
  }
  return { at: referenceMs, basis: 'reference' };
}

// ---------- 본체 ----------
/**
 * @returns {{platform:string,start:string|null,end:string|null,fare:number|null,
 *            feeAmount:number|null,feeRatePercent:number|null,netAmount:number|null,
 *            when:{date:{y:number,m:number,d:number}|null,time:{h:number,mi:number}|null,source:string|null},
 *            keywordHits:number,isCallCard:boolean}}
 */
export function parseCallCard(raw) {
  const lines = raw
    .replaceAll(' ', ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const labelLines = new Set();
  lines.forEach((l, i) => {
    if (startLabel.test(l) || endLabel.test(l) || otherLabel.test(l)) labelLines.add(i);
  });

  // 1) 출발지·도착지
  const claimed = new Set();
  let start = null;
  let end = null;
  let startIdx = -1;
  let endIdx = -1;
  const sIdx = lines.findIndex((l) => startLabel.test(l));
  if (sIdx >= 0) {
    const r = pickPlace(lines, sIdx, startLabel, claimed, labelLines);
    if (r) [start, startIdx] = [r.value, r.idx];
  }
  const eIdx = lines.findIndex((l) => endLabel.test(l));
  if (eIdx >= 0) {
    const r = pickPlace(lines, eIdx, endLabel, claimed, labelLines);
    if (r) [end, endIdx] = [r.value, r.idx];
  }
  // 라벨을 OCR 이 못 읽은 쪽은 주소처럼 생긴 줄로 찾습니다.
  if (start !== null && end === null) {
    for (let j = startIdx + 1; j < Math.min(lines.length, startIdx + 8); j++) {
      if (claimed.has(j) || labelLines.has(j)) continue;
      if (addressScore(lines[j]) >= 2) {
        end = cleanAddress(lines[j]);
        claimed.add(j);
        break;
      }
    }
  } else if (end !== null && start === null) {
    for (let j = endIdx - 1; j >= Math.max(0, endIdx - 6); j--) {
      if (claimed.has(j) || labelLines.has(j)) continue;
      if (addressScore(lines[j]) >= 3) {
        start = cleanAddress(lines[j]);
        claimed.add(j);
        break;
      }
    }
  }

  // 라벨이 없는 카드: "출발 → 도착" 한 줄 형태
  if (start === null && end === null) {
    for (const line of lines) {
      const parts = line.split(arrowRe);
      if (parts.length === 2) {
        const a = clean(parts[0].replace(labelPrefixRe, ''));
        const b = clean(parts[1].replace(labelPrefixRe, ''));
        if (a.length >= 2 && b.length >= 2 && !notRouteRe.test(a) && !notRouteRe.test(b)) {
          start = a;
          end = b;
          break;
        }
      }
    }
  }

  // 2) 요금·수익·수수료
  let fare = null;
  let net = null;
  let feeAmount = null;
  let feeRate = null;
  let fareLabeled = false;
  lines.forEach((line, i) => {
    if (fare === null) {
      const m = fareLabel.exec(line);
      if (m) {
        const rest = m[1].split('수수료')[0];
        let a = amountsIn(rest).find(validFare);
        if (a === undefined) {
          const bare = bareAmountRe.exec(rest);
          a = bare && validFare(toInt(bare[1])) ? toInt(bare[1]) : undefined;
        }
        if (a === undefined && lines[i + 1] !== undefined && !feeWord.test(lines[i + 1])) {
          a = amountsIn(lines[i + 1]).find(validFare);
        }
        if (a !== undefined) {
          fare = a;
          fareLabeled = true;
        }
      }
    }
    if (net === null) {
      const inline = netInline.exec(line);
      if (inline && validFare(toInt(inline[1]))) net = toInt(inline[1]);
    }
    if (feeAmount === null && feeRate === null && feeWord.test(line)) {
      let seg = line.split('수수료').slice(1).join('수수료');
      if (amountsIn(seg).length === 0 && !percentRe.test(seg) && lines[i + 1] !== undefined) seg = lines[i + 1];
      feeAmount = amountsIn(seg)[0] ?? null;
      if (feeAmount === null) {
        const pm = percentRe.exec(seg);
        feeRate = pm ? Number.parseFloat(pm[1]) : null;
      }
    }
  });
  if (net === null) {
    for (let i = 0; i < lines.length && net === null; i++) {
      const m = netLabel.exec(lines[i]);
      if (!m) continue;
      let a = firstAmount(m[1]);
      if (a === null && lines[i + 1] !== undefined) a = firstAmount(lines[i + 1]);
      if (a !== null) net = a;
    }
  }

  // 요금 라벨이 없으면: 수익(실수익·총수입)을 요금으로, 그것도 없으면 수수료/할인 줄을 뺀 금액 중 가장 큰 값
  if (fare === null && net !== null) {
    fare = net;
    feeAmount = 0;
  } else if (fare === null) {
    const cands = lines
      .filter((l) => !feeWord.test(l) && !FARE_NOISE.some((w) => l.includes(w)))
      .flatMap((l) => [...amountsIn(l), ...commaAmountsIn(l)])
      .filter(validFare);
    fare = cands.length ? Math.max(...cands) : null;
  } else if (fareLabeled && net !== null && net <= fare) {
    // "요금 90,000원 (수익금:84,969원)" → 차감액(수수료·세금·보험) = 요금 - 수익금
    feeAmount = fare - net;
    feeRate = null;
  }

  const when = extractWhen(lines);
  const keywordHits = KEYWORDS.filter((k) => raw.includes(k)).length;
  const signals =
    (start !== null ? 1 : 0) + (end !== null ? 1 : 0) + (fare !== null ? 1 : 0) + (when.date || when.time ? 1 : 0);
  const isCallCard =
    (keywordHits >= 2 && (fare !== null || (start !== null && end !== null))) ||
    ((start !== null || end !== null) && signals >= 2);

  return {
    platform: detectPlatform(raw),
    start,
    end,
    fare,
    feeAmount,
    feeRatePercent: feeRate,
    netAmount: net,
    when,
    keywordHits,
    isCallCard,
  };
}

const phoneRe = /0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4}|(?<!\d)1[5-8]\d{2}[-\s]?\d{4}(?!\d)/g;

/** 콜카드 텍스트를 저장하기 전에 전화번호(휴대폰·대표번호)를 지웁니다. */
export function maskPhones(text) {
  return text.replace(phoneRe, '[전화번호]');
}
