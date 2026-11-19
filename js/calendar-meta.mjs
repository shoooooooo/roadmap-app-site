import { validCalendarId, validClientId } from './calendar-config.mjs';
import { strongEtag } from './calendar-api.mjs';
import { eventIdFor, validSyncKey, ownedEvent } from './calendar-plan.mjs';
import { validDate } from './date-jst.mjs';

export const META_KEY = 'roadmap-app.calendar-sync.v2';
export const CHECKPOINT_KEY = META_KEY + '.checkpoint';
export const nonce = () => crypto.randomUUID().replaceAll('-', '');
export const validNonce = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const emptyMeta = () => ({ version: 2, clientId: '', calendarId: '', binding: null, writer: null,
  enabled: false, hold: null, records: {}, pending: null });
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).sort().join(' ') === keys;
const validGeneration = n => Number.isInteger(n) && n >= 0 && n <= 10000;

export function validateMeta(m) {
  const corrupt = () => { throw new Error('meta-corrupt'); };
  if (!exact(m, 'binding calendarId clientId enabled hold pending records version writer') || m.version !== 2 ||
      typeof m.enabled !== 'boolean' || ![null, 'remote', 'collision'].includes(m.hold)) corrupt();
  if (!object(m.records) || Object.keys(m.records).length > 1000) corrupt();
  if (!m.binding) {
    if (m.binding !== null || m.clientId !== '' || m.calendarId !== '' || m.writer !== null || m.enabled ||
        m.pending !== null || m.hold !== null || Object.keys(m.records).length) corrupt();
    return m;
  }
  if (!validNonce(m.binding) || !validNonce(m.writer) || !validClientId(m.clientId) || !validCalendarId(m.calendarId)) corrupt();
  for (const [key, r] of Object.entries(m.records)) {
    if (!validSyncKey(key) || !exact(r, 'end etag generation id retired') || !validGeneration(r.generation) ||
        r.id !== eventIdFor(key, r.generation, m.writer) || !validDate(r.end) ||
        typeof r.retired !== 'boolean' || !(r.etag === null || strongEtag(r.etag))) corrupt();
  }
  const op = m.pending;
  if (op !== null) {
    if (!exact(op, 'body etag generation id key kind') || !['insert', 'update', 'delete'].includes(op.kind) ||
        !validSyncKey(op.key) || !validGeneration(op.generation) || op.id !== eventIdFor(op.key, op.generation, m.writer) ||
        (op.kind === 'insert' ? op.etag !== null : !strongEtag(op.etag))) corrupt();
    if (op.kind === 'delete' ? op.body !== null : !ownedEvent(op.body, m.writer) || op.body.id !== op.id) corrupt();
  }
  return m;
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
    if (previous !== text) storage.setItem(META_KEY, text);
    if (storage.getItem(META_KEY) !== text) throw new Error();
  } catch { throw new Error('meta-write-failed'); }
  return text;
}

export function checkpointMatches(storage, raw) {
  return raw !== null && storage.getItem(CHECKPOINT_KEY) === raw;
}

export function acceptCheckpoint(storage, raw, mainKey) {
  if (raw === null || storage.getItem(mainKey) !== raw) throw new Error('paused-local');
  try {
    storage.setItem(CHECKPOINT_KEY, raw);
    if (storage.getItem(CHECKPOINT_KEY) !== raw) throw new Error();
  } catch { throw new Error('meta-write-failed'); }
}
