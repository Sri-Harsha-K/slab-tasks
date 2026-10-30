// The task list itself: shape, validation and every change, as pure functions over the document.
// Shared by the desktop app's main process, the renderer (browser fallback) and the MCP server, so all
// three agree on what a task is and on what counts as a duplicate.

export const APP = 'slab-tasks';
export const VERSION = 1;
export const COLORS = ['#FFD23F', '#FF8A3D', '#FF5C5C', '#FF6B9D', '#B69CFF', '#5AB0FF', '#4FD1C5', '#7CE38B'];
export const DEFAULT_COLOR = '#FFD23F';
export const CLAUDE_COLOR = '#4FD1C5';
const MAX = { title: 200, notes: 4000, meetingId: 200, meetingTitle: 200, processed: 500 };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const validDate = (v) => {
  if (!DATE_RE.test(v || '')) return '';
  const [y, m, d] = v.split('-').map(Number), dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? v : '';
};
const validTime = (v) => (TIME_RE.test(v || '') ? v : '');
const validColor = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v.toUpperCase() : fallback);

let seq = 0;
export const newId = () => 't' + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);
export const emptyDoc = () => ({ app: APP, version: VERSION, rev: 0, tasks: [], processedMeetings: [] });

/** Lowercased, punctuation-free title: "Send Q3 deck!" and "send q3 deck" are the same task. */
export const normTitle = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function normSource(s) {
  if (!s || typeof s !== 'object') return null;
  const meetingId = str(s.meetingId, MAX.meetingId);
  if (!meetingId) return null;
  return { meetingId, title: str(s.title, MAX.meetingTitle), date: validDate(str(s.date, 10)) };
}

/** A stored task, made safe: unknown fields dropped, bad values replaced. Returns null for a task with no title. */
export function normalizeTask(raw, now = new Date().toISOString()) {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.title, MAX.title);
  if (!title) return null;
  const due = validDate(str(raw.due, 10));
  const done = raw.done === true;
  return {
    id: str(raw.id, 64) || newId(),
    title,
    notes: str(raw.notes, MAX.notes),
    due,
    time: due ? validTime(str(raw.time, 5)) : '',
    color: validColor(raw.color, raw.createdBy === 'claude' ? CLAUDE_COLOR : DEFAULT_COLOR),
    done,
    doneAt: done ? str(raw.doneAt, 40) || now : '',
    createdAt: str(raw.createdAt, 40) || now,
    updatedAt: str(raw.updatedAt, 40) || str(raw.createdAt, 40) || now,
    createdBy: raw.createdBy === 'claude' ? 'claude' : 'me',
    source: normSource(raw.source),
  };
}

/** Whatever was read from disk, as a valid document (a missing or broken file is an empty list). */
export function normalizeDoc(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tasks)) return emptyDoc();
  const seen = new Set();
  const tasks = raw.tasks.map(t => normalizeTask(t)).filter(t => t && !seen.has(t.id) && seen.add(t.id));
  const processedMeetings = (Array.isArray(raw.processedMeetings) ? raw.processedMeetings : [])
    .map(m => m && typeof m === 'object' && str(m.id, MAX.meetingId)
      ? { id: str(m.id, MAX.meetingId), title: str(m.title, MAX.meetingTitle), at: str(m.at, 40), count: Math.max(0, Math.floor(+m.count || 0)) }
      : null)
    .filter(Boolean).slice(-MAX.processed);
  return { app: APP, version: VERSION, rev: Math.max(0, Math.floor(+raw.rev || 0)), tasks, processedMeetings };
}

/**
 * Is `input` already on the list? Same meeting + same normalized title, or (for tasks without a meeting)
 * the same title as a task that is still open.
 */
export function findDuplicate(doc, input) {
  const n = normTitle(input.title), mid = input.source ? input.source.meetingId : '';
  return doc.tasks.find(t => normTitle(t.title) === n && (mid ? t.source && t.source.meetingId === mid : !t.done)) || null;
}

/**
 * Adds tasks. `source` (a meeting) applies to every task that doesn't name its own. Duplicates are
 * skipped, not added twice. Returns { added, skipped }. Mutates `doc`.
 */
export function addTasks(doc, inputs, { source = null, createdBy = 'me', now = new Date().toISOString() } = {}) {
  const added = [], skipped = [];
  for (const raw of inputs || []) {
    const t = normalizeTask({ ...raw, id: '', source: (raw && raw.source) || source, createdBy, createdAt: now, updatedAt: now, done: false }, now);
    if (!t) { skipped.push({ title: str(raw && raw.title, MAX.title), reason: 'empty title' }); continue; }
    const dup = findDuplicate(doc, t);
    if (dup) { skipped.push({ title: t.title, reason: 'duplicate', id: dup.id }); continue; }
    doc.tasks.push(t);
    added.push(t);
  }
  const src = normSource(source);
  if (src) markProcessed(doc, [{ meetingId: src.meetingId, title: src.title, count: added.length }], now);
  return { added, skipped };
}

const EDITABLE = ['title', 'notes', 'due', 'time', 'color', 'done'];

/** Applies a partial edit. Returns the updated task, or null if there's no task with that id. Mutates `doc`. */
export function updateTask(doc, id, patch, now = new Date().toISOString()) {
  const i = doc.tasks.findIndex(t => t.id === id);
  if (i < 0) return null;
  const cur = doc.tasks[i], next = { ...cur };
  for (const k of EDITABLE) if (patch && k in patch && patch[k] !== undefined) next[k] = patch[k];
  if (next.done && !cur.done) next.doneAt = now;
  if (!next.done) next.doneAt = '';
  next.updatedAt = now;
  const t = normalizeTask(next, now);
  if (!t) return null;  // an edit can't blank the title
  doc.tasks[i] = t;
  return t;
}

