# Slab Tasks

A neobrutalist desktop to-do list for Windows, built on the same base as **Slab** (the calendar): same look, same Electron shell, same tray / start-with-Windows behaviour. It ships with an **MCP server**, so Claude can add tasks to it. Ask Claude to read your meeting notes in Wispr Flow and it adds only the action items that are yours.

```
Claude Desktop / Claude Code
  ├─ Wispr Flow connector   → reads meetings, notes, transcripts
  └─ slab-tasks MCP (stdio) → %APPDATA%\Slab Tasks\tasks.json ← Slab Tasks app (watches the file, updates live)
```

## Install

1. Run `app\release\Slab-Tasks-Setup-1.0.0.exe`.
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

`SLAB_TASKS_SINCE` (optional, ISO time such as `2026-10-29T21:00:00Z`) stops backfill. When Claude passes a meeting's start time, `check_meetings` lists meetings that started earlier as `old`, and `add_tasks` refuses them. The only exception is when you ask for one of those meetings by name (Claude then passes `allow_old: true`). Set it to the moment you turn on automation.

Scheduled runs call `start_run` first. It returns `search_since`, which is the previous run's checkpoint minus an hour of overlap; repeats are dropped by `check_meetings`. Each run ends with `finish_run`, which saves a new checkpoint to `automation.json` next to `tasks.json`. The checkpoint is pulled back to the start of any meeting whose notes weren't finalized yet, so that meeting is still inside the next window. A failed run doesn't save a checkpoint, so the next run retries the same window.

## Use it

In Claude, say *"make tasks from today's meetings"*, or pick the **tasks_from_meetings** prompt. Claude then:

1. finds the meetings in Wispr Flow,
2. skips meetings it has already processed (`check_meetings`),
3. adds only your action items, tagged with the meeting (`add_tasks`; re-running a meeting adds no duplicates),
4. summarises what it added and what it skipped as someone else's.

New tasks show up in the app right away, with a **FROM CLAUDE** pop-up even when the app is in the tray.

| MCP tool | What it does |
|---|---|
| `add_tasks` | Add tasks, optionally from a meeting (dedupes, marks the meeting processed) |
| `list_tasks` | `today` / `upcoming` / `all` / `done`, filter by meeting or text |
| `update_task` | Edit title, notes, due, time, colour, done |
| `delete_task` | Remove a task |
| `check_meetings` | Which meeting ids were already processed |
| `mark_meetings_processed` | Record meetings with nothing for you |

## App

- Views: **Today** (overdue + due today), **Upcoming**, **All**, **Done**. Group by date or by meeting.
- Quick add: type and press Enter (Shift+Enter opens the full form). `N` new · `/` search · `1–4` views · `Esc` close.
- Click a task to edit its notes, due date and time, and colour. Click ☐ to complete it.
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
