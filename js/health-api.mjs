const BASE = 'https://health.googleapis.com/v4/users/me/';
const JSON_LIMIT = 1024 * 1024;
const TCX_LIMIT = 8 * JSON_LIMIT;
const TCX = 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2';
const DAY = 86_400_000;

export class HealthError extends Error {
  constructor(code, retryAt = 0) {
    super(code);
    this.code = code;
    this.retryAt = retryAt;
  }
}
export function errorCode(status, data) {
  if (status === 401) return 'expired';
  if (status === 429) return 'quota';
  if (status >= 500) return 'server';
  const info = Array.isArray(data?.error?.details) && data.error.details.find(d => d?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
  const detailed = info?.metadata?.detailedReasons;
  if (status === 400 && typeof detailed === 'string' &&
      /\b(?:INVALID_DATA_POINT_FILTER\w*|INVALID_TIME_RANGE)\b/.test(detailed)) return 'condition';
  const reason = info?.reason ?? data?.error?.status;
  switch (reason) {
    case 'ACCOUNT_NOT_LINKED': return 'unlinked';
    case 'MISSING_OAUTH_SCOPE': return 'scope';
    case 'API_PRIVATE_PREVIEW_ACCESS_DENIED': case 'DISALLOWED_OAUTH_SCOPES': return 'unavailable';
    case 'DATA_ACCESS_DENIED': case 'RESOURCE_PERMISSION_DENIED': case 'PERMISSION_DENIED': return 'denied';
    case 'RESOURCE_NOT_FOUND': case 'NOT_FOUND': return 'not-found';
    case 'INVALID_TIME_RANGE': case 'INVALID_DATA_TYPE_FORMAT': case 'INVALID_DATA_POINT_FILTER': case 'INVALID_ARGUMENT': return 'condition';
    default: return typeof reason === 'string' && reason.startsWith('INVALID_DATA_POINT_FILTER_') ? 'condition' : 'unknown';
  }
}
function calendarDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}
export function dateRange(start, end) {
  const a = calendarDay(start), b = calendarDay(end);
  if (a === null || b === null || b < a || b - a >= 7 * DAY || start < '1900-01-01' || end > '9999-12-30') {
    throw new HealthError('date');
  }
  return { start, end: new Date(b + DAY).toISOString().slice(0, 10) };
}
function civilMidnight(value) {
  const [year, month, day] = value.split('-').map(Number);
  return { date: { year, month, day }, time: { hours: 0, minutes: 0, seconds: 0 } };
}
export function rangeFilter(key, start, end) {
  return key + ' >= "' + start + '"' + (end ? ' AND ' + key + ' < "' + end + '"' : '');
}
function fieldPath(field, prefix = '') {
  const key = prefix + field.path.replaceAll('.', '/');
  return field.fields ? field.fields.flatMap(item => fieldPath(item, key + '/')) : [key];
}
function partialMask(key, fields, extra = []) {
  const mask = [...fields.flatMap(f => fieldPath(f)), ...extra];
  return key ? key + '(' + mask.join(',') + ')' : mask.join(',');
}
function url(path, query) {
  const endpoint = new URL(BASE + path);
  endpoint.search = new URLSearchParams(query);
  return endpoint;
}
function metricRequest(entry, range, time, pageToken) {
  const ecg = entry.time === 'ecg', reference = entry.time === 'reference';
  const path = 'dataTypes/' + (entry.gps ? 'exercise' : entry.id) + '/dataPoints';
  const mode = entry.mode, rollup = mode === 'dailyRollUp';
  const extra = entry.dateField ? [entry.dateField] : [];
  if (entry.gps) extra.push('exerciseMetadata/hasGps');
  const keys = [partialMask(entry.key, entry.fields, extra)];
  if (rollup) keys.unshift('civilStartTime');
  if (entry.gps) keys.unshift('dataPointName');
  const items = rollup ? 'rollupDataPoints' : 'dataPoints';
  const query = { fields: 'nextPageToken,' + items + '(' + keys.join(',') + ')' };
  if (rollup) return {
    url: url(path + ':dailyRollUp', query),
    body: { range: { start: civilMidnight(range.start), end: civilMidnight(range.end) }, windowSizeDays: 1, pageSize: 7 },
    items,
  };
  query.pageSize = ecg ? 5 : 20;
  if (!reference) {
    const first = ecg ? new Date(time - DAY).toISOString() : range.start;
    query.filter = rangeFilter(entry.filterKey, first, ecg ? undefined : range.end);
  }
  if (pageToken) query.pageToken = pageToken;
  return { url: url(path + (mode === 'reconcile' ? ':reconcile' : ''), query), items };
}
async function readText(response, budget, signal) {
  const length = Number(response.headers.get('content-length'));
  if (length > budget.remaining) {
    void response.body?.cancel().catch(() => {});
    throw new HealthError('size');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let result = '';
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) return result + decoder.decode();
      budget.remaining -= value.byteLength;
      if (budget.remaining < 0) throw new HealthError('size');
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function parseJson(value) {
  try {
    const result = JSON.parse(value);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new HealthError('format'); }
}
function retryTime(value) {
  const now = Date.now();
  const delay = /^\d+$/.test(value ?? '') ? Number(value) * 1000 : Date.parse(value) - now;
  return now + (Number.isFinite(delay) && delay >= 0 ? Math.max(1000, delay) : 5000);
}
export function healthReader(access, signal, current = () => true) {
  const budget = { remaining: JSON_LIMIT };
  async function request(address, body, tcx = false) {
    signal.throwIfAborted();
    if (!current()) throw new HealthError('interrupted');
    const headers = { Authorization: 'Bearer ' + access, Accept: tcx ? 'application/tcx+xml' : 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    const deadline = AbortSignal.timeout(20000);
    const requestSignal = AbortSignal.any([signal, deadline]);
    try {
      const response = await fetch(address, {
        method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
        credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        signal: requestSignal,
      });
      if (!response.ok) {
        let data;
        if ([400, 403, 404].includes(response.status)) {
          try { data = parseJson(await readText(response, { remaining: 32768 }, requestSignal)); }
          catch { requestSignal.throwIfAborted(); }
        } else void response.body?.cancel().catch(() => {});
        throw new HealthError(errorCode(response.status, data),
          response.status === 429 ? retryTime(response.headers.get('Retry-After')) : 0);
      }
      const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (tcx ? !['application/tcx+xml', 'application/xml', 'text/xml', 'application/octet-stream'].includes(type) : type !== 'application/json') {
        void response.body?.cancel().catch(() => {});
        throw new HealthError('format');
      }
      const data = await readText(response, tcx ? { remaining: TCX_LIMIT } : budget, requestSignal);
      return tcx ? data : parseJson(data);
    } catch (e) {
      signal.throwIfAborted();
      if (e instanceof HealthError) throw e;
      throw new HealthError(deadline.aborted ? 'timeout' : 'network');
    }
  }
  async function identity() {
    const { healthUserId } = await request(url('identity', { fields: 'healthUserId' }));
    if (typeof healthUserId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(healthUserId)) throw new HealthError('format');
    return healthUserId;
  }
  async function data(entry, range) {
    if (entry.mode === 'resource') {
      const mask = partialMask(entry.listKey, entry.fields);
      const query = entry.listKey ? { fields: 'nextPageToken,' + mask, pageSize: 20 } : { fields: mask };
      const object = await request(url(entry.endpoint ?? entry.id, query));
      return entry.listKey ? take(object, entry.listKey, 20) : { rows: Object.keys(object).length ? [object] : [] };
    }

    const captureTime = Date.now(), rows = [], seen = new Set();
    const singlePage = ['ecg', 'reference', 'rollup'].includes(entry.time);
    const pageLimit = singlePage ? 1 : 3;
    const pageSize = entry.time === 'ecg' ? 5 : entry.time === 'rollup' ? 7 : 20;
    let token;
    for (let i = 0; i < pageLimit; i++) {
      signal.throwIfAborted();
      const next = metricRequest(entry, range, captureTime, token);
      const object = await request(next.url, next.body);
      const page = take(object, next.items, pageSize);
      if (entry.time === 'ecg') {
        page.rows = page.rows.filter(row => {
          const start = Date.parse(row[entry.key]?.interval?.startTime);
          return Number.isFinite(start) && start >= captureTime - DAY && start <= captureTime;
        });
      }
      rows.push(...page.rows);
      token = object.nextPageToken;
      if (page.overLimit || (token && (typeof token !== 'string' || token.length > 2048 || seen.has(token)))) return { rows, truncated: true };
      if (!token) return { rows };
      seen.add(token);
    }
    return { rows, truncated: true };
  }
  async function route(name, healthUserId) {
    const parts = /^users\/([a-zA-Z0-9_-]{1,200})\/dataTypes\/exercise\/dataPoints\/(\d{1,19})$/.exec(name ?? '');
    if (!parts || !['me', healthUserId].includes(parts[1]) || BigInt(parts[2]) > 9223372036854775807n) throw new HealthError('format');
    const source = await request(url('dataTypes/exercise/dataPoints/' + parts[2] + ':exportExerciseTcx', { alt: 'media' }), undefined, true);
    return parseTrack(source);
  }
  return { identity, data, route };
}
function take(value, key, limit) {
  const input = value[key] === undefined ? [] : value[key];
  if (!Array.isArray(input)) throw new HealthError('format');
  const rows = input.slice(0, limit);
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new HealthError('format');
  return { rows, overLimit: input.length > limit, truncated: input.length > limit || Boolean(value.nextPageToken) };
}
export function parseTrack(source) {
  if (/<!DOCTYPE\b/i.test(source)) throw new HealthError('format');
  const xml = new DOMParser().parseFromString(source, 'application/xml');
  if (xml.documentElement.namespaceURI !== TCX || xml.documentElement.localName !== 'TrainingCenterDatabase') throw new HealthError('format');
  const points = [];
  for (const point of xml.getElementsByTagNameNS(TCX, 'Trackpoint')) {
    const position = point.getElementsByTagNameNS(TCX, 'Position')[0];
    if (!position) continue;
    const field = key => position.getElementsByTagNameNS(TCX, key)[0]?.textContent.trim();
    const lat = field('LatitudeDegrees'), lng = field('LongitudeDegrees');
    if (!lat || !lng || !/^-?\d+(?:\.\d+)?$/.test(lat) || !/^-?\d+(?:\.\d+)?$/.test(lng) || Math.abs(Number(lat)) > 90 || Math.abs(Number(lng)) > 180) continue;
    const time = point.getElementsByTagNameNS(TCX, 'Time')[0]?.textContent;
    const ms = Date.parse(time);
    if (points.length === 100) return { points, truncated: true };
    points.push({ lat: Number(lat), lng: Number(lng), utc: Number.isFinite(ms) ? new Date(ms).toISOString() : '' });
  }
  return { points };
}
