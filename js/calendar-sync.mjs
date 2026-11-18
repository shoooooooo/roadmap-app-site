import { KEY } from './schema.mjs';
import { todayJst, weekStart } from './date-jst.mjs';
import { CALENDAR_NAME } from './calendar-config.mjs';
import { desiredEvents, diffEvents, signature, ownedEvent, eventIdFor } from './calendar-plan.mjs';
import { readMeta, writeMeta, emptyMeta } from './calendar-meta.mjs';

export function createCalendarSync({ storage, store, auth, api, clientId, testClock = false, allowTestClock = false, now = () => Date.now(), online = () => globalThis.navigator?.onLine !== false, locks = globalThis.navigator?.locks, onStatus = () => {}, delay = 800, retryDelay = n => Math.min(300000, 2000 * 2 ** n) * (0.8 + Math.random() * 0.4) }) {
  let status = 'off', timer, running = null, dirty = false, version = 0, controller, retries = 0, stopped = false, disconnecting = false, explicitCreate = false;
  const emit = code => { status = code; onStatus(code); };
  const allowed = () => { if (!clientId) return 'unconfigured'; if (testClock && !allowTestClock) return 'test-clock'; return null; };
  const localReady = () => {
    if (store.safe) return false;
    try { return storage.getItem(KEY) === store.raw; } catch { return false; }
  };
  function request(reason = 'saved') {
    if (stopped || disconnecting) return;
    if (['online', 'manual', 'connected'].includes(reason)) retries = 0;
    version++; dirty = true; clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, delay);
  }
  async function flush() {
    clearTimeout(timer);
    if (stopped || disconnecting) return;
    if (running) { await running; if (dirty) await flush(); return; }
    dirty = true;
    running = (async () => {
      while (dirty && !stopped && !disconnecting) {
        dirty = false; const generation = version;
        try {
          if (locks) {
            await locks.request('roadmap-app-calendar-sync', { ifAvailable: true }, async lock => {
              if (lock) await pass(generation);
              else { emit('other-tab'); timer = setTimeout(() => request('retry'), 5000); }
            });
          } else await pass(generation);
        } catch (e) {
          const code = e.code || e.message;
          if (code === 'aborted') continue;
          if (code === 'needs-sign-in') auth.clear();
          emit(['needs-sign-in', 'permission', 'binding-lost', 'creation-ambiguous', 'meta-corrupt', 'meta-write-failed', 'storage-unavailable', 'paused-local', 'integrity', 'api-error'].includes(code) ? code : 'sync-error');
          if (['network', 'server', 'rate'].includes(code) && retries < 6) {
            emit(online() ? 'backoff' : 'offline');
            if (online()) timer = setTimeout(() => request('retry'), retryDelay(retries++));
          }
          // A storage/binding/auth error needs intervention, not an immediate loop.
          dirty = false;
        }
      }
    })();
    try { await running; } finally { running = null; }
  }
  async function pass(generation) {
    const block = allowed(); if (block) { emit(block); return; }
    let { meta, raw } = readMeta(storage);
    if (!meta.enabled) { emit('off'); return; }
    if (!online()) { emit('offline'); return; }
    if (!auth.token()) { emit('needs-sign-in'); return; }
    if (!localReady()) { emit('paused-local'); return; }
    const today = todayJst(now()), desired = desiredEvents(store.state, today);
    if (desired === null) { emit('paused-local'); return; }
    controller = new AbortController(); const signal = controller.signal;
    const save = () => { raw = writeMeta(storage, meta, raw); };
    const current = () => !disconnecting && !signal.aborted && generation === version && localReady() && todayJst(now()) === today && auth.token();
    emit('syncing');
    if (meta.creation !== null) throw new Error('creation-ambiguous');
    if (!meta.calendarId) {
      if (meta.knownCalendars.length && !explicitCreate) throw new Error('binding-lost');
      if (!current()) return;
      // Persist BEFORE non-idempotent calendar creation. Unknown outcomes never retry.
      meta.creation = 'in-flight'; save();
      let created;
      try { created = await api.create(signal); }
      catch (e) {
        meta.creation = ['network', 'server', 'aborted'].includes(e.code) ? 'ambiguous' : null; save();
        if (meta.creation) throw new Error('creation-ambiguous');
        throw e;
      }
      meta.calendarId = created.id; meta.knownCalendars = [...new Set([created.id, ...meta.knownCalendars])].slice(0, 3); meta.creation = null; save(); explicitCreate = false;
    }
    if (!current()) return;
    async function collect(id) {
      const found = []; let pageToken, pages = 0;
      do {
        const page = await api.list(id, today, pageToken, signal);
        if (page.summary !== CALENDAR_NAME || !Array.isArray(page.items)) throw new Error('binding-lost');
        found.push(...page.items); pageToken = page.nextPageToken;
        if (++pages > 10 || found.length > 1000) throw new Error('integrity');
      } while (pageToken && current());
      return found;
    }
    let found;
    try { found = await collect(meta.calendarId); }
    catch (e) {
      if (!['gone', 'permission', 'binding-lost'].includes(e.code || e.message)) throw e;
      for (const id of meta.knownCalendars.filter(id => id !== meta.calendarId)) {
        try { found = await collect(id); meta.calendarId = id; meta.events = {}; meta.generations = {}; break; }
        catch (other) { if (!['gone', 'permission', 'binding-lost'].includes(other.code || other.message)) throw other; }
      }
      if (!found) throw new Error('binding-lost');
    }
    if (!current()) return;
    // Keep ended incarnations until a fresh generation has been durably reserved.
    const wk = weekStart(today), fresh = {};
    if (meta.generationWeek !== wk) {
      // Week rollover is the only collection boundary, never a temporary deletion.
      const carry = new Set([...desired.keys(), ...Object.entries(meta.events).filter(([, entry]) => entry.end > wk).map(([key]) => key)]);
      for (const key of Object.keys(meta.generations)) if (!carry.has(key)) delete meta.generations[key];
      meta.generationWeek = wk;
    }
    for (const [key, entry] of Object.entries(meta.events)) if (entry.end <= today && entry.end > wk) fresh[key] = entry;
    for (const body of found) {
      if (!ownedEvent(body) || body.status === 'cancelled') continue;
      const key = body.extendedProperties.private.key;
      if (fresh[key]?.end <= today) {
        if (fresh[key].id === body.id) continue;
        delete fresh[key];
      }
      if (fresh[key]) throw new Error('integrity');
      meta.generations[key] = Number(body.extendedProperties.private.generation);
      fresh[key] = { id: body.id, signature: signature(body), first: body.start.date, end: body.end.date };
    }
    meta.events = fresh;
    // Deleted keys retain their generation through clock ticks, pause and reload.
    save();
    async function upsert(key, original, update) {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (!current()) return null;
        const gen = meta.generations[key] || 0;
        const body = structuredClone(original); body.id = eventIdFor(key, gen); body.extendedProperties.private.generation = String(gen);
        if (update) {
          try { await api.update(meta.calendarId, body, signal); return body; }
          catch (e) { if (e.code !== 'gone') throw e; update = false; }
        }
        try { await api.insert(meta.calendarId, body, signal); return body; }
        catch (e) {
          if (e.code !== 'conflict') throw e;
          let existing;
          try { existing = await api.get(meta.calendarId, body.id, signal); }
          catch (readError) {
            // 404 after conflict may be propagation delay: do not allocate another ID.
            if (readError.status !== 410) throw readError;
          }
          if (existing && existing.status !== 'cancelled') {
            if (!ownedEvent(existing) || existing.extendedProperties.private.key !== key) throw new Error('integrity');
            if (existing.end.date <= today) throw new Error('integrity');
            if (signature(existing) !== signature(body)) await api.update(meta.calendarId, body, signal);
            return body;
          }
          // Deleted IDs may remain reserved. A durable generation makes revival idempotent.
          meta.generations[key] = gen + 1; delete meta.events[key]; save();
        }
      }
      throw new Error('integrity');
    }
    for (const op of diffEvents(desired, meta.events, today)) {
      if (!current()) return;
      if (op.kind === 'delete') {
        try { await api.delete(meta.calendarId, op.id, signal); } catch (e) { if (e.code !== 'gone') throw e; }
        delete meta.events[op.key];
      } else {
        if (meta.events[op.key]?.end <= today) {
          meta.generations[op.key] = (meta.generations[op.key] || 0) + 1;
          delete meta.events[op.key]; save();
        }
        const body = await upsert(op.key, op.body, op.kind === 'update');
        if (!body) return;
        meta.events[op.key] = { id: body.id, signature: signature(body), first: body.start.date, end: body.end.date };
      }
      // Late responses may have changed the server. Record only into the same binding.
      save();
    }
    if (current()) { retries = 0; emit('synced'); }
  }
  async function connect() {
    if (disconnecting || stopped) return;
    const block = allowed(); if (block) { emit(block); return; }
    try {
      readMeta(storage); emit('signing-in');
      await auth.signIn();
      if (disconnecting || stopped) { auth.clear(); return; }
      const { meta, raw } = readMeta(storage); meta.enabled = true; writeMeta(storage, meta, raw);
      request('connected');
    } catch (e) { emit(['meta-corrupt', 'storage-unavailable', 'meta-write-failed', 'permission'].includes(e.message) ? e.message : 'needs-sign-in'); }
  }
  async function disconnect() {
    if (disconnecting) return;
    disconnecting = true; version++; dirty = false; clearTimeout(timer); controller?.abort(); emit('disconnecting');
    // Immediately clear credentials; then let the old pass settle before persisting disabled.
    const revocation = auth.revoke();
    await running;
    const revoked = await revocation;
    try { const { meta, raw } = readMeta(storage); meta.enabled = false; writeMeta(storage, meta, raw); emit(revoked ? 'off' : 'revoke-unconfirmed'); }
    catch (e) { emit(e.message); }
    finally { disconnecting = false; }
  }
  async function createAgain() {
    if (running || disconnecting || !auth.token()) { emit('needs-sign-in'); return; }
    try {
      const { meta, raw } = readMeta(storage);
      // Explicit confirmation in the UI is required; retain old bindings for another account.
      meta.calendarId = null; meta.creation = null; meta.events = {}; meta.generations = {};
      writeMeta(storage, meta, raw);
      explicitCreate = true; request('manual'); await flush();
    } catch (e) { emit(e.message); }
    finally { explicitCreate = false; }
  }
  async function reset() {
    version++; controller?.abort(); dirty = false; clearTimeout(timer); auth.clear(); await running;
    try { const raw = storage.getItem('roadmap-app.calendar-sync.v1'); writeMeta(storage, emptyMeta(), raw); emit('off'); }
    catch { emit('meta-write-failed'); }
  }
  function dispose() { stopped = true; dirty = false; clearTimeout(timer); controller?.abort(); auth.clear(); }
  return { request, flush, connect, disconnect, createAgain, reset, dispose, status: () => status };
}
