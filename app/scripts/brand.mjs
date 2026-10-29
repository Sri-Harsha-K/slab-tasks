// Renders the Slab Tasks icons and installer art from src/assets/tasks-mark.svg, in Slab's icon style
// (cream rounded tile, thick ink border, hard shadow). Usage: npm run brand
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mark = fs.readFileSync(path.join(root, 'src/assets/tasks-mark.svg'), 'utf8').replace(/ width="\d+" height="\d+"/, ' width="100%" height="100%"');
const font = pathToFileURL(path.join(root, 'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-opsz-normal.woff2')).href;
const mono = pathToFileURL(path.join(root, 'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2')).href;

// Tile proportions measured from Slab's own app icon.
const tile = (s, { flat = false } = {}) => {
  const b = Math.max(2, Math.round(s * 0.032)), sh = flat ? 0 : Math.round(s * 0.045), r = Math.round(s * 0.19), pad = Math.round(s * 0.21);
  const w = s - sh - (flat ? 0 : 2);
  return `<div style="position:relative;width:${s}px;height:${s}px">
    ${sh ? `<div style="position:absolute;left:${sh}px;top:${sh}px;width:${w}px;height:${w}px;border-radius:${r}px;background:#111"></div>` : ''}
    <div style="position:absolute;left:0;top:0;width:${w}px;height:${w}px;box-sizing:border-box;border-radius:${r}px;background:#FFF4E0;border:${b}px solid #111;padding:${pad}px ${pad * 0.95}px;display:flex">${mark}</div>
  </div>`;
};
const page = (body, w, h, bg = 'transparent') => `<!doctype html><html><head><style>
  @font-face { font-family: B; src: url(${font}); font-weight: 200 800; } @font-face { font-family: M; src: url(${mono}); font-weight: 700; }
  html,body { margin:0; width:${w}px; height:${h}px; background:${bg}; overflow:hidden; }
  </style></head><body>${body}</body></html>`;

const browser = await chromium.launch();
const shot = async (html, w, h, transparent = true) => {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(html); await p.evaluate(() => document.fonts.ready);
  const buf = await p.screenshot({ omitBackground: transparent, type: 'png' });
  await p.close();
  return buf;
};

// ICO with PNG-compressed entries (supported since Vista).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(({ size, buf }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  return Buffer.concat([head, ...pngs.map(p => p.buf)]);
}

// 24-bit BMP (what NSIS wants for installer art).
function bmp(pngBuf) {
  const { width: w, height: h, data } = PNG.sync.read(pngBuf);
  const row = Math.ceil(w * 3 / 4) * 4, size = 54 + row * h, out = Buffer.alloc(size);
  out.write('BM', 0); out.writeUInt32LE(size, 2); out.writeUInt32LE(54, 10); out.writeUInt32LE(40, 14);
  out.writeInt32LE(w, 18); out.writeInt32LE(h, 22); out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); out.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((h - 1 - y) * w + x) * 4, d = 54 + y * row + x * 3;
    out[d] = data[s + 2]; out[d + 1] = data[s + 1]; out[d + 2] = data[s];
  }
  return out;
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const s of sizes) pngs.push({ size: s, buf: await shot(page(tile(s, { flat: s <= 24 }), s, s), s, s) });
const big = await shot(page(tile(512), 512, 512), 512, 512);

fs.mkdirSync(path.join(root, 'brand'), { recursive: true });
fs.writeFileSync(path.join(root, 'brand/slab-tasks-icon-512.png'), big);
fs.writeFileSync(path.join(root, 'build/icon.png'), big);
fs.writeFileSync(path.join(root, 'build/icon.ico'), ico(pngs));
fs.writeFileSync(path.join(root, 'electron/icon.png'), pngs.find(p => p.size === 256).buf);
fs.writeFileSync(path.join(root, 'electron/tray.ico'), ico(pngs.filter(p => p.size <= 64)));

const sidebar = page(`<div style="height:100%;box-sizing:border-box;padding:26px 18px;display:flex;flex-direction:column;gap:18px;background:#FFF4E0;border-right:4px solid #111">
  <div style="width:70px;height:66px">${mark}</div>
  <div style="font-family:B;font-weight:800;font-size:30px;line-height:.95;letter-spacing:-1px;text-transform:uppercase;color:#111">Slab<br>Tasks</div>
  <div style="margin-top:auto;font-family:M;font-size:10px;font-weight:700;letter-spacing:1px;color:#111">TO-DOS YOU<br>AND CLAUDE<br>SHARE</div></div>`, 164, 314, '#FFF4E0');
const header = page(`<div style="height:100%;display:flex;align-items:center;justify-content:flex-end;padding-right:10px;background:#FFF4E0"><div style="width:44px;height:41px">${mark}</div></div>`, 150, 57, '#FFF4E0');
const sb = bmp(await shot(sidebar, 164, 314, false));
fs.writeFileSync(path.join(root, 'build/installerSidebar.bmp'), sb);
fs.writeFileSync(path.join(root, 'build/uninstallerSidebar.bmp'), sb);
fs.writeFileSync(path.join(root, 'build/installerHeader.bmp'), bmp(await shot(header, 150, 57, false)));
await browser.close();
console.log('brand: wrote build/icon.ico, build/icon.png, electron/icon.png, electron/tray.ico, installer bitmaps');
