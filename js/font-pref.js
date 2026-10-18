// 글꼴 선택. 고른 글꼴의 CSS 만 불러오므로 기본 사용 시 추가 용량이 들지 않습니다. (클래식 스크립트: 깜빡임 방지를 위해 <head> 에서 바로 실행)
(function () {
  var KEY = 'call-assistant-font';
  var FALLBACK = "system-ui, -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif";
  var FONTS = {
    default: { label: '기본 (IBM Plex Sans KR · 숫자 도현체)' },
    'noto-sans-kr': { label: '노토 산스 (깔끔한 고딕)', family: 'Noto Sans KR', css: 'noto-sans-kr.css' },
    'nanum-gothic': { label: '나눔고딕 (익숙한 고딕)', family: 'Nanum Gothic', css: 'nanum-gothic.css' },
    'gowun-dodum': { label: '고운돋움 (부드럽고 둥근 느낌)', family: 'Gowun Dodum', css: 'gowun-dodum.css' },
    'nanum-myeongjo': { label: '나눔명조 (단정한 명조)', family: 'Nanum Myeongjo', css: 'nanum-myeongjo.css' },
    system: { label: '기기 기본 글꼴 (가장 빠름)', family: null },
  };
  function apply(id) {
    var f = FONTS[id] || FONTS.default;
    var root = document.documentElement;
    if (!FONTS[id] || id === 'default') {
      root.style.removeProperty('--font');
      root.style.removeProperty('--font-num');
      root.style.removeProperty('--num-w');
      return;
    }
    if (f.css && !document.querySelector('link[data-font="' + id + '"]')) {
      var l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = 'vendor/fonts/' + f.css;
      l.setAttribute('data-font', id);
      document.head.appendChild(l);
    }
    var stack = (f.family ? "'" + f.family + "', " : '') + FALLBACK;
    root.style.setProperty('--font', stack);
    root.style.setProperty('--font-num', stack);
    root.style.setProperty('--num-w', '700');
  }
  function saved() {
    try { return localStorage.getItem(KEY) || 'default'; } catch (e) { return 'default'; }
  }
  function save(id) {
    try { if (id === 'default') localStorage.removeItem(KEY); else localStorage.setItem(KEY, id); } catch (e) {}
    apply(id);
  }
  window.FontPref = { FONTS: FONTS, apply: apply, saved: saved, save: save };
  apply(saved());
})();
