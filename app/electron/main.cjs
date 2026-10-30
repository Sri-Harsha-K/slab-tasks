const { app, BrowserWindow, Menu, Tray, ipcMain, screen, nativeImage, session, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const PAGE = path.join(__dirname, '..', 'dist', 'index.html');
const NOTIFIER_W = 342;  // keep in sync with src/Notifier.jsx
const HIDDEN_ARG = '--hidden';  // used by the "Start with Windows" entry: start in the tray, no window
const PRELOAD = path.join(__dirname, 'preload.cjs');
const isWin = process.platform === 'win32';

// Tests run the app against a throwaway profile (SLAB_TASKS_FILE points the list elsewhere too).
if (process.env.SLAB_TASKS_USER_DATA) app.setPath('userData', path.resolve(process.env.SLAB_TASKS_USER_DATA));
// Test mode: windows open far off-screen, without focus, sound or a tray icon, so a test run never shows
// up on the desktop of the machine it runs on.
const HEADLESS = !!process.env.SLAB_TASKS_HEADLESS;
const OFF_SCREEN = -32000;

let win = null;
let notifier = null;
let tray = null;
let toasts = [];
let quitting = false;
let shownOnce = false;

// The task list is shared with the MCP server (a separate process Claude starts), so it lives in a plain
// file both sides lock and rewrite atomically: see shared/store.js. Loaded in whenReady (ES modules).
let store = null, core = null, FILE = null;
let lastRev = -1;
const known = new Set();  // task ids already seen, so only new ones from Claude raise a pop-up

// Small desktop-only state (separate from the task list).
const stateFile = () => path.join(app.getPath('userData'), 'desktop.json');
let desk = { trayHintShown: false, autoStartInitialised: false, reminded: {} };  // reminded: reminder key → when it fired
const loadDesk = () => { try { desk = { ...desk, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }; } catch (e) {} };
const saveDesk = () => { try { fs.writeFileSync(stateFile(), JSON.stringify(desk)); } catch (e) {} };

// ---- Main window: closing it hides Slab Tasks to the tray so Claude's new tasks still pop up -----

function createWindow(hidden) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: '#FFF4E0',
    title: 'Slab Tasks',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    ...(HEADLESS ? { x: OFF_SCREEN, y: OFF_SCREEN, skipTaskbar: true } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: PRELOAD, disableBlinkFeatures: 'Auxclick' },
  });
  win.once('ready-to-show', () => { if (!hidden) showWindow(); });
  // Hand the window its list as soon as it loads instead of waiting for it to ask: right after an install the
  // window's own request can come back empty, and the list is only pushed again when the file changes.
  win.webContents.on('did-finish-load', () => { const doc = readNow(); if (doc && win) win.webContents.send('tasks:changed', doc); });
  win.loadFile(PAGE);
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!desk.trayHintShown) {
      desk.trayHintShown = true; saveDesk();
      showToast({ id: 'tray-hint', kind: 'STILL RUNNING', title: 'Slab Tasks is in the tray', body: 'New tasks from Claude still pop up. Quit from the tray icon.', color: '#4FD1C5' });
    }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) return createWindow(false);
  if (win.isMinimized()) win.restore();
  if (HEADLESS) { win.setPosition(OFF_SCREEN, OFF_SCREEN); win.showInactive(); return; }
  if (!shownOnce) { shownOnce = true; win.maximize(); }
  win.show();
  win.focus();
}

function quit() { quitting = true; app.quit(); }

// ---- Start with Windows -------------------------------------------------------------------------

const loginItem = () => ({ path: process.execPath, args: [HIDDEN_ARG] });
const getAutoStart = () => isWin && app.getLoginItemSettings(loginItem()).openAtLogin;
function setAutoStart(on) {
  if (!isWin) return false;
  app.setLoginItemSettings({ ...loginItem(), openAtLogin: !!on });
  refreshTray();
  return getAutoStart();
}

// ---- Tray icon ----------------------------------------------------------------------------------

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, isWin ? 'tray.ico' : 'icon.png')));
  } catch (e) { tray = null; return; }  // no tray host (some Linux desktops): the app still runs
  tray.setToolTip('Slab Tasks');
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Slab Tasks', click: showWindow },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: !!getAutoStart(), enabled: isWin, click: (item) => setAutoStart(item.checked) },
    { type: 'separator' },
    { label: 'Quit Slab Tasks', click: quit },
  ]));
}

// ---- Pop-up: Slab's own toast in a transparent, always-on-top corner window ------------------------

function createNotifier() {
  notifier = new BrowserWindow({
    width: NOTIFIER_W, height: 120, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, title: 'Slab Tasks',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, preload: PRELOAD, disableBlinkFeatures: 'Auxclick',
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',  // it plays the chime on its own
    },
  });
  if (HEADLESS) notifier.webContents.setAudioMuted(true);
  else notifier.setAlwaysOnTop(true, 'screen-saver');
  notifier.loadFile(PAGE, { hash: 'notifier' });
  notifier.on('closed', () => { notifier = null; });
}

