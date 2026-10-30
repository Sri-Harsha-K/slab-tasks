// Slab Tasks as a remote MCP connector (Cloudflare Workers), so claude.ai on web and mobile can use the list.
// The tools are the same as the desktop extension's (app/shared/tools.js); only the storage differs: one
// Durable Object holds the list, and sign-in goes through GitHub, limited to ALLOWED_GITHUB_LOGIN.
import { DurableObject, env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
// @ts-ignore: plain JS shared with the desktop app
import { defineTools, objectSchema } from "../../app/shared/tools.js";
// @ts-ignore
import { emptyDoc, normalizeDoc, mergeDocs, sameDoc } from "../../app/shared/tasks.js";
import { GitHubHandler } from "./github-handler";
import type { Props } from "./utils";

/** The whole list in one Durable Object: a single writer, so saves never interleave. */
export class TaskStore extends DurableObject {
	async getDoc() {
		return normalizeDoc((await this.ctx.storage.get("doc")) ?? emptyDoc());
	}
	/** Saves `doc` only if nothing else saved since `rev` was read; returns false so the caller can retry. */
	async putDoc(doc: any, rev: number) {
		const cur = (await this.ctx.storage.get<any>("doc"))?.rev ?? 0;
		if (cur !== rev) return false;
		await this.ctx.storage.put("doc", doc);
		return true;
	}
	async getRun() {
		return (await this.ctx.storage.get("run")) ?? {};
	}
	async putRun(run: any) {
		await this.ctx.storage.put("run", run);
	}
}

const store = () => env.TASK_STORE.get(env.TASK_STORE.idFromName("tasks"));

const backend = {
	read: () => store().getDoc(),
	async mutate(fn: (doc: any) => any) {
		// Read, change, save if nobody saved in between; otherwise wait a moment and redo it on the newer list.
		for (let i = 0; i < 40; i++) {
			const doc = await store().getDoc();
			const rev = doc.rev;
			const result = fn(doc);
			doc.rev = rev + 1;
			if (await store().putDoc(doc, rev)) return { doc, result };
			await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * Math.min(i + 1, 5)));
		}
		throw new Error("Slab Tasks: the list kept changing while saving; try again.");
	},
	readRun: () => store().getRun(),
	writeRun: (run: any) => store().putRun(run),
};

export function createServer() {
	const { instructions, tools, prompts } = defineTools(backend, {
		owner: env.OWNER,
		since: env.SINCE,
		timeZone: env.TIME_ZONE,
		where: "a to-do list in the cloud, also synced to their desktop app",
		log: (...a: unknown[]) => console.log("[slab-tasks]", ...a),
	});
	const server = new McpServer({ name: "slab-tasks", version: "1.0.0" }, { instructions });
	for (const t of tools) server.registerTool(t.name, { ...t.config, inputSchema: objectSchema(t.config.inputSchema) }, t.handler);
	for (const p of prompts) server.registerPrompt(p.name, { ...p.config, argsSchema: objectSchema(p.config.argsSchema) }, p.handler);
	return server;
}

const mcpHandler = createMcpHandler(createServer);
const apiHandler = {
	fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
		// Sign-in already refuses anyone else; this is a second lock in case the allowed login changes.
		const props = (ctx as any).props as Props | undefined;
		if (!props || props.login?.toLowerCase() !== env.ALLOWED_GITHUB_LOGIN.toLowerCase()) {
			return new Response("Forbidden", { status: 403 });
		}
		return mcpHandler(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;

const provider = new OAuthProvider<Env>({
	apiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
	// The URL MCP clients connect to. Every token is bound to it.
	resourceMetadata: { resource: env.MCP_RESOURCE },
});

// ---- Desktop sync: the tray app merges its local list with this one ---------------------------------
// POST /sync with the app's whole list; the cloud merges it into its own and returns the result, which
// the app saves locally. Only open when the SYNC_TOKEN secret is set, and only with that key.

async function sameSecret(a: string, b: string) {
	const enc = new TextEncoder();
	const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
	return crypto.subtle.timingSafeEqual(x, y);
}

export async function handleSync(request: Request) {
	const key = (env as any).SYNC_TOKEN as string | undefined;
	if (!key || key.length < 24) return new Response("Not found", { status: 404 });
	const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
	if (!given || !(await sameSecret(given, key))) return new Response("Unauthorized", { status: 401 });
	if (request.method === "GET") return Response.json(await backend.read());
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
	let incoming: any;
	try { incoming = normalizeDoc(await request.json()); } catch { return new Response("Bad list", { status: 400 }); }
	// Nothing new from the app (the usual case): answer without saving, so the list's rev stays put.
	const now = await backend.read();
	if (sameDoc(now, mergeDocs(now, incoming))) return Response.json(now);
	const { doc } = await backend.mutate((cur: any) => {
		const merged = mergeDocs(cur, incoming);
		if (!sameDoc(cur, merged)) { cur.tasks = merged.tasks; cur.processedMeetings = merged.processedMeetings; cur.deleted = merged.deleted; }
	});
	return Response.json(doc);
}

export default {
	fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
		if (new URL(request.url).pathname === "/sync") return handleSync(request);
		return provider.fetch(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;
