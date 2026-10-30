// Test-only Worker: the real tools and storage, served without sign-in. Never deployed (see wrangler.test.jsonc).
import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "../src/index";
export { TaskStore } from "../src/index";

const mcp = createMcpHandler(createServer, { route: "/mcp" });
export default { fetch: (req: Request, env: Env, ctx: ExecutionContext) => mcp(req, env, ctx) };
