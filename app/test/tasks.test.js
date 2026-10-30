import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyDoc, normalizeDoc, normalizeTask, normTitle, addTasks, updateTask, deleteTask, clearDone, markProcessed, isProcessed,
  viewTasks, groupTasks, counts, dueReminders, reminderKey, mergeDocs, sameDoc, CLAUDE_COLOR, DEFAULT_COLOR,
} from '../shared/tasks.js';

const NOW = '2026-10-29T10:00:00.000Z';
const meeting = { meetingId: 'm-1', title: 'Sprint review', date: '2026-10-29' };

test('normalizeTask: drops junk, keeps valid fields', () => {
  const t = normalizeTask({ title: '  Ship deck  ', due: '2026-02-30', time: '25:00', color: 'red', extra: 1, createdBy: 'x' }, NOW);
  assert.equal(t.title, 'Ship deck');
  assert.equal(t.due, '', 'Feb 30 is not a date');
  assert.equal(t.time, '');
  assert.equal(t.color, DEFAULT_COLOR);
  assert.equal(t.createdBy, 'me');
  assert.equal('extra' in t, false);
  assert.equal(normalizeTask({ title: '   ' }), null);
});

test('normalizeTask: time needs a due date; claude tasks default to teal', () => {
  assert.equal(normalizeTask({ title: 'a', time: '09:30' }).time, '');
  assert.equal(normalizeTask({ title: 'a', due: '2026-10-30', time: '09:30' }).time, '09:30');
  assert.equal(normalizeTask({ title: 'a', createdBy: 'claude' }).color, CLAUDE_COLOR);
});

test('normalizeDoc: broken input is an empty list; duplicate ids dropped', () => {
  assert.deepEqual(normalizeDoc(null).tasks, []);
  assert.deepEqual(normalizeDoc({ tasks: 'nope' }).tasks, []);
  const d = normalizeDoc({ rev: 4, tasks: [{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }, { title: '' }] });
  assert.equal(d.rev, 4);
  assert.deepEqual(d.tasks.map(t => t.title), ['x']);
});

test('normTitle ignores case and punctuation', () => {
  assert.equal(normTitle('Send the Q3 deck!'), normTitle('send the q3   deck'));
});

test('addTasks: dedupes within a meeting and marks it processed', () => {
  const doc = emptyDoc();
  const r1 = addTasks(doc, [{ title: 'Send Q3 deck' }, { title: 'Book venue', due: '2026-11-02' }], { source: meeting, createdBy: 'claude', now: NOW });
  assert.equal(r1.added.length, 2);
  assert.equal(r1.added[0].source.meetingId, 'm-1');
  assert.equal(r1.added[0].createdBy, 'claude');
  const r2 = addTasks(doc, [{ title: 'send q3 deck.' }, { title: 'Email Priya' }], { source: meeting, createdBy: 'claude', now: NOW });
  assert.deepEqual(r2.added.map(t => t.title), ['Email Priya']);
  assert.equal(r2.skipped[0].reason, 'duplicate');
  assert.ok(isProcessed(doc, 'm-1'));
  assert.equal(doc.processedMeetings[0].count, 3);
});

test('addTasks: same title from a different meeting is a new task', () => {
  const doc = emptyDoc();
  addTasks(doc, [{ title: 'Follow up' }], { source: meeting });
  const r = addTasks(doc, [{ title: 'Follow up' }], { source: { meetingId: 'm-2', title: 'Other' } });
  assert.equal(r.added.length, 1);
});

test('addTasks without a meeting: duplicate only while the old one is open', () => {
  const doc = emptyDoc();
  const [t] = addTasks(doc, [{ title: 'Buy milk' }]).added;
  assert.equal(addTasks(doc, [{ title: 'buy milk' }]).added.length, 0);
  updateTask(doc, t.id, { done: true });
  assert.equal(addTasks(doc, [{ title: 'buy milk' }]).added.length, 1);
});

test('updateTask: done stamps doneAt, reopening clears it, title cannot be blanked', () => {
  const doc = emptyDoc();
  const [t] = addTasks(doc, [{ title: 'x' }], { now: NOW }).added;
  const d = updateTask(doc, t.id, { done: true }, '2026-10-29T11:00:00.000Z');
  assert.equal(d.doneAt, '2026-10-29T11:00:00.000Z');
  assert.equal(updateTask(doc, t.id, { done: false }).doneAt, '');
  assert.equal(updateTask(doc, t.id, { title: '' }), null);
  assert.equal(doc.tasks[0].title, 'x');
  assert.equal(updateTask(doc, 'missing', { title: 'y' }), null);
});

test('deleteTask, clearDone', () => {
  const doc = emptyDoc();
  const [a, b] = addTasks(doc, [{ title: 'a' }, { title: 'b' }]).added;
  updateTask(doc, a.id, { done: true });
  assert.equal(clearDone(doc), 1);
  assert.equal(deleteTask(doc, b.id).id, b.id);
  assert.equal(deleteTask(doc, b.id), null);
  assert.equal(doc.tasks.length, 0);
});

test('markProcessed records meetings with zero tasks', () => {
  const doc = emptyDoc();
  markProcessed(doc, [{ meetingId: 'm-9', title: '1:1' }, { meetingId: '' }]);
  assert.deepEqual(doc.processedMeetings.map(m => [m.id, m.count]), [['m-9', 0]]);
});