/** Removes a task. Returns the removed task or null. Mutates `doc`. */
export function deleteTask(doc, id) {
  const i = doc.tasks.findIndex(t => t.id === id);
  return i < 0 ? null : doc.tasks.splice(i, 1)[0];
}

/** Removes every finished task. Returns how many. Mutates `doc`. */
export function clearDone(doc) {
  const before = doc.tasks.length;
  doc.tasks = doc.tasks.filter(t => !t.done);
  return before - doc.tasks.length;
}

/** Records meetings as handled, so Claude can skip them next time. `count` adds up across calls. Mutates `doc`. */
export function markProcessed(doc, meetings, now = new Date().toISOString()) {
  for (const m of meetings || []) {
    const id = str(m && m.meetingId, MAX.meetingId);
    if (!id) continue;
    const prev = doc.processedMeetings.find(p => p.id === id);
    const count = Math.max(0, Math.floor(+m.count || 0));
    if (prev) { prev.at = now; prev.count += count; if (m.title) prev.title = str(m.title, MAX.meetingTitle); }
    else doc.processedMeetings.push({ id, title: str(m.title, MAX.meetingTitle), at: now, count });
  }
  doc.processedMeetings = doc.processedMeetings.slice(-MAX.processed);
}

export const isProcessed = (doc, meetingId) => doc.processedMeetings.some(p => p.id === meetingId);

// ---- views -------------------------------------------------------------------------------------

/** 'overdue' | 'today' | 'upcoming' | 'nodate' for an open task, relative to `today` (YYYY-MM-DD). */
export const bucket = (t, today) => !t.due ? 'nodate' : t.due < today ? 'overdue' : t.due === today ? 'today' : 'upcoming';

/** Open tasks first by due date (undated last), then time, then oldest first. */
export const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (a.time || '99').localeCompare(b.time || '99') || a.createdAt.localeCompare(b.createdAt);
export const byDoneAt = (a, b) => b.doneAt.localeCompare(a.doneAt);

/**
 * Tasks for one view: 'today' (overdue + today), 'upcoming' (dated, after today), 'all' (every open task),
 * 'done' (finished, newest first). Optional `meetingId` and free-text `query` narrow it further.
 */
export function viewTasks(tasks, view, today, { meetingId = '', query = '' } = {}) {
  const q = normTitle(query);
  let list = tasks.filter(t => view === 'done' ? t.done : !t.done);
  if (view === 'today') list = list.filter(t => t.due && t.due <= today);
  if (view === 'upcoming') list = list.filter(t => t.due && t.due > today);
  if (meetingId) list = list.filter(t => t.source && t.source.meetingId === meetingId);
  if (q) list = list.filter(t => normTitle(t.title + ' ' + t.notes + ' ' + (t.source ? t.source.title : '')).includes(q));
  return list.sort(view === 'done' ? byDoneAt : byDue);
}

/** Splits a sorted list into labelled sections: by due date ('date') or by source meeting ('meeting'). */
export function groupTasks(list, by, today, labelForDate) {
  const groups = [];
  const push = (key, label, t) => { let g = groups.find(x => x.key === key); if (!g) groups.push(g = { key, label, tasks: [] }); g.tasks.push(t); };
  for (const t of list) {
    if (by === 'meeting') push(t.source ? 'm:' + t.source.meetingId : 'm:', t.source ? (t.source.title || 'Meeting') : 'Added by hand', t);
    else if (t.done) push('done', 'Done', t);
    else {
      const b = bucket(t, today);
      if (b === 'overdue') push('overdue', 'Overdue', t);
      else if (b === 'nodate') push('nodate', 'No date', t);
      else push('d:' + t.due, labelForDate(t.due), t);
    }
  }
  return groups;
}

export function counts(tasks, today) {
  const open = tasks.filter(t => !t.done);
  return {
    open: open.length,
    overdue: open.filter(t => t.due && t.due < today).length,
    today: open.filter(t => t.due === today).length,
    upcoming: open.filter(t => t.due && t.due > today).length,
    claude: open.filter(t => t.createdBy === 'claude').length,
    done: tasks.length - open.length,
  };
}

// ---- Reminders: a timed task pops up when its time comes -------------------------------------------

export const REMINDER_GRACE_MS = 6 * 3600e3;
/** Identifies one reminder. Moving the task to another date or time gives a new key, so it fires again. */
export const reminderKey = (t) => t.id + '|' + t.due + 'T' + t.time;
/** When the task is due, in local time (ms), or NaN without a date and time. */
export const dueAt = (t) => (t.due && t.time ? new Date(t.due + 'T' + t.time + ':00').getTime() : NaN);

/**
 * Open timed tasks whose reminder should show now: due at or before `now`, not fired yet (`fired` holds
 * reminder keys), and not more than `graceMs` late (missed while the PC was off still reminds, days later
 * doesn't). A task added or edited after its time had passed isn't reminded: you just saw it.
 */
export function dueReminders(tasks, now = Date.now(), fired = new Set(), graceMs = REMINDER_GRACE_MS) {
  return tasks.filter(t => {
    if (t.done || fired.has(reminderKey(t))) return false;
    const at = dueAt(t);
    if (!(at <= now) || now - at > graceMs) return false;
    return !(Date.parse(t.updatedAt || t.createdAt) > at);
  }).sort((a, b) => dueAt(a) - dueAt(b));
}
