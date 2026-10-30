// Drives the bundled MCP server over stdio, the way Claude does. Run with `npm run test:mcp` (bundles first).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { read } from '../shared/store.js';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp-dist', 'server.mjs');
const FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slab-tasks-mcp-')), 'tasks.json');

const client = new Client({ name: 'test', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, SLAB_TASKS_FILE: FILE, SLAB_TASKS_OWNER: 'Alex Rivera', SLAB_TASKS_SINCE: '2026-10-29T21:00:00Z' }, stderr: 'ignore' }));
const call = async (name, args) => (await client.callTool({ name, arguments: args }));
const meeting = { id: 'wispr-42', title: 'Design sync', date: '2026-10-29' };

test.after(() => client.close());

test('lists the tools and the prompt; instructions name the owner', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['add_tasks', 'check_meetings', 'delete_task', 'finish_run', 'list_tasks', 'mark_meetings_processed', 'start_run', 'update_task']);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map(p => p.name), ['tasks_from_meetings']);
  assert.match(client.getInstructions(), /Alex Rivera/);
  assert.match(client.getInstructions(), /ONLY action items/);
});

test('add_tasks writes to the shared file, tagged as Claude, with the meeting', async () => {
  const r = await call('add_tasks', { meeting, tasks: [{ title: 'Send mockups to Sam', due: '2026-10-31', notes: 'Sam asked for v2' }, { title: 'Book usability sessions' }] });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.added.length, 2);
  const doc = read(FILE);
  assert.equal(doc.tasks.length, 2);
  assert.ok(doc.tasks.every(t => t.createdBy === 'claude' && t.source.meetingId === 'wispr-42'));
  assert.equal(doc.processedMeetings[0].id, 'wispr-42');
});

test('re-running the same meeting adds nothing', async () => {
  const r = await call('add_tasks', { meeting, tasks: [{ title: 'send mockups to Sam!' }] });
  assert.equal(r.structuredContent.added.length, 0);
  assert.equal(r.structuredContent.skipped[0].reason, 'duplicate');
  assert.equal(read(FILE).tasks.length, 2);
});

test('check_meetings / mark_meetings_processed', async () => {
  let r = await call('check_meetings', { meeting_ids: ['wispr-42', 'wispr-43'] });
  assert.deepEqual(r.structuredContent.new, ['wispr-43']);
  await call('mark_meetings_processed', { meetings: [{ id: 'wispr-43', title: 'All hands' }] });
  r = await call('check_meetings', { meeting_ids: ['wispr-42', 'wispr-43'] });
  assert.deepEqual(r.structuredContent.new, []);
});

test('meetings before SLAB_TASKS_SINCE are never backfilled, unless asked', async () => {
  const old = { id: 'wispr-old', title: 'Last week', date: '2026-10-28', start: '2026-10-28T22:18:26.439000Z' };
  const fresh = { id: 'wispr-new', title: 'Just now', start: '2026-10-29T14:30:00-07:00' };
  let r = await call('check_meetings', { meetings: [old, fresh, { id: 'wispr-42' }] });
  assert.deepEqual(r.structuredContent.old, ['wispr-old']);
  assert.deepEqual(r.structuredContent.new, ['wispr-new']);
  assert.deepEqual(r.structuredContent.processed.map(m => m.id), ['wispr-42']);
  r = await call('add_tasks', { meeting: old, tasks: [{ title: 'Stale item' }] });
  assert.equal(r.structuredContent.added.length, 0);
  assert.equal(r.structuredContent.skipped[0].reason, 'before cutoff');
  assert.ok(!read(FILE).tasks.some(t => t.title === 'Stale item'));
  assert.ok(!read(FILE).processedMeetings.some(m => m.id === 'wispr-old'), 'a refused meeting is not marked processed');
  r = await call('add_tasks', { meeting: old, tasks: [{ title: 'Stale item' }], allow_old: true });
  assert.equal(r.structuredContent.added.length, 1);
  await call('delete_task', { id: r.structuredContent.added[0].id });
  assert.match(client.getInstructions(), /2026-10-29T21:00:00\.000Z/);
});

