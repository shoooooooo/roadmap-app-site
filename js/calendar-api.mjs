import { validCalendarId } from './calendar-config.mjs';
export const API_BASE = 'https://www.googleapis.com/calendar/v3';
export class CalendarError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
export const strongEtag = value => typeof value === 'string' && /^"[!-!#-~]+"$/.test(value) && !/[\r\n]/.test(value);
export function createCalendarApi({ calendarId, fetch: fetcher = globalThis.fetch, getToken }) {
  if (!validCalendarId(calendarId)) throw new CalendarError('invalid-calendar');
  const events = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const event = id => `${events}/${encodeURIComponent(id)}`;
  async function request(method, path, body, signal, etag) {
    if (['PUT', 'DELETE'].includes(method) && !strongEtag(etag)) throw new CalendarError('integrity');
    const token = getToken(); if (!token) throw new CalendarError('needs-sign-in');
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      if (signal?.aborted) throw new CalendarError('aborted');
      const headers = { Authorization: `Bearer ${token}` };
      if (body) headers['Content-Type'] = 'application/json';
      if (etag) headers['If-Match'] = etag;
      const r = await fetcher(API_BASE + path, { method, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
      if (r.ok) return r.status === 204 ? null : await r.json();
      let code = ({ 401: 'needs-sign-in', 403: 'permission', 404: 'gone', 410: 'gone', 409: 'conflict', 412: 'changed', 429: 'rate' })[r.status] || (r.status >= 500 ? 'server' : 'api-error');
      if (r.status === 403) {
        const data = await r.json().catch(() => null);
        if (data?.error?.errors?.some(e => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(e.reason))) code = 'rate';
      }
      throw new CalendarError(code, r.status);
    } catch (e) {
      if (e instanceof CalendarError) throw e;
      throw new CalendarError(signal?.aborted ? 'aborted' : 'network');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return {
    list: (since, pageToken, signal) => request('GET', events + '?' + new URLSearchParams({ timeMin: `${since}T00:00:00+09:00`, privateExtendedProperty: 'app=roadmap-app', maxResults: '250', showDeleted: 'false', ...(pageToken ? { pageToken } : {}) }), null, signal),
    verify: (since, signal) => request('GET', events + '?' + new URLSearchParams({ timeMin: `${since}T00:00:00+09:00`, maxResults: '1', fields: 'summary,accessRole' }), null, signal),
    get: (id, signal) => request('GET', event(id), null, signal),
    insert: (body, signal) => request('POST', events + '?sendUpdates=none', body, signal),
    update: (body, etag, signal) => request('PUT', event(body.id) + '?sendUpdates=none', body, signal, etag),
    delete: (id, etag, signal) => request('DELETE', event(id) + '?sendUpdates=none', null, signal, etag)
  };
}
