// Runs the Worker locally (wrangler, no Cloudflare account needed) and drives it over MCP like claude.ai does.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_startWorker } from 'wrangler';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pacificToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// The test entry (no sign-in) for the tools, and the real entry to check that sign-in is enforced.
const tools = await unstable_startWorker({ config: path.join(here, 'wrangler.test.jsonc'), dev: { server: { port: 0 }, inspector: false, persist: false } });
const real = await unstable_startWorker({ config: path.join(here, '..', 'wrangler.jsonc'), dev: { server: { port: 0 }, inspector: false, persist: false } });
const base = await tools.url;
const client = new Client({ name: 'test', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base)));
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;

test.after(async () => { await client.close(); await tools.dispose(); await real.dispose(); });

test('same tools as the desktop extension; instructions name the owner and time zone', async () => {
  const { tools: list } = await client.listTools();
  assert.deepEqual(list.map(t => t.name).sort(), ['add_tasks', 'check_meetings', 'delete_task', 'finish_run', 'list_tasks', 'mark_meetings_processed', 'start_run', 'update_task']);
  assert.match(client.getInstructions(), /Harsha/);
  assert.match(client.getInstructions(), /America\/Los_Angeles/);
});

test('add from chat: kept in the cloud store, "today" is Pacific, a time alone means today', async () => {
  const r = await call('add_tasks', { tasks: [{ title: 'Send the deck to Priya', due: '2026-10-31', time: '15:00' }, { title: 'Call the bank', time: '09:30' }] });
  assert.equal(r.today, pacificToday);
  assert.equal(r.added.length, 2);
  assert.equal(r.added[1].due, pacificToday);
  const l = await call('list_tasks', { view: 'all' });
  assert.deepEqual(l.tasks.map(t => t.title).sort(), ['Call the bank', 'Send the deck to Priya']);
});

test('meetings: dedupe, cutoff, processed', async () => {
  const meeting = { id: 'wispr-1', title: 'Standup', date: pacificToday, start: new Date().toISOString() };
  assert.equal((await call('add_tasks', { meeting, tasks: [{ title: 'Ship it' }] })).added.length, 1);
  assert.equal((await call('add_tasks', { meeting, tasks: [{ title: 'ship it!' }] })).added.length, 0);
  const old = { id: 'wispr-old', start: '2026-10-28T10:00:00Z' };
  const c = await call('check_meetings', { meetings: [meeting, old, { id: 'wispr-2', start: new Date().toISOString() }] });
  assert.deepEqual([c.processed.map(m => m.id), c.old, c.new], [['wispr-1'], ['wispr-old'], ['wispr-2']]);
});

test('update, complete, delete', async () => {
  const id = (await call('list_tasks', { query: 'bank' })).tasks[0].id;
  assert.equal((await call('update_task', { id, done: true })).done, true);
  assert.equal((await call('list_tasks', { view: 'done' })).total, 1);
  assert.equal((await call('delete_task', { id })).id, id);
});

test('parallel adds from several clients lose nothing', async () => {
  const before = (await call('list_tasks', { view: 'all', limit: 500 })).total;
  await Promise.all(Array.from({ length: 8 }, (_, i) => call('add_tasks', { tasks: [{ title: 'parallel ' + i }] })));
  assert.equal((await call('list_tasks', { view: 'all', limit: 500 })).total, before + 8);
});

test('scheduled-run checkpoint lives in the cloud too', async () => {
  await call('finish_run', { ran_at: '2026-10-30T19:45:00Z', pending_starts: ['2026-10-30T19:10:00Z'] });
  assert.equal((await call('start_run')).previous_checkpoint, '2026-10-30T19:10:00.000Z');
});

test('the real entry refuses requests without a sign-in token', async () => {
  const res = await fetch(new URL('/mcp', await real.url), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(res.status, 401);
  const meta = await fetch(new URL('/.well-known/oauth-authorization-server', await real.url));
  assert.equal(meta.status, 200, 'sign-in metadata is published for claude.ai');
});

test('desktop sync: key required, merges both ways, no-op saves nothing', async () => {
  const url = new URL('/sync', base), KEY = 'test-sync-key-0123456789abcdef';
  const sync = (body, key = KEY) => fetch(url, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  assert.equal((await sync(null, 'wrong-key-wrong-key-wrong')).status, 401);
  assert.equal((await fetch(url)).status, 401);
  const cloud = await (await sync()).json();
  assert.ok(cloud.tasks.some(t => t.title === 'Send the deck to Priya'), 'cloud list comes down');
  // The PC adds one task and deletes one the cloud has.
  const gone = cloud.tasks.find(t => t.title === 'Send the deck to Priya');
  const now = new Date().toISOString();
  const pc = { ...cloud, tasks: [...cloud.tasks.filter(t => t.id !== gone.id), { id: 'pc-1', title: 'Made on the PC', createdAt: now, updatedAt: now, createdBy: 'me' }], deleted: [{ id: gone.id, at: now }] };
  const merged = await (await sync(pc)).json();
  assert.ok(merged.tasks.some(t => t.id === 'pc-1') && !merged.tasks.some(t => t.id === gone.id));
  const l = await call('list_tasks', { view: 'all', limit: 500 });
  assert.ok(l.tasks.some(t => t.title === 'Made on the PC'), 'Claude sees the PC task');
  assert.ok(!l.tasks.some(t => t.id === gone.id), 'and not the one deleted on the PC');
  const again = await (await sync(merged)).json();
  assert.equal(again.rev, merged.rev, 'syncing an up-to-date list saves nothing');
});
