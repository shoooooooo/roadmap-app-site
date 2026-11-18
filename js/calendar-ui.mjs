import { GOOGLE_CLIENT_ID, ALLOW_TEST_CLOCK } from './calendar-config.mjs';
import { createGoogleAuth } from './google-auth.mjs';
import { createCalendarApi } from './calendar-api.mjs';
import { createCalendarSync } from './calendar-sync.mjs';
import { el, button, p } from './views.mjs';

const messages = {
  off: 'カレンダー未接続', unconfigured: 'カレンダー未設定', 'test-clock': 'テスト時刻では連携できません',
  loading: 'Googleの接続準備中', ready: 'Googleでログインできます', 'signing-in': 'Googleで接続中',
  syncing: 'カレンダーへ同期中', synced: 'カレンダー同期済み', offline: 'オフライン・後で同期します',
  backoff: '通信待ち・自動で再試行します', 'sync-error': '同期エラー・再試行してください',
  'needs-sign-in': '再接続が必要です', permission: 'カレンダーの許可を確認してください',
  'binding-lost': '接続先カレンダーを確認できません', 'creation-ambiguous': 'カレンダー作成の結果を確認できません',
  'meta-corrupt': '連携情報を読めません', 'meta-write-failed': '連携情報を保存できません',
  'storage-unavailable': '端末の保存領域を利用できません', 'paused-local': '端末内データの確認が必要です。再読込してください',
  'other-tab': '別のタブで同期中', integrity: '予定の対応を確認できません。同期を停止しました',
  'api-error': '予定を反映できません。設定を確認してください', 'gis-unavailable': 'Googleの接続準備に失敗しました',
  disconnecting: '接続を解除中', 'revoke-unconfirmed': '端末の接続を解除しました。Google側の許可取消は未確認です'
};
export function mountCalendar({ storage, store, now, testClock }) {
  const panel = document.querySelector('#calendar-controls'), short = document.querySelector('#calendar-status'), alert = document.querySelector('#sync-alert');
  const auth = createGoogleAuth({ clientId: GOOGLE_CLIENT_ID, now });
  const api = createCalendarApi({ getToken: auth.token });
  let ready = false, engine;
  async function prepare() {
    display('loading');
    try { await auth.prepare(); ready = true; display('ready'); }
    catch { display('gis-unavailable'); }
  }
  function display(code) {
    const message = messages[code] || messages['sync-error'];
    short.textContent = message; short.dataset.state = code;
    const actions = el('div', { class: 'actions' });
    const blocked = ['unconfigured', 'test-clock', 'storage-unavailable'].includes(code);
    if (code === 'meta-corrupt') actions.append(button('連携情報をリセット', () => {
      if (confirm('連携情報だけをリセットします。古いカレンダーは自動発見できず、再接続で新しく作ります。古いカレンダーはGoogle側で整理してください。端末の記録は残ります。')) void engine.reset();
    }));
    else if (['binding-lost', 'creation-ambiguous'].includes(code)) actions.append(button('新しい専用カレンダーを作成', () => {
      if (confirm('新しい「人生ロードマップ」を作ります。以前のカレンダーが残る場合があります。古い予定は変更しません。作成しますか？')) void engine.createAgain();
    }));
    else if (!['loading', 'signing-in', 'disconnecting'].includes(code)) {
      if (['synced', 'syncing', 'backoff', 'offline', 'sync-error', 'other-tab'].includes(code)) actions.append(button('今すぐ同期', () => engine.request('manual'), { disabled: code === 'syncing' }));
      else actions.append(button(ready ? 'Googleでログイン' : 'Googleカレンダーに接続', ready ? () => { void engine.connect(); } : () => { void prepare(); }, { disabled: blocked }));
    }
    if (!['off', 'unconfigured', 'test-clock', 'ready', 'loading', 'disconnecting', 'revoke-unconfirmed', 'meta-corrupt', 'storage-unavailable'].includes(code)) actions.append(button('接続を解除', () => { void engine.disconnect(); }));
    panel.replaceChildren(p(message, 'status'), actions);
    if (code === 'unconfigured') panel.append(p('先に docs/google-calendar-setup.md の手順で公開用クライアントIDを用意してください。', 'muted'));
    if (code === 'revoke-unconfirmed') panel.append(p('Googleアカウントの「サードパーティとの接続」から、このアプリの許可を取り消してください。', 'muted'));
    const attention = ['needs-sign-in', 'permission', 'binding-lost', 'creation-ambiguous', 'meta-corrupt', 'meta-write-failed', 'paused-local', 'integrity', 'api-error', 'sync-error', 'revoke-unconfirmed'].includes(code);
    alert.hidden = !attention; alert.textContent = attention ? `カレンダー：${message}。画面下部の「Googleカレンダー連携」を開いてください。` : '';
  }
  engine = createCalendarSync({ storage, store, auth, api, clientId: GOOGLE_CLIENT_ID, testClock, allowTestClock: ALLOW_TEST_CLOCK, now, onStatus: display });
  window.addEventListener('online', () => engine.request('online'));
  window.addEventListener('offline', () => engine.request('offline'));
  window.addEventListener('storage', () => engine.request('storage'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) engine.request('visible'); });
  setInterval(() => engine.request('clock'), 60000);
  engine.request('start');
  return engine;
}
