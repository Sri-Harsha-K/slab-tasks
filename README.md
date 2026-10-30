# Slab Tasks

A neobrutalist desktop to-do list for Windows, built on the same base as **Slab** (the calendar): same look, same Electron shell, same tray / start-with-Windows behaviour. It ships with an **MCP server**, so Claude can add tasks to it. Ask Claude to read your meeting notes in Wispr Flow or Granola and it adds only the action items that are yours, by hand or every hour.

```
Claude Desktop / Claude Code
  ├─ Wispr Flow / Granola   → reads meetings, notes, transcripts
  └─ slab-tasks MCP (stdio) → %APPDATA%\Slab Tasks\tasks.json ← Slab Tasks app (watches the file, updates live)
```

## Install

1. Run `app\release\Slab-Tasks-Setup-<version>.exe` (build it with `npm run dist:win`).
2. Connect Claude (below).

## Connect Claude

The MCP server is installed with the app at `<install dir>\resources\mcp\server.mjs` and runs on Node.js (v20+). In the app, **••• → Copy Claude config** copies the right entry for you.

**Claude Desktop (recommended): install the extension.** Run `npm run dist:mcpb` in `app/`, then double-click `app/release/Slab-Tasks-<version>.mcpb`, or drag it into Claude Desktop under **Settings → Extensions**. Fill in your name and press Install. Slab Tasks then appears in Claude's connectors list, and Desktop runs it with its own Node. Afterwards you can ask things like "add a task for this on Friday at 3pm".

**Claude Desktop (manual)**: add this to `%APPDATA%\Claude\claude_desktop_config.json` under `mcpServers`, then restart Claude Desktop. Desktop may rewrite this file, so the extension is the more reliable option.

```json
"slab-tasks": {
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\Users\\<you>\\AppData\\Local\\Programs\\Slab Tasks\\resources\\mcp\\server.mjs"],
  "env": { "SLAB_TASKS_OWNER": "Your Name" }
}
```

**Claude Code**:

```bash
claude mcp add --scope user slab-tasks --env "SLAB_TASKS_OWNER=Your Name" -- node "C:\Users\<you>\AppData\Local\Programs\Slab Tasks\resources\mcp\server.mjs"
```

`SLAB_TASKS_OWNER` is your name as it appears in meetings. Claude uses it to tell your action items from everyone else's.

`SLAB_TASKS_SINCE` (optional, ISO time such as `2026-10-29T21:00:00Z`) stops backfill. When Claude passes a meeting's start time, `check_meetings` lists meetings that started earlier as `old`, and `add_tasks` refuses them. The only exception is when you ask for one of those meetings by name (Claude then passes `allow_old: true`). Set it to the moment you turn on automation. In the extension, this is the **Ignore meetings before** setting.

## Use it

In Claude, say *"make tasks from today's meetings"*, or pick the **tasks_from_meetings** prompt. Claude then:

1. finds the meetings in Wispr Flow or Granola,
2. skips meetings it has already processed (`check_meetings`),
3. adds only your action items, tagged with the meeting (`add_tasks`; re-running a meeting adds no duplicates),
4. summarises what it added and what it skipped as someone else's.

New tasks show up in the app right away, with a **FROM CLAUDE** pop-up even when the app is in the tray.

You can also ask for one-off tasks, e.g. *"add a task for this on Friday at 3pm"*.

