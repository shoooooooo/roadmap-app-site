import { createGoogleAuth } from './google-auth.mjs';
import { createCalendarApi } from './calendar-api.mjs';
import { readMeta, META_KEY } from './calendar-meta.mjs';
import { createCalendarSync } from './calendar-sync.mjs';
import { el, button, field, p } from './views.mjs';

const messages = {
  off: 'カレンダー未接続', unconfigured: 'カレンダー未設定', 'test-clock': 'テスト時刻では連携できません',
  loading: 'Googleの接続準備中', ready: 'Googleでログインできます', 'signing-in': 'Googleで接続中',
  syncing: 'カレンダーへ同期中', synced: 'カレンダー同期済み', offline: 'オフライン・後で同期します',
  backoff: '通信または予定の変更を確認し、再試行します', 'sync-error': '同期エラー・再試行してください',
  'needs-sign-in': '再接続が必要です', permission: 'カレンダーの許可を確認してください',
  'binding-lost': '入力したIDのカレンダー名と所有権を確認できません',
  'meta-corrupt': '連携情報を読めません', 'meta-write-failed': '連携情報を保存できません',
  'storage-unavailable': '端末の保存領域を利用できません', 'paused-local': '端末内データを確認し、再読込してください',
  'locks-unavailable': 'このブラウザでは同期の排他制御を利用できません',
  'other-tab': '別のタブで同期中', integrity: '予定の対応を確認できません。同期を停止しました',
  changed: 'Google側で変更が続いた予定を保留しました',
  continuity: '復元または端末内データの変更を検出し、同期を保留しました',
  remote: '以前の連携または別の端末の予定を検出し、同期を保留しました',
  collision: '以前の予定の削除または反映を確認できず、同期を保留しました',
  'review-resume': '現在の計画で同期を再開する内容を確認してください',
  'invalid-client': 'ウェブ用クライアントIDの形式を確認してください',
  'invalid-calendar': 'Googleカレンダーの設定から副カレンダーIDをコピーしてください',
  'api-error': '予定を反映できません。設定を確認してください', 'gis-unavailable': 'Googleの接続準備に失敗しました',
  disconnecting: '接続を解除中', 'revoke-unconfirmed': '端末の接続を解除しました。Google側の許可取消は未確認です'
};

