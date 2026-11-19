import { CALENDAR_SCOPE } from './calendar-config.mjs';
const gisByDocument = new WeakMap();
export function prepareGoogleIdentity(win, doc) {
  if (win.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisByDocument.has(doc)) gisByDocument.set(doc, new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      gisByDocument.delete(doc);
      reject(new Error('gis-unavailable'));
    };
    const timer = setTimeout(fail, 15000);
    script.onload = () => {
      if (!win.google?.accounts?.oauth2) { fail(); return; }
      clearTimeout(timer);
      resolve();
    };
    script.onerror = fail;
    doc.head.append(script);
  }));
  return gisByDocument.get(doc);
}

// Nothing in this closure is persisted, exported to a backup, or logged.
export function createGoogleAuth({ clientId, now = () => Date.now(), window: win = globalThis.window, document: doc = globalThis.document }) {
  let access = null, expires = 0, client = null, active = 0;
  function clear() { access = null; expires = 0; active++; }
  const token = () => access && now() < expires ? access : null;
  async function prepare() {
    if (!clientId) throw new Error('unconfigured');
    await prepareGoogleIdentity(win, doc);
  }
  function signIn() {
    const oauth = win.google?.accounts?.oauth2;
    if (!oauth) return Promise.reject(new Error('gis-unavailable'));
    clear(); const generation = active;
    return new Promise((resolve, reject) => {
      const fail = code => { clearTimeout(timer); if (active === generation) clear(); reject(new Error(code)); };
      const timer = setTimeout(() => { if (active === generation) clear(); fail('sign-in-cancelled'); }, 120000);
      try {
        client = oauth.initTokenClient({ client_id: clientId, scope: CALENDAR_SCOPE, include_granted_scopes: false,
          callback: response => {
            if (active !== generation) { fail('sign-in-cancelled'); return; }
            if (response?.error || !response?.access_token || typeof response.scope !== 'string' || response.scope.trim() !== CALENDAR_SCOPE) { fail('permission'); return; }
            if (!Number.isFinite(Number(response.expires_in)) || Number(response.expires_in) <= 60) { clear(); fail('needs-sign-in'); return; }
            access = response.access_token; expires = now() + (Number(response.expires_in) - 60) * 1000; clearTimeout(timer); resolve();
          }, error_callback: () => fail('sign-in-cancelled') });
        // Synchronous call inside the actual button gesture; never after await.
        client.requestAccessToken({ prompt: 'select_account' });
      } catch { fail('gis-unavailable'); }
    });
  }
  async function revoke() {
    const current = token(); clear();
    if (!current || !win.google?.accounts?.oauth2) return false;
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 15000);
      try { win.google.accounts.oauth2.revoke(current, r => { clearTimeout(timer); resolve(r?.successful === true); }); }
      catch { clearTimeout(timer); resolve(false); }
    });
  }
  return { prepare, signIn, token, clear, revoke };
}
