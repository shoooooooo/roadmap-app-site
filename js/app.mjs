import { todayJst, weekStart, weekday, addDays, dateLabel, ageAt } from './date-jst.mjs';
import { initialState, backup, parseBackup, MAX_BYTES } from './schema.mjs';
import { createStore } from './store.mjs';
import { ensureWeek, buildWeek, suggestions, record, cancelRecord, dismiss, summary, saveReview, saveGoal, toggleMilestone } from './plan.mjs';
import { el, button, p, field, selectField, statusLabel } from './views.mjs';
import { mountCalendar } from './calendar-ui.mjs';

const launched = Date.now();
const param = new URLSearchParams(location.search).get('now');
const fixed = param && /(?:Z|[+-]\d\d:\d\d)$/.test(param) && Number.isFinite(Date.parse(param)) ? Date.parse(param) : null;
const now = () => (fixed === null ? Date.now() : fixed + Date.now() - launched);
const today = () => todayJst(now());
if (param) { const b = document.querySelector('#test-clock'); b.hidden = false; b.textContent = fixed === null ? 'テスト時刻の形式が不正です。通常の日本時間を使います。' : `テスト時刻で表示中: ${param}（日本時間）`; }
let storage;
try { storage = localStorage; } catch { storage = { getItem() { throw new Error('端末内保存を利用できません'); } }; }
const store = createStore(storage, now);
let calendar = null;
let page = 'today', viewedWeek = weekStart(today()), renderedDate = today(), toastTimer;
const main = document.querySelector('#main'), errorNode = document.querySelector('#error');
const dialog = document.querySelector('#dialog'), dialogContent = document.querySelector('#dialog-content');
document.querySelector('#dialog-close').onclick = () => dialog.close();
function error(message) {
  errorNode.textContent = message; errorNode.hidden = !message;
  if (dialog.open) { const local = dialog.querySelector('.form-error'); if (local) local.textContent = message; }
}
function toast(message) { clearTimeout(toastTimer); document.querySelector('#toast').textContent = message; toastTimer = setTimeout(() => { document.querySelector('#toast').textContent = ''; }, 4500); }
function commit(fn, message = '保存しました') {
  if (renderedDate !== today()) { dialog.close(); viewedWeek = weekStart(today()); render(); error('日付が変わりました。内容を確認して、もう一度操作してください。'); return false; }
  const ok = store.commit(s => { ensureWeek(s, today()); return fn(s); });
  if (ok) { error(''); render(); toast(message); } else { error(store.error); document.querySelector('#toast').textContent = ''; }
  return ok;
}
function openDialog(title, content) {
  dialogContent.replaceChildren(el('h2', { id: 'dialog-title' }, title), content);
  dialog.showModal();
}
function formShell(onSubmit) {
  const form = el('form'); const err = el('p', { class: 'form-error', role: 'alert' });
  form.addEventListener('submit', e => { e.preventDefault(); err.textContent = ''; try { onSubmit(new FormData(form)); } catch (e) { err.textContent = e.message; } });
  form.append(err); return form;
}
function heading(title, subtitle, date = null) {
  return [el('h1', { tabindex: '-1' }, title), date ? p(date, 'page-date') : null, p(subtitle, 'intro')].filter(Boolean);
}
function recordNow(item, status, slot = null) {
  const value = { status, date: today(), slot, minutes: status === 'done' ? item.minutes : null, memo: '' };
  commit(s => record(s, weekStart(today()), item.id, value, today()), status === 'rest' ? '休みとして保存しました' : '実施を保存しました');
}
function cancel(item, wk = weekStart(today())) { commit(s => cancelRecord(s, wk, item.id, today()), '記録を取り消しました'); }
function recordDialog(item, wk = weekStart(today())) {
  const r = store.state.weeks[wk]?.records[item.id];
  const form = formShell(data => {
    const status = data.get('record-status');
    const value = { status, date: data.get('record-date'), slot: status === 'done' && item.kind === 'slot3' ? data.get('record-slot') : null, minutes: status === 'done' ? Number(data.get('record-minutes')) : null, memo: data.get('record-memo').trim() };
    if (commit(s => record(s, wk, item.id, value, today()), '記録を保存しました')) dialog.close();
  });
  form.append(p(`${item.title}・予定 ${item.minutes}分`),
    selectField('状態', 'record-status', [['done', '実施した'], ['rest', '休み']], 'done'),
    field('実施日（日本時間）', 'record-date', { type: 'date', required: true, min: wk, max: today() }, /^\d{4}-/.test(item.day) ? item.day : r?.date || today()),
    field('実施した時間（分）', 'record-minutes', { type: 'number', min: 1, max: 240, required: true }, r?.minutes || item.minutes));
  if (item.kind === 'slot3') form.append(selectField('タイミング', 'record-slot', [['morning', '朝'], ['after-work', '仕事後']], 'morning'));
  if (item.english) form.append(p('事前練習として保存します。受講時間には加算しません。', 'muted'));
  form.append(field('一行メモ（任意・100文字まで）', 'record-memo', { maxlength: 100 }, r?.memo || ''), el('button', { type: 'submit', class: 'primary' }, 'この内容で記録する'));
  openDialog('行動を記録する', form);
}
function candidate(item, w) {
  const r = w.records[item.id];
  const card = el('article', { class: `card ${item.kind === 'slot3' ? 'workout' : ''}`, 'data-item': item.id },
    el('div', { class: 'card-top' }, el('span', { class: 'tag' }, item.continued ? '来週も続ける → 今週の一歩' : item.kind === 'slot3' ? '月・木の小さな習慣' : '目標につながる一歩'), el('span', { class: 'duration' }, `${item.minutes}分`)), el('h3', {}, item.title));
  const goal = store.state.goals.find(g => g.id === item.goalId);
  card.append(p(goal?.nextStep || '小さく始めてみましょう', 'muted'));
  if (item.english) card.append(p('事前練習・受講時間に含めません', 'muted'));
  const actions = el('div', { class: 'actions' });
  if (item.kind === 'slot3') {
    actions.append(button('朝に実施', () => recordNow(item, 'done', 'morning'), { class: 'primary', 'data-action': 'morning' }), button('仕事後に実施', () => recordNow(item, 'done', 'after-work'), { 'data-action': 'after-work' }), button('今日は休む', () => recordNow(item, 'rest'), { 'data-action': 'rest' }));
  } else if (r?.status === 'adopted' && r.date === today()) {
    card.append(p('採用中・まだ実施は記録されていません', 'status'));
    actions.append(button('記録する', () => recordDialog(item), { class: 'primary' }), button('採用を取り消す', () => cancel(item)));
  } else {
    actions.append(button('採用', () => commit(s => record(s, weekStart(today()), item.id, { status: 'adopted', date: today(), slot: null, minutes: null, memo: '' }, today()), '今日の一歩に採用しました'), { class: 'primary' }), button('変更・記録', () => recordDialog(item)), button('見送り', () => commit(s => dismiss(s, item.id, today()), '今日は見送りました')));
  }
  card.append(actions); return card;
}
function todayView(s, w) {
  const date = today();
  const completed = w.items.filter(p => w.records[p.id]?.date === date && ['done', 'rest'].includes(w.records[p.id].status));
  const list = suggestions(w, date);
  main.append(...heading('今日の、小さな一歩。', '全部やらなくて大丈夫。今日に合うものを一つ選びましょう。', dateLabel(date)),
    el('div', { class: 'card overview' }, el('h2', {}, completed.length ? `今日は${completed.length}件、記録できました` : 'まずは、できそうなことから'), p('記録はこの端末のブラウザ内に保存されます。', 'muted')),
    el('div', { class: 'section-heading' }, el('h2', {}, '今日の候補'), el('small', {}, '日本時間')));
  for (const item of list) main.append(candidate(item, w));
  if (!list.length) main.append(p('いまの候補はありません。今週の記録を確認するか、ロードマップで目標を追加できます。', 'empty'));
  if (completed.length) {
    main.append(el('h2', {}, '今日の記録'));
    for (const item of completed) main.append(el('article', { class: 'card' }, el('h3', {}, item.title), p(statusLabel(w.records[item.id]), 'status'), button('記録を取り消す', () => cancel(item))));
  }
  const skipped = w.dismissed[date] || [];
  if (skipped.length) main.append(el('details', {}, el('summary', {}, `見送った候補（${skipped.length}）`), skipped.map(id => {
    const item = w.items.find(p => p.id === id);
    return el('div', { class: 'item-row' }, p(item.title), button('候補に戻す', () => commit(s => dismiss(s, id, date, true), '候補に戻しました')));
  })));
}
function reviewForm(s, w) {
  if (weekday(today()) < 6) return p('週末に、来週も続けること・来週は減らすことを一つずつ選べます。', 'muted');
  const active = s.goals.filter(g => g.status === 'active'); const reduce = active.filter(g => g.sessions.length >= 2);
  if (active.length < 2 || !reduce.length) return p('ふりかえりには異なる2つの目標が必要です。減らす目標は週2回以上に設定してください。', 'muted');
  const form = formShell(data => {
    if (commit(state => saveReview(state, { keep: data.get('keep'), reduce: data.get('reduce'), keepNote: data.get('keep-note').trim(), reduceNote: data.get('reduce-note').trim() }, today()), '翌週の調整を保存しました')) toast('翌週だけに反映します。今週の予定と実績はそのままです。');
  });
  form.append(selectField('来週も続ける目標', 'keep', active.map(g => [g.id, g.title]), w.review?.keep || 'english'), field('続けることを一つ', 'keep-note', { required: true, maxlength: 100 }, w.review?.keepNote || ''), selectField('来週は減らす目標', 'reduce', reduce.map(g => [g.id, g.title]), w.review?.reduce || 'bookkeeping'), field('減らすことを一つ', 'reduce-note', { required: true, maxlength: 100 }, w.review?.reduceNote || ''), p('続ける目標は候補の先頭へ。減らす目標は最後の1回を翌週だけ外します。翌々週には元の回数に戻ります。', 'muted'), el('button', { type: 'submit', class: 'primary' }, '翌週の調整を保存'));
  return form;
}
function weekView(s) {
  const starts = Object.keys(s.weeks).sort();
  const current = weekStart(today()), wk = viewedWeek, w = s.weeks[wk];
  main.append(...heading('今週を、見渡す。', `${dateLabel(wk)} 〜 ${dateLabel(addDays(wk, 6))} ・月曜始まり`));
  const idx = starts.indexOf(wk);
  const move = next => { viewedWeek = next; render(); };
  main.append(el('div', { class: 'week-controls' }, button('← 前の週', () => move(starts[idx - 1]), { disabled: idx <= 0 }), button('今週へ', () => move(current)), button('次の週 →', () => move(starts[idx + 1]), { disabled: idx < 0 || idx === starts.length - 1 || starts[idx + 1] > current })));
  if (!w) { main.append(p('この週は予定が作られていません。', 'empty')); return; }
  const frozen = wk !== current;
  if (frozen) main.append(p('過去の週（閲覧のみ）・予定と実績を保存したまま表示しています。', 'notice'));
  if (w.appliedAdjustment) main.append(p(`先週のふりかえりを反映：続ける「${s.goals.find(g => g.id === w.appliedAdjustment.keep)?.title}」／減らす「${s.goals.find(g => g.id === w.appliedAdjustment.reduce)?.title}」（1回減）`, 'notice'));
  const gids = [...new Set(w.items.map(p => p.goalId))];
  if (!gids.length) main.append(p('今週の行動はまだありません。ロードマップから目標を追加しましょう。', 'empty'));
  for (const gid of gids) {
    const items = w.items.filter(p => p.goalId === gid), stat = summary(w, gid, today(), wk);
    const card = el('article', { class: 'card', 'data-goal': gid }, el('h2', {}, items[0].title), el('div', { class: 'stats' }, el('span', {}, `予定 ${stat.count}回 / ${stat.planned}分`), el('span', {}, `実施 ${stat.done}回 / ${stat.minutes}分`), el('span', {}, `休み ${stat.rest}`), el('span', {}, `未記録 ${stat.missed}`), el('span', {}, `残り ${stat.remaining}`)));
    if (items[0].english) card.append(p('事前練習のみ。受講時間への加算はありません。', 'muted'));
    for (const item of items) {
      const r = w.records[item.id]; const dateText = item.day === 'any' ? 'いつでも' : item.day === 'weekend' ? '週末に余裕があれば' : dateLabel(item.day);
      const status = r ? statusLabel(r) : frozen || (!['any', 'weekend'].includes(item.day) && item.day < today()) ? '未記録' : '予定・未実施';
      const row = el('div', { class: 'item-row', 'data-item': item.id }, p(`${dateText} ・ ${item.minutes}分 ・ ${status}`));
      if (r) row.append(p(`${dateLabel(r.date)} ${r.memo}`, 'muted'));
      if (!frozen && !store.safe) {
        if (r) row.append(button(r.status === 'adopted' ? '採用を取り消す' : '記録を取り消す', () => cancel(item, wk)));
        if (!r || r.status === 'adopted') row.append(button('記録する', () => recordDialog(item, wk), { disabled: /^\d{4}-/.test(item.day) && item.day > today() }));
      }
      card.append(row);
    }
    main.append(card);
  }
  const reflection = el('section', { class: 'card' }, el('h2', {}, '来週を、少し整える。'));
  if (frozen) reflection.append(p(w.review ? `続ける：${w.review.keepNote} ／ 減らす：${w.review.reduceNote}` : 'この週のふりかえりは未記録です。', 'muted'));
  else reflection.append(reviewForm(s, w));
  main.append(reflection);
}
function goalDialog(old = null) {
  const gid = old?.id || `g-${crypto.randomUUID()}`;
  const form = formShell(data => {
    const title = data.get('goal-title').trim(); if (!title) throw new Error('目標名を入力してください。');
    const target = data.get('goal-month') || null;
    if (target && target < today().slice(0, 7) && target !== old?.targetMonth) throw new Error('目標月は今月以降を選んでください。');
    const titles = data.get('goal-milestones').split('\n').map(s => s.trim()).filter(Boolean);
    const goal = { id: gid, title, kind: old?.kind || 'minutes', status: data.get('goal-status'), targetMonth: target, sessions: [...sessionBox.children].map((row, i) => ({ minutes: Number(data.get(`minutes-${i}`)), day: /^(any|weekend)$/.test(data.get(`day-${i}`)) ? data.get(`day-${i}`) : Number(data.get(`day-${i}`)) })), nextStep: data.get('goal-next').trim(), note: data.get('goal-note').trim(), english: old?.english || false, milestones: titles.map((title, i) => old?.milestones.find(m => m.title === title) || { id: `m-${i}`, title, done: false }) };
    // New IDs must not collide when an edited list reorders an existing milestone.
    goal.milestones = goal.milestones.map((m, i) => ({ ...m, id: `m-${i}` }));
    if (commit(s => saveGoal(s, goal, today()), old ? '目標を更新しました' : '目標を追加しました')) dialog.close();
  });
  form.append(field('目標名（40文字まで）', 'goal-title', { required: true, maxlength: 40 }, old?.title || ''), field('目標月（任意）', 'goal-month', { type: 'month' }, old?.targetMonth || ''), selectField('提案への表示', 'goal-status', [['active', '続ける'], ['paused', '一時停止する']], old?.status || 'active'));
  const sessionBox = el('div', { id: 'session-box' });
  const days = [['any', 'いつでも'], ['weekend', '週末'], ...[1, 2, 3, 4, 5, 6, 7].map((n, i) => [String(n), '月火水木金土日'[i] + '曜'])];
  let sessions = structuredClone(old?.sessions || [{ minutes: 15, day: 'any' }, { minutes: 15, day: 'any' }]);
  function readSessions() { sessions = [...sessionBox.children].map((row, i) => ({ minutes: Number(row.querySelector('input').value), day: row.querySelector('select').value })); }
  function rows() { sessionBox.replaceChildren(...sessions.map((s, i) => el('fieldset', {}, el('legend', {}, `週の行動 ${i + 1}`), el('div', { class: 'split' }, field('分数', `minutes-${i}`, { type: 'number', min: 1, max: 240, required: true }, s.minutes), selectField('候補に出す日', `day-${i}`, old?.kind === 'slot3' ? days.slice(2) : days, s.day))))); }
  rows(); form.append(el('h3', {}, '週の行動'), p('記録済みの行動はそのまま残り、未記録の候補に変更を反映します。', 'muted'), sessionBox, el('div', { class: 'actions' }, button('行動を1回増やす', () => { readSessions(); if (sessions.length < 7) { sessions.push({ minutes: 15, day: old?.kind === 'slot3' ? '1' : 'any' }); rows(); } }), button('最後の行動を減らす', () => { readSessions(); if (sessions.length > 1) { sessions.pop(); rows(); } })));
  const milestones = el('textarea', { id: 'goal-milestones', name: 'goal-milestones', maxlength: 409 }); milestones.value = old?.milestones.map(m => m.title).join('\n') || '';
  form.append(el('label', { for: 'goal-milestones' }, '中間目標（1行1件・各40文字・最大10件）'), milestones, field('次の一歩（80文字まで）', 'goal-next', { maxlength: 80 }, old?.nextStep || ''), field('目標のメモ（100文字まで）', 'goal-note', { maxlength: 100 }, old?.note || ''), el('button', { type: 'submit', class: 'primary' }, old ? '目標を更新する' : '目標を追加する'));
  openDialog(old ? '目標を編集する' : '新しい目標', form);
}
function roadmapView(s, w) {
  main.append(...heading('これからに、道をつくる。', '目標を今週の行動へ。その先の一歩を、少しずつ。'));
  const age = ageAt(s.profile.birthYearMonth, today());
  main.append(el('section', { class: 'card overview' }, el('h2', {}, '計画の目安'), p('人生の時間軸 / 架空のサンプル', 'caption'), p(`架空の生年月 1996年4月・現在位置 ${age}歳・設定年齢80歳までの区切り`, 'muted'), el('div', { class: 'timeline' }, el('small', {}, '1996'), el('progress', { max: 80, value: Math.min(80, Math.max(0, age)), 'aria-label': `架空の計画帯。現在位置${age}歳、設定年齢80歳。` }), el('small', {}, '2076')), el('div', { class: 'timeline-labels' }, s.goals.filter(g => g.targetMonth).map(g => el('span', {}, `${g.targetMonth} ${g.title}`))), p('年齢は計画の区切りです。実在の人の生年月は入力しません。', 'muted')));
  main.append(button('＋ 目標を追加', () => goalDialog(), { class: 'primary', id: 'add-goal' }));
  if (!s.goals.length) main.append(p('目標はまだありません。最初の小さな一歩を追加しましょう。', 'empty'));
  for (const g of s.goals) {
    const items = w.items.filter(p => p.goalId === g.id); const count = g.milestones.filter(m => m.done).length;
    const card = el('article', { class: 'card', 'data-goal': g.id }, el('div', { class: 'card-top' }, el('span', { class: 'tag' }, g.status === 'paused' ? '一時停止中' : '目標'), button('編集', () => goalDialog(g))), el('h2', {}, g.title), p(g.targetMonth ? `${g.targetMonth}を目安に` : '自分のペースで', 'muted'));
    if (g.note) card.append(p(g.note, 'muted'));
    const chain = el('div', { class: 'chain' });
    const ms = el('div', {}, el('h3', {}, `中間目標 ${count}/${g.milestones.length}`), el('progress', { max: Math.max(1, g.milestones.length), value: count, 'aria-label': '中間目標の進捗' }));
    for (const m of g.milestones) ms.append(el('label', { class: 'milestone' }, el('input', { type: 'checkbox', checked: m.done, 'aria-label': m.title, onchange: () => { if (!commit(s => toggleMilestone(s, g.id, m.id), m.done ? '進捗を取り消しました' : '進捗を更新しました')) render(); } }), m.title));
    if (!g.milestones.length) ms.append(p('編集から中間目標を追加できます。', 'muted'));
    chain.append(ms, el('div', {}, el('h3', {}, '↓ 今週の行動'), items.length ? items.map(item => p(`${item.minutes}分 ・ ${statusLabel(w.records[item.id])}`)) : p('今週の候補はありません。')), el('div', {}, el('h3', {}, '↓ 次の一歩'), p(g.nextStep || '今週のできそうな行動を一つ選ぶ')));
    card.append(chain); main.append(card);
  }
}
function render() {
  renderedDate = today();
  const s = store.state, wk = weekStart(today()), w = s.weeks[wk] || buildWeek(s, wk);
  main.replaceChildren();
  document.querySelectorAll('[data-page]').forEach(b => { if (b.dataset.page === page) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  if (store.safe) { error(store.error); main.append(p('安全モード：端末内データは上書きしません。画面下部の書き出し・復元を使ってください。', 'notice')); }
  if (page === 'today') todayView(s, w); else if (page === 'week') weekView(s); else roadmapView(s, w);
  if (store.safe) main.querySelectorAll('button,input,select,textarea').forEach(n => n.disabled = true);
  calendar?.request('saved');
}
document.querySelectorAll('[data-page]').forEach(b => b.onclick = () => { page = b.dataset.page; render(); main.querySelector('h1')?.focus(); });
function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.querySelector('#export').onclick = () => {
  if (store.safe) { error('安全モードでは元データの出力を使ってください。'); return; }
  download(JSON.stringify(backup(store.state, now()), null, 2), `roadmap-backup-${today()}.json`);
  document.querySelector('#backup-message').textContent = 'バックアップのダウンロードを開始しました。';
};
document.querySelector('#raw-export').onclick = () => {
  if (store.raw === null) { error('保存中の元データがありません。'); return; }
  download(store.raw, `roadmap-raw-${today()}.json`);
};
document.querySelector('#restore-file').addEventListener('change', async e => {
  const file = e.target.files?.[0]; if (!file) return;
  try {
    if (file.size > MAX_BYTES) throw new Error('バックアップは1MBまでです。');
    const restored = parseBackup(await file.text());
    const box = el('div', {}, p(`目標 ${restored.goals.length}件・週 ${Object.keys(restored.weeks).length}件。現在のデータ全体を置き換えます。先に書き出すことをおすすめします。`), el('p', { class: 'form-error', role: 'alert' }), button('このバックアップで置き換える', () => {
      if (store.restore(restored)) { viewedWeek = weekStart(today()); dialog.close(); error(''); if (!store.state.weeks[viewedWeek]) store.commit(s => { ensureWeek(s, today()); }); render(); if (store.error) error(store.error); else toast('バックアップから復元しました'); }
      else error(store.error);
    }, { class: 'primary', id: 'confirm-restore' }));
    openDialog('バックアップを復元しますか', box);
  } catch (e) { error(`復元しませんでした。${e.message}`); }
  finally { e.target.value = ''; }
});
function refreshDate() {
  if (today() !== renderedDate) { dialog.close(); viewedWeek = weekStart(today()); if (!store.safe) store.commit(s => { ensureWeek(s, today()); }); render(); if (store.error) error(store.error); }
}
document.addEventListener('visibilitychange', refreshDate); window.addEventListener('focus', refreshDate); setInterval(refreshDate, 60000);
if (!store.safe && !store.state.weeks[weekStart(today())]) store.commit(s => { ensureWeek(s, today()); });
render(); if (store.error) error(store.error);
calendar = mountCalendar({ storage, store, now, testClock: fixed !== null });
