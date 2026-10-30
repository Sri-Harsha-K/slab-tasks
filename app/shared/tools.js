// The Slab Tasks MCP tools, used by the local stdio server (mcp/server.mjs, tasks.json on this PC) and by any
// other host, such as a self-hosted cloud connector. Each host passes a storage backend and its settings, so
// they all behave the same.
//
// backend: {
//   read(): Promise<doc>                         current list
//   mutate(fn): Promise<{ doc, result }>         run fn(doc) on a fresh copy and save it
//   readRun(): Promise<{ checkpoint? }>          scheduled-run checkpoint
//   writeRun(state): Promise<void>
// }
import { z } from 'zod';
import { addTasks, updateTask, deleteTask, markProcessed, viewTasks, counts, COLORS } from './tasks.js';

const OVERLAP_MS = 60 * 60 * 1000; // scheduled runs re-scan an hour before the checkpoint; check_meetings drops repeats

/** YYYY-MM-DD for `d` in `timeZone` (IANA name), or in the host's own zone when none is given. */
export function dateIn(timeZone, d = new Date()) {
  if (!timeZone) return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const brief = (t) => ({ id: t.id, title: t.title, notes: t.notes || undefined, due: t.due || undefined, time: t.time || undefined, done: t.done, createdBy: t.createdBy, meeting: t.source ? { id: t.source.meetingId, title: t.source.title, date: t.source.date || undefined } : undefined });
const reply = (data, text) => ({ content: [{ type: 'text', text: text + '\n\n' + JSON.stringify(data, null, 2) }], structuredContent: data });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * Builds the server instructions, tools and prompt.
 * opts: { owner, since (ISO cutoff for backfill), timeZone (IANA, e.g. 'America/Los_Angeles'), where, log }
 * Returns { instructions, tools: [{ name, config: { title, description, inputSchema (zod raw shape), annotations }, handler }], prompts }.
 */
export function defineTools(backend, opts = {}) {
  const OWNER = (opts.owner || '').trim();
  const ownerText = OWNER ? `the user (${OWNER})` : 'the user';
  const SINCE = Date.parse(opts.since || '') || 0;
  const sinceText = SINCE ? new Date(SINCE).toISOString() : '';
  const tooOld = (m) => !!(SINCE && m && m.start && Date.parse(m.start) < SINCE);
  const today = () => dateIn(opts.timeZone);
  const log = opts.log || (() => {});
  const where = opts.where || 'a desktop app';

  const instructions = `Slab Tasks is ${ownerText}'s personal to-do list (${where}). Tasks you add appear in the app immediately.

One-off tasks from chat ("add a task for this on Friday at 3pm", "remind me tomorrow to…"):
- Call add_tasks right away without a meeting. "This"/"that" means what the conversation is about: write a clear title and put the useful context (links, names, numbers) in notes.
- Resolve relative dates against the user's local date (list_tasks returns "today" if you are unsure${opts.timeZone ? `; the user's time zone is ${opts.timeZone}` : ''}). Pass due as YYYY-MM-DD and time as 24h HH:MM. A time with no date means today.
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

  const tools = [];
  const tool = (name, config, handler) => tools.push({ name, config, handler });

  tool('add_tasks', {
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
    const day = today();
    // The list drops a time that has no date; "at 3pm" on its own means today.
    const inputs = tasks.map(t => (t.time && !t.due ? { ...t, due: day } : t));
    const { result } = await backend.mutate(doc => addTasks(doc, inputs, { source, createdBy: 'claude' }));
    const data = { today: day, added: result.added.map(brief), skipped: result.skipped };
    log(`add_tasks: +${result.added.length}, skipped ${result.skipped.length}`, meeting ? `(meeting ${meeting.id})` : '');
    return reply(data, `Added ${result.added.length} task(s)` + (result.skipped.length ? `, skipped ${result.skipped.length} (duplicates or empty)` : '') + '.');
  });

  tool('list_tasks', {
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
    const doc = await backend.read(), day = today();
    const list = viewTasks(doc.tasks, view, day, { meetingId: meeting_id, query });
    const data = { today: day, view, counts: counts(doc.tasks, day), total: list.length, tasks: list.slice(0, limit).map(brief) };
    return reply(data, `${list.length} task(s) in "${view}"` + (list.length > limit ? ` (showing ${limit})` : '') + '.');
  });

  tool('update_task', {
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
    const { result } = await backend.mutate(doc => updateTask(doc, id, patch));
    return result ? reply(brief(result), 'Task updated.') : fail(`No task with id "${id}".`);
  });

  tool('delete_task', {
    title: 'Delete a task',
    description: 'Permanently remove a task. Prefer update_task with done=true for finished work.',
    inputSchema: { id: z.string().min(1).max(64) },
    annotations: { destructiveHint: true },
  }, async ({ id }) => {
    const { result } = await backend.mutate(doc => deleteTask(doc, id));
    return result ? reply(brief(result), 'Task deleted.') : fail(`No task with id "${id}".`);
  });

  tool('check_meetings', {
    title: 'Check which meetings were processed',
    description: 'Given meetings (id + start, preferred) or meeting ids, report which have already been turned into tasks, which started before the cutoff (skip both), and which are new.',
    inputSchema: {
      meetings: z.array(meetingIn).max(200).optional(),
      meeting_ids: z.array(z.string().min(1).max(200)).max(200).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ meetings = [], meeting_ids = [] }) => {
    const doc = await backend.read();
    const all = [...meetings, ...meeting_ids.map(id => ({ id }))];
    const ids = all.map(m => m.id);
    const processed = doc.processedMeetings.filter(m => ids.includes(m.id));
    const done = new Set(processed.map(m => m.id));
    const old = all.filter(m => !done.has(m.id) && tooOld(m)).map(m => m.id);
    const data = { processed, old, new: ids.filter(id => !done.has(id) && !old.includes(id)) };
    return reply(data, `${processed.length} already processed, ${old.length} before the cutoff, ${data.new.length} new.`);
  });

  tool('mark_meetings_processed', {
    title: 'Mark meetings processed',
    description: `Record meetings as read when they contained no action items for ${ownerText}, so they are skipped next time. (add_tasks with a meeting already does this.)`,
    inputSchema: { meetings: z.array(meetingIn).min(1).max(100) },
  }, async ({ meetings }) => {
    await backend.mutate(doc => markProcessed(doc, meetings.map(m => ({ meetingId: m.id, title: m.title, count: 0 }))));
    return reply({ marked: meetings.map(m => m.id) }, `Marked ${meetings.length} meeting(s) as processed.`);
  });

  tool('start_run', {
    title: 'Start a scheduled run',
    description: 'For scheduled runs: returns search_since (search meetings that started at or after it, i.e. since the previous run, with some overlap) and ran_at (pass it back to finish_run).',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const now = Date.now(), prev = Date.parse((await backend.readRun()).checkpoint || '') || 0;
    const base = prev ? prev - OVERLAP_MS : SINCE || now - 24 * 3600e3;
    const data = { search_since: new Date(Math.max(base, SINCE)).toISOString(), ran_at: new Date(now).toISOString(), previous_checkpoint: prev ? new Date(prev).toISOString() : null };
    return reply(data, `Search meetings that started since ${data.search_since}.`);
  });

  tool('finish_run', {
    title: 'Finish a scheduled run',
    description: 'For scheduled runs, once every new meeting has been handled: saves the checkpoint so the next run starts here. Pass ran_at from start_run and the start times of meetings skipped because their notes were not finalized yet. Do not call it if the run failed.',
    inputSchema: {
      ran_at: z.iso.datetime({ offset: true }),
      pending_starts: z.array(z.iso.datetime({ offset: true })).max(200).optional().describe('Start times of meetings left for later (finalized = false)'),
    },
  }, async ({ ran_at, pending_starts = [] }) => {
    const checkpoint = new Date(Math.min(Date.parse(ran_at), ...pending_starts.map(Date.parse))).toISOString();
    await backend.writeRun({ checkpoint, finishedAt: new Date().toISOString() });
    log('finish_run: checkpoint', checkpoint);
    return reply({ checkpoint }, `Checkpoint saved: next run starts from ${checkpoint}.`);
  });

  const prompts = [{
    name: 'tasks_from_meetings',
    config: {
      title: 'Tasks from my meetings',
      description: `Read meeting notes (Wispr Flow, Granola) and add ${ownerText}'s action items to Slab Tasks.`,
      argsSchema: { when: z.string().optional().describe('Which meetings, e.g. "today", "yesterday", "this week", or a meeting name') },
    },
    handler: ({ when }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Create Slab Tasks to-dos from my meetings ${when ? `(${when})` : 'from today'}. Today is ${today()}.

1. Find the meetings in that window with my note-taker tools (e.g. Wispr Flow or Granola: search or list meetings; use my local time zone).
2. Call check_meetings with their ids and skip any already processed.
3. For each new meeting, read its notes and transcript and pick out only the action items that are mine (assigned to me or that I volunteered for). Ignore other people's items.
4. Call add_tasks once per meeting with those items and the meeting's id, title and date. If a meeting has nothing for me, call mark_meetings_processed for it.
5. Summarise what you added per meeting, what you skipped as someone else's, and anything you weren't sure about.`,
        },
      }],
    }),
  }];

  return { instructions, tools, prompts };
}

/** z.object(shape) built with this module's zod, for SDKs that want a whole schema instead of a raw shape. */
export const objectSchema = (shape) => z.object(shape || {});
