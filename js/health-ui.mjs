import { button, el, field } from './views.mjs';
import { validClientId } from './calendar-config.mjs';
import { prepareGoogleIdentity } from './google-auth.mjs';
import { catalog, categories, defaultListIds, HEALTH_SCOPE, listEligible, listLimit, listRequest, unavailable } from './health-catalog.mjs';
import { dateRange, healthReader } from './health-api.mjs';
import { renderHealthList, renderHealthRows, renderTrack } from './health-view.mjs';

const statusText = {
  disconnected: '未接続',
  selecting: '閲覧したいカテゴリと専用のクライアントIDを入力してください。',
  'invalid-id': 'ウェブ用OAuthクライアントIDの形式を確認してください。',
  'shared-id': 'Calendarとは異なるプロジェクトの専用クライアントIDを入力してください。',
  loading: 'Googleの認証を準備しています。',
  ready: '準備できました。「Googleで閲覧を許可」を押してください。',
  authorizing: 'Googleでの選択と同意をお待ちください。',
  cancelled: '同意操作を中断しました。もう一度接続できます。',
  permission: '閲覧の許可が得られませんでした。',
  'scope-mismatch': '要求外または確認できない権限が返ったため接続を破棄しました。',
  'invalid-scope': 'Googleが指定の権限を受け付けませんでした。栄養を選んでいる場合は、外して他のカテゴリに再同意できます。',
  'gis-error': 'Googleの認証を準備できませんでした。通信を確認してください。',
  granted: '閲覧の許可を受けました。表示時にGoogle Healthとの接続を確認します。',
  partial: '一部のカテゴリだけ許可されました。許可された項目を表示できます。',
  readyData: 'Google Healthに接続済み。',
  partialData: '一部の項目を表示できません。各項目の説明を確認してください。',
  fetching: '選んだ項目を取得しています。お待ちください。',
  expired: '許可の期限が切れました。表示を消去しました。再接続してください。',
  unlinked: '選んだアカウントはGoogle Healthにリンクされていません。',
  scope: 'この項目の閲覧権限が不足しています。対象カテゴリを選んで再同意してください。',
  unavailable: 'このプロジェクトでは項目の利用が許可されていません。Google側の利用条件を確認してください。',
  denied: 'Googleがこのデータへのアクセスを拒否しました。',
  'not-found': '選んだデータは見つかりませんでした。利用中の機器・同期状態も確認できます。',
  unknown: 'Google Healthの応答理由を判別できませんでした。',
  condition: 'このアプリが送った取得条件をGoogle Healthが受け付けませんでした。',
  date: '開始日から終了日まで、実在する日付を7日以内で指定してください。',
  quota: '利用上限に達しました。時間をおいてから「表示」を押してください。',
  server: 'Google Healthでエラーが起きました。',
  network: 'Google Healthと通信できませんでした。',
  timeout: '応答が時間内に届きませんでした。',
  format: 'Google Healthの応答形式を確認できませんでした。',
  size: '結果が大きすぎるため表示しません。期間を絞れる項目は期間を短くしてください。',
  interrupted: '画面が非表示になったため取得を中断しました。',
};

const localDay = now => {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
};
const scopeOf = name => HEALTH_SCOPE + name + '.readonly';

