export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
export const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const mins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const hhmm = (m) => { m = Math.max(0, Math.min(1439, m)); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
export const addDays = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return fmt(d); };
// Whole days from a to b, immune to DST shifts.
export const diffDays = (a, b) => { const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number); return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5); };

export const cap = (s) => s.slice(0, 1) + s.slice(1).toLowerCase();
export const short = (d) => MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate();
export const fmtLong = (k) => { const d = parse(k); return cap(DAYS[d.getDay()]) + ', ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate() + ' ' + d.getFullYear(); };
export const hourLabel = (h) => (h % 12 || 12) + (h < 12 ? ' AM' : ' PM');
/**
 * Reads a typed time: "9:07", "09.07", "907", "0907", "9", "21:07", "9:07pm", "12am".
 * Returns 'HH:MM', or null if it isn't a valid time.
 */
export function parseTime(raw) {
  let s = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  const ap = /^(.*?)([ap])\.?(m\.?)?$/.exec(s);
  if (ap) s = ap[1];
  let h, m, mt;
  if ((mt = /^(\d{1,2})[:.h](\d{2})$/.exec(s))) { h = +mt[1]; m = +mt[2]; }
  else if (/^\d{1,2}$/.test(s)) { h = +s; m = 0; }
  else if (/^\d{3,4}$/.test(s)) { h = +s.slice(0, -2); m = +s.slice(-2); }
  else return null;
  if (ap) { if (h < 1 || h > 12) return null; h = h % 12 + (ap[2] === 'p' ? 12 : 0); }
  if (h > 23 || m > 59) return null;
  return hhmm(h * 60 + m);
}
export const durLabel = (m) => m < 60 ? m + 'm' : m % 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m / 60 + 'h';
