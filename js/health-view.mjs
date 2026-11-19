import { el } from './views.mjs';

import { healthEnumLabel } from './health-enums.mjs';

const missing = '値なし';
const get = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);

export function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}
const concise = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 3 });
const two = v => String(v).padStart(2, '0');
function date(value) {
  if (![value?.year, value?.month, value?.day].every(Number.isInteger) || value.year < 1900 || value.year > 9999) return '';
  const key = String(value.year) + '-' + two(value.month) + '-' + two(value.day);
  const parsed = Date.parse(key + 'T00:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(key + 'T') ? key : '';
}
function civil(value) {
  const day = date(value?.date);
  const { hours = 0, minutes = 0, seconds = 0 } = value?.time ?? {};
  if (!day || ![hours, minutes, seconds].every(Number.isInteger) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) return '';
  return day + ' ' + two(hours) + ':' + two(minutes) + ':' + two(seconds);
}
function timestamp(value, offset) {
  const ms = typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return '';
  const seconds = typeof offset === 'string' && /^-?\d+s$/.test(offset) ? Number(offset.slice(0, -1)) : NaN;
  if (!Number.isFinite(seconds) || Math.abs(seconds) > 18 * 3600) return new Date(ms).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  return new Date(ms + 1000 * seconds).toISOString().slice(0, 19).replace('T', ' ') + '（記録地）';
}
function measureTime(entry, value, raw) {
  switch (entry.time) {
    case 'daily': return date(value.date);
    case 'rollup': return date(raw.civilStartTime?.date);
    case 'sample': return civil(value.sampleTime?.civilTime) || timestamp(value.sampleTime?.physicalTime, value.sampleTime?.utcOffset);
    case 'sleep': return civil(value.interval?.civilEndTime) || timestamp(value.interval?.endTime, value.interval?.endUtcOffset);
    case 'interval': case 'session': case 'ecg': return civil(value.interval?.civilStartTime) || timestamp(value.interval?.startTime, value.interval?.startUtcOffset);
    default: return '';
  }
}
function format(value, field) {
  switch (field.format) {
    case 'text': return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : missing;
    case 'flag': return value === true ? 'はい' : value === false ? 'いいえ' : missing;
    case 'date': return date(value) || missing;
    case 'datetime': return civil(value) || missing;
    case 'utc': return timestamp(value) || missing;
    case 'enum': return typeof value === 'string' ? healthEnumLabel(field.enumGroup, value) : missing;
    case 'duration': return typeof value === 'string' && /^\d+(?:\.\d+)?s$/.test(value) ? concise.format(Number(value.slice(0, -1)) / 60) + ' 分' : missing;
    case 'sleepDuration': {
      const m = numeric(value);
      return m === null || m < 0 ? missing : Math.floor(m / 60) + ' 時間 ' + m % 60 + ' 分';
    }
    default: {
      const n = numeric(value);
      return n === null ? missing : concise.format(n * field.scale) + (field.format === 'number' ? '' : ' ' + field.format);
    }
  }
}
function rowsInto(dl, fields, datum) {
  for (const field of fields) {
    const value = get(datum, field.path);
    if (field.fields) {
      if (!Array.isArray(value) || !value.length) {
        dl.append(el('dt', {}, field.path === 'summary.stagesSummary' ? '睡眠ステージ' : '内訳'), el('dd', {}, missing));
        continue;
      }
      for (const part of value.slice(0, 20)) rowsInto(dl, field.fields, part);
      if (value.length > 20) dl.append(el('dt', {}, '内訳'), el('dd', {}, '先頭20件を表示'));
    } else dl.append(el('dt', {}, field.label), el('dd', {}, format(value, field)));
  }
}
function sleepDetails(list, sleep) {
  const summary = sleep.summary, a = numeric(summary?.minutesAsleep), b = numeric(summary?.minutesInSleepPeriod);
  const efficiency = a !== null && b !== null && a >= 0 && b > 0 && a <= b ? Math.round(a / b * 100) + ' %' : '算出不可';
  list.append(el('dt', {}, '睡眠効率（アプリ計算）'), el('dd', {}, efficiency + '（実睡眠 ÷ 睡眠期間）'));
  const start = civil(sleep.interval?.civilStartTime) || timestamp(sleep.interval?.startTime, sleep.interval?.startUtcOffset);
  if (start) list.append(el('dt', {}, '就寝日時'), el('dd', {}, start));
}
export function renderHealthRows(target, entry, result, selectTrack) {
  const ordered = result.rows.map(raw => {
    const value = entry.key ? raw[entry.key] : raw;
    return { raw, value, when: measureTime(entry, value ?? {}, raw) };
  }).sort((a, b) => a.when.localeCompare(b.when));
  target.replaceChildren();
  if (!ordered.length) target.append(el('p', {}, '指定の条件に記録がありません。装着・同期・対応機能は機器によって異なります。'));
  if (entry.mode === 'dailyRollUp') target.append(el('p', {}, 'Google Healthの日別集計。値のない日は記録なしとして表示します。'));
  if (entry.latest) target.append(el('p', {}, '指定期間内の最新最大60件。' + entry.latest));
  if (result.truncated) target.append(el('p', {}, '取得上限に達したため一部表示です。条件を絞って再表示できます。'));
  const known = ordered.map(r => r.when).filter(Boolean);
  if (entry.latest && known.length) target.append(el('p', {}, '表示した測定時刻 ' + known.at(0) + ' ～ ' + known.at(-1)));
  for (const { raw, value, when } of ordered) {
    const heading = when || (entry.time && entry.time !== 'reference' ? '測定日時なし' : entry.label);
    const article = el('article', { class: 'health-record' }, el('h4', {}, heading));
    if (!value) article.append(el('p', {}, '記録なし'));
    else {
      const list = el('dl', {});
      rowsInto(list, entry.fields, value);
      if (entry.time === 'sleep') sleepDetails(list, value);
      article.append(list);
      if (entry.id === 'pairedDevices' && /^Fitbit Ace(?:\s|$)/i.test(value.deviceVersion ?? '')) {
        article.append(el('p', {}, 'Fitbit AceシリーズはGoogle Health APIに非対応です。'));
      }
      if (entry.gps) {
        if (raw.dataPointName && value.exerciseMetadata?.hasGps === true) {
          const button = el('button', { type: 'button' }, 'この運動のGPSを表示');
          button.addEventListener('click', () => selectTrack(raw.dataPointName));
          article.append(button);
        } else article.append(el('p', {}, 'この運動の記録にGPS経路はありません。'));
      }
    }
    target.append(article);
  }
}

function latestTime(entry, value, raw) {
  if (entry.time === 'daily' || entry.time === 'rollup') {
    const day = measureTime(entry, value, raw);
    return { day, when: '' };
  }
  const sample = value.sampleTime;
  const interval = value.interval;
  const [local, physical, offset] = entry.time === 'sleep' ?
    [interval?.civilEndTime, interval?.endTime, interval?.endUtcOffset] :
    [sample?.civilTime, sample?.physicalTime, sample?.utcOffset];
  const parts = typeof physical === 'string' &&
    /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(physical);
  const ms = parts ? Date.parse(parts[1] + parts[3]) : NaN;
  const instant = Number.isFinite(ms) ? BigInt(ms) * 1_000_000n + BigInt((parts[2] ?? '').padEnd(9, '0')) : null;
  const shifted = timestamp(physical, offset);
  const recorded = shifted.endsWith('（記録地）') ? shifted.slice(0, 19) : '';
  const day = date(local?.date) || recorded.slice(0, 10);
  const hasTime = local?.time && typeof local.time === 'object' && !Array.isArray(local.time);
  const nanos = local?.time?.nanos ?? 0;
  const localTime = hasTime && Number.isInteger(nanos) && nanos >= 0 && nanos < 1e9 && civil(local);
  const when = localTime || (day && recorded.startsWith(day) ? recorded : '');
  const fraction = localTime ? String(nanos).padStart(9, '0') : (parts?.[2] ?? '').padEnd(9, '0');
  return { day, when, key: when ? when + '.' + fraction : '', instant };
}

export function latestHealth(entry, result, range) {
  const candidates = [], notes = [];
  let unknownDate = false;
  for (const raw of result.rows) {
    const value = raw[entry.key];
    if (entry.time === 'rollup' && !entry.fields.some(field => get(value, field.path) != null)) continue;
    const time = latestTime(entry, value ?? {}, raw);
    if (!time.day) unknownDate = true;
    else if (time.day >= range.start && time.day < range.end) candidates.push({ ...time, value: value ?? {} });
  }
  if (result.truncated) notes.push('取得上限に達したため最新未確認');
  if (unknownDate) notes.push('日時不明の記録があるため最新未確認');
  if (!candidates.length) return { rows: [], notes };

  const allInstants = candidates.every(row => row.instant != null);
  let chosen;
  let differentPrecision = false;
  if (allInstants) {
    const newest = candidates.reduce((a, b) => a.instant >= b.instant ? a : b).instant;
    chosen = candidates.filter(row => row.instant === newest);
  } else {
    const day = candidates.map(row => row.day).sort().at(-1);
    const sameDay = candidates.filter(row => row.day === day);
    const key = sameDay.map(row => row.key ?? '').sort().at(-1);
    chosen = sameDay.filter(row => !row.key || row.key === key);
    differentPrecision = key !== '' && chosen.some(row => !row.when);
    if (candidates.some(row => row.instant != null)) notes.push('記録の時刻の基準がそろわないため最新未確認');
    if (differentPrecision) notes.push('同じ日の時刻が不明な記録があるため最新未確認');
  }
  const fields = entry.time === 'sleep' ? entry.fields.filter(field => field.path === 'summary.minutesAsleep') : entry.fields;
  const rows = [...new Map(chosen.map(row => {
    const values = fields.map(field => [field, get(row.value, field.path)]);
    const nap = entry.time === 'sleep' && row.value.metadata?.mainSleep === false;
    const identity = JSON.stringify([row.day, row.when, values.map(([, value]) => numeric(value) ?? value), nap]);
    return [identity, { day: row.day, when: row.when, values, nap }];
  })).values()];
  if (rows.length > 1 && !differentPrecision) {
    notes.push(entry.time === 'daily' || entry.time === 'rollup' ? '同じ日に複数の値' :
      rows.every(row => row.when) ? '同時刻に複数の値' : '日時を区別できない複数の値');
  }
  const shown = rows.slice(0, 3);
  if (rows.length > shown.length) notes.push('候補は最大3件表示');
  return { rows: shown, notes };
}

export function renderHealthList(target, readings, range) {
  target.replaceChildren(...readings.map(({ entry, result, message }) => {
    const card = el('article', { class: 'health-record health-latest', 'data-health-latest': entry.id }, el('h4', {}, entry.label));
    if (message) {
      card.append(el('p', {}, message));
      return card;
    }
    const { rows, notes } = latestHealth(entry, result, range);
    for (const note of notes) card.append(el('p', { class: 'health-note' }, note));
    if (!rows.length && !notes.length) card.append(el('p', {}, '期間内に記録なし'));
    for (const { day, when, values, nap } of rows) {
      const time = entry.time === 'sleep' ? '起床 ' : '';
      const precision = when ? '（記録地）' : ['daily', 'rollup'].includes(entry.time) ? '（日別）' : '（時刻なし）';
      const reading = values.map(([field, value]) => {
        const prefix = entry.time === 'sleep' ? '実睡眠 ' : values.length > 1 ? field.label + ' ' : '';
        return el('span', {}, prefix + format(value, field));
      });
      card.append(el('p', { class: 'health-latest-value' }, ...reading),
        el('p', { class: 'health-note' }, time + (when || day) + precision));
      if (nap) card.append(el('p', { class: 'health-note' }, '主な睡眠ではない記録（昼寝など）'));
    }
    return card;
  }));
}

export function renderTrack(target, result) {
  target.replaceChildren(el('h4', {}, '運動のGPS経路'));
  if (!result.points.length) target.append(el('p', {}, '表示できる位置記録がありません。'));
  const list = el('ol', {});
  for (const { lat, lng, utc } of result.points) {
    list.append(el('li', {}, (utc ? utc.replace('T', ' ').replace('Z', ' UTC') : '時刻なし') + '　緯度 ' + lat + '°　経度 ' + lng + '°'));
  }
  if (list.childElementCount) target.append(list);
  if (result.truncated) target.append(el('p', {}, '先頭100点を表示しています。'));
}
