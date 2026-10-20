// 로그인 화면(이메일 간편 가입 + 구글)과 설정의 계정 칸.
//  - 이메일 가입: 이름·이메일·비밀번호 → Firebase 가 인증 메일을 보냄 → 메일의 링크를 누르면 본인(이메일) 확인 끝
//  - 구글: 구글 공식 스크립트(accounts.google.com/gsi/client)로 받은 ID 토큰을 Firebase 로그인으로 바꿈
//
// 안전장치: js/firebase-config.js 에 googleClientId 도 requireLogin 도 없으면 로그인을 요구하지 않습니다 (설정 실수로 앱이 잠기지 않게).

import { firebase } from './share-sync.js';
import { firebaseConfig } from './firebase-config.js';

const GSI = 'https://accounts.google.com/gsi/client';

export function loginRequired() {
  return Boolean(firebase.configured() && (firebaseConfig.googleClientId || firebaseConfig.requireLogin) && !firebase.isLoggedIn());
}

export function initAuth({ esc, toast, onLogin }) {
  const gate = document.querySelector('#loginGate');
  const banner = document.querySelector('#verifyBanner');
  const $g = (sel) => gate.querySelector(sel);
  let gsiLoading = null;
  let mode = 'login';

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

  function say(msg, ok = false) {
    const el = $g('.gate-msg');
    el.textContent = msg ?? '';
    el.hidden = !msg;
    el.classList.toggle('ok', ok);
  }

  function friendly(e) {
    const m = String(e?.message ?? e);
    if (/INVALID_IDP_RESPONSE|audience|client/i.test(m))
      return '구글 로그인 설정이 맞지 않아요. Firebase 콘솔에서 Google 로그인을 켜고, 이 사이트 주소가 승인된 도메인인지 확인하세요';
    return m;
  }

  function setMode(next) {
    mode = next;
    const signup = mode === 'signup';
    gate.querySelectorAll('[data-action="gate-mode"]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $g('#gName').hidden = !signup;
    $g('#gConsent').hidden = !signup;
    $g('#gReset').hidden = signup;
    $g('#gPass').autocomplete = signup ? 'new-password' : 'current-password';
    $g('#gSubmit').textContent = signup ? '가입하고 인증 메일 받기' : '로그인';
    say('');
  }

  function finishLogin(msg) {
    gate.hidden = true;
    document.body.classList.remove('locked');
    renderVerify();
    toast(msg);
    onLogin?.();
  }

  async function onCredential(resp) {
    say('');
    gate.classList.add('busy');
    try {
      await firebase.signInWithGoogle(resp.credential);
      finishLogin('로그인했어요');
    } catch (e) {
      say(friendly(e));
    } finally {
      gate.classList.remove('busy');
    }
  }

  async function submitMail(e) {
    e.preventDefault();
    const email = $g('#gEmail').value.trim();
    const password = $g('#gPass').value;
    const name = $g('#gName').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return say('이메일 주소를 확인해 주세요');
    if (password.length < 6) return say('비밀번호는 6자 이상이에요');
    if (mode === 'signup') {
      if (!name) return say('이름을 입력해 주세요');
      if (!$g('#gAgree').checked) return say('수집 동의에 체크해 주세요');
    }
    gate.classList.add('busy');
    try {
      if (mode === 'signup') {
        await firebase.signUpEmail({ email, password, name });
        finishLogin('가입했어요. 메일의 인증 링크를 눌러 주세요');
      } else {
        await firebase.signInEmail({ email, password });
        finishLogin('로그인했어요');
      }
    } catch (err) {
      say(err.message);
    } finally {
      gate.classList.remove('busy');
    }
  }

  async function resetPassword() {
    const email = $g('#gEmail').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return say('위 칸에 이메일을 먼저 입력해 주세요');
    try {
      await firebase.sendPasswordReset(email);
      say('비밀번호 재설정 메일을 보냈어요. 메일함(스팸함 포함)을 확인하세요', true);
    } catch (err) {
      say(err.message);
    }
  }

  async function showGate() {
    gate.hidden = false;
    document.body.classList.add('locked');
    const hasGoogle = Boolean(firebaseConfig.googleClientId);
    $g('#gOr').hidden = !hasGoogle;
    $g('#gBtn').hidden = !hasGoogle;
    if (!hasGoogle) return;
    try {
      await loadGsi();
      window.google.accounts.id.initialize({ client_id: firebaseConfig.googleClientId, callback: onCredential, auto_select: false, cancel_on_tap_outside: true });
      window.google.accounts.id.renderButton($g('#gBtn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', locale: 'ko', width: 280 });
    } catch (e) {
      say(friendly(e));
    }
  }

  // ---------- 이메일 인증 안내 ----------
  const needsVerify = () => {
    const a = firebase.account();
    return Boolean(a && a.provider === 'password' && !a.verified);
  };
  function renderVerify() {
    if (banner) banner.hidden = !needsVerify();
    renderAccount();
  }
  async function recheck(manual = false) {
    if (!needsVerify()) return;
    try {
      const ok = await firebase.checkVerified();
      renderVerify();
      if (ok) {
        toast('이메일 인증이 끝났어요. 이제 공유를 쓸 수 있어요');
        onLogin?.();
      } else if (manual) toast('아직 인증 전이에요. 메일의 링크를 눌러 주세요');
    } catch (e) {
      if (manual) toast(e.message);
    }
  }

  function renderAccount() {
    const box = document.querySelector('#accountBox');
    if (!box) return;
    const a = firebase.account();
    if (a) {
      const initial = esc((a.name || a.email || '?').trim().charAt(0).toUpperCase());
      const via = a.provider === 'google.com' ? '구글' : a.verified ? '이메일 · 인증됨' : '이메일 · 인증 전';
      box.innerHTML = `<div class="acct"><span class="avatar" aria-hidden="true">${initial}</span>
        <span class="who"><b>${esc(a.name || '내 계정')}</b><small>${esc(a.email)} · ${via}</small></span>
        <button class="btn small" data-action="auth-logout">로그아웃</button></div>`;
    } else if (firebase.configured() && !firebaseConfig.googleClientId && !firebaseConfig.requireLogin) {
      box.innerHTML = '<div class="small warn-text">로그인 설정이 비어 있어요. js/firebase-config.js 에 googleClientId 또는 requireLogin: true 를 넣으면 로그인이 켜져요 (README 참고)</div>';
    } else {
      box.innerHTML = '<div class="small muted">로그인 안 됨</div>';
    }
  }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
      case 'gate-mode':
        setMode(el.dataset.mode);
        break;
      case 'gate-reset':
        resetPassword();
        break;
      case 'auth-verified':
        recheck(true);
        break;
      case 'auth-resend':
        try {
          await firebase.sendVerification();
          toast('인증 메일을 다시 보냈어요 (스팸함도 확인하세요)');
        } catch (err) {
          toast(err.message);
        }
        break;
      case 'auth-logout':
        if (!confirm('로그아웃할까요? 이 기기의 일지는 그대로 남아 있어요.')) return;
        firebase.signOut();
        location.reload();
        break;
    }
  });
  gate.querySelector('#mailForm').addEventListener('submit', submitMail);
  // 메일 앱에서 인증 링크를 누르고 돌아오면 자동으로 확인
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && recheck(false));

  if (loginRequired()) showGate();
  renderVerify();
  if (needsVerify()) recheck(false);
  return { renderAccount };
}
