const LIFF_ID = '2007831775-ojeB1qbw';
const LINE_USER_KEY = 'lineUserId';
let initPromise = null;

export async function initLiff() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (typeof window.liff === 'undefined') return { ready: false, loggedIn: false };
    await window.liff.init({ liffId: LIFF_ID });
    if (!window.liff.isLoggedIn()) return { ready: true, loggedIn: false };
    const profile = await window.liff.getProfile();
    const lineUserId = profile.userId || '';
    if (lineUserId) localStorage.setItem(LINE_USER_KEY, lineUserId);
    return { ready: true, loggedIn: true, profile, lineUserId };
  })().catch(error => {
    console.error(error);
    return { ready: false, loggedIn: false, error };
  });
  return initPromise;
}

export function loginWithLine() {
  const redirectUrl = new URL(window.location.href);
  ['code', 'state', 'liffClientId', 'liffRedirectUri'].forEach(key => redirectUrl.searchParams.delete(key));
  window.liff.login({ redirectUri: redirectUrl.href });
}

export function encodedLineUserId() {
  const value = localStorage.getItem(LINE_USER_KEY) || '';
  if (!value) return '';
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
