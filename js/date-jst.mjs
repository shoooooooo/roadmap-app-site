const DAY = 86400000;
export const todayJst = (ms = Date.now()) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
export const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
export const addDays = (s, n) => new Date(Date.parse(s) + n * DAY).toISOString().slice(0, 10);
export const weekday = s => new Date(s).getUTCDay() || 7;
export const weekStart = s => addDays(s, 1 - weekday(s));
export const dateLabel = s => `${Number(s.slice(5, 7))}/${Number(s.slice(8))}（${'月火水木金土日'[weekday(s) - 1]}）`;
export const ageAt = (birth, date) => Number(date.slice(0, 4)) - Number(birth.slice(0, 4)) - (date.slice(5, 7) < birth.slice(5, 7) ? 1 : 0);
