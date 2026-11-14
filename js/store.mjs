import { KEY, initialState, validateState } from './schema.mjs';
export function createStore(storage, now = () => Date.now()) {
  let state = initialState(now()), raw = null, error = '', safe = false;
  try { raw = storage.getItem(KEY); if (raw !== null) state = validateState(JSON.parse(raw)); }
  catch { safe = true; error = '端末内データを読めません。安全モードです。元データを保存してから復元してください。'; }
  function commit(mutator, recovery = false) {
    try {
      if (safe && !recovery) throw new Error('安全モードのため変更できません。バックアップから復元してください。');
      if (storage.getItem(KEY) !== raw) throw new Error('別のタブで変更されました。再読込してから操作してください。');
      let next = structuredClone(state);
      next = mutator(next) || next;
      next.revision = state.revision + 1; next.savedAt = new Date(now()).toISOString();
      next = validateState(next);
      const text = JSON.stringify(next);
      storage.setItem(KEY, text);
      if (storage.getItem(KEY) !== text) { safe = true; throw new Error('保存の読戻しに失敗しました。再読込して確認してください。'); }
      state = next; raw = text; error = ''; safe = false; return true;
    } catch (e) { error = `保存できませんでした。${e.message}`; return false; }
  }
  return { get state() { return structuredClone(state); }, get error() { return error; }, get safe() { return safe; }, get raw() { return raw; }, commit, restore: s => commit(() => validateState(s), true) };
}
