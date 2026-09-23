// Export engine (spec §7.2): all formats are generated 100% client-side.
// .afbackup = PBKDF2-600K + AES-256-GCM with an independent backup password.

import QRCode from "qrcode";
import { bytesToB64, b64ToBytes, deriveMasterKey, randomBytes, KDF_ITERATIONS } from "./crypto";
import { buildOtpAuthUri } from "./totp";
import type { RecoveryData, TokenData, VaultToken, VaultRecovery } from "./types";
import { tokenFingerprint } from "./types";

const te = new TextEncoder();
const td = new TextDecoder();

export interface RecoveryBundle {
  fingerprint: string;
  data: RecoveryData;
}

async function aesGcm(key: Uint8Array, iv: Uint8Array, data: Uint8Array, aad: string, decrypt = false): Promise<Uint8Array> {
  const ck = await crypto.subtle.importKey("raw", key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const params = { name: "AES-GCM", iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer, additionalData: te.encode(aad) };
  const out = decrypt
    ? await crypto.subtle.decrypt(params, ck, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
    : await crypto.subtle.encrypt(params, ck, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  return new Uint8Array(out);
}

export interface AfBackupPlain {
  tokens: TokenData[];
  recoveries: RecoveryBundle[];
}

// ---------- .afbackup ----------
export async function buildAfBackup(tokens: VaultToken[], recoveries: VaultRecovery[], password: string): Promise<string> {
  const plain: AfBackupPlain = {
    tokens: tokens.map(stripMeta),
    recoveries: recoveries.map((r) => ({ fingerprint: fingerprintOfRecoveryOwner(r, tokens), data: stripRecMeta(r) })),
  };
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = await deriveMasterKey(password, bytesToB64(salt), KDF_ITERATIONS);
  const ct = await aesGcm(key, iv, te.encode(JSON.stringify(plain)), "afbackup-v1");
  return JSON.stringify(
    {
      format: "afbackup",
      version: 1,
      kdf: { algorithm: "PBKDF2-SHA256", iterations: KDF_ITERATIONS, salt: bytesToB64(salt) },
      enc: { iv: bytesToB64(iv), ct: bytesToB64(ct) },
      exported_at: Date.now(),
      app: "AuthForge v1.0",
    },
    null,
    2
  );
}

export async function openAfBackup(raw: string, password: string): Promise<AfBackupPlain> {
  const f = JSON.parse(raw) as {
    format: string;
    kdf: { iterations: number; salt: string };
    enc: { iv: string; ct: string };
  };
  if (f.format !== "afbackup") throw new Error("Not an AuthForge backup");
  const key = await deriveMasterKey(password, f.kdf.salt, f.kdf.iterations);
  const pt = await aesGcm(key, b64ToBytes(f.enc.iv), b64ToBytes(f.enc.ct), "afbackup-v1", true);
  return JSON.parse(td.decode(pt)) as AfBackupPlain;
}

// ---------- plain formats ----------
function stripMeta(t: VaultToken): TokenData {
  const { id: _id, version: _v, deleted: _d, createdAt: _c, updatedAt: _u, ...data } = t;
  return data;
}
function stripRecMeta(r: VaultRecovery): RecoveryData {
  const { id: _id, tokenId: _t, version: _v, deleted: _d, createdAt: _c, updatedAt: _u, ...data } = r;
  return data;
}
function fingerprintOfRecoveryOwner(r: VaultRecovery, tokens: VaultToken[]): string {
  const owner = tokens.find((t) => t.id === r.tokenId);
  return owner ? tokenFingerprint(owner) : `orphan:${r.tokenId}`;
}

export function buildPlainJson(tokens: VaultToken[], recoveries: VaultRecovery[]): string {
  return JSON.stringify(
    {
      format: "authforge",
      version: 1,
      exported_at: Date.now(),
      tokens: tokens.map(stripMeta),
      recoveries: recoveries.map((r) => ({ fingerprint: fingerprintOfRecoveryOwner(r, tokens), data: stripRecMeta(r) })),
    },
    null,
    2
  );
}

export function buildUris(tokens: VaultToken[]): string {
  return tokens.map((t) => buildOtpAuthUri(stripMeta(t))).join("\n");
}

export function buildCsv(tokens: VaultToken[], recoveries: VaultRecovery[]): string {
  const byFp = new Map<string, string[]>();
  for (const r of recoveries) {
    const fp = fingerprintOfRecoveryOwner(r, tokens);
    byFp.set(fp, r.codes.filter((c) => !c.used).map((c) => c.code));
  }
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = ["issuer,account,secret,algorithm,digits,period,type,counter,category,notes,recovery_codes"];
  for (const t of tokens) {
    rows.push(
      [
        t.issuer, t.account, t.secret.replace(/\s/g, "").toUpperCase(), t.algorithm,
        String(t.digits), String(t.period), t.type, t.counter != null ? String(t.counter) : "",
        t.category ?? "", t.notes ?? "", (byFp.get(tokenFingerprint(t)) ?? []).join(" "),
      ].map(esc).join(",")
    );
  }
  return rows.join("\n");
}

// ---------- printable emergency recovery card (spec §12.5 plan 2) ----------
export async function buildRecoveryCardHtml(tokens: VaultToken[], recoveries: VaultRecovery[]): Promise<string> {
  const groups = tGroup(tokens);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const blocks: string[] = [];
  for (const g of groups) {
    const t = g;
    const uri = buildOtpAuthUri(stripMeta(t));
    const qr = await QRCode.toDataURL(uri, { margin: 0, width: 110, color: { dark: "#111111", light: "#ffffff" } });
    const recs = recoveries.filter((r) => r.tokenId === t.id && !r.deleted);
    const recHtml = recs
      .map((r) => {
        const unused = r.codes.filter((c) => !c.used).map((c) => c.code);
        if (unused.length === 0) return "";
        return `<div class="rec"><span class="rl">Recovery codes (${unused.length})</span><span class="codes">${unused.map((c) => `<code>${esc(c)}</code>`).join(" ")}</span></div>`;
      })
      .join("");
    blocks.push(`<section class="card">
  <img src="${qr}" alt="QR"/>
  <div class="meta">
    <h2>${esc(t.issuer || "(no issuer)")}</h2>
    <p class="acc">${esc(t.account || "")}</p>
    <p class="secret">${esc(t.secret.replace(/\s/g, "").toUpperCase().replace(/(.{4})/g, "$1 ").trim())}</p>
    <p class="params">${t.algorithm} · ${t.digits} digits · ${t.type === "hotp" ? "HOTP counter " + (t.counter ?? 0) : t.period + "s"}</p>
    ${recHtml}
  </div>
</section>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>AuthForge Emergency Recovery Card</title>
<style>
body{font-family:ui-monospace,Menlo,Consolas,monospace;color:#111;max-width:760px;margin:32px auto;padding:0 16px}
h1{font-size:18px;letter-spacing:.12em;text-transform:uppercase}
.warn{border:1px solid #c00;color:#900;padding:10px 12px;font-size:12px;margin:14px 0}
.card{display:flex;gap:16px;border:1px solid #999;padding:14px;margin:12px 0;page-break-inside:avoid}
.card img{width:110px;height:110px}
.meta h2{margin:0 0 2px;font-size:15px}.acc{margin:0 0 8px;color:#444;font-size:12px}
.secret{font-size:14px;letter-spacing:.15em;margin:4px 0}
.params{font-size:11px;color:#555;margin:2px 0 8px}
.rec{font-size:11px}.rl{display:block;color:#666;margin-bottom:2px}
.codes code{background:#f0f0f0;padding:1px 4px;margin-right:4px;display:inline-block}
footer{margin-top:24px;font-size:11px;color:#666;border-top:1px solid #999;padding-top:8px}
@media print{.noprint{display:none}}
</style></head><body>
<h1>AuthForge — Emergency Recovery Card</h1>
<div class="warn"><b>KEEP THIS DOCUMENT IN A SAFE PLACE.</b> Anyone holding it can generate your 2FA codes and use the recovery codes below.
Print it, store it in a safe, then close this tab.</div>
${blocks.join("\n") || "<p>No tokens.</p>"}
<footer>Generated ${new Date().toLocaleString()} · ${groups.length} token(s) · ${recoveries.filter((r) => !r.deleted).length} recovery record(s) · AuthForge</footer>
<script>window.onload=()=>setTimeout(()=>window.print(),400)</script>
</body></html>`;
}

const tGroup = (tokens: VaultToken[]) => tokens.filter((t) => !t.deleted);

export function download(filename: string, content: string, mime = "application/octet-stream") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
