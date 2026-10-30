// Slab Tasks MCP server (stdio). Claude starts it; it reads and writes the same tasks.json as the desktop
// app (shared/store.js locks + atomic writes), so whatever Claude adds shows up in the open app at once.
// The tools themselves live in shared/tools.js (also used by the cloud connector in cloud/).
// stdout is the MCP channel: log to stderr only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { defaultFile, read, mutate, writeAtomic } from '../shared/store.js';
import { defineTools } from '../shared/tools.js';

const FILE = defaultFile();
const log = (...a) => console.error('[slab-tasks]', ...a);

// Scheduled runs pick up where the last one left off. The checkpoint sits next to tasks.json; only this
// server touches it.
const RUN_FILE = path.join(path.dirname(FILE), 'automation.json');

const backend = {
  read: async () => read(FILE),
  mutate: async (fn) => mutate(fn, FILE),
  readRun: async () => { try { return JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')) || {}; } catch (e) { return {}; } },
  writeRun: async (state) => { fs.mkdirSync(path.dirname(RUN_FILE), { recursive: true }); writeAtomic(RUN_FILE, state); },
};

// SLAB_TASKS_OWNER: whose list this is, so Claude can tell the user's action items from everyone else's.
// SLAB_TASKS_SINCE: meetings that started before this (ISO time) were handled before automation took over.
const { instructions, tools, prompts } = defineTools(backend, {
  owner: process.env.SLAB_TASKS_OWNER, since: process.env.SLAB_TASKS_SINCE, log,
});

const server = new McpServer({ name: 'slab-tasks', version: '1.0.0' }, { instructions });
for (const t of tools) server.registerTool(t.name, t.config, t.handler);
for (const p of prompts) server.registerPrompt(p.name, p.config, p.handler);

await server.connect(new StdioServerTransport());
log('ready, file:', FILE, process.env.SLAB_TASKS_OWNER ? `owner: ${process.env.SLAB_TASKS_OWNER}` : '');
