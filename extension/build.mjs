#!/usr/bin/env node
// AuthForge extension build.
//
//   node extension/build.mjs [--minify]
//
// Bundles the extension entries together with the SHARED client modules
// (src/lib/client/{crypto,totp,icons,recovery,i18n}.ts) so there is exactly one
// implementation of the cryptography and OTP logic across web + extension.
// Emits a load-unpacked-ready directory at extension/dist.

import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const MINIFY = process.argv.includes("--minify");

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, "icons"), { recursive: true });

const shared = {
  bundle: true,
  minify: MINIFY,
  legalComments: "none",
  sourcemap: false,
  logLevel: "info",
  target: ["chrome116"],
};

// ESM entries: MV3 module service worker + popup (type="module")
await build({
  ...shared,
  entryPoints: {
    background: join(HERE, "src/background.ts"),
    popup: join(HERE, "src/popup.ts"),
  },
  outdir: DIST,
  format: "esm",
});

// Content script must be a classic script (IIFE, no import statements)
await build({
  ...shared,
  entryPoints: { content: join(HERE, "src/content.ts") },
  outdir: DIST,
  format: "iife",
});

// Self-test bundle (runs under Node)
await build({
  ...shared,
  entryPoints: [join(HERE, "src/selftest.ts")],
  format: "esm",
  platform: "node",
  outfile: join(DIST, "selftest.mjs"),
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

// Static assets
copyFileSync(join(HERE, "manifest.json"), join(DIST, "manifest.json"));
copyFileSync(join(HERE, "popup.html"), join(DIST, "popup.html"));
copyFileSync(join(HERE, "popup.css"), join(DIST, "popup.css"));
copyFileSync(join(HERE, "offscreen.html"), join(DIST, "offscreen.html"));
copyFileSync(join(HERE, "offscreen.js"), join(DIST, "offscreen.js"));

// ---------------------------------------------------------------- icons
// Chrome only accepts bitmap icons, so they are generated deterministically
// here (no binary assets in git, no image tooling required).
const BG = [13, 16, 21];
const BORDER = [42, 47, 60];
const ACCENT = [190, 242, 100];

function roundedRectInside(x, y, size, radius) {
  const r = Math.min(radius, size / 2);
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function renderIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const R = size * 0.215;
  const ringCx = size * 0.415;
  const ringCy = size * 0.415;
  const r0 = size * 0.135;
  const r1 = size * 0.205;
  const stemX0 = size * 0.455;
  const stemX1 = size * 0.545;
  const stemY0 = size * 0.45;
  const stemY1 = size * 0.755;
  const AA = 1.0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = roundedRectInside(x + 0.5, y + 0.5, size, R);
      if (!inside) {
        px[i + 3] = 0; // transparent corner
        continue;
      }
      let color = BG;

      // border band (2 px, scaled)
      const inset = Math.max(1.2, size * 0.016);
      const onEdge =
        !roundedRectInside(x + 0.5, y + 0.5, size - inset * 2, R - inset) ||
        x < inset || y < inset || x > size - inset || y > size - inset;
      if (onEdge) color = BORDER;

      // key ring
      const d = Math.hypot(x + 0.5 - ringCx, y + 0.5 - ringCy);
      if (d >= r0 - AA && d <= r1 + AA) color = ACCENT;

      // key stem
      if (x + 0.5 >= stemX0 && x + 0.5 <= stemX1 && y + 0.5 >= stemY0 && y + 0.5 <= stemY1) color = ACCENT;

      px[i] = color[0];
      px[i + 1] = color[1];
      px[i + 2] = color[2];
      px[i + 3] = 255;
    }
  }
  return px;
}

// --- minimal PNG encoder (RGBA, 8-bit, no interlace) ---
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, rowStart + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(DIST, "icons", `${size}.png`), encodePng(size, renderIcon(size)));
}

// Patch the manifest with the generated icons (kept out of the source manifest
// so the build is the single place that knows about binary assets).
const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
manifest.icons = { 16: "icons/16.png", 32: "icons/32.png", 48: "icons/48.png", 128: "icons/128.png" };
manifest.action = manifest.action ?? {};
manifest.action.default_icon = { 16: "icons/16.png", 32: "icons/32.png", 48: "icons/48.png", 128: "icons/128.png" };
writeFileSync(join(DIST, "manifest.json"), JSON.stringify(manifest, null, 2));

// ---------------------------------------------------------------- verify
const required = [
  "manifest.json",
  "popup.html",
  "popup.css",
  "popup.js",
  "background.js",
  "content.js",
  "offscreen.html",
  "offscreen.js",
  "icons/16.png",
  "icons/32.png",
  "icons/48.png",
  "icons/128.png",
];
const missing = required.filter((f) => !existsSync(join(DIST, f)));
if (missing.length) {
  console.error("✗ missing build outputs:", missing.join(", "));
  process.exit(1);
}

const m = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
if (m.permissions.includes("tabs")) {
  console.error("✗ manifest must not request the `tabs` permission (spec R11)");
  process.exit(1);
}
if (JSON.stringify(m).match(/https?:\/\/(?!localhost)/)) {
  console.warn("! manifest references a remote URL — review host_permissions");
}

console.log(`\n✓ extension built → ${DIST}`);
console.log("  chrome://extensions → Developer mode → Load unpacked → select that folder");
console.log("  verify the shipped bundle:  node extension/dist/selftest.mjs");
