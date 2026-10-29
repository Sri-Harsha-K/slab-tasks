import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { read, mutate } from '../shared/store.js';
import { addTasks } from '../shared/tasks.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slab-tasks-')), 'tasks.json');

test('read: missing or corrupt file is an empty list', () => {
  const f = tmpFile();
  assert.deepEqual(read(f).tasks, []);
  fs.writeFileSync(f, '{not json');
  assert.deepEqual(read(f).tasks, []);
});

test('mutate: saves, bumps rev, leaves no temp or lock files', () => {
  const f = tmpFile();
  const { doc, result } = mutate(d => addTasks(d, [{ title: 'one' }]).added.length, f);
  assert.equal(result, 1);
  assert.equal(doc.rev, 1);
  assert.equal(read(f).tasks[0].title, 'one');
  mutate(d => addTasks(d, [{ title: 'two' }]), f);
  assert.equal(read(f).rev, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['tasks.json']);
});

test('mutate: a throwing change saves nothing', () => {
  const f = tmpFile();
  mutate(d => addTasks(d, [{ title: 'keep' }]), f);
  assert.throws(() => mutate(d => { d.tasks = []; throw new Error('nope'); }, f));
  assert.equal(read(f).tasks.length, 1);
});

test('mutate: a stale lock left by a crashed writer is taken over', () => {
  const f = tmpFile();
  fs.writeFileSync(f + '.lock', '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(f + '.lock', old, old);
  mutate(d => addTasks(d, [{ title: 'x' }]), f);
  assert.equal(read(f).tasks.length, 1);
});

test('mutate: concurrent writers in separate processes lose nothing', async () => {
  const f = tmpFile(), N = 4, EACH = 15;
  const storeUrl = new URL('../shared/store.js', import.meta.url).href, tasksUrl = new URL('../shared/tasks.js', import.meta.url).href;
  const code = `const { mutate } = await import(${JSON.stringify(storeUrl)}); const { addTasks } = await import(${JSON.stringify(tasksUrl)});
    for (let i = 0; i < ${EACH}; i++) mutate(d => addTasks(d, [{ title: 'p' + process.argv[1] + '-' + i }]), ${JSON.stringify(f)});`;
  await Promise.all(Array.from({ length: N }, (_, w) => new Promise((res, rej) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code, String(w)], { stdio: 'inherit' });
    c.on('exit', (status) => (status === 0 ? res() : rej(new Error('worker exit ' + status))));
  })));
  const doc = read(f);
  assert.equal(doc.tasks.length, N * EACH);
  assert.equal(doc.rev, N * EACH);
});