function sendToasts() {
  if (!notifier) return;
  notifier.webContents.send('toasts', toasts);
  if (!toasts.length) notifier.hide();
}

function showToast(toast) {
  toasts = [...toasts.filter(x => x.id !== toast.id), toast].slice(-4);
  if (!notifier) createNotifier();
  sendToasts();
}

// ---- Task list: owner of the file on the app side; watches it for changes made by Claude -----------

// A read that still fails after store.read's retries is skipped: the next poll tries again.
const readNow = () => { try { return store.read(FILE); } catch (e) { console.error('[slab-tasks] read failed:', e.message); return null; } };

function pushDoc(doc) {
  if (!doc || doc.rev === lastRev) return;
  const firstRead = lastRev === -1;  // startup read had failed: these tasks aren't new, just late
  lastRev = doc.rev;
  const fresh = doc.tasks.filter(t => !known.has(t.id));
  fresh.forEach(t => known.add(t.id));
  const fromClaude = fresh.filter(t => t.createdBy === 'claude');
  if (fromClaude.length && lastRev > 0 && !firstRead) {
    const meetings = [...new Set(fromClaude.map(t => t.source && t.source.title).filter(Boolean))];
    showToast({
      id: 'claude-' + doc.rev, kind: 'FROM CLAUDE', color: '#4FD1C5', sound: true,
      title: fromClaude.length === 1 ? fromClaude[0].title : fromClaude.length + ' new tasks',
      body: meetings.length ? meetings.join(' · ') : fromClaude.length === 1 ? 'Added by Claude' : fromClaude.map(t => t.title).join(' · '),
      open: { id: fromClaude[0].id },
    });
  }
  if (win) win.webContents.send('tasks:changed', doc);
}

// ---- Reminders: timed tasks pop up when they're due, even with the window closed -------------------

const REMINDER_CHECK_MS = 15000;
const LATE_MS = 5 * 60 * 1000;  // later than this (PC was off or asleep) → "MISSED" instead of "DUE NOW"

function checkReminders() {
  const doc = readNow();
  if (!doc) return;
  const fired = desk.reminded || {};
  const now = Date.now();
  const due = core.dueReminders(doc.tasks, now, new Set(Object.keys(fired)));
  // Forget reminders older than the grace period; they can never fire again anyway.
  for (const [k, at] of Object.entries(fired)) if (now - at > 2 * core.REMINDER_GRACE_MS) delete fired[k];
  for (const t of due) {
    fired[core.reminderKey(t)] = now;
    const late = now - core.dueAt(t) > LATE_MS;
    showToast({
      id: 'due-' + core.reminderKey(t), kind: late ? 'MISSED' : 'DUE NOW', color: t.color, sound: true,
      title: t.title,
      body: (late ? 'Was due ' : 'Due ') + t.time + (t.source && t.source.title ? ' · ' + t.source.title : t.notes ? ' · ' + t.notes.split(/\r?\n/)[0].slice(0, 80) : ''),
      open: { id: t.id }, snooze: true,
    });
  }
  desk.reminded = fired;
  // Snoozed reminders come back once their time is up (kept in desktop.json, so a restart doesn't lose them).
  const snoozed = desk.snoozed || [];
  const back = snoozed.filter(s => s.until <= now);
  for (const s of back) showToast({ ...s.toast, id: s.toast.id + '-s' + s.until, kind: 'SNOOZED' });
  desk.snoozed = snoozed.filter(s => s.until > now);
  if (due.length || back.length) saveDesk();
}

const SNOOZE_MS = 10 * 60 * 1000;

let watchTimer = null;
function watchFile() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // Watch the folder, not the file: atomic saves replace the file, which ends a watch on the file itself.
  try {
    fs.watch(path.dirname(FILE), (_ev, name) => {
      if (name && name !== path.basename(FILE)) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => pushDoc(readNow()), 80);
    });
  } catch (e) {}
  // Belt and braces for file systems where fs.watch misses events.
  setInterval(() => pushDoc(readNow()), 5000).unref();
}

const change = (fn) => { const { doc, result } = store.mutate(fn, FILE); known.clear(); doc.tasks.forEach(t => known.add(t.id)); pushDoc(doc); return { doc, result }; };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;

const mcpServerPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'mcp', 'server.mjs') : path.join(__dirname, '..', 'mcp-dist', 'server.mjs'));
// Claude Desktop doesn't always start servers with the user's PATH, so point at node.exe directly when we can find it.
function nodePath() {
  const exe = isWin ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    try { const p = path.join(dir, exe); if (dir && fs.statSync(p).isFile()) return p; } catch (e) {}
  }
  return 'node';
}
const mcpConfig = () => JSON.stringify({ mcpServers: { 'slab-tasks': { command: nodePath(), args: [mcpServerPath()], env: { SLAB_TASKS_OWNER: 'Your Name' } } } }, null, 2);

// Each channel only accepts messages from the window that is meant to send them.
const fromMain = (e) => !!win && e.sender === win.webContents;
const fromNotifier = (e) => !!notifier && e.sender === notifier.webContents;

