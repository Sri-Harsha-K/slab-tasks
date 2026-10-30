// Packs the MCP server as a Claude Desktop extension (release/Slab-Tasks-<version>.mcpb). Installing it
// (double-click, or Settings → Extensions) lists Slab Tasks among Claude's connectors and runs the server
// on Claude Desktop's own Node, so it doesn't depend on hand-edited config.
// Usage: npm run dist:mcpb   (bundles the server first)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stage = path.join(root, 'release', 'extension');
const out = path.join(root, 'release', `Slab-Tasks-${pkg.version}.mcpb`);

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'server'), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.copyFileSync(path.join(root, 'brand', 'slab-tasks-icon-512.png'), path.join(stage, 'icon.png'));
fs.copyFileSync(path.join(root, 'mcp-dist', 'server.mjs'), path.join(stage, 'server', 'server.mjs'));

const mcpb = path.join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
execFileSync(process.execPath, [mcpb, 'validate', path.join(stage, 'manifest.json')], { stdio: 'inherit' });
execFileSync(process.execPath, [mcpb, 'pack', stage, out], { stdio: 'inherit' });
console.log('\nExtension:', out);
