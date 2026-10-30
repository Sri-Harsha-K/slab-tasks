// End-to-end checks against the real desktop app (Electron), with a throwaway profile and task file.
// Usage: npm run test:e2e   (screenshots land in test/.out/)
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutate, read } from '../shared/store.js';
import { addTasks } from '../shared/tasks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '.out');
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slab-tasks-e2e-'));
const FILE = path.join(tmp, 'tasks.json');
const results = [];
const check = (name, ok, info = '') => { results.push([ok ? 'PASS' : 'FAIL', name, info]); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const today = fmt(new Date()), yesterday = fmt(new Date(Date.now() - 864e5)), later = fmt(new Date(Date.now() + 3 * 864e5));

// A few tasks already on the list before the app opens.
mutate(doc => {
  addTasks(doc, [{ title: 'Renew passport', due: yesterday }, { title: 'Water the plants', due: today, time: '18:00', color: '#7CE38B' }, { title: 'Plan offsite agenda', due: later }]);
}, FILE);

// Runs off-screen and muted (SLAB_TASKS_HEADLESS), so nothing appears on the desktop of the machine running it.
// Runs the unpackaged app: the packaged build turns off the inspector fuse Playwright needs to attach.
const app = await electron.launch({ args: [path.join(here, '..')], env: { ...process.env, SLAB_TASKS_FILE: FILE, SLAB_TASKS_USER_DATA: path.join(tmp, 'profile'), SLAB_TASKS_HEADLESS: '1' } });
try {
  const p = await app.firstWindow();
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
  await p.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await p.waitForSelector('[data-task]');
  await wait(400);
  await p.screenshot({ path: OUT + '/1-all.png', timeout: 5000 }).catch(() => {});

  const titles = async () => p.$$eval('[data-task] span span:first-child', els => els.map(e => e.textContent));
  check('loads tasks from the file', (await p.locator('[data-task]').count()) === 3);
  check('overdue section shows first', (await p.locator('section').first().innerText()).toUpperCase().startsWith('OVERDUE'));

  // Quick add
  await p.keyboard.press('n');
  await p.keyboard.type('Call the bank');
  await p.keyboard.press('Enter');
  await wait(300);
  check('quick add: task appears', await p.locator('[data-task]', { hasText: 'Call the bank' }).count() === 1);
  check('quick add: saved to tasks.json', read(FILE).tasks.some(t => t.title === 'Call the bank' && t.createdBy === 'me'));

  // Claude writes to the file (as the MCP server would) → shows up live, tagged.
  mutate(doc => addTasks(doc, [{ title: 'Send Q3 numbers to Priya', notes: 'She asked in the sprint review', due: later }, { title: 'Draft hiring plan' }],
    { source: { meetingId: 'wispr-123', title: 'Sprint review', date: today }, createdBy: 'claude' }), FILE);
  await p.waitForSelector('[data-task]:has-text("Send Q3 numbers to Priya")', { timeout: 8000 }).catch(() => {});
  const claudeCard = p.locator('[data-task]', { hasText: 'Send Q3 numbers to Priya' });
  check('live update: Claude task appears without reload', await claudeCard.count() === 1);
  check('live update: tagged CLAUDE + meeting', (await claudeCard.innerText().catch(() => '')).includes('CLAUDE') && (await claudeCard.innerText().catch(() => '')).includes('FROM: Sprint review'));
  check('rail lists the meeting', await p.locator('aside button', { hasText: 'Sprint review' }).count() === 1);
  await p.screenshot({ path: OUT + '/2-claude-live.png', timeout: 5000 }).catch(() => {});

  // A long meeting title shortens with "…" and its date stays visible inside the chip.
  mutate(doc => addTasks(doc, [{ title: 'Long meeting chip' }], { source: { meetingId: 'wispr-long', title: 'Sales Automation Cost Optimization and Quarterly Planning Review', date: today }, createdBy: 'claude' }), FILE);
  await p.waitForSelector('[data-task]:has-text("Long meeting chip")', { timeout: 8000 }).catch(() => {});
  const chipFits = await p.locator('[data-task]', { hasText: 'Long meeting chip' }).locator('.h-chip').evaluate(c => {
    const d = c.lastElementChild.getBoundingClientRect(), box = c.getBoundingClientRect();
    return c.lastElementChild.textContent.startsWith('·') && d.right <= box.right + 1 && d.width > 0;
  }).catch(() => false);
  check('meeting chip: long title shortened, date still visible', chipFits);
  mutate(doc => { doc.tasks = doc.tasks.filter(t => t.title !== 'Long meeting chip'); doc.processedMeetings = doc.processedMeetings.filter(m => m.id !== 'wispr-long'); }, FILE);
  await wait(400);

  // Meeting filter
  await p.locator('aside button', { hasText: 'Sprint review' }).click(); await wait(200);
  check('meeting filter narrows the list', await p.locator('[data-task]').count() === 2);
  await p.locator('button', { hasText: 'FROM: Sprint review ✕' }).click(); await wait(200);
  check('meeting filter clears', await p.locator('[data-task]').count() === 6);

  // Group by meeting
  await p.locator('button', { hasText: /^MEETING$/ }).click(); await wait(200);
  const labels = await p.$$eval('section > div:first-child span:first-child', els => els.map(e => e.textContent));
  check('group by meeting', labels.includes('Sprint review') && labels.includes('Added by hand'), labels.join(' | '));
  await p.screenshot({ path: OUT + '/3-by-meeting.png', timeout: 5000 }).catch(() => {});
  await p.locator('button', { hasText: /^DATE$/ }).click(); await wait(150);

  // Complete
  await p.locator('[data-task]', { hasText: 'Water the plants' }).locator('[role=checkbox]').click(); await wait(300);
  check('checkbox completes task', read(FILE).tasks.find(t => t.title === 'Water the plants').done === true);
  check('done task leaves the open list', await p.locator('[data-task]', { hasText: 'Water the plants' }).count() === 0);
  await p.locator('header button', { hasText: /^Done/i }).click(); await wait(200);
  check('done view shows it', await p.locator('[data-task]', { hasText: 'Water the plants' }).count() === 1);
  await p.screenshot({ path: OUT + '/4-done.png', timeout: 5000 }).catch(() => {});

  // Today view
  await p.locator('header button', { hasText: /^Today/i }).click(); await wait(200);
  check('today view = overdue + today', (await p.locator('[data-task]').count()) === 1, String(await p.locator('[data-task]').count()));

  // Edit modal
  await p.locator('header button', { hasText: /^All/i }).click(); await wait(200);
  await claudeCard.click(); await wait(250);
  check('edit modal opens', await p.locator('text=EDIT TASK').count() === 1 || await p.locator('text=Edit task').count() === 1);
  check('modal shows source', await p.locator('text=ADDED BY CLAUDE').count() === 1);
  await p.screenshot({ path: OUT + '/5-edit.png', timeout: 5000 }).catch(() => {});
  const title = p.locator('input[placeholder="What needs doing?"]');
  await title.fill('Send Q3 numbers to Priya + Ana');
  await p.locator('button', { hasText: /^Save$/i }).click(); await wait(300);
  check('edit saves', read(FILE).tasks.some(t => t.title === 'Send Q3 numbers to Priya + Ana' && t.source && t.source.meetingId === 'wispr-123'));

  // Search
  await p.keyboard.press('/'); await p.keyboard.type('hiring'); await wait(200);
  check('search filters', await p.locator('[data-task]').count() === 1);
  await p.keyboard.press('Escape'); await wait(150);

  // Delete
  await p.locator('[data-task]', { hasText: 'Call the bank' }).click(); await wait(200);
  await p.locator('button', { hasText: /^Delete$/i }).click(); await wait(300);
  check('delete removes from file', !read(FILE).tasks.some(t => t.title === 'Call the bank'));

  // Reminder: a timed task that has just come due pops up in the corner window, once.
  const minuteAgo = new Date(Date.now() - 60e3);
  const hhmm = String(minuteAgo.getHours()).padStart(2, '0') + ':' + String(minuteAgo.getMinutes()).padStart(2, '0');
  mutate(doc => addTasks(doc, [{ title: 'Stand-up with Sam', due: fmt(minuteAgo), time: hhmm }], { now: new Date(Date.now() - 3600e3).toISOString() }), FILE);
  const notifierPage = async () => app.windows().find(w => w.url().includes('#notifier'));
  let pop = null;
  for (let i = 0; i < 25 && !pop; i++) {
    await wait(1000);
    const np = await notifierPage();
    if (np && await np.locator('text=Stand-up with Sam').count()) pop = np;
  }
  check('reminder: due task pops up', !!pop);
  const reminder = pop && pop.locator('[role=status]', { hasText: 'Stand-up with Sam' });
  const reminderText = reminder ? await reminder.innerText() : '';
  check('reminder: labelled DUE NOW with its time', reminderText.includes('DUE NOW') && reminderText.includes(hhmm), reminderText.replace(/\s+/g, ' '));
  if (pop) {
    await pop.screenshot({ path: OUT + '/7-reminder.png', timeout: 5000 }).catch(() => {});
    check('pop-up: Dismiss and Snooze buttons', await pop.locator('button', { hasText: 'DISMISS' }).count() >= 1 && await pop.locator('button', { hasText: 'SNOOZE' }).count() === 1);
    await pop.locator('button', { hasText: 'SNOOZE' }).click(); await wait(500);
    const deskState = JSON.parse(fs.readFileSync(path.join(tmp, 'profile', 'desktop.json'), 'utf8'));
    check('snooze: pop-up closes and is saved for later', await pop.locator('text=Stand-up with Sam').count() === 0
      && (deskState.snoozed || []).some(s => s.toast.title === 'Stand-up with Sam' && s.until > Date.now() + 9 * 60e3));
    await wait(16000);  // one more reminder check
    check('reminder: fires only once', await pop.locator('text=Stand-up with Sam').count() === 0);
    // A second reminder, left alone, fades out by itself.
    mutate(doc => addTasks(doc, [{ title: 'Fade check', due: fmt(minuteAgo), time: hhmm }], { now: new Date(Date.now() - 3600e3).toISOString() }), FILE);
    let seenFade = false;
    for (let i = 0; i < 20 && !seenFade; i++) { await wait(1000); seenFade = await pop.locator('text=Fade check').count() > 0; }
    await wait(6500);
    const left = await pop.locator('text=Fade check').count();
    check('pop-up: fades out on its own after 5 s', seenFade && left === 0, 'seen=' + seenFade + ' left=' + left);
  }

  // Narrow window: no horizontal overflow
  await p.setViewportSize({ width: 420, height: 800 }).catch(() => {});
  const win = await app.browserWindow(p);
  await win.evaluate(w => { w.unmaximize(); w.setSize(420, 820); });
  await wait(400);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('narrow window: no horizontal scroll', overflow <= 0, 'overflow=' + overflow);
  await p.screenshot({ path: OUT + '/6-narrow.png', timeout: 5000 }).catch(() => {});

  check('no renderer errors', errs.length === 0, errs.join(' | '));
} finally {
  await app.close();
}

for (const [s, n, i] of results) console.log(s, n, i ? '(' + i + ')' : '');
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
