// 콜카드 주소(OCR 결과)를 지도 검색에 쓸 수 있는 후보 문장들로 바꿉니다.
// OCR 주소는 "수원시영통구"처럼 띄어쓰기가 없거나, 뒤에 건물명·번호가 붙어 있어서
// 한 번에 검색되지 않는 일이 많습니다. 그래서 "자세한 것 → 대략적인 것" 순서로 여러 후보를 만듭니다.

const PROVINCES = {
  서울: '서울특별시', 부산: '부산광역시', 대구: '대구광역시', 인천: '인천광역시', 광주: '광주광역시',
  대전: '대전광역시', 울산: '울산광역시', 세종: '세종특별자치시', 경기: '경기도', 강원: '강원특별자치도',
  충북: '충청북도', 충남: '충청남도', 전북: '전북특별자치도', 전남: '전라남도', 경북: '경상북도', 경남: '경상남도', 제주: '제주특별자치도',
};

export function normalizeAddress(raw) {
  let s = String(raw ?? '')
    .replace(/\([^)]*\)?/g, ' ') // (건물명) 제거
    .replace(/[<>{}|_~^=※@"'`]/g, ' ')
    .replace(/([가-힣]{1,4}[시군])([가-힣]{1,4}구)/g, '$1 $2') // 수원시영통구 → 수원시 영통구
    .replace(/([가-힣]{1,4}[읍면])([가-힣]{1,6}[리])(?![가-힣])/g, '$1 $2') // 모가면두미리 → 모가면 두미리
    .replace(/([가-힣]{1,4}시)([가-힣]{1,4}[읍면동])(?![가-힣])/g, '$1 $2') // 용인시백암면 → 용인시 백암면
    .replace(/\s+/g, ' ')
    .trim();
  // 같은 낱말이 연달아 두 번 나오면 하나로 ("반포동 반포동 110")
  s = s.replace(/(^|\s)(\S+)(\s+\2)+(?=\s|$)/g, '$1$2');
  return s;
}

/** 지도 검색에 쓸 후보 목록 (앞에 있을수록 구체적). 중복 없음. */
export function addressCandidates(raw, { min = 2, max = 6 } = {}) {
  const norm = normalizeAddress(raw);
  const tokens = norm.split(' ').filter(Boolean);
  if (tokens.length < min) return [];
  const expand = (ts) => (PROVINCES[ts[0]] ? [PROVINCES[ts[0]], ...ts.slice(1)] : ts);
  const out = [];
  const add = (ts) => {
    if (ts.length < min) return;
    const s = expand(ts).join(' ');
    if (!out.includes(s)) out.push(s);
  };
  // 한글이 거의 없는 토큰(번호 등)은 한 단계로 건너뛰어도 되지만, 그냥 뒤에서부터 하나씩 줄입니다.
  for (let n = tokens.length; n >= min; n--) {
    const slice = tokens.slice(0, n);
    // 건물명처럼 보이는 마지막 토큰(번지수가 아닌 한글 낱말)이 행정구역 단위가 아니면 한 번 더 건너뜀
    add(slice);
    if (out.length >= max) break;
  }
  return out;
}

/** 지도에 보여줄 짧은 이름 ("용인시 처인구 양지읍") */
export function shortLabel(raw) {
  const tokens = normalizeAddress(raw).split(' ').filter(Boolean);
  const body = tokens[0] in PROVINCES || Object.values(PROVINCES).includes(tokens[0]) ? tokens.slice(1) : tokens;
  const keep = [];
  for (const t of body) {
    if (/^\d/.test(t)) break;
    keep.push(t);
    if (/[동읍면리가]$/.test(t)) break;
  }
  return keep.slice(0, 4).join(' ') || tokens.slice(0, 3).join(' ');
}
