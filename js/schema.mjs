import { validDate, weekStart, addDays } from './date-jst.mjs';
export const KEY = 'roadmap-app.v1';
export const MAX_BYTES = 1000000;
const fail = name => { throw new Error(`形式が不正です: ${name}`); };
const check = (ok, name) => { if (!ok) fail(name); };
function keys(o, names) {
  check(o && typeof o === 'object' && !Array.isArray(o), 'オブジェクト');
  check(Object.keys(o).sort().join('|') === names.split(' ').sort().join('|'), '項目名');
}
const str = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const id = v => typeof v === 'string' && /^[a-z0-9-]{1,50}$/.test(v);
const iso = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const month = v => typeof v === 'string' && /^(19|20|21)\d\d-(0[1-9]|1[0-2])$/.test(v);
const arr = (v, min, max) => Array.isArray(v) && v.length >= min && v.length <= max;
function safeTree(v, depth = 0) {
  check(depth < 25, '深さ');
  if (v && typeof v === 'object') for (const k of Object.keys(v)) {
    check(!['__proto__', 'prototype', 'constructor'].includes(k), '予約キー');
    safeTree(v[k], depth + 1);
  }
}
function map(o, max, fn) {
  check(o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length <= max, '一覧');
  for (const [k, v] of Object.entries(o)) fn(k, v);
}
export function validateGoal(g) {
  keys(g, 'id title kind status targetMonth sessions nextStep note milestones english');
  check(id(g.id) && str(g.title, 1, 40), '目標名');
  check(['slot3', 'minutes'].includes(g.kind) && ['active', 'paused'].includes(g.status), '目標の種類');
  check(g.targetMonth === null || month(g.targetMonth), '目標月');
  check(str(g.nextStep, 0, 80) && str(g.note, 0, 100) && typeof g.english === 'boolean', '目標の説明');
  check(arr(g.sessions, 1, 7), '週の回数');
  const days = new Set();
  for (const s of g.sessions) {
    keys(s, 'minutes day');
    check(int(s.minutes, 1, 240) && (['any', 'weekend'].includes(s.day) || int(s.day, 1, 7)), '行動の分数・曜日');
    if (g.kind === 'slot3') { check(int(s.day, 1, 7) && !days.has(s.day), '筋トレは曜日ごとに1件'); days.add(s.day); }
  }
  check(arr(g.milestones, 0, 10), '中間目標');
  const mids = new Set();
  for (const m of g.milestones) {
    keys(m, 'id title done');
    check(id(m.id) && !mids.has(m.id) && str(m.title, 1, 40) && typeof m.done === 'boolean', '中間目標'); mids.add(m.id);
  }
  return g;
}
function review(r, goals) {
  if (r === null) return;
  keys(r, 'keep reduce keepNote reduceNote');
  check(goals.has(r.keep) && goals.has(r.reduce) && r.keep !== r.reduce, '続ける・減らす目標');
  check(str(r.keepNote, 1, 100) && str(r.reduceNote, 1, 100), 'ふりかえり');
}
export function validateState(s) {
  safeTree(s); keys(s, 'schemaVersion revision savedAt profile goals weeks');
  check(s.schemaVersion === 1 && int(s.revision, 0, Number.MAX_SAFE_INTEGER) && iso(s.savedAt), '版');
  keys(s.profile, 'birthYearMonth planningAge');
  // The timeline deliberately uses one fictional example, never a real birth date.
  check(s.profile.birthYearMonth === '1996-04' && s.profile.planningAge === 80, '架空の時間軸');
  check(arr(s.goals, 0, 40), '目標数');
  const goals = new Map();
  for (const g of s.goals) { validateGoal(g); check(!goals.has(g.id), '目標ID重複'); goals.set(g.id, g); }
  map(s.weeks, 600, (wk, w) => {
    check(validDate(wk) && weekStart(wk) === wk, '週の月曜');
    keys(w, 'items records dismissed review appliedAdjustment');
    check(arr(w.items, 0, 280), '週の行動');
    const items = new Map(); const workoutDays = new Set();
    for (const p of w.items) {
      keys(p, 'id goalId title kind minutes day english continued');
      check(id(p.id) && !items.has(p.id) && goals.has(p.goalId) && str(p.title, 1, 40), '行動ID・参照');
      check(['slot3', 'minutes'].includes(p.kind) && int(p.minutes, 1, 240), '行動');
      check(['any', 'weekend'].includes(p.day) || (validDate(p.day) && p.day >= wk && p.day <= addDays(wk, 6)), '行動日');
      check(typeof p.english === 'boolean' && typeof p.continued === 'boolean', '行動区分');
      if (p.kind === 'slot3') { const key = `${p.goalId}/${p.day}`; check(validDate(p.day) && !workoutDays.has(key), '筋トレの日付重複'); workoutDays.add(key); }
      items.set(p.id, p);
    }
    map(w.records, 280, (pid, r) => {
      const p = items.get(pid); check(!!p, '記録の参照');
      keys(r, 'status date slot minutes memo');
      check(['adopted', 'done', 'rest'].includes(r.status) && validDate(r.date) && r.date >= wk && r.date <= addDays(wk, 6), '記録日・状態');
      check(p.day === 'any' || (p.day === 'weekend' ? new Date(r.date).getUTCDay() % 6 === 0 : r.date === p.day), '予定と記録日');
      check(str(r.memo, 0, 100), '一行メモ');
      check(r.status === 'done' ? int(r.minutes, 1, 240) : r.minutes === null, '記録分数');
      check(p.kind === 'slot3' && r.status === 'done' ? ['morning', 'after-work'].includes(r.slot) : r.slot === null, '実施タイミング');
    });
    map(w.dismissed, 7, (date, ids) => {
      check(validDate(date) && date >= wk && date <= addDays(wk, 6) && arr(ids, 0, 280) && new Set(ids).size === ids.length && ids.every(x => items.has(x)), '見送り');
    });
    review(w.review, goals); review(w.appliedAdjustment, goals);
  });
  return structuredClone(s);
}
export const backup = (state, now = Date.now()) => ({ format: 'roadmap-app-backup', schemaVersion: 1, exportedAt: new Date(now).toISOString(), state: validateState(state) });
export function parseBackup(text) {
  check(new TextEncoder().encode(text).length <= MAX_BYTES, '1MB上限');
  const b = JSON.parse(text); safeTree(b); keys(b, 'format schemaVersion exportedAt state');
  check(b.format === 'roadmap-app-backup' && b.schemaVersion === 1 && iso(b.exportedAt), 'バックアップの版');
  return validateState(b.state);
}
export function initialState(now = Date.now()) {
  const goal = (id, title, sessions, extra = {}) => ({ id, title, sessions, kind: 'minutes', status: 'active', targetMonth: null, nextStep: 'まず1回、小さく始める', note: '', milestones: [{ id: 'first', title: '最初の1回を試す', done: false }], english: false, ...extra });
  return { schemaVersion: 1, revision: 0, savedAt: new Date(now).toISOString(), profile: { birthYearMonth: '1996-04', planningAge: 80 }, weeks: {}, goals: [
    goal('strength', '筋トレ', [{ minutes: 2, day: 1 }, { minutes: 2, day: 4 }], { kind: 'slot3', nextStep: '洗顔直後、または仕事後に2分' }),
    goal('bookkeeping', '簿記', [30, 30, 60].map(minutes => ({ minutes, day: 'any' })), { targetMonth: '2027-08', nextStep: '仕訳を1問解く', note: '最初は週2時間。30分を2回、60分を1回。' }),
    goal('english', '英会話の事前練習', [10, 10, 10].map(minutes => ({ minutes, day: 'any' })), { targetMonth: '2027-01', english: true, nextStep: '短い自己紹介を声に出す', note: '2027年1月末から受講予定。事前練習は受講30時間に加算しません。' }),
    goal('sidework', '副業', [{ minutes: 30, day: 'weekend' }], { nextStep: '身近なサービスを観察して学ぶ', note: '週末に余裕があれば。初回は観察と学び。時間ノルマなし。' })
  ] };
}
