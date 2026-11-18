import { eventIdFor, validSyncKey } from './calendar-plan.mjs';
import { validDate, weekStart } from './date-jst.mjs';
export const META_KEY = 'roadmap-app.calendar-sync.v1';
export const emptyMeta = () => ({ version: 1, enabled: false, calendarId: null, knownCalendars: [], creation: null, events: {}, generations: {}, generationWeek: null });
const object = o => o && typeof o === 'object' && !Array.isArray(o);
const exact = (o, names) => object(o) && Object.keys(o).sort().join(' ') === names.split(' ').sort().join(' ');
const calendarId = id => typeof id === 'string' && /^[A-Za-z0-9._%+@-]{1,255}$/.test(id);
export function validateMeta(m) {
  const fail = () => { throw new Error('meta-corrupt'); };
  function safe(v, depth = 0) {
    if (depth > 8) fail();
    if (object(v) || Array.isArray(v)) for (const k of Object.keys(v)) { if (['__proto__', 'constructor', 'prototype'].includes(k)) fail(); safe(v[k], depth + 1); }
  }
  safe(m);
  if (!exact(m, 'version enabled calendarId knownCalendars creation events generations generationWeek') || m.version !== 1 || typeof m.enabled !== 'boolean' || !(m.calendarId === null || calendarId(m.calendarId))) fail();
  if (m.generationWeek !== null && (!validDate(m.generationWeek) || weekStart(m.generationWeek) !== m.generationWeek)) fail();
  if (!Array.isArray(m.knownCalendars) || m.knownCalendars.length > 3 || new Set(m.knownCalendars).size !== m.knownCalendars.length || !m.knownCalendars.every(calendarId) || (m.calendarId && !m.knownCalendars.includes(m.calendarId))) fail();
  if (m.creation !== null && !['in-flight', 'ambiguous'].includes(m.creation)) fail();
  if (!object(m.events) || Object.keys(m.events).length > 1000) fail();
  if (!object(m.generations) || Object.keys(m.generations).length > 1000) fail();
  for (const [key, gen] of Object.entries(m.generations)) if (!validSyncKey(key) || !Number.isSafeInteger(gen) || gen < 0 || gen > 10000) fail();
  for (const [key, entry] of Object.entries(m.events)) {
    if (!validSyncKey(key) || !exact(entry, 'id signature first end') || entry.id !== eventIdFor(key, m.generations[key] || 0) || typeof entry.signature !== 'string' || entry.signature.length > 1000 || !validDate(entry.first) || !validDate(entry.end) || entry.first >= entry.end) fail();
  }
  return structuredClone(m);
}
export function readMeta(storage) {
  let raw;
  try { raw = storage.getItem(META_KEY); } catch { throw new Error('storage-unavailable'); }
  if (raw === null) return { raw, meta: emptyMeta() };
  if (raw.length > 1000000) throw new Error('meta-corrupt');
  try { return { raw, meta: validateMeta(JSON.parse(raw)) }; } catch { throw new Error('meta-corrupt'); }
}
export function writeMeta(storage, meta, previous) {
  const text = JSON.stringify(validateMeta(meta));
  try {
    if (storage.getItem(META_KEY) !== previous) throw new Error();
    storage.setItem(META_KEY, text);
    if (storage.getItem(META_KEY) !== text) throw new Error();
  } catch { throw new Error('meta-write-failed'); }
  return text;
}