export function mountHealth({ testClock, calendarClientId }) {
  const panel = document.querySelector('#health-panel');
  if (testClock) {
    panel.append(el('p', { role: 'status' }, 'テスト時計の画面ではGoogle Healthに接続できません。'));
    return;
  }
  let phase = 'disconnected', generation = 0, controller, expiresAt = 0, expiryTimer, oauthTimer;
  let client, allowed = new Set(), selected = new Set(), token, healthId, busy = false, retryAt = 0, retryTimer;
  let sessionClientId;
  const input = field('Google Health専用のウェブ用OAuthクライアントID', 'health-client-id', {
    type: 'text', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', maxlength: '255',
  });
  const id = input.querySelector('input');
  const boxes = new Map();
  const legend = el('fieldset', { class: 'health-options' }, el('legend', {}, '閲覧するカテゴリ（任意）'));
  for (const [name, [label, purpose]] of Object.entries(categories)) {
    const check = el('input', { type: 'checkbox', value: name });
    boxes.set(name, check);
    legend.append(el('label', {}, check, el('span', {}, el('strong', {}, label), el('small', {}, purpose))));
    check.addEventListener('change', onConfigChange);
  }
  id.addEventListener('input', onConfigChange);

  const status = el('p', { id: 'health-status', role: 'status' });
  const prepare = button('接続準備', prepareConnection, { id: 'health-prepare' });
  const consent = button('Googleで閲覧を許可', authorize, { id: 'health-consent' });
  const disconnect = button('この端末で切断', () => reset('disconnected'), { id: 'health-disconnect' });
  const mode = el('select', { id: 'health-mode' },
    el('option', { value: 'list' }, '記録一覧'), el('option', { value: 'detail' }, '項目別（明細）'));
  const listHint = el('p', { id: 'health-list-hint' });
  const listChoices = el('fieldset', { class: 'health-options', 'aria-describedby': 'health-list-hint' },
    el('legend', {}, '一覧に含める項目'));
  const listSettings = el('details', { id: 'health-list-settings' },
    el('summary', {}, '一覧に含める項目'), listHint, listChoices);
  const fallback = el('p', {}, '一覧で読める許可済みの項目がありません。項目別で確認するか、カテゴリを選んで再接続してください。');
  const typeLabel = el('label', { for: 'health-type' }, '表示する項目');
  const type = el('select', { id: 'health-type' });
  const startField = field('開始日', 'health-start', { type: 'date' });
  const endField = field('終了日', 'health-end', { type: 'date' });
  const start = startField.querySelector('input'), end = endField.querySelector('input');
  const dateFields = el('div', { class: 'health-dates' }, startField, endField);
  const hint = el('p', { id: 'health-range-hint' });
  const show = button('表示', () => void display(), { id: 'health-display' });
  const results = el('div', { id: 'health-results' });
  const track = el('div', { id: 'health-track' });
  const view = el('div', { class: 'health-view', hidden: true },
    el('label', { for: 'health-mode' }, '表示方法'), mode, fallback, listSettings, typeLabel, type, hint, dateFields,
    el('div', { class: 'actions' }, show));
  const disabled = el('details', { id: 'health-unavailable' }, el('summary', {}, '取得できない項目'),
    el('dl', {}, unavailable.flatMap(([name, reason]) => [el('dt', {}, name), el('dd', {}, reason)])));
  panel.append(el('p', {}, '選んだ項目をその都度読み取ります。健康値と権限はこのページのメモリに保持し、期限切れ、切断、開き直しで消去します。'),
    el('p', {}, 'Calendarとは別プロジェクトのクライアントIDを使用してください。切断するとこのページでの閲覧が終了します。Google側の許可はGoogleアカウントから管理できます。'),
    input, legend, el('div', { class: 'actions' }, prepare, consent, disconnect), view, status, results, track, disabled);

  const options = () => catalog.filter(e =>
    (e.gps ? selected.has('location') : e.scopes.every(scope => selected.has(scope))) &&
    e.scopes.every(scope => allowed.has(scope)));
  const entry = () => options().find(e => e.id === type.value);
  const eligible = catalog.filter(listEligible);
  const listEntries = [
    ...defaultListIds.map(id => eligible.find(item => item.id === id)),
    ...eligible.filter(item => !defaultListIds.includes(item.id)),
  ];
  const listBoxes = new Map();
  function setupViews() {
    const available = options();
    type.replaceChildren(...available.map(e => el('option', { value: e.id }, e.label)));
    for (const item of listEntries.filter(e => available.includes(e))) {
      const check = el('input', { type: 'checkbox', value: item.id });
      check.checked = defaultListIds.includes(item.id);
      check.addEventListener('change', changedView);
      listBoxes.set(item.id, check);
      listChoices.append(el('label', {}, check, el('span', {}, item.label)));
    }
    mode.value = listBoxes.size ? 'list' : 'detail';
    const first = new Date(Date.now());
    end.value = localDay(first);
    first.setDate(first.getDate() - 6);
    start.value = localDay(first);
  }
  function notice(code) {
    status.dataset.status = code;
    status.textContent = statusText[code];
  }
  function update() {
    consent.hidden = phase !== 'ready';
    prepare.disabled = ['loading', 'authorizing'].includes(phase);
    disconnect.hidden = phase === 'disconnected';
    view.hidden = !token;
    const listing = mode.value === 'list';
    const checked = [...listBoxes.values()].filter(box => box.checked).length;
    for (const box of listBoxes.values()) box.disabled = !box.checked && checked >= listLimit;
    listHint.textContent = checked + ' / ' + listLimit + ' 項目を選択中。' +
      (checked >= listLimit ? '追加するには選択中の項目を外してください。' : '選んだ項目は「表示」を押すと読み込みます。');
    mode.querySelector('option[value="list"]').disabled = !listBoxes.size;
    fallback.hidden = Boolean(listBoxes.size);
    listSettings.hidden = !listing;
    typeLabel.hidden = type.hidden = listing;
    const current = entry();
    const noDates = !listing && (!current || current.mode === 'resource' || ['reference', 'ecg'].includes(current.time));
    dateFields.hidden = noDates;
    hint.textContent = listing ? '選んだ最大8項目の最新値を表示します。期間は最大7日。日付は記録地が基準です。' :
      current?.time === 'ecg' ? '直近24時間の最新最大5件。波形は取得しません。' :
      noDates ? '期間指定のない項目です。' : '開始日から終了日まで最大7日。日付は記録地の暦を基準にします。';
    show.disabled = busy || (listing ? !checked : !current) || Date.now() < retryAt;
    for (const b of results.querySelectorAll('button')) b.disabled = show.disabled;
    if (token) prepare.textContent = 'アカウントを切り替える';
    else prepare.textContent = '接続準備';
  }
  function refreshCooldown() {
    update();
    if (Date.now() < retryAt) retryTimer = setTimeout(refreshCooldown, Math.min(2_147_483_647, Math.max(1, retryAt - Date.now())));
  }
  function cancelReading() {
    controller?.abort();
    controller = undefined;
    busy = false;
    results.replaceChildren();
    track.replaceChildren();
  }
  function reset(code, clearInput = false) {
    generation++;
    phase = 'disconnected';
    cancelReading();
    clearTimeout(expiryTimer);
    clearTimeout(oauthTimer);
    client = token = healthId = sessionClientId = undefined;
    expiresAt = 0;
    allowed = new Set();
    selected = new Set();
    type.replaceChildren();
    for (const check of listBoxes.values()) check.parentElement.remove();
    listBoxes.clear();
    listSettings.open = false;
    mode.value = 'detail';
    if (clearInput) id.value = '';
    notice(code);
    update();
  }
  function onConfigChange() {
    reset('selecting');
  }
  function changedView() {
    cancelReading();
    if (token) notice(healthId ? 'readyData' : 'granted');
    update();
  }
  for (const control of [mode, type, start, end]) control.addEventListener('change', changedView);
  for (const control of [start, end]) control.addEventListener('input', changedView);
  function checkSession() {
    if (!token) return false;
    if (Date.now() >= expiresAt) { reset('expired'); return false; }
    if (calendarClientId() === sessionClientId) { reset('shared-id'); return false; }
    return true;
  }
  function expiry() {
    if (checkSession()) expiryTimer = setTimeout(expiry, Math.max(1, expiresAt - Date.now()));
  }
  function requestedCategories() {
    return new Set([...boxes].filter(([, check]) => check.checked).map(([name]) => name));
  }
  async function prepareConnection() {
    reset('selecting');
    const clientId = id.value.trim();
    if (!validClientId(clientId)) { notice('invalid-id'); return; }
    if (clientId === calendarClientId()) { notice('shared-id'); return; }
    selected = requestedCategories();
    if (!selected.size) return;
    const ticket = generation;
    phase = 'loading';
    notice('loading');
    update();
    try {
      await prepareGoogleIdentity(window, document);
      if (ticket !== generation) return;
      phase = 'ready';
      notice('ready');
      update();
    } catch { if (ticket === generation) reset('gis-error'); }
  }
  function authorize() {
    if (phase !== 'ready') return;
    const clientId = id.value.trim();
    if (clientId === calendarClientId()) { reset('shared-id'); return; }
    const ticket = generation;
    phase = 'authorizing';
    notice('authorizing');
    update();
    const active = () => ticket === generation && phase === 'authorizing';
    const fail = code => { if (active()) reset(code); };
    oauthTimer = setTimeout(() => fail('cancelled'), 120000);
    try {
      const checked = [...selected];
      if (selected.has('location') && !selected.has('activity_and_fitness')) checked.push('activity_and_fitness');
      client = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: checked.map(scopeOf).join(' '),
        include_granted_scopes: false,
        callback(response) {
          if (!active()) return;
          if (response?.error) {
            fail(response.error === 'invalid_scope' ? 'invalid-scope' : response.error === 'access_denied' ? 'permission' : 'cancelled');
            return;
          }
          const names = typeof response?.scope === 'string' ? response.scope.trim().split(/\s+/) : [];
          const lookup = new Map(checked.map(name => [scopeOf(name), name]));
          if (!names.length || names.some(name => !lookup.has(name))) { fail('scope-mismatch'); return; }
          const duration = Number(response.expires_in);
          if (typeof response.access_token !== 'string' || !/^[!-~]{1,4096}$/.test(response.access_token) ||
              !Number.isFinite(duration) || duration <= 60 || duration > 86400) { fail('permission'); return; }
          if (clientId === calendarClientId()) { fail('shared-id'); return; }
          clearTimeout(oauthTimer);
          client = undefined;
          allowed = new Set(names.map(name => lookup.get(name)));
          token = response.access_token;
          sessionClientId = clientId;
          expiresAt = Date.now() + (duration - 60) * 1000;
          phase = 'authorized';
          setupViews();
          notice(allowed.size < checked.length ? 'partial' : 'granted');
          update();
          expiry();
        },
        error_callback: () => fail('cancelled'),
      });
      client.requestAccessToken({ prompt: 'select_account' });
    } catch { fail('gis-error'); }
  }
  async function display(trackName) {
    if (!checkSession() || busy || Date.now() < retryAt || document.hidden || !panel.open) return;
    const listing = mode.value === 'list';
    const item = entry();
    if (trackName ? listing || !item?.gps : show.disabled) return;
    let dates;
    if (!trackName) cancelReading();
    else track.replaceChildren();
    try {
      if (!dateFields.hidden) dates = dateRange(start.value, end.value);
    } catch { notice('date'); update(); return; }
    const request = new AbortController();
    controller = request;
    busy = true;
    notice('fetching');
    update();
    const current = () => {
      if (controller !== request || request.signal.aborted || !checkSession()) return false;
      if (!panel.open) { changedView(); return false; }
      if (document.hidden) { cancelReading(); notice('interrupted'); update(); return false; }
      return true;
    };
    const reader = healthReader(token, request.signal, current);
    const errorStatus = error => Object.hasOwn(statusText, error.code) ? error.code : 'unknown';
    const cooldown = error => {
      retryAt = error.retryAt;
      clearTimeout(retryTimer);
      refreshCooldown();
    };
    try {
      if (!healthId) {
        const account = await reader.identity();
        if (!current()) return;
        healthId = account;
      }
      if (listing) {
        const readings = [];
        let stopped;
        for (const entry of listEntries) {
          if (!current()) return;
          const box = listBoxes.get(entry.id);
          if (!box) {
            if (defaultListIds.includes(entry.id) && entry.scopes.every(scope => selected.has(scope))) {
              readings.push({ entry, message: '許可されていません。カテゴリを確認して再同意してください。' });
            }
            continue;
          }
          if (!box.checked) continue;
          if (stopped) {
            readings.push({ entry, message: stopped });
            continue;
          }
          try {
            const result = await reader.data(listRequest(entry), dates);
            if (!current()) return;
            readings.push({ entry, result });
          } catch (e) {
            if (!current()) return;
            if (e.code === 'expired' || e.code === 'unlinked') throw e;
            if (e.code === 'quota') { cooldown(e); stopped = '待機のため未取得'; }
            if (e.code === 'size') stopped = '取得量の上限のため未取得';
            if (e.code === 'network') stopped = '通信エラーのため未取得';
            readings.push({ entry, message: statusText[errorStatus(e)] });
          }
        }
        if (!current()) return;
        renderHealthList(results, readings, dates);
        notice(readings.some(row => row.message || row.result?.truncated) ? 'partialData' : 'readyData');
        return;
      }
      const result = trackName ? await reader.route(trackName, healthId) : await reader.data(item, dates);
      if (!current()) return;
      if (trackName) renderTrack(track, result);
      else renderHealthRows(results, item, result, name => void display(name));
      notice('readyData');
    } catch (e) {
      if (!current()) return;
      if (e.code === 'expired' || e.code === 'unlinked') { reset(e.code); return; }
      if (e.code === 'quota') cooldown(e);
      notice(errorStatus(e));
    } finally {
      if (controller === request) { controller = undefined; busy = false; update(); }
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && busy) { cancelReading(); notice('interrupted'); }
    else checkSession();
    update();
  });
  window.addEventListener('focus', () => { checkSession(); update(); });
  window.addEventListener('pagehide', () => reset('disconnected', true));
  window.addEventListener('pageshow', event => { if (event.persisted) reset('disconnected', true); });
  window.addEventListener('storage', () => { checkSession(); update(); });
  panel.addEventListener('toggle', () => {
    if (!panel.open && token) changedView();
  });
  reset('disconnected');
}
