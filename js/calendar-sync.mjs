import { KEY } from './schema.mjs';
import { CALENDAR_NAME, validCalendarId, validClientId } from './calendar-config.mjs';
import { confirmedEvent, desiredEvents, diffEvents, eventIdFor, keyInWeek, signature } from './calendar-plan.mjs';
import { acceptCheckpoint, checkpointMatches, emptyMeta, META_KEY, nonce, readMeta, writeMeta } from './calendar-meta.mjs';
import { addDays, todayJst, validDate, weekStart } from './date-jst.mjs';

const LOCK_NAME = 'roadmap-app-calendar-sync';
const fail = code => { throw new Error(code); };
const codeOf = error => error.code || error.message;
const labels = items => items.slice(0, 5).map(e => ({
  summary: typeof e.summary === 'string' ? e.summary.slice(0, 160) : '予定名なし',
  date: validDate(e.start?.date) ? e.start.date : ''
}));

export function createCalendarSync({ storage, store, makeAuth, makeApi, testClock, now = () => Date.now(),
  online = () => navigator.onLine, locks = globalThis.navigator?.locks, onStatus = () => {},
  delay = 800, retryDelay = n => Math.min(300000, 2000 * 2 ** n) }) {
  let status = 'off', session, timer, running, controller, generation = 0, retries = 0;
  const conflicts = new Map();
  let dirty = false, busy = false, stopped = false, resume = null, preview = null;
  const emit = (code, detail = null) => { status = code; onStatus(code, detail); };
  const localReady = () => !store.safe && store.raw !== null && storage.getItem(KEY) === store.raw;

  function allowed() {
    if (testClock) fail('test-clock');
    if (!locks) fail('locks-unavailable');
    if (!localReady()) fail('paused-local');
  }

  function request(reason = 'saved') {
    if (busy || stopped) return;
    if (['manual', 'online', 'connected', 'resume'].includes(reason)) retries = 0;
    if (['manual', 'connected', 'resume'].includes(reason)) conflicts.clear();
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, delay);
  }

  function report(error) {
    const code = codeOf(error);
    if (code === 'aborted') return;
    if (code === 'needs-sign-in') session?.auth.clear();
    if (['network', 'rate', 'server'].includes(code)) {
      emit(!online() ? 'offline' : retries < 6 ? 'backoff' : 'sync-error');
      if (online() && retries < 6) timer = setTimeout(() => request('retry'), retryDelay(retries++));
      return;
    }
    const recognized = ['needs-sign-in', 'permission', 'binding-lost', 'remote', 'collision', 'meta-corrupt',
      'meta-write-failed', 'storage-unavailable', 'paused-local', 'integrity', 'api-error', 'test-clock',
      'locks-unavailable', 'invalid-client', 'invalid-calendar', 'gis-unavailable'];
    emit(recognized.includes(code) ? code : 'sync-error');
  }

  async function flush() {
    clearTimeout(timer);
    if (running) { await running; return; }
    if (busy || stopped) return;
    if (!locks || testClock) { report(new Error(testClock ? 'test-clock' : 'locks-unavailable')); return; }
    dirty = true;
    running = (async () => {
      while (dirty && !busy && !stopped) {
        dirty = false;
        try {
          await locks.request(LOCK_NAME, { ifAvailable: true }, async lock => {
            if (lock) await pass();
            else {
              emit('other-tab');
              timer = setTimeout(() => request('retry'), 5000);
            }
          });
        } catch (error) { if (!busy && !stopped) report(error); }
      }
    })();
    try { await running; } finally { running = null; }
  }

  async function pass() {
    if (busy || stopped) return;
    let { meta, raw } = readMeta(storage);
    if (!localReady()) fail('paused-local');
    if (!meta.binding) { emit('unconfigured'); return; }
    if (session?.binding === meta.binding && ['loading', 'ready', 'signing-in'].includes(status)) return;
    if (!meta.enabled) { emit('off'); return; }
    allowed();
    if (!session || session.binding !== meta.binding || !session.auth.token()) { emit('needs-sign-in'); return; }
    if (!online()) { emit('offline'); return; }
    const local = store.raw, currentSession = session, epoch = generation, token = session.auth.token();
    const today = todayJst(now()), week = weekStart(today), since = addDays(week, -1);
    const desired = desiredEvents(store.state, today);
    if (!desired) fail('paused-local');
    const grant = resume;
    resume = null;
    const authorized = grant?.binding === meta.binding && grant.local === local && grant.today === today && grant.raw === raw;
    const inspecting = authorized && grant.stage === 'preview';
    const applying = authorized && grant.stage === 'apply';
    const continued = checkpointMatches(storage, local);
    const expiredHold = meta.hold === 'collision' && meta.pending && !keyInWeek(meta.pending.key, week);
    if (!inspecting && !applying) {
      if (preview?.raw === raw && preview.local === local && preview.today === today) {
        emit('review-resume', preview.counts); return;
      }
      if (!continued) { emit('continuity'); return; }
      if (meta.hold && !expiredHold) { emit(meta.hold, preview?.blockers); return; }
    }
    const api = makeApi(meta.calendarId, () => currentSession.auth.token());
    const signal = (controller = new AbortController()).signal;
    const current = () => {
      if (stopped || busy || signal.aborted || generation !== epoch || session !== currentSession ||
          !localReady() || store.raw !== local || todayJst(now()) !== today ||
          storage.getItem(META_KEY) !== raw) fail('aborted');
      if (currentSession.auth.token() !== token) fail('needs-sign-in');
      if (!inspecting && !applying && !checkpointMatches(storage, local)) fail('aborted');
    };
    const save = () => { current(); raw = writeMeta(storage, meta, raw); };
    const checkTarget = page => {
      if (page?.summary !== CALENDAR_NAME || page.accessRole !== 'owner') fail('binding-lost');
    };
    async function remote(call) {
      current();
      try {
        const result = await call();
        current();
        return result;
      } catch (error) {
        current();
        throw error;
      }
    }
    async function collect() {
      const found = [], pages = new Set();
      let next;
      try {
        do {
          const page = await remote(() => api.list(since, next, signal));
          checkTarget(page);
          if (!Array.isArray(page.items)) fail('binding-lost');
          found.push(...page.items);
          next = page.nextPageToken;
          if (found.length > 1000 || (next !== undefined &&
              (typeof next !== 'string' || !next || pages.has(next) || pages.size >= 9))) fail('integrity');
          pages.add(next);
        } while (next !== undefined);
      } catch (error) {
        if (['gone', 'permission'].includes(codeOf(error))) fail('binding-lost');
        throw error;
      }
      return found;
    }
    function hold(code, blockers = []) {
      const detail = labels(blockers);
      if (!inspecting) { meta.hold = code; save(); }
      preview = { blockers: detail };
      emit(code, detail);
    }
    const item = (event, eventGeneration, retired = false) => ({
      id: event.id, generation: eventGeneration, etag: event.etag ?? null, end: event.end.date, retired
    });
    async function lookup(id) {
      try {
        const body = await remote(() => api.get(id, signal));
        if (body?.id !== id) fail('integrity');
        return body.status === 'cancelled' ? { tombstone: true } : { body };
      } catch (error) {
        if (error.status === 410) return { tombstone: true };
        if (error.status === 404) return { missing: true };
        throw error;
      }
    }
    const known = (body, key, id) => confirmedEvent(body, meta.writer, key, id);
    const terminal = event => validDate(event?.end?.date) && event.end.date <= today;
    function resolve(op, body) {
      if (!known(body, op.key, op.id) ||
          body.extendedProperties.private.op !== op.body.extendedProperties.private.op ||
          signature(body) !== signature(op.body)) fail('integrity');
      recordObserved(op, body);
    }
    function recordObserved(op, body) {
      meta.records[op.key] = item(body, op.generation, terminal(body));
      meta.pending = null;
    }

    emit('syncing');
    const found = await collect();
    const active = new Map(), byId = new Map();
    const blockers = [];
    for (const event of found) {
      if (event?.status === 'cancelled') continue;
      if (typeof event?.id !== 'string' || byId.has(event.id)) fail('integrity');
      byId.set(event.id, event);
      if (terminal(event)) continue;
      const key = event.extendedProperties?.private?.key;
      if (!known(event, key, event.id)) { blockers.push(event); continue; }
      if (!keyInWeek(key, week)) continue;
      const record = meta.records[key];
      if (active.has(key) || (record?.id !== event.id &&
          meta.pending?.id !== event.id && (!authorized || record))) {
        blockers.push(event); continue;
      }
      active.set(key, event);
    }
    if (blockers.length) { hold('remote', blockers); return; }

    // Reconcile a submitted operation before using the latest desired plan.
    // A reservation is never replayed as an old mutation after a local edit or midnight.
    const old = meta.pending;
    let reserved;
    if (old) {
      const seen = await lookup(old.id);
      const oldRecord = meta.records[old.key];
      if (old.kind === 'insert') {
        if (seen.body) {
          if (!known(seen.body, old.key, old.id)) { hold('remote', [seen.body]); return; }
          // This ID was reserved by this writer. Google may have edited its contents
          // after accepting either this request or an earlier retry of that reservation.
          recordObserved(old, seen.body);
        } else if (!keyInWeek(old.key, week) && !byId.has(old.id)) {
          meta.pending = null;
        } else if (seen.tombstone) {
          if (!authorized || active.has(old.key)) { hold('collision'); return; }
          meta.records[old.key] = item(old.body, old.generation, true);
          meta.pending = null;
        } else {
          // A 404 after a 409 cannot distinguish delayed visibility from a deletion.
          // On explicit recheck the same reserved ID may be retried, but never skipped.
          if (meta.hold === 'collision' && !authorized) { hold('collision'); return; }
          reserved = old;
        }
      } else {
        if (!oldRecord || oldRecord.id !== old.id || !oldRecord.etag) fail('integrity');
        const confirmedAbsent = seen.missing && !byId.has(old.id) &&
          (!keyInWeek(old.key, week) || (authorized && !active.has(old.key)));
        if (seen.tombstone || confirmedAbsent) {
          oldRecord.retired = true;
          meta.pending = null;
        } else if (!seen.body) { hold('collision'); return; }
        else if (!known(seen.body, old.key, old.id)) { hold('remote', [seen.body]); return; }
        else {
          // Either the mutation applied or the event is still live. Record the
          // observed version and plan against its current date, content and ETag.
          recordObserved(old, seen.body);
        }
      }
    }

    const mapped = {};
    const mapEvent = (key, event) => {
      mapped[key] = { id: event.id, end: event.end.date, signature: signature(event),
        summary: event.summary, start: event.start };
    };
    for (const [key, record] of Object.entries(meta.records)) {
      if (!keyInWeek(key, week)) { delete meta.records[key]; continue; }
      if (record.retired) {
        if (active.has(key)) { hold('remote', [active.get(key)]); return; }
        continue;
      }
      let event = active.get(key) || byId.get(record.id);
      if (!event) {
        const seen = await lookup(record.id);
        if (seen.tombstone) { record.retired = true; continue; }
        if (!seen.body) {
          if (record.end <= today && !desired.has(key)) continue;
          if (authorized && record.etag) { record.retired = true; continue; }
          hold('collision'); return;
        }
        event = seen.body;
      }
      if (!known(event, key, record.id)) {
        if (terminal(event) && !desired.has(key)) continue;
        hold('remote', [event]); return;
      }
      meta.records[key] = item(event, record.generation, terminal(event));
      if (!terminal(event)) mapEvent(key, event);
    }
    for (const [key, event] of active) {
      if (meta.records[key] || event.id === reserved?.id) continue;
      if (!authorized) { hold('remote', [event]); return; }
      meta.records[key] = item(event, Number(event.extendedProperties.private.generation));
      mapEvent(key, event);
    }
    const ops = diffEvents(desired, mapped, today);
    if (reserved) ops.sort((a, b) => Number(b.key === reserved.key) - Number(a.key === reserved.key));
    const changes = () => JSON.stringify(ops.map(op => [op.kind, op.key, meta.records[op.key]?.id,
      meta.records[op.key]?.etag, op.body ? signature(op.body) : null]));
    if (inspecting) {
      preview = { binding: meta.binding, local, today, raw, changes: changes(), counts: {
        insert: ops.filter(op => op.kind === 'insert').length,
        update: ops.filter(op => op.kind === 'update').length,
        delete: ops.filter(op => op.kind === 'delete').length,
        targets: labels(ops.filter(op => op.kind !== 'insert').map(op => mapped[op.key]))
      } };
      emit('review-resume', preview.counts);
      return;
    }
    if (applying) {
      if (preview?.changes !== changes()) {
        emit('continuity'); return;
      }
      acceptCheckpoint(storage, local, KEY);
      meta.hold = null;
      preview = null;
    }
    // Keep an uncertain insert's generation even if the currently desired plan changed.
    if (reserved && keyInWeek(reserved.key, week) && !desired.has(reserved.key)) {
      meta.pending = reserved;
      save();
      emit('collision');
      return;
    }
    if (reserved && !keyInWeek(reserved.key, week)) {
      meta.pending = reserved = null;
    }
    if (expiredHold && !meta.pending) meta.hold = null;
    if (!reserved) save();
    let changed = false, limited = false;
    for (const op of ops) {
      current();
      const entry = meta.records[op.key], conflictKey = entry?.id;
      if (op.kind !== 'insert' && (conflicts.get(conflictKey) || 0) >= 3) { limited = true; continue; }
      let next, target;
      if (op.kind === 'insert') {
        let eventGeneration = reserved?.key === op.key ? reserved.generation : entry ? entry.generation + 1 : 0;
        if (eventGeneration > 10000) fail('integrity');
        let id = eventIdFor(op.key, eventGeneration, meta.writer);
        if (applying && eventGeneration === 0 && reserved?.key !== op.key) {
          const previous = await lookup(id);
          if (previous.tombstone || terminal(previous.body)) {
            eventGeneration = 1;
            id = eventIdFor(op.key, eventGeneration, meta.writer);
          } else if (previous.body) { hold('remote', [previous.body]); return; }
        }
        // Recheck the window on inserts so independently initialized browsers see each
        // other's active plans before sending subsequent writes.
        const listed = await collect();
        const unexpected = listed.filter(e => e?.status !== 'cancelled' && !terminal(e) &&
          (!known(e, e.extendedProperties?.private?.key, e.id) ||
            (e.extendedProperties.private.key === op.key && e.id !== id)));
        if (unexpected.length) { hold('remote', unexpected); return; }
        next = operation(op, id, eventGeneration, null);
      } else {
        const seen = await lookup(op.id ?? entry.id);
        if (seen.tombstone) { entry.retired = true; save(); changed = true; continue; }
        if (!seen.body) { hold('collision'); return; }
        target = seen.body;
        if (!known(target, op.key, entry.id)) { hold('remote', [target]); return; }
        if (terminal(target)) { meta.records[op.key] = item(target, entry.generation, true); save(); changed = true; continue; }
        if (op.kind === 'update' && signature(target) === signature(op.body)) continue;
        next = operation(op, target.id, entry.generation, target.etag);
      }
      // This list is a name/ownership check on the exact same path, just before the mutation.
      try { checkTarget(await remote(() => api.verify(since, signal))); }
      catch (error) {
        if (['gone', 'permission'].includes(codeOf(error))) fail('binding-lost');
        throw error;
      }
      const existingReservation = next.kind === 'insert' && reserved?.key === op.key && signature(reserved.body) === signature(next.body);
      if (existingReservation) next.body = reserved.body;
      meta.pending = next;
      save();
      try {
        if (next.kind === 'delete') {
          await remote(() => api.delete(next.id, next.etag, signal));
          entry.retired = true;
          meta.pending = null;
        } else {
          const body = await remote(() => next.kind === 'insert'
            ? api.insert(next.body, signal) : api.update(next.body, next.etag, signal));
          resolve(next, body);
        }
        save();
        conflicts.delete(conflictKey);
      } catch (error) {
        if (error.code === 'changed') {
          meta.pending = null;
          save();
          const failures = (conflicts.get(conflictKey) || 0) + 1;
          conflicts.set(conflictKey, failures);
          if (failures >= 3) limited = true; else changed = true;
        } else if (error.code === 'conflict' && next.kind === 'insert') {
          const seen = await lookup(next.id);
          if (seen.body && known(seen.body, next.key, next.id)) {
            recordObserved(next, seen.body);
            save();
            if (terminal(seen.body) || signature(seen.body) !== signature(next.body)) changed = true;
          } else if (seen.body) { hold('remote', [seen.body]); return; }
          else { hold('collision'); return; }
        } else throw error;
      }
      if (reserved?.key === op.key) reserved = null;
    }
    // Detect a competing first connection even if each browser wrote a different final key.
    const competing = (await collect()).filter(e => e?.status !== 'cancelled' && !terminal(e) &&
      !known(e, e.extendedProperties?.private?.key, e.id));
    if (competing.length) { hold('remote', competing); return; }
    if (changed) {
      if (retries < 3) {
        emit('backoff');
        timer = setTimeout(() => request('retry'), retryDelay(retries++));
      } else emit('changed');
    } else { retries = 0; emit(limited ? 'changed' : 'synced'); }

    function operation(op, id, eventGeneration, etag) {
      const body = op.body ? structuredClone(op.body) : null;
      if (body) {
        body.id = id;
        Object.assign(body.extendedProperties.private, { schema: '2', writer: meta.writer,
          generation: String(eventGeneration), op: nonce() });
      }
      return { kind: op.kind, key: op.key, id, generation: eventGeneration, etag, body };
    }
  }

  function sessionFor(meta) {
    if (session?.binding !== meta.binding) {
      session?.auth.clear();
      conflicts.clear();
      session = { binding: meta.binding, auth: makeAuth(meta.clientId) };
    }
    return session;
  }

  async function prepare() {
    if (busy || stopped) return;
    try {
      allowed();
      const { meta } = readMeta(storage);
      if (!meta.binding) { emit('unconfigured'); return; }
      const selected = sessionFor(meta), epoch = generation;
      emit('loading');
      await selected.auth.prepare();
      if (epoch === generation && session === selected && readMeta(storage).meta.binding === selected.binding) emit('ready');
    } catch (error) { if (!busy && !stopped) report(error); }
  }

  async function connect() {
    if (busy || stopped) return;
    const epoch = generation;
    let selected;
    try {
      allowed();
      const { meta } = readMeta(storage);
      if (!meta.binding) { emit('unconfigured'); return; }
      selected = sessionFor(meta);
      emit('signing-in');
      await selected.auth.signIn();
      let connected = false;
      await locks.request(LOCK_NAME, async () => {
        if (busy || stopped || selected !== session || epoch !== generation) return;
        allowed();
        const fresh = readMeta(storage);
        if (fresh.meta.binding !== selected.binding) return;
        fresh.meta.enabled = true;
        writeMeta(storage, fresh.meta, fresh.raw);
        connected = true;
      });
      if (connected) { emit('syncing'); request('connected'); }
      else selected.auth.clear();
    } catch (error) {
      if (epoch === generation && !stopped && (!selected || session === selected)) report(error);
    }
  }

  async function manage(action) {
    if (busy || stopped) return;
    if (testClock || !locks) { report(new Error(testClock ? 'test-clock' : 'locks-unavailable')); return; }
    busy = true;
    generation++;
    resume = preview = null;
    dirty = false;
    clearTimeout(timer);
    controller?.abort();
    try {
      await locks.request(LOCK_NAME, async () => {
        if (!stopped) await action();
      });
    } catch (error) { report(error); }
    finally { busy = false; }
  }

  async function configure(clientId, calendarId) {
    if (!validClientId(clientId)) { emit('invalid-client'); return; }
    if (!validCalendarId(calendarId)) { emit('invalid-calendar'); return; }
    let saved = false;
    await manage(() => {
      allowed();
      const { meta, raw } = readMeta(storage);
      if (meta.clientId === clientId && meta.calendarId === calendarId) { saved = true; return; }
      session?.auth.clear();
      session = null;
      const next = meta.calendarId === calendarId ? meta : { ...emptyMeta(), writer: nonce() };
      if (!meta.binding) acceptCheckpoint(storage, store.raw, KEY);
      Object.assign(next, { clientId, calendarId, binding: nonce(), enabled: false });
      writeMeta(storage, next, raw);
      emit('off');
      saved = true;
    });
    if (saved) await flush();
    return saved;
  }

  async function disconnect() {
    await manage(async () => {
      emit('disconnecting');
      const { meta, raw } = readMeta(storage);
      const auth = session?.auth;
      session = null;
      meta.enabled = false;
      writeMeta(storage, meta, raw);
      const revoked = await auth?.revoke();
      emit(revoked ? 'off' : 'revoke-unconfirmed');
    });
  }

  async function reset() {
    await manage(() => {
      session?.auth.clear();
      session = null;
      writeMeta(storage, emptyMeta(), storage.getItem(META_KEY));
      emit('unconfigured');
    });
  }

  function reconsider(apply = false) {
    if (busy || stopped) return;
    try {
      allowed();
      const { meta, raw } = readMeta(storage);
      const local = store.raw, today = todayJst(now());
      if (apply && (preview?.raw !== raw || preview.local !== local || preview.today !== today)) {
        emit('continuity'); return;
      }
      resume = { stage: apply ? 'apply' : 'preview', binding: meta.binding, local, today, raw };
      request('resume');
    } catch (error) { report(error); }
  }

  function dispose() {
    stopped = true; clearTimeout(timer); controller?.abort(); session?.auth.clear();
  }
  return { request, flush, prepare, connect, configure, disconnect, reset, reconsider, dispose, status: () => status };
}
