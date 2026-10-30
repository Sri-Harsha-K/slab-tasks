// tasks.json on disk. The desktop app and the MCP server are separate processes that both write it, so
// every change is read → modify → write under a lock file, and writes go through a temp file + rename
// so a reader never sees half a file.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { emptyDoc, normalizeDoc } from './tasks.js';

export const FILE_NAME = 'tasks.json';
const LOCK_STALE_MS = 5000;
const LOCK_WAIT_MS = 4000;

/** Where the list lives: $SLAB_TASKS_FILE, else the desktop app's data folder (%APPDATA%\Slab Tasks). */
export function defaultFile() {
  if (process.env.SLAB_TASKS_FILE) return path.resolve(process.env.SLAB_TASKS_FILE);
  const base = process.env.APPDATA
    || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(base, 'Slab Tasks', FILE_NAME);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const RETRIES = 40, RETRY_MS = 25;

/**
 * Reads the list. A missing file is an empty list. A file that is briefly locked (antivirus or the search
 * indexer right after boot, another writer mid-rename) is retried for about a second; if it still can't be
 * read this throws, never pretending the list is empty. Bad JSON throws with code 'ECORRUPT'.
 */
export function read(file = defaultFile()) {
  for (let i = 0; ; i++) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return emptyDoc();
      if (i < RETRIES && ['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) { sleep(RETRY_MS); continue; }
      throw e;
    }
    try { return normalizeDoc(JSON.parse(text)); }
    catch (e) {
      if (i < RETRIES) { sleep(RETRY_MS); continue; }
      throw Object.assign(new Error('Slab Tasks: ' + file + ' is not valid JSON'), { code: 'ECORRUPT' });
    }
  }
}

export function writeAtomic(file, doc) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  // Windows can refuse the rename for a moment while another process has the file open: retry briefly.
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) { if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; } sleep(25); }
  }
}

function lock(file) {
  const lockFile = file + '.lock', start = Date.now();
  for (;;) {
    try { fs.closeSync(fs.openSync(lockFile, 'wx')); return () => { try { fs.unlinkSync(lockFile); } catch (e) {} }; }
    catch (e) {
      // Windows says EPERM/EACCES while another writer's lock is still being deleted: same as "taken".
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      // A writer that crashed mid-change leaves its lock behind; take it over once it's clearly stale.
      try { if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockFile); continue; } } catch (_) { continue; }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error('Slab Tasks: timed out waiting for ' + lockFile);
      sleep(15);
    }
  }
}

/**
 * Runs `fn(doc)` on a fresh copy of the list and saves it (rev + 1) if `fn` doesn't throw.
 * Returns { doc, result } where result is whatever `fn` returned.
 */
export function mutate(fn, file = defaultFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const unlock = lock(file);
  try {
    let doc;
    try { doc = read(file); }
    catch (e) {
      if (e.code !== 'ECORRUPT') throw e;
      // Keep the damaged file for recovery and start a fresh list rather than refusing every change.
      fs.renameSync(file, file + '.corrupt-' + Date.now());
      doc = emptyDoc();
    }
    const result = fn(doc);
    doc.rev += 1;
    writeAtomic(file, doc);
    return { doc, result };
  } finally { unlock(); }
}