ipcMain.handle('tasks:get', (e) => (fromMain(e) ? store.read(FILE) : null));
ipcMain.handle('tasks:add', (e, input) => {
  if (!fromMain(e) || !isObj(input)) return null;
  return change(doc => core.addTasks(doc, [input], { createdBy: 'me' })).doc;
});
ipcMain.handle('tasks:update', (e, id, patch) => {
  if (!fromMain(e) || !isId(id) || !isObj(patch)) return null;
  return change(doc => core.updateTask(doc, id, patch)).doc;
});
ipcMain.handle('tasks:delete', (e, id) => (fromMain(e) && isId(id) ? change(doc => core.deleteTask(doc, id)).doc : null));
ipcMain.handle('tasks:clearDone', (e) => (fromMain(e) ? change(doc => core.clearDone(doc)).doc : null));

ipcMain.on('notifier:ready', (e) => { if (fromNotifier(e)) sendToasts(); });
// The pop-up reports its content height; anchor the window to the bottom-right of the primary screen.
ipcMain.on('notifier:resize', (e, h) => {
  if (!fromNotifier(e) || !toasts.length) return;
  const height = Math.max(40, Math.min(900, Math.round(+h || 0)));
  const wa = screen.getPrimaryDisplay().workArea;
  notifier.setBounds(HEADLESS ? { x: OFF_SCREEN, y: OFF_SCREEN, width: NOTIFIER_W, height }
    : { x: wa.x + wa.width - NOTIFIER_W - 8, y: wa.y + wa.height - height - 8, width: NOTIFIER_W, height });
  if (!notifier.isVisible()) notifier.showInactive();
});
ipcMain.on('toast:dismiss', (e, id) => {
  if (!fromNotifier(e)) return;
  toasts = toasts.filter(t => t.id !== id);
  sendToasts();
});
ipcMain.on('toast:snooze', (e, id) => {
  if (!fromNotifier(e)) return;
  const t = toasts.find(x => x.id === id);
  toasts = toasts.filter(x => x.id !== id);
  sendToasts();
  if (!t || !t.snooze) return;
  desk.snoozed = [...(desk.snoozed || []), { until: Date.now() + SNOOZE_MS, toast: t }];
  saveDesk();
});
// Clicking a pop-up brings the app forward (from the tray too) and opens that task.
ipcMain.on('toast:open', (e, id) => {
  if (!fromNotifier(e)) return;
  const t = toasts.find(x => x.id === id);
  toasts = toasts.filter(x => x.id !== id);
  sendToasts();
  showWindow();
  if (win && t && t.open) win.webContents.send('task:open', t.open);
});

// ---- Main window ↔ desktop settings ------------------------------------------------------------

ipcMain.handle('autostart:get', (e) => (fromMain(e) ? !!getAutoStart() : false));
ipcMain.handle('autostart:set', (e, on) => (fromMain(e) ? !!setAutoStart(on === true) : false));
ipcMain.handle('mcp:copyConfig', (e) => { if (!fromMain(e)) return false; clipboard.writeText(mcpConfig()); return true; });
ipcMain.on('data:show', (e) => { if (fromMain(e)) shell.showItemInFolder(FILE); });
ipcMain.on('app:quit', (e) => { if (fromMain(e)) quit(); });

// ---- Lockdown: the app only ever shows its own bundled page ------------------------------------

// No window may navigate away, open new windows or embed web views (this also stops a file dropped on
// the window from replacing the page).
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

// ---- App lifecycle ------------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Opening the app again (Start Menu, desktop icon) while it runs in the tray just shows the window.
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { quitting = true; });
  if (isWin) app.setAppUserModelId('com.slab.tasks');
  app.whenReady().then(async () => {
    // No browser permissions needed (camera, mic, location, notifications, clipboard read, …): deny them all.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    Menu.setApplicationMenu(null);
    store = await import(pathToFileURL(path.join(__dirname, '..', 'shared', 'store.js')).href);
    core = await import(pathToFileURL(path.join(__dirname, '..', 'shared', 'tasks.js')).href);
    FILE = process.env.SLAB_TASKS_FILE ? path.resolve(process.env.SLAB_TASKS_FILE) : path.join(app.getPath('userData'), store.FILE_NAME);
    // If the file can't be read yet (right after boot), lastRev stays -1 and the first good poll fills the window.
    const doc = readNow();
    if (doc) { doc.tasks.forEach(t => known.add(t.id)); lastRev = doc.rev; }
    watchFile();
    loadDesk();
    // The installed app starts with Windows by default so Claude's tasks pop up after a restart (switchable in the tray / ••• menu).
    if (!desk.autoStartInitialised) {
      desk.autoStartInitialised = true; saveDesk();
      if (isWin && app.isPackaged) setAutoStart(true);
    }
    if (!HEADLESS) createTray();
    createWindow(process.argv.includes(HIDDEN_ARG));
    setTimeout(checkReminders, 3000);  // catch up on anything missed while the app was off
    setInterval(checkReminders, REMINDER_CHECK_MS).unref();
  });
  app.on('window-all-closed', () => app.quit());
}
