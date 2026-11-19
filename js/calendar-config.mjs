export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';
export const CALENDAR_NAME = '人生ロードマップ';

const ascii = (value, max) => typeof value === 'string' && value.length <= max && !/[^!-~]/.test(value);
export const validClientId = value => ascii(value, 255) && /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(value);
export const validCalendarId = value => ascii(value, 255) && /^[a-z0-9][a-z0-9_-]*@group\.calendar\.google\.com$/.test(value);
