import { weekStart, addDays, validDate } from './date-jst.mjs';

export const validSyncKey = key => typeof key === 'string' && /^(item:[a-z0-9-]{1,50}|float:\d{4}-\d\d-\d\d:[a-z0-9-]{1,50}:(any|weekend))$/.test(key);
// Injective base32hex encoding, using only Calendar's permitted ID alphabet.
export function eventIdFor(key, generation = 0) {
  if (!validSyncKey(key)) throw new Error('invalid sync key');
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > 10000) throw new Error('invalid generation');
  const alphabet = '0123456789abcdefghijklmnopqrstuv'; let bits = 0, value = 0, out = 'rm1';
  for (const byte of new TextEncoder().encode(`${key}#${generation}`)) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; out += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
// Compare the full canonical content, avoiding probabilistic hash collisions.
export const signature = body => JSON.stringify([body.summary, body.start?.date, body.end?.date]);
export function ownedEvent(body) {
  const key = body?.extendedProperties?.private?.key;
  const gen = body?.extendedProperties?.private?.generation;
  return validSyncKey(key) && typeof gen === 'string' && /^(0|[1-9]\d{0,4})$/.test(gen) && Number(gen) <= 10000 && body.extendedProperties.private.app === 'roadmap-app' && body.id === eventIdFor(key, Number(gen)) && validDate(body.start?.date) && validDate(body.end?.date) && body.start.date < body.end.date && typeof body.summary === 'string' && body.summary.length <= 500;
}
export function desiredEvents(state, today) {
  const wk = weekStart(today), w = state.weeks[wk];
  if (!w) return null;
  const result = new Map(), groups = new Map(), sunday = addDays(wk, 6);
  function add(key, summary, first, last) {
    if (first > last) return;
    const body = { id: eventIdFor(key), summary, description: 'みちしるべから自動同期した今日・今週の予定です。変更はアプリで行ってください。', start: { date: first }, end: { date: addDays(last, 1) }, status: 'confirmed', transparency: 'transparent', reminders: { useDefault: false }, extendedProperties: { private: { app: 'roadmap-app', key } } };
    body.extendedProperties.private.generation = '0'; result.set(key, body);
  }
  for (const item of w.items) {
    const r = w.records[item.id], key = `item:${item.id}`;
    if (r && ['done', 'rest'].includes(r.status)) continue;
    if (r?.status === 'adopted' && r.date === today) { add(key, `採用：${item.title} ${item.minutes}分`, today, today); continue; }
    if (validDate(item.day)) {
      if (item.day >= today && !(item.day === today && w.dismissed[today]?.includes(item.id))) add(key, `${item.title} ${item.minutes}分`, item.day, item.day);
    } else {
      const groupKey = `float:${wk}:${item.goalId}:${item.day}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(item);
    }
  }
  for (const [key, items] of groups) {
    let first = key.endsWith(':weekend') && today < addDays(wk, 5) ? addDays(wk, 5) : today;
    if (first === today && items.every(p => w.dismissed[today]?.includes(p.id))) first = addDays(today, 1);
    const label = key.endsWith(':weekend') ? '週末に余裕があれば' : `今週あと${items.length}回`;
    add(key, `${items[0].title} ${label}（${items.map(p => p.minutes).join('・')}分）`, first, sunday);
  }
  return result;
}
export function diffEvents(desired, mapped, today) {
  if (desired === null) return [];
  const deletes = [], writes = [];
  for (const [key, old] of Object.entries(mapped)) {
    // end is exclusive. Past events are immutable, even after an offline edit.
    if (old.end <= today) continue;
    if (!desired.has(key)) deletes.push({ kind: 'delete', key, id: old.id });
  }
  for (const [key, body] of desired) {
    const old = mapped[key];
    // An ended incarnation stays untouched, but its key may be planned again today.
    if (!old || old.end <= today || old.signature !== signature(body)) writes.push({ kind: old && old.end > today ? 'update' : 'insert', key, id: body.id, body });
  }
  return [...deletes, ...writes];
}