test('viewTasks + groupTasks + counts', () => {
  const doc = emptyDoc();
  addTasks(doc, [
    { title: 'late', due: '2026-10-27' }, { title: 'now', due: '2026-10-29', time: '09:00' }, { title: 'soon', due: '2026-11-01' }, { title: 'whenever' },
  ], { now: NOW });
  addTasks(doc, [{ title: 'from meeting' }], { source: meeting, createdBy: 'claude', now: NOW });
  const today = '2026-10-29';
  assert.deepEqual(viewTasks(doc.tasks, 'today', today).map(t => t.title), ['late', 'now']);
  assert.deepEqual(viewTasks(doc.tasks, 'upcoming', today).map(t => t.title), ['soon']);
  assert.deepEqual(viewTasks(doc.tasks, 'all', today).map(t => t.title), ['late', 'now', 'soon', 'whenever', 'from meeting']);
  assert.deepEqual(viewTasks(doc.tasks, 'all', today, { meetingId: 'm-1' }).map(t => t.title), ['from meeting']);
  assert.deepEqual(viewTasks(doc.tasks, 'all', today, { query: 'SPRINT' }).map(t => t.title), ['from meeting'], 'search covers meeting title');
  const g = groupTasks(viewTasks(doc.tasks, 'all', today), 'date', today, (k) => k);
  assert.deepEqual(g.map(x => x.key), ['overdue', 'd:2026-10-29', 'd:2026-11-01', 'nodate']);
  const gm = groupTasks(viewTasks(doc.tasks, 'all', today), 'meeting', today, (k) => k);
  assert.deepEqual(gm.map(x => x.label), ['Added by hand', 'Sprint review']);
  assert.deepEqual(counts(doc.tasks, today), { open: 5, overdue: 1, today: 1, upcoming: 1, claude: 1, done: 0 });
});

test('dueReminders: fires once at the due time, re-arms when moved, skips stale and done', () => {
  const at = (s) => new Date(s).getTime();
  const doc = emptyDoc();
  addTasks(doc, [
    { title: 'call', due: '2026-10-30', time: '15:45' },
    { title: 'later', due: '2026-10-30', time: '17:00' },
    { title: 'no time', due: '2026-10-30' },
    { title: 'long ago', due: '2026-10-29', time: '08:00' },
    { title: 'finished', due: '2026-10-30', time: '15:00' },
  ], { now: '2026-10-29T12:00:00.000Z' });
  updateTask(doc, doc.tasks.find(t => t.title === 'finished').id, { done: true }, '2026-10-29T12:00:00.000Z');
  const names = (now, fired) => dueReminders(doc.tasks, now, fired).map(t => t.title);
  assert.deepEqual(names(at('2026-10-30T15:44:00'), new Set()), []);
  assert.deepEqual(names(at('2026-10-30T15:45:10'), new Set()), ['call']);
  const call = doc.tasks.find(t => t.title === 'call');
  const fired = new Set([reminderKey(call)]);
  assert.deepEqual(names(at('2026-10-30T15:46:00'), fired), [], 'fires only once');
  assert.deepEqual(names(at('2026-10-30T18:00:00'), fired), ['later'], 'missed while off: still reminded');
  assert.deepEqual(names(at('2026-10-31T09:00:00'), new Set()), [], 'more than 6h late: dropped');
  updateTask(doc, call.id, { time: '16:30' }, '2026-10-30T15:50:00');
  assert.deepEqual(names(at('2026-10-30T16:31:00'), fired), ['call'], 'moved: re-armed');
  updateTask(doc, call.id, { time: '16:00' }, '2026-10-30T16:40:00');
  assert.deepEqual(names(at('2026-10-30T16:41:00'), new Set()), [], 'set to a time already past: no pop-up');
});

test('mergeDocs: newer edit wins, deletions stick, processed meetings union, idempotent', () => {
  const T0 = '2026-10-30T10:00:00.000Z', T1 = '2026-10-30T11:00:00.000Z', T2 = '2026-10-30T12:00:00.000Z';
  const base = emptyDoc();
  addTasks(base, [{ title: 'shared' }, { title: 'to delete' }, { title: 'edited then deleted' }], { now: T0 });
  const [shared, del, edDel] = base.tasks;
  const pc = normalizeDoc(JSON.parse(JSON.stringify(base))), cloud = normalizeDoc(JSON.parse(JSON.stringify(base)));
  addTasks(pc, [{ title: 'made on PC' }], { now: T1 });
  addTasks(cloud, [{ title: 'made on phone' }], { source: { meetingId: 'm1', title: 'Standup' }, createdBy: 'claude', now: T1 });
  updateTask(pc, shared.id, { notes: 'pc note' }, T1);
  updateTask(cloud, shared.id, { notes: 'phone note' }, T2);
  deleteTask(pc, del.id, T1);
  deleteTask(cloud, edDel.id, T1);
  updateTask(pc, edDel.id, { notes: 'edited later' }, T2);
  const m = mergeDocs(pc, cloud);
  const byTitle = Object.fromEntries(m.tasks.map(t => [t.title, t]));
  assert.deepEqual(Object.keys(byTitle).sort(), ['edited then deleted', 'made on PC', 'made on phone', 'shared']);
  assert.equal(byTitle.shared.notes, 'phone note', 'newer edit wins');
  assert.equal(byTitle['edited then deleted'].notes, 'edited later', 'an edit after the deletion keeps it');
  assert.ok(m.deleted.some(d => d.id === del.id) && !m.deleted.some(d => d.id === edDel.id));
  assert.ok(isProcessed(m, 'm1'));
  assert.ok(m.rev > pc.rev);
  const again = mergeDocs(m, cloud);
  assert.ok(sameDoc(again, m) && again.rev === m.rev, 'merging again changes nothing');
  assert.ok(sameDoc(mergeDocs(cloud, pc), m), 'order of the two sides does not matter');
  clearDone(m, T2);
  assert.equal(normalizeDoc(JSON.parse(JSON.stringify(m))).deleted.length, m.deleted.length, 'deletions survive a save and reload');
});