test('scheduled runs search from the previous run, held back for unfinished notes', async () => {
  const win = async () => (await call('start_run', {})).structuredContent;
  let w = await win();
  assert.equal(w.previous_checkpoint, null);
  assert.equal(w.search_since, '2026-10-29T21:00:00.000Z', 'first run starts at the cutoff');
  // A meeting started 19:10 was still being written at the 19:45 run: the next run must still see it.
  await call('finish_run', { ran_at: '2026-10-30T19:45:00Z', pending_starts: ['2026-10-30T19:10:00.000Z'] });
  w = await win();
  assert.equal(w.previous_checkpoint, '2026-10-30T19:10:00.000Z');
  assert.equal(w.search_since, '2026-10-30T18:10:00.000Z');
  await call('finish_run', { ran_at: '2026-10-30T20:45:00-00:00' });
  assert.equal((await win()).search_since, '2026-10-30T19:45:00.000Z');
  await call('finish_run', { ran_at: '2026-10-29T21:30:00Z' });
  assert.equal((await win()).search_since, '2026-10-29T21:00:00.000Z', 'never earlier than the cutoff');
  assert.ok(fs.existsSync(path.join(path.dirname(FILE), 'automation.json')));
});

test('one-off task from chat: date + time kept, a time alone means today', async () => {
  let r = await call('add_tasks', { tasks: [{ title: 'Send deck to Priya', due: '2026-10-31', time: '15:00', notes: 'Deck from the sales chat' }] });
  assert.deepEqual([r.structuredContent.added[0].due, r.structuredContent.added[0].time], ['2026-10-31', '15:00']);
  assert.equal(r.structuredContent.added[0].meeting, undefined);
  r = await call('add_tasks', { tasks: [{ title: 'Call the bank', time: '09:30' }] });
  assert.equal(r.structuredContent.added[0].due, r.structuredContent.today);
  assert.equal(r.structuredContent.added[0].time, '09:30');
  for (const t of read(FILE).tasks.filter(t => ['Send deck to Priya', 'Call the bank'].includes(t.title))) await call('delete_task', { id: t.id });
  assert.match(client.getInstructions(), /One-off tasks from chat/);
});

test('list, update, complete, delete', async () => {
  let r = await call('list_tasks', {});
  assert.equal(r.structuredContent.total, 2);
  const id = r.structuredContent.tasks.find(t => t.title === 'Book usability sessions').id;
  r = await call('update_task', { id, due: '2026-11-03', time: '10:00' });
  assert.equal(r.structuredContent.due, '2026-11-03');
  r = await call('update_task', { id, done: true });
  assert.equal(r.structuredContent.done, true);
  r = await call('list_tasks', { view: 'done' });
  assert.equal(r.structuredContent.total, 1);
  r = await call('delete_task', { id });
  assert.equal(r.structuredContent.id, id);
  r = await call('delete_task', { id });
  assert.equal(r.isError, true);
  r = await call('list_tasks', { meeting_id: 'wispr-42', query: 'mockups' });
  assert.equal(r.structuredContent.total, 1);
});

test('bad input is rejected', async () => {
  const r = await call('add_tasks', { tasks: [{ title: 'x', due: 'tomorrow' }] }).catch(e => ({ isError: true, e }));
  assert.equal(r.isError, true);
});

test('prompt walks through check → add → summarise', async () => {
  const p = await client.getPrompt({ name: 'tasks_from_meetings', arguments: { when: 'yesterday' } });
  const text = p.messages[0].content.text;
  assert.match(text, /yesterday/);
  assert.match(text, /check_meetings/);
  assert.match(text, /only the action items that are mine/);
});
