// The renderer's view of the task list. In the desktop app every change goes through the main process
// (which owns tasks.json); in a plain browser (`npm run dev`) the same changes run on localStorage.
import { normalizeDoc, addTasks, updateTask, deleteTask, clearDone } from '../../shared/tasks.js';

const KEY = 'slab-tasks-v1';
const bridge = typeof window !== 'undefined' && window.slab && window.slab.getTasks ? window.slab : null;

const read = () => { try { return normalizeDoc(JSON.parse(localStorage.getItem(KEY))); } catch (e) { return normalizeDoc(null); } };
const local = (fn) => {
  const doc = read();
  fn(doc);
  doc.rev += 1;
  try { localStorage.setItem(KEY, JSON.stringify(doc)); } catch (e) {}
  return Promise.resolve(doc);
};

export const desktop = !!bridge;

export const api = bridge ? {
  get: () => bridge.getTasks(),
  add: (input) => bridge.addTask(input),
  update: (id, patch) => bridge.updateTask(id, patch),
  remove: (id) => bridge.deleteTask(id),
  clearDone: () => bridge.clearDone(),
  onChange: (cb) => bridge.onTasks(cb),
  onOpen: (cb) => bridge.onTaskOpen(cb),
} : {
  get: () => Promise.resolve(read()),
  add: (input) => local(doc => addTasks(doc, [input], { createdBy: 'me' })),
  update: (id, patch) => local(doc => updateTask(doc, id, patch)),
  remove: (id) => local(doc => deleteTask(doc, id)),
  clearDone: () => local(doc => clearDone(doc)),
  onChange: (cb) => { const h = (e) => { if (e.key === KEY) cb(read()); }; window.addEventListener('storage', h); return () => window.removeEventListener('storage', h); },
  onOpen: () => () => {},
};