export function mountCalendar({ storage, store, now, testClock }) {
  const panel = document.querySelector('#calendar-controls'), short = document.querySelector('#calendar-status');
  const alert = document.querySelector('#sync-alert');
  const inputAttrs = { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none', maxlength: 255, required: true };
  const clientField = field('ウェブ用 OAuth クライアントID', 'calendar-client-id', inputAttrs);
  const calendarField = field('人生ロードマップの副カレンダーID', 'calendar-target-id', inputAttrs);
  const client = clientField.querySelector('input'), target = calendarField.querySelector('input');
  const save = el('button', { type: 'submit', class: 'primary' }, '連携設定を保存');
  const form = el('form', { autocomplete: 'off', onsubmit: event => {
    event.preventDefault();
    void engine.configure(client.value, target.value);
  } }, clientField, calendarField, el('div', { class: 'actions' }, save));
  const stateText = p('', 'status'), actions = el('div', { class: 'actions' }), help = el('div');
  panel.replaceChildren(form, stateText, actions, help);

  function loadSettings() {
    try {
      const { meta } = readMeta(storage);
      client.value = meta.clientId;
      target.value = meta.calendarId;
    } catch { /* The status renders the storage error. */ }
  }

  function display(code, detail) {
    const message = messages[code] || messages['sync-error'];
    short.textContent = message; short.dataset.state = code;
    stateText.textContent = message;
    actions.replaceChildren(); help.replaceChildren();
    const blocked = ['test-clock', 'storage-unavailable', 'paused-local', 'locks-unavailable', 'meta-corrupt'].includes(code);
    for (const control of [client, target, save]) control.disabled = blocked || code === 'disconnecting';
    if (code === 'unconfigured') help.append(p('Google Cloudで発行したIDと、Googleカレンダーの「カレンダーの統合」にあるIDを入力してください。', 'muted'));
    if (['meta-corrupt', 'integrity'].includes(code)) actions.append(button('連携情報をリセット', async () => {
      if (confirm('このブラウザの連携設定を消去します。Googleの予定と端末の計画はそのままです。')) {
        await engine.reset(); loadSettings();
      }
    }));
    if (code === 'ready') actions.append(button('Googleでログイン', () => { void engine.connect(); }));
    if (['off', 'needs-sign-in', 'binding-lost', 'permission', 'gis-unavailable', 'revoke-unconfirmed'].includes(code)) {
      actions.append(button('Googleカレンダーに接続', () => { void engine.prepare(); }));
    }
    if (['synced', 'offline', 'backoff', 'sync-error', 'other-tab', 'changed', 'api-error', 'meta-write-failed', 'integrity'].includes(code)) {
      actions.append(button('今すぐ同期', () => engine.request('manual')));
    }
    if (['remote', 'collision', 'continuity'].includes(code)) {
      actions.append(button('再確認して再開', () => engine.reconsider()));
      if (code !== 'continuity') {
        help.append(p('Googleカレンダーで、このカレンダーの今日以降にある「みちしるべから自動同期」の予定を確認してください。不要なアプリ予定だけを整理して再確認するか、別の既存副カレンダーIDを入力してください。', 'muted'));
      }
      if (Array.isArray(detail) && detail.length) help.append(el('ul', {}, detail.map(e => el('li', {}, [e.date, e.summary].filter(Boolean).join(' ')))));
    }
    if (code === 'review-resume' && detail) {
      help.append(p(`入力した「人生ロードマップ」に現在の計画を反映します。追加 ${detail.insert}件・更新 ${detail.update}件・削除 ${detail.delete}件。`));
      if (detail.targets.length) {
        help.append(p('更新・削除の対象（一部）', 'muted'), el('ul', {},
          detail.targets.map(e => el('li', {}, [e.date, e.summary].filter(Boolean).join(' ')))));
      }
      actions.append(button('この計画で同期を再開', () => engine.reconsider(true)));
    }
    if (!blocked && !['off', 'unconfigured', 'loading', 'disconnecting', 'revoke-unconfirmed', 'invalid-client', 'invalid-calendar'].includes(code)) {
      actions.append(button('接続を解除', () => { void engine.disconnect(); }));
    }
    if (code === 'revoke-unconfirmed') help.append(p('Googleアカウントの「サードパーティとの接続」から、このアプリの許可を取り消せます。', 'muted'));
    const attention = ['needs-sign-in', 'permission', 'binding-lost', 'meta-corrupt', 'meta-write-failed', 'paused-local',
      'integrity', 'api-error', 'sync-error', 'revoke-unconfirmed', 'remote', 'collision', 'continuity', 'changed'].includes(code);
    alert.hidden = !attention;
    alert.textContent = attention ? `カレンダー：${message}。画面下部の「Googleカレンダー連携」を開いてください。` : '';
  }

  const engine = createCalendarSync({
    storage, store, now, testClock, onStatus: display,
    makeAuth: clientId => createGoogleAuth({ clientId, now }),
    makeApi: (calendarId, getToken) => createCalendarApi({ calendarId, getToken })
  });
  loadSettings();
  window.addEventListener('online', () => engine.request('online'));
  window.addEventListener('offline', () => engine.request('offline'));
  window.addEventListener('storage', event => {
    if (event.key === META_KEY || event.key === null) {
      // Keep local edits to the form until the user decides whether to save them.
      engine.request('storage');
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) engine.request('visible'); });
  setInterval(() => engine.request('clock'), 60000);
  engine.request('start');
  return engine;
}
