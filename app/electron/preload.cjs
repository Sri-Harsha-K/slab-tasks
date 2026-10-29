// Bridge between the renderer windows and the main process (task list, pop-up).
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const h = (_e, v) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('slab', {
  platform: process.platform,
  // main window: the task list
  getTasks: () => ipcRenderer.invoke('tasks:get'),
  addTask: (input) => ipcRenderer.invoke('tasks:add', input),
  updateTask: (id, patch) => ipcRenderer.invoke('tasks:update', id, patch),
  deleteTask: (id) => ipcRenderer.invoke('tasks:delete', id),
  clearDone: () => ipcRenderer.invoke('tasks:clearDone'),
  onTasks: (cb) => on('tasks:changed', cb),
  onTaskOpen: (cb) => on('task:open', cb),
  // main window: desktop settings
  getAutoStart: () => ipcRenderer.invoke('autostart:get'),
  setAutoStart: (on) => ipcRenderer.invoke('autostart:set', on),
  copyMcpConfig: () => ipcRenderer.invoke('mcp:copyConfig'),
  showDataFile: () => ipcRenderer.send('data:show'),
  quit: () => ipcRenderer.send('app:quit'),
  // pop-up window
  onToasts: (cb) => on('toasts', cb),
  notifierReady: () => ipcRenderer.send('notifier:ready'),
  resizeNotifier: (h) => ipcRenderer.send('notifier:resize', h),
  dismissToast: (id) => ipcRenderer.send('toast:dismiss', id),
  openToast: (id) => ipcRenderer.send('toast:open', id),
});
