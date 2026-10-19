// 로그인 화면(구글)과 설정의 계정 칸. 구글 로그인 버튼은 구글 공식 스크립트(accounts.google.com/gsi/client)를 쓰고,
// 받은 구글 신분증(ID 토큰)을 Firebase 로그인으로 바꿔 저장합니다. (js/share-firebase.js 의 signInWithGoogle)
//
// 안전장치: js/firebase-config.js 에 googleClientId 가 없으면 로그인을 요구하지 않습니다 (설정 실수로 앱이 잠기지 않게).

import { firebase } from './share-sync.js';
import { firebaseConfig } from './firebase-config.js';

const GSI = 'https://accounts.google.com/gsi/client';

export function loginRequired() {
  return Boolean(firebase.configured() && firebaseConfig.googleClientId && !firebase.isLoggedIn());
}

export function initAuth({ esc, toast, onLogin }) {
  const gate = document.querySelector('#loginGate');
  let gsiLoading = null;

  const loadGsi = () =>
    (gsiLoading ??= new Promise((resolve, reject) => {
      if (window.google?.accounts?.id) return resolve();
      const s = document.createElement('script');
      s.src = GSI;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('구글 로그인 스크립트를 불러오지 못했어요 (인터넷 확인)'));
      document.head.appendChild(s);
    }));

  function say(msg) {
    const el = gate.querySelector('.gate-msg');
    el.textContent = msg ?? '';
    el.hidden = !msg;
  }

  function friendly(e) {
    const m = String(e?.message ?? e);
    if (/INVALID_IDP_RESPONSE|audience|client/i.test(m))
      return '구글 로그인 설정이 맞지 않아요. Firebase 콘솔에서 Google 로그인을 켜고, 이 사이트 주소가 승인된 도메인인지 확인하세요';
    return m;
  }

  async function onCredential(resp) {
    say('');
    gate.classList.add('busy');
    try {
      await firebase.signInWithGoogle(resp.credential);
      gate.hidden = true;
      document.body.classList.remove('locked');
      toast('로그인했어요');
      onLogin?.();
    } catch (e) {
      say(friendly(e));
    } finally {
      gate.classList.remove('busy');
    }
  }

  async function showGate() {
    gate.hidden = false;
    document.body.classList.add('locked');
    try {
      await loadGsi();
      window.google.accounts.id.initialize({ client_id: firebaseConfig.googleClientId, callback: onCredential, auto_select: false, cancel_on_tap_outside: true });
      window.google.accounts.id.renderButton(gate.querySelector('#gBtn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', locale: 'ko', width: 280 });
    } catch (e) {
      say(friendly(e));
    }
  }

  function renderAccount() {
    const box = document.querySelector('#accountBox');
    if (!box) return;
    const a = firebase.account();
    if (a) {
      const initial = esc((a.name || a.email || '?').trim().charAt(0).toUpperCase());
      box.innerHTML = `<div class="acct"><span class="avatar" aria-hidden="true">${initial}</span>
        <span class="who"><b>${esc(a.name || '구글 계정')}</b><small>${esc(a.email)}</small></span>
        <button class="btn small" data-action="auth-logout">로그아웃</button></div>`;
    } else if (firebase.configured() && !firebaseConfig.googleClientId) {
      box.innerHTML = '<div class="small warn-text">구글 로그인 설정이 비어 있어요. js/firebase-config.js 에 googleClientId 를 넣으면 로그인이 켜져요 (README 참고)</div>';
    } else {
      box.innerHTML = '<div class="small muted">로그인 안 됨</div>';
    }
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-action="auth-logout"]')) return;
    if (!confirm('로그아웃할까요? 이 기기의 일지는 그대로 남아 있어요.')) return;
    firebase.signOut();
    location.reload();
  });

  if (loginRequired()) showGate();
  return { renderAccount, showGate };
}