To have this happen on its own every hour, see [Automate it](#automate-it-hourly-scheduled-task).

| MCP tool | What it does |
|---|---|
| `add_tasks` | Add tasks, optionally from a meeting (dedupes, marks the meeting processed) |
| `list_tasks` | `today` / `upcoming` / `all` / `done`, filter by meeting or text |
| `update_task` | Edit title, notes, due, time, colour, done |
| `delete_task` | Remove a task |
| `check_meetings` | Which meetings were already processed, or started before the cutoff |
| `mark_meetings_processed` | Record meetings with nothing for you |
| `start_run` / `finish_run` | Scheduled runs: which meetings to read, and where the next run starts |

## Automate it: hourly scheduled task

A Claude scheduled task can read your new meeting notes every hour and add your action items, with no prompting. It reads Wispr Flow, Granola or both, and only looks at meetings since the previous run.

### What you need

- **Claude Desktop** with the **Slab Tasks extension** installed (see [Connect Claude](#connect-claude)). In **Settings → Extensions → Slab Tasks**, fill in:
  - **Your name**: as it appears in meetings.
  - **Ignore meetings before**: the time you switch automation on, as an ISO time such as `2026-10-29T21:00:00Z`. Older meetings then never get turned into tasks, so the first run doesn't backfill your whole history.
- At least one **note-taker connector** in Claude: **Wispr Flow** and/or **Granola**. With only one, the prompt skips the other.
- The **Slab Tasks app** installed and running (it starts with Windows), so new tasks pop up as they arrive.

### 1. Fill in the prompt

Copy [`prompts/scheduler-prompt.txt`](prompts/scheduler-prompt.txt) and replace the placeholders:

| Placeholder | What to put | Example |
|---|---|---|
| `{{FULL_NAME}}` | Your name as it appears in calendar invites and notes | `Alex Rivera` |
| `{{CALLED}}` | What people call you in meetings (add nicknames, comma-separated) | `Alex` |
| `{{TIME_ZONE}}` | Your time zone | `Pacific time`, `IST` |
| `{{NOT_ME}}` *(optional)* | Someone easily confused with you | `Alexa (design lead)` |
| `{{OTHER_PEOPLE}}` *(optional)* | Colleagues who often take action items | `Sam, Priya, Jordan` |

If you skip an optional placeholder, delete the sentence it's in. For `{{OTHER_PEOPLE}}`, that's the `(e.g. …)` part.

### 2. Create the scheduled task

In Claude Desktop, open **Scheduled tasks** and create a new one:

- **Prompt**: your filled-in prompt.
- **Schedule**: hourly on working days, at a time that leaves room for notes to finish after meetings end (Wispr Flow takes about 30 minutes). Example: every hour at :45 from 11:45 to 17:45, Monday to Friday (cron `45 11-17 * * 1-5`, in local time).
- **Permissions**: let it use the note-taker and Slab Tasks tools without asking. It runs unattended, so a permission prompt would stall it.
- **Notifications**: optional. The app already pops up **FROM CLAUDE** when tasks are added.

### 3. Test it

Run the task once by hand (**Run now**). Its summary lists:

- the time window it searched,
- the tasks it added, per meeting,
- the items it skipped as someone else's,
- meetings it left for later because their notes weren't finished.

Check the tasks in the app. If it picked up someone else's items, add them to `{{NOT_ME}}` / `{{OTHER_PEOPLE}}` or sharpen the "Who I am" line.

### How it works

- **No duplicates.** Each meeting is processed once. Re-runs skip it (`check_meetings`), and a task you delete never comes back.
- **Only new meetings.** Every run starts with `start_run`, which returns the previous run's checkpoint minus an hour of overlap. Every run ends with `finish_run`, which saves the next checkpoint to `%APPDATA%\Slab Tasks\automation.json`.
- **Unfinished notes wait.** A meeting whose notes aren't finished yet (Wispr `finalized = false`, Granola transcript pending) holds the checkpoint at its start time. The next run picks it up.
- **Failures retry.** A run that fails doesn't save a checkpoint, so the next run retries the same window. A missed run (PC asleep) is covered by the next one.
- **One copy per meeting.** A meeting recorded by both Wispr Flow and Granola is used once: the Wispr copy is preferred, and the other copy is marked processed. Granola ids are stored with a `granola:` prefix.

### Good to know

- It only runs while your PC is on and Claude Desktop is running.
- Each run uses your Claude plan's usage. A run with no new meetings is short.
- To pause it, turn the task off in **Scheduled tasks**. To re-read a meeting on purpose, ask Claude in chat by meeting name. Claude can then override the cutoff (`allow_old`).
- Claude Code works too: `claude mcp add` (above) gives it the same tools. Set `SLAB_TASKS_SINCE` there to match.

## App

- Views: **Today** (overdue + due today), **Upcoming**, **All**, **Done**. Group by date or by meeting.
- Quick add: type and press Enter (Shift+Enter opens the full form). `N` new · `/` search · `1–4` views · `Esc` close.
- Click a task to edit its notes, due date and time, and colour. Click ☐ to complete it.
- Reminders: a task with a date **and** time pops up **DUE NOW** in the corner with a chime when it's due, even when the window is closed (the app keeps running in the tray). If the PC was off or asleep at that time, it shows **MISSED** once when the app is back, but only within 6 hours. Moving a task to a new date or time re-arms its reminder. Click the pop-up to open the task.
- The side panel shows overdue / today / upcoming / from-Claude counts and the meetings Claude has read.
- Data: `%APPDATA%\Slab Tasks\tasks.json` (••• → Show data file). The app and the MCP server lock the file and write it atomically, so neither overwrites the other's changes.

## Develop

```bash
cd app
npm install
npm start            # build + run in Electron
npm test             # task model + file store
npm run test:mcp     # MCP server over stdio
npm run test:e2e     # real Electron app via Playwright (screenshots in test/.out)
npm run brand        # regenerate icons / installer art from src/assets/tasks-mark.svg
npm run dist:win     # installer → app/release/
```

Layout: `shared/` holds the task model and file store, used by both the app and the MCP server. `electron/` is the shell (window, tray, pop-up, IPC). `src/` is the React UI (pickers, toast and styles come from Slab). `mcp/` is the MCP server, bundled to `mcp-dist/` with esbuild.

Not yet linked to Slab. The task file format leaves room for Slab to show due tasks on its calendar later.
