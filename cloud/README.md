# Slab Tasks — cloud connector

Your Slab Tasks list as a **remote MCP connector** on Cloudflare Workers, so Claude on **claude.ai (web), the mobile apps and Claude Desktop** can add and read tasks. It has the same tools as the desktop extension (`app/shared/tools.js`). The list is stored in your Cloudflare account (one Durable Object), and sign-in goes through **GitHub**, limited to one GitHub account.

> This is for your own personal copy. The desktop app and the `.mcpb` extension don't need any of this. They keep everything on the PC.

## What you need

- A free **Cloudflare** account.
- A **GitHub** account (the one allowed to sign in).
- Node.js 20+ on the machine you deploy from.

## Set up and deploy (once)

Run these in `cloud/`.

1. **Install and sign in to Cloudflare:**
   ```bash
   npm install
   npx wrangler login
   ```
   This opens your browser to approve access.

2. **Create the sign-in storage** and paste the printed `id` into `wrangler.jsonc` → `kv_namespaces[0].id`:
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```

3. **Deploy once to get your URL:**
   ```bash
   npx wrangler deploy
   ```
   It prints `https://slab-tasks.<your-subdomain>.workers.dev`. Put `https://slab-tasks.<your-subdomain>.workers.dev/mcp` into `wrangler.jsonc` → `vars.MCP_RESOURCE`.

4. **Create a GitHub OAuth app** at [github.com/settings/developers](https://github.com/settings/developers) → **New OAuth App**:
   - Homepage URL: `https://slab-tasks.<your-subdomain>.workers.dev`
   - Authorization callback URL: `https://slab-tasks.<your-subdomain>.workers.dev/callback`

   Copy the **Client ID**, and generate a **Client secret**.

5. **Store the secrets.** Each command asks you to paste a value:
   ```bash
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY
   ```
   For `COOKIE_ENCRYPTION_KEY`, use any long random string, e.g. the output of `openssl rand -hex 32`.

6. **Check your settings** in `wrangler.jsonc` → `vars`:
   - `ALLOWED_GITHUB_LOGIN`: your GitHub username. Nobody else can sign in.
   - `OWNER`: your name as it appears in meetings.
   - `TIME_ZONE`: e.g. `America/Los_Angeles`, used for "today" and "Friday at 3pm".
   - `SINCE`: optional backfill cutoff.

7. **Deploy again:** `npx wrangler deploy`.

## Add it to Claude

In **claude.ai → Settings → Connectors → Add custom connector**:

- Name: `Slab Tasks`
- URL: `https://slab-tasks.<your-subdomain>.workers.dev/mcp`

Claude sends you through **Sign in with GitHub** once. After that the connector works on claude.ai, in the Claude mobile apps and in Claude Desktop, all signed in with the same Claude account.

Try: *"Add a task to send the deck to Priya on Friday at 3pm"*, then *"What's due today?"*

## Sync with the desktop app

To have tasks Claude adds on claude.ai or your phone show up in the tray app (with the **FROM CLAUDE** pop-up and **DUE NOW** reminders), turn on sync:

1. **Make a sync key:** any random text of at least 24 characters, e.g. `openssl rand -hex 32`. Keep it private: it lets an app read and change your list.
2. **Store it on the cloud:**
   ```bash
   npx wrangler secret put SYNC_TOKEN
   ```
3. **Enter it in the app:** ••• → **Cloud sync** → address `https://slab-tasks.<your-subdomain>.workers.dev` and the same key → **Save & sync**.

The app then syncs every 30 seconds, and a few seconds after any change on the PC. Edits merge task by task (the newer edit wins), deletions stick on both sides, and it catches up after being offline. The key is stored encrypted for your Windows user.

## Notes

- **Without sync**, the cloud list and the desktop app's list are separate.
- **Private.** Only `ALLOWED_GITHUB_LOGIN` gets a token, and every MCP request is checked against it again.
- **Cost:** a personal list fits comfortably within Cloudflare's free tier (Workers, Durable Objects, KV).

## Develop

```bash
npm test     # runs the Worker locally (no account needed) and drives it over MCP
npm run dev  # local server on http://localhost:8788 (needs a .dev.vars with the three secrets)
```

`test/entry.ts` + `test/wrangler.test.jsonc` serve the tools without sign-in, for tests only. They're never deployed.

`src/github-handler.ts`, `src/utils.ts` and `src/workers-oauth-utils.ts` are adapted from Cloudflare's [remote-mcp-github-oauth](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth) template.
