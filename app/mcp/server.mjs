// Slab Tasks MCP server (stdio). Claude starts it; it reads and writes the same tasks.json as the desktop
// app (shared/store.js locks + atomic writes), so whatever Claude adds shows up in the open app at once.
// stdout is the MCP channel: log to stderr only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { defaultFile, read, mutate, writeAtomic } from '../shared/store.js';
import { addTasks, updateTask, deleteTask, markProcessed, viewTasks, counts, COLORS } from '../shared/tasks.js';

const FILE = defaultFile();
// Whose list this is, so Claude can tell the user's action items from everyone else's in a meeting.
const OWNER = (process.env.SLAB_TASKS_OWNER || '').trim();
const ownerText = OWNER ? `the user (${OWNER})` : 'the user';
const log = (...a) => console.error('[slab-tasks]', ...a);
// Meetings that started before this (ISO time) were handled before automation took over: never backfill them.
const SINCE = Date.parse(process.env.SLAB_TASKS_SINCE || '') || 0;
const sinceText = SINCE ? new Date(SINCE).toISOString() : '';
const tooOld = (m) => !!(SINCE && m && m.start && Date.parse(m.start) < SINCE);

// Scheduled runs pick up where the last one left off. The checkpoint sits next to tasks.json; only this
// server touches it. It is the last run's start, pulled back to the earliest meeting that was still being
// written then, so a meeting whose notes finalize later is still inside the next run's window.
const RUN_FILE = path.join(path.dirname(FILE), 'automation.json');
const OVERLAP_MS = 60 * 60 * 1000; // re-scan an hour before the checkpoint; check_meetings drops repeats
const readRun = () => { try { return JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')) || {}; } catch (e) { return {}; } };

const localDate = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const brief = (t) => ({ id: t.id, title: t.title, notes: t.notes || undefined, due: t.due || undefined, time: t.time || undefined, done: t.done, createdBy: t.createdBy, meeting: t.source ? { id: t.source.meetingId, title: t.source.title, date: t.source.date || undefined } : undefined });
const reply = (data, text) => ({ content: [{ type: 'text', text: text + '\n\n' + JSON.stringify(data, null, 2) }], structuredContent: data });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

const INSTRUCTIONS = `Slab Tasks is ${ownerText}'s personal to-do list (a desktop app). Tasks you add appear in the app immediately.

One-off tasks from chat ("add a task for this on Friday at 3pm", "remind me tomorrow to…"):
- Call add_tasks right away without a meeting. "This"/"that" means what the conversation is about: write a clear title and put the useful context (links, names, numbers) in notes.
- Resolve relative dates against the user's local date (list_tasks returns "today" if you are unsure). Pass due as YYYY-MM-DD and time as 24h HH:MM. A time with no date means today.
- Confirm back in one line with the resolved date and time (e.g. "Fri 31 Oct, 15:00").

Creating tasks from meetings (e.g. Wispr Flow notes or transcripts):
- Add ONLY action items that belong to ${ownerText}: things assigned to them, or that they volunteered for ("I'll…", "<their name> to…", "can you take this?" → "yes"). Match their name loosely (first name, nickname, "me"/"I" when they are the speaker).
- Skip action items owned by other people, group decisions, FYIs, ideas nobody took, and anything already done in the meeting.
- When unsure whether an item is theirs, leave it out and mention it in your summary instead.
- Write each title as a short imperative ("Send Q3 numbers to Priya"). Put context (who asked, why, links) in notes. Set due (YYYY-MM-DD, resolved against the meeting date) only when a deadline was stated or clearly implied.
- Always pass the meeting (id, title, date, start) to add_tasks: it prevents duplicates and marks the meeting as read.${sinceText ? `
- Meetings that started before ${sinceText} are already handled and are refused, unless the user explicitly asks for that meeting (then pass allow_old: true).` : ''}
- Call check_meetings first and skip meetings already processed, unless the user asks to redo one. If a meeting had nothing for the user, call mark_meetings_processed so it is skipped next time.
- Finish with a short summary: tasks added (per meeting), items skipped because they were someone else's, and anything uncertain.`;

const server = new McpServer({ name: 'slab-tasks', version: '1.0.0' }, { instructions: INSTRUCTIONS });

const taskIn = z.object({
  title: z.string().min(1).max(200).describe('Short imperative task title'),
  notes: z.string().max(4000).optional().describe('Context: who asked, why, links, quotes from the meeting'),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Due date YYYY-MM-DD, only if a deadline was stated or implied'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('Due time HH:MM (24h); needs a due date'),
  color: z.enum(COLORS).optional().describe('Optional colour; defaults to teal for tasks Claude adds'),
});
const meetingIn = z.object({
  id: z.string().min(1).max(200).describe('Stable meeting id from the notes source (e.g. the Wispr Flow meeting id)'),
  title: z.string().max(200).optional().describe('Meeting title'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Meeting date YYYY-MM-DD (local)'),
  start: z.iso.datetime({ offset: true }).optional().describe('When the meeting started, ISO time as the notes source gives it'),
});

server.registerTool('add_tasks', {
  title: 'Add tasks',
  description: `Add one or more tasks to ${ownerText}'s list, e.g. "add a task for this on Friday at 3pm". Give due (YYYY-MM-DD, resolved against the user's local date) and time (24h HH:MM) when the user names them; a time alone means today. When the tasks come from a meeting, pass "meeting": duplicates from the same meeting are skipped and the meeting is marked as processed. Returns the tasks added, the ones skipped, and today's date.`,
  inputSchema: {
    tasks: z.array(taskIn).max(100).describe('Tasks to add (can be empty when used only to mark a meeting processed)'),
    meeting: meetingIn.optional(),
    allow_old: z.boolean().optional().describe('Only when the user explicitly asks for a meeting that started before the cutoff'),
  },
}, async ({ tasks, meeting, allow_old }) => {
  if (tooOld(meeting) && !allow_old) {
    log(`add_tasks: refused meeting ${meeting.id}, started ${meeting.start} before ${sinceText}`);
    return reply({ added: [], skipped: tasks.map(t => ({ title: t.title, reason: 'before cutoff' })) },
      `Meeting started before ${sinceText}, which was handled before automation took over. Nothing added.`);
  }
  const source = meeting ? { meetingId: meeting.id, title: meeting.title || '', date: meeting.date || '' } : null;
  const today = localDate();
  // The list drops a time that has no date; "at 3pm" on its own means today.
  const inputs = tasks.map(t => (t.time && !t.due ? { ...t, due: today } : t));
  const { result } = mutate(doc => addTasks(doc, inputs, { source, createdBy: 'claude' }), FILE);
  const data = { today, added: result.added.map(brief), skipped: result.skipped };
  log(`add_tasks: +${result.added.length}, skipped ${result.skipped.length}`, meeting ? `(meeting ${meeting.id})` : '');
  return reply(data, `Added ${result.added.length} task(s)` + (result.skipped.length ? `, skipped ${result.skipped.length} (duplicates or empty)` : '') + '.');
});

server.registerTool('list_tasks', {
  title: 'List tasks',
  description: 'List tasks. view: "today" = overdue + due today, "upcoming" = due after today, "all" = every open task (default), "done" = finished. Optionally filter by meeting id or a search query.',
  inputSchema: {
    view: z.enum(['today', 'upcoming', 'all', 'done']).optional(),
    meeting_id: z.string().max(200).optional(),
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  annotations: { readOnlyHint: true },
}, async ({ view = 'all', meeting_id = '', query = '', limit = 100 }) => {
  const doc = read(FILE), today = localDate();
  const list = viewTasks(doc.tasks, view, today, { meetingId: meeting_id, query });
  const data = { today, view, counts: counts(doc.tasks, today), total: list.length, tasks: list.slice(0, limit).map(brief) };
  return reply(data, `${list.length} task(s) in "${view}"` + (list.length > limit ? ` (showing ${limit})` : '') + '.');
});

server.registerTool('update_task', {
  title: 'Update a task',
  description: 'Change a task: title, notes, due date (empty string clears it), time, colour, or done (true = complete, false = reopen).',
  inputSchema: {
    id: z.string().min(1).max(64),
    title: z.string().min(1).max(200).optional(),
    notes: z.string().max(4000).optional(),
    due: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional(),
    time: z.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]).optional(),
    color: z.enum(COLORS).optional(),
    done: z.boolean().optional(),
  },
}, async ({ id, ...patch }) => {
  const { result } = mutate(doc => updateTask(doc, id, patch), FILE);
  return result ? reply(brief(result), 'Task updated.') : fail(`No task with id "${id}".`);
});

server.registerTool('delete_task', {
  title: 'Delete a task',
  description: 'Permanently remove a task. Prefer update_task with done=true for finished work.',
  inputSchema: { id: z.string().min(1).max(64) },
  annotations: { destructiveHint: true },
}, async ({ id }) => {
  const { result } = mutate(doc => deleteTask(doc, id), FILE);
  return result ? reply(brief(result), 'Task deleted.') : fail(`No task with id "${id}".`);
});

server.registerTool('check_meetings', {
  title: 'Check which meetings were processed',
  description: 'Given meetings (id + start, preferred) or meeting ids, report which have already been turned into tasks, which started before the cutoff (skip both), and which are new.',
  inputSchema: {
    meetings: z.array(meetingIn).max(200).optional(),
    meeting_ids: z.array(z.string().min(1).max(200)).max(200).optional(),
  },
  annotations: { readOnlyHint: true },
}, async ({ meetings = [], meeting_ids = [] }) => {
  const doc = read(FILE);
  const all = [...meetings, ...meeting_ids.map(id => ({ id }))];
  const ids = all.map(m => m.id);
  const processed = doc.processedMeetings.filter(m => ids.includes(m.id));
  const done = new Set(processed.map(m => m.id));
  const old = all.filter(m => !done.has(m.id) && tooOld(m)).map(m => m.id);
  const data = { processed, old, new: ids.filter(id => !done.has(id) && !old.includes(id)) };
  return reply(data, `${processed.length} already processed, ${old.length} before the cutoff, ${data.new.length} new.`);
});

server.registerTool('mark_meetings_processed', {
  title: 'Mark meetings processed',
  description: `Record meetings as read when they contained no action items for ${ownerText}, so they are skipped next time. (add_tasks with a meeting already does this.)`,
  inputSchema: { meetings: z.array(meetingIn).min(1).max(100) },
}, async ({ meetings }) => {
  mutate(doc => markProcessed(doc, meetings.map(m => ({ meetingId: m.id, title: m.title, count: 0 }))), FILE);
  return reply({ marked: meetings.map(m => m.id) }, `Marked ${meetings.length} meeting(s) as processed.`);
});

server.registerTool('start_run', {
  title: 'Start a scheduled run',
  description: 'For scheduled runs: returns search_since (search meetings that started at or after it, i.e. since the previous run, with some overlap) and ran_at (pass it back to finish_run).',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  const now = Date.now(), prev = Date.parse(readRun().checkpoint || '') || 0;
  const base = prev ? prev - OVERLAP_MS : SINCE || now - 24 * 3600e3;
  const data = { search_since: new Date(Math.max(base, SINCE)).toISOString(), ran_at: new Date(now).toISOString(), previous_checkpoint: prev ? new Date(prev).toISOString() : null };
  return reply(data, `Search meetings that started since ${data.search_since}.`);
});

server.registerTool('finish_run', {
  title: 'Finish a scheduled run',
  description: 'For scheduled runs, once every new meeting has been handled: saves the checkpoint so the next run starts here. Pass ran_at from start_run and the start times of meetings skipped because their notes were not finalized yet. Do not call it if the run failed.',
  inputSchema: {
    ran_at: z.iso.datetime({ offset: true }),
    pending_starts: z.array(z.iso.datetime({ offset: true })).max(200).optional().describe('Start times of meetings left for later (finalized = false)'),
  },
}, async ({ ran_at, pending_starts = [] }) => {
  const checkpoint = new Date(Math.min(Date.parse(ran_at), ...pending_starts.map(Date.parse))).toISOString();
  fs.mkdirSync(path.dirname(RUN_FILE), { recursive: true });
  writeAtomic(RUN_FILE, { checkpoint, finishedAt: new Date().toISOString() });
  log('finish_run: checkpoint', checkpoint);
  return reply({ checkpoint }, `Checkpoint saved: next run starts from ${checkpoint}.`);
});

server.registerPrompt('tasks_from_meetings', {
  title: 'Tasks from my meetings',
  description: `Read meeting notes (Wispr Flow) and add ${ownerText}'s action items to Slab Tasks.`,
  argsSchema: { when: z.string().optional().describe('Which meetings, e.g. "today", "yesterday", "this week", or a meeting name') },
}, ({ when }) => ({
  messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: `Create Slab Tasks to-dos from my meetings ${when ? `(${when})` : 'from today'}. Today is ${localDate()}.

1. Find the meetings in that window with the Wispr Flow tools (search or list meetings; use my local time zone).
2. Call check_meetings with their ids and skip any already processed.
3. For each new meeting, read its notes and transcript and pick out only the action items that are mine (assigned to me or that I volunteered for). Ignore other people's items.
4. Call add_tasks once per meeting with those items and the meeting's id, title and date. If a meeting has nothing for me, call mark_meetings_processed for it.
5. Summarise what you added per meeting, what you skipped as someone else's, and anything you weren't sure about.`,
    },
  }],
}));

await server.connect(new StdioServerTransport());
log('ready, file:', FILE, OWNER ? `owner: ${OWNER}` : '');
