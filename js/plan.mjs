import { weekStart, addDays, weekday } from './date-jst.mjs';
import { validateGoal } from './schema.mjs';
export function buildWeek(s, start) {
  const applied = structuredClone(s.weeks[addDays(start, -7)]?.review || null);
  const w = { items: [], records: {}, dismissed: {}, review: null, appliedAdjustment: applied };
  for (const g of s.goals.filter(g => g.status === 'active')) {
    const sessions = applied?.reduce === g.id ? g.sessions.slice(0, -1) : g.sessions;
    sessions.forEach((t, i) => w.items.push({ id: `w${start.replaceAll('-', '')}-${g.id}-${i}`, goalId: g.id, title: g.title, kind: g.kind, minutes: t.minutes, day: typeof t.day === 'number' ? addDays(start, t.day - 1) : t.day, english: g.english, continued: applied?.keep === g.id }));
  }
  return w;
}
export function ensureWeek(s, date) {
  const wk = weekStart(date);
  if (!s.weeks[wk]) s.weeks[wk] = buildWeek(s, wk);
  return s.weeks[wk];
}
function current(s, wk, date) {
  if (wk !== weekStart(date)) throw new Error('過去の週は閲覧のみです。');
  return ensureWeek(s, date);
}
export const eligible = (p, date) => p.day === 'any' || (p.day === 'weekend' ? weekday(date) >= 6 : p.day === date);
export function record(s, wk, pid, value, today) {
  const w = current(s, wk, today), p = w.items.find(p => p.id === pid);
  if (!p || value.date > today || weekStart(value.date) !== wk || !eligible(p, value.date)) throw new Error('この日には記録できません。');
  const old = w.records[pid];
  // Completed/rest records require an explicit cancellation before replacement.
  if (old && old.status !== 'adopted') return;
  w.records[pid] = structuredClone(value);
}
export function cancelRecord(s, wk, pid, today) { delete current(s, wk, today).records[pid]; }
export function dismiss(s, pid, today, undo = false) {
  const w = ensureWeek(s, today);
  if (!w.items.some(p => p.id === pid)) throw new Error('行動が見つかりません。');
  const ids = new Set(w.dismissed[today] || []);
  undo ? ids.delete(pid) : ids.add(pid); w.dismissed[today] = [...ids];
}
export function saveReview(s, value, today) {
  if (weekday(today) < 6) throw new Error('ふりかえりは土日に保存できます。');
  const keep = s.goals.find(g => g.id === value.keep && g.status === 'active');
  const reduce = s.goals.find(g => g.id === value.reduce && g.status === 'active');
  if (!keep || !reduce || keep.id === reduce.id || reduce.sessions.length < 2 || !value.keepNote.trim() || !value.reduceNote.trim()) throw new Error('続けること・減らすことを別の目標から一つずつ選び、内容を入力してください。減らす目標には週2回以上が必要です。');
  ensureWeek(s, today).review = structuredClone(value);
}
export function saveGoal(s, goal, today) {
  validateGoal(goal);
  const idx = s.goals.findIndex(g => g.id === goal.id);
  idx < 0 ? s.goals.push(structuredClone(goal)) : s.goals.splice(idx, 1, structuredClone(goal));
  const wk = weekStart(today), w = ensureWeek(s, today);
  const preserved = w.items.filter(p => p.goalId === goal.id && w.records[p.id]);
  const fresh = buildWeek(s, wk).items.filter(p => p.goalId === goal.id);
  const preservedDays = new Set(preserved.map(p => p.day));
  let candidates = fresh.filter(p => !preserved.some(old => old.id === p.id));
  if (goal.kind === 'slot3') candidates = candidates.filter(p => !preservedDays.has(p.day));
  else candidates = candidates.slice(0, Math.max(0, fresh.length - preserved.length));
  w.items = [...w.items.filter(p => p.goalId !== goal.id), ...preserved, ...candidates];
  const valid = new Set(w.items.map(p => p.id));
  for (const day of Object.keys(w.dismissed)) w.dismissed[day] = w.dismissed[day].filter(x => valid.has(x));
}
export function toggleMilestone(s, gid, mid) {
  const m = s.goals.find(g => g.id === gid)?.milestones.find(m => m.id === mid);
  if (!m) throw new Error('中間目標が見つかりません。'); m.done = !m.done;
}
export function suggestions(w, date) {
  const doneGoals = new Set(w.items.filter(p => w.records[p.id]?.status === 'done' && w.records[p.id].date === date).map(p => p.goalId));
  const available = w.items.filter(p => eligible(p, date) && !['done', 'rest'].includes(w.records[p.id]?.status) && !w.dismissed[date]?.includes(p.id) && !doneGoals.has(p.goalId));
  const rate = gid => {
    const items = w.items.filter(p => p.goalId === gid);
    return items.filter(p => w.records[p.id]?.status === 'done').length / items.length;
  };
  // Each goal receives one candidate, so the small list remains varied.
  const candidates = available.filter(p => p.kind !== 'slot3').sort((a, b) => Number(b.continued) - Number(a.continued) || rate(a.goalId) - rate(b.goalId) || a.minutes - b.minutes || a.id.localeCompare(b.id));
  const chosen = [];
  for (const p of candidates) if (!chosen.some(q => q.goalId === p.goalId) && chosen.length < 3) chosen.push(p);
  return [...available.filter(p => p.kind === 'slot3'), ...chosen];
}
export function summary(w, gid, today, wk) {
  const ps = w.items.filter(p => p.goalId === gid);
  const records = ps.map(p => w.records[p.id]);
  const unrecorded = ps.filter(p => !w.records[p.id] || w.records[p.id].status === 'adopted');
  const missed = unrecorded.filter(p => wk < weekStart(today) || (!['any', 'weekend'].includes(p.day) && p.day < today)).length;
  return { count: ps.length, planned: ps.reduce((n, p) => n + p.minutes, 0), done: records.filter(r => r?.status === 'done').length, minutes: records.reduce((n, r) => n + (r?.minutes || 0), 0), rest: records.filter(r => r?.status === 'rest').length, missed, remaining: unrecorded.length - missed };
}
