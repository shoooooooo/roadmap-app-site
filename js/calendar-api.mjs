import { CALENDAR_NAME } from './calendar-config.mjs';
export const API_BASE = 'https://www.googleapis.com/calendar/v3';
export class CalendarError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
export function createCalendarApi({ fetch: fetcher = globalThis.fetch, getToken }) {
  async function request(method, path, body, signal) {
    const token = getToken(); if (!token) throw new CalendarError('needs-sign-in');
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      if (signal?.aborted) throw new CalendarError('aborted');
      const r = await fetcher(API_BASE + path, { method, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
      if (r.ok) return r.status === 204 ? null : await r.json();
      let code = ({ 401: 'needs-sign-in', 403: 'permission', 404: 'gone', 410: 'gone', 409: 'conflict', 429: 'rate' })[r.status] || (r.status >= 500 ? 'server' : 'api-error');
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
  const events = id => `/calendars/${encodeURIComponent(id)}/events`;
  return {
    create: signal => request('POST', '/calendars', { summary: CALENDAR_NAME, timeZone: 'Asia/Tokyo', description: 'みちしるべ専用の予定カレンダー' }, signal),
    list: (id, today, pageToken, signal) => request('GET', events(id) + '?' + new URLSearchParams({ timeMin: `${today}T00:00:00+09:00`, privateExtendedProperty: 'app=roadmap-app', maxResults: '250', showDeleted: 'false', ...(pageToken ? { pageToken } : {}) }), null, signal),
    get: (id, event, signal) => request('GET', `${events(id)}/${encodeURIComponent(event)}`, null, signal),
    insert: (id, body, signal) => request('POST', events(id) + '?sendUpdates=none', body, signal),
    update: (id, body, signal) => request('PUT', `${events(id)}/${encodeURIComponent(body.id)}?sendUpdates=none`, body, signal),
    delete: (id, event, signal) => request('DELETE', `${events(id)}/${encodeURIComponent(event)}?sendUpdates=none`, null, signal)
  };
}
