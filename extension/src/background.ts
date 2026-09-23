// AuthForge extension — MV3 background service worker.
//
// Holds the ONLY in-memory copy of the derived keys and decrypted tokens.
// MV3 evicts idle service workers (~30 s) which acts as a natural key wipe in
// addition to the explicit auto-lock. Secrets never enter the popup DOM: this
// worker computes OTP codes and returns just the code + expiry.

import {
  ApiError,
  api,
  setAccessToken,
  setBaseUrl,
  setRefreshHandler,
} from "../../src/lib/client/api";
import {
  authProofHex,
  decryptJson,
  deriveKeys,
  encryptJson,
  newKdfParams,
  zeroize,
  type KeyPair,
} from "../../src/lib/client/crypto";
import { base32Decode, otpCode, totpCounter } from "../../src/lib/client/totp";
import { matchesHost } from "../../src/lib/client/icons";
import type {
  EncRecord,
  RecoveryData,
  TokenData,
  VaultRecovery,
  VaultToken,
} from "../../src/lib/client/types";
import {
  clearProfile,
  loadProfile,
  pair,
  saveProfile,
  unwrapKeys,
  type ExtProfile,
} from "./state";

// ---------- session (memory only) ----------
interface Session {
  keys: KeyPair | null;
  tokens: VaultToken[];
  recoveries: VaultRecovery[];
  host: string | null;
  lastSync: number;
  note: string | null;
  busy: boolean;
}
const session: Session = {
  keys: null,
  tokens: [],
  recoveries: [],
  host: null,
  lastSync: 0,
  note: null,
  busy: false,
};
let profile: ExtProfile | null = null;
let booting: Promise<void> | null = null;

// ---------- clipboard (spec §12.3: guaranteed 30 s clear on extension) ----------
async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Service workers can lose clipboard focus; the offscreen document has a
    // real DOM and is Chrome's documented fallback for MV3 clipboard writes.
  }
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["CLIPBOARD"],
        justification: "Auto-clear copied 2FA codes 30 seconds after copying.",
      });
    }
    await chrome.runtime.sendMessage({ type: "af-clip-write", text });
  } catch {
    throw new Error("clipboard-unavailable");
  }
}

function scheduleClipboardClear(): void {
  chrome.alarms.create("af-clear-clip", { when: Date.now() + 30_000 });
}

// ---------- auth / sync ----------
setRefreshHandler(async () => {
  if (!profile?.refreshToken) return false;
  try {
    const res = await api.refresh(profile.refreshToken);
    setAccessToken(res.access_token);
    profile.refreshToken = res.refresh_token;
    await saveProfile(profile);
    return true;
  } catch {
    return false;
  }
});

async function pull(): Promise<void> {
  if (!profile || !session.keys) return;
  const res = await api.pull(profile.syncVersion);
  let changed = false;
  for (const r of res.tokens) {
    const i = profile.tokens.findIndex((x) => x.id === r.id);
    const next: EncRecord = {
      id: r.id,
      encrypted_data: r.encrypted_data ?? "",
      version: r.version ?? 0,
      deleted: !!r.deleted,
      created_at: r.created_at ?? 0,
      updated_at: r.updated_at,
    };
    if (i < 0 && !next.deleted) {
      profile.tokens.push(next);
      changed = true;
    } else if (i >= 0 && next.version > profile.tokens[i]!.version) {
      profile.tokens[i] = next;
      changed = true;
    }
  }
  for (const r of res.recoveries) {
    const i = profile.recoveries.findIndex((x) => x.id === r.id);
    const next: EncRecord = {
      id: r.id,
      token_id: r.token_id ?? "",
      encrypted_data: r.encrypted_data ?? "",
      version: r.version ?? 0,
      deleted: !!r.deleted,
      created_at: r.created_at ?? 0,
      updated_at: r.updated_at,
    };
    if (i < 0 && !next.deleted) {
      profile.recoveries.push(next);
      changed = true;
    } else if (i >= 0 && next.version > profile.recoveries[i]!.version) {
      profile.recoveries[i] = next;
      changed = true;
    }
  }
  profile.syncVersion = res.server_version;
  session.lastSync = Date.now();
  session.note = null;
  await saveProfile(profile);
  if (changed) await decryptAll();
}

async function decryptAll(): Promise<void> {
  if (!profile || !session.keys) return;
  const keys = session.keys;
  const tokens: VaultToken[] = [];
  const recoveries: VaultRecovery[] = [];
  for (const r of profile.tokens) {
    if (r.deleted) continue;
    try {
      const d = await decryptJson<TokenData>(keys.encKey, r.id, r.encrypted_data);
      tokens.push({
        ...d,
        id: r.id,
        version: r.version,
        deleted: false,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    } catch {
      /* record written by another vault key — skip */
    }
  }
  for (const r of profile.recoveries) {
    if (r.deleted) continue;
    try {
      const d = await decryptJson<RecoveryData>(keys.encKey, r.id, r.encrypted_data);
      recoveries.push({
        ...d,
        id: r.id,
        tokenId: r.token_id ?? "",
        version: r.version,
        deleted: false,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    } catch {
      /* skip */
    }
  }
  session.tokens = tokens;
  session.recoveries = recoveries;
}

/** Wake-up path: unwrap keys from the Device Key (no master password needed). */
async function ensureSession(): Promise<void> {
  if (session.keys) return;
  if (booting) return booting;
  booting = (async () => {
    profile = profile ?? (await loadProfile());
    if (!profile) return;
    setBaseUrl(profile.serverUrl);
    try {
      session.keys = await unwrapKeys(profile);
    } catch {
      session.note = "ext.corruptStore";
      return;
    }
    if (profile.refreshToken) {
      const ok = await (await import("../../src/lib/client/api")).tryRefresh?.();
      if (!ok) session.note = "ext.sessionExpired";
    } else {
      session.note = "ext.sessionExpired";
    }
    try {
      await pull();
    } catch (e) {
      session.note = e instanceof ApiError && e.status === 0 ? "ext.offline" : "ext.syncFailed";
    }
  })();
  try {
    await booting;
  } finally {
    booting = null;
  }
}

function lock(dropKeys: boolean): void {
  if (session.keys) {
    zeroize(session.keys.authKey);
    zeroize(session.keys.encKey);
  }
  session.keys = null;
  session.tokens = [];
  session.recoveries = [];
  session.note = null;
  setAccessToken(null);
  if (dropKeys) {
    void clearProfile();
    profile = null;
  }
}

// ---------- code computation ----------
export interface CodeEntry {
  id: string;
  issuer: string;
  account: string;
  code: string | null;
  period: number;
  type: string;
  digits: number;
  expiresAt: number;
  matched: boolean;
  hasRecovery: boolean;
  remainingRecovery: number | null;
}

/** Sync: how many tokens match the current site (badge counter, no OTP work). */
function matchCount(host: string): number {
  return session.tokens.filter((t) => matchesHost(t.issuer, t.account, host)).length;
}

async function buildEntries(host: string | null): Promise<CodeEntry[]> {
  const now = Date.now();
  const list = await Promise.all(
    session.tokens.map(async (t): Promise<CodeEntry> => {
      let code: string | null = null;
      try {
        code = await otpCode(
          {
            secretBytes: base32Decode(t.secret),
            algorithm: t.algorithm,
            digits: t.digits,
            period: t.period,
            type: t.type,
            counter: t.type === "hotp" ? t.counter ?? 0 : totpCounter(t.period, now),
          },
          now
        );
      } catch {
        code = null;
      }
      const rec = session.recoveries.find((r) => r.tokenId === t.id && !r.deleted);
      let remaining: number | null = null;
      if (rec) {
        const used = rec.codes.filter((c) => c.used).length;
        remaining = rec.codes.length - used;
      }
      return {
        id: t.id,
        issuer: t.issuer,
        account: t.account,
        code,
        period: t.period,
        type: t.type,
        digits: t.digits,
        expiresAt: t.type === "hotp" ? Number.MAX_SAFE_INTEGER : (totpCounter(t.period, now) + 1) * t.period * 1000,
        matched: host ? matchesHost(t.issuer, t.account, host) : false,
        hasRecovery: !!rec,
        remainingRecovery: remaining,
      };
    })
  );
  return list.sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? -1 : 1;
    return a.issuer.localeCompare(b.issuer);
  });
}

function touchAutoLock(): void {
  if (!profile) return;
  const mins = profile.autoLockMins;
  if (mins > 0) chrome.alarms.create("af-autolock", { delayInMinutes: Math.max(1, mins) });
  else void chrome.alarms.clear("af-autolock");
}

// ---------- pairing ----------
async function doPair(
  serverUrl: string,
  email: string,
  password: string,
  register: boolean
): Promise<void> {
  const url = serverUrl.trim().replace(/\/$/, "");
  setBaseUrl(url);
  const kdfParams = register ? newKdfParams() : (await api.prelogin(email)).kdf_params;

  let refreshToken = "";
  const { profile: p, keys } = await pair(url, email, password, kdfParams, async (k) => {
    const proof = await authProofHex(k.authKey);
    const deviceName = "AuthForge extension";
    const res = register
      ? await api.register({ email, kdf_params: kdfParams, auth_key_hash: proof, device_name: deviceName })
      : await api.login({ email, auth_proof: proof, device_name: deviceName });
    setAccessToken(res.access_token);
    refreshToken = res.refresh_token;
    return k;
  });

  p.refreshToken = refreshToken;
  await saveProfile(p);
  profile = p;
  session.keys = keys;
  session.note = null;
  await pull();
}

// ---------- recovery usage ----------
async function setRecoveryUsed(tokenId: string, index: number, used: boolean): Promise<void> {
  if (!profile || !session.keys) throw new Error("ext.locked");
  const rec = session.recoveries.find((r) => r.tokenId === tokenId && !r.deleted);
  if (!rec) throw new Error("ext.noRecovery");

  const data: RecoveryData = {
    recoveryType: rec.recoveryType,
    codes: rec.codes.map((c, i) => (i === index ? { ...c, used, usedAt: used ? Date.now() : undefined } : c)),
    rawText: rec.rawText,
    notes: rec.notes,
    addedAt: rec.addedAt,
  };
  const encrypted = await encryptJson(session.keys.encKey, rec.id, data);
  const change = {
    id: rec.id,
    token_id: tokenId,
    encrypted_data: encrypted,
    updated_at: Date.now(),
  };

  let res;
  try {
    res = await api.push(profile.syncVersion, [], [change]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      await pull(); // re-sync then retry once
      res = await api.push(profile.syncVersion, [], [change]);
    } else {
      throw e;
    }
  }

  rec.codes = data.codes;
  const i = profile.recoveries.findIndex((r) => r.id === rec.id);
  if (i >= 0) {
    profile.recoveries[i] = {
      ...profile.recoveries[i]!,
      encrypted_data: encrypted,
      version: res.applied.recoveries[0]?.version ?? profile.recoveries[i]!.version,
      updated_at: Date.now(),
    };
  }
  profile.syncVersion = res.new_server_version;
  await saveProfile(profile);
  void api.reportAudit([{ action: used ? "recovery_use" : "recovery_view", ts: Date.now() }]).catch(() => undefined);
}

// ---------- message router ----------
interface Msg {
  type: string;
  [k: string]: unknown;
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const msg = raw as Msg;
  // content script → SW: report the hostname of the page it landed on.
  // This replaces reading tab.url, which needs the `tabs` permission (spec R11).
  if (msg?.type === "af-host") {
    const host = String(msg.host ?? "");
    session.host = host;
    const tabId = sender.tab?.id;
    if (tabId != null) void chrome.storage.session.set({ [`host:${tabId}`]: host });
    const n = matchCount(host);
    chrome.action.setBadgeBackgroundColor({ color: "#bef264" });
    chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" });
    sendResponse({ ok: true });
    return;
  }

  void (async () => {
    try {
      switch (msg?.type) {
        case "af-status": {
          profile = profile ?? (await loadProfile());
          if (!profile) return sendResponse({ state: "unpaired" });
          await ensureSession();
          return sendResponse({
            state: session.keys ? "ready" : "error",
            email: profile.email,
            serverUrl: profile.serverUrl,
            tokenCount: session.tokens.length,
            lastSync: session.lastSync,
            note: session.note,
            autoLockMins: profile.autoLockMins,
            reauthOnLock: profile.reauthOnLock,
          });
        }
        case "af-pair": {
          await doPair(
            String(msg.serverUrl),
            String(msg.email).trim().toLowerCase(),
            String(msg.password),
            msg.register === true
          );
          touchAutoLock();
          return sendResponse({ ok: true });
        }
        case "af-codes": {
          await ensureSession();
          if (!session.keys) return sendResponse({ ok: false, error: session.note ?? "ext.locked" });
          return sendResponse({
            ok: true,
            entries: buildEntries(session.host),
            lastSync: session.lastSync,
            note: session.note,
            email: profile?.email,
          });
        }
        case "af-copy": {
          await writeClipboard(String(msg.code));
          scheduleClipboardClear();
          void api.reportAudit([{ action: "recovery_copy", ts: Date.now() }]).catch(() => undefined);
          return sendResponse({ ok: true });
        }
        case "af-recovery": {
          await ensureSession();
          const rec = session.recoveries.find((r) => r.tokenId === String(msg.tokenId) && !r.deleted);
          if (!rec) return sendResponse({ ok: false, error: "ext.noRecovery" });
          void api.reportAudit([{ action: "recovery_view", ts: Date.now() }]).catch(() => undefined);
          return sendResponse({
            ok: true,
            id: rec.id,
            recoveryType: rec.recoveryType,
            codes: rec.codes.map((c) => ({ code: c.code, used: c.used, usedAt: c.usedAt ?? null })),
          });
        }
        case "af-recovery-use": {
          await ensureSession();
          await setRecoveryUsed(String(msg.tokenId), Number(msg.index), msg.used === true);
          return sendResponse({ ok: true });
        }
        case "af-lock": {
          const drop = msg.dropKeys === true;
          lock(drop);
          return sendResponse({ ok: true });
        }
        case "af-settings": {
          profile = profile ?? (await loadProfile());
          if (!profile) return sendResponse({ ok: false });
          if (typeof msg.autoLockMins === "number") profile.autoLockMins = msg.autoLockMins;
          if (typeof msg.reauthOnLock === "boolean") profile.reauthOnLock = msg.reauthOnLock;
          await saveProfile(profile);
          touchAutoLock();
          return sendResponse({ ok: true });
        }
        case "af-disconnect": {
          lock(true);
          return sendResponse({ ok: true });
        }
        case "af-get-host": {
          const bag = await chrome.storage.session.get(null);
          const tabId = msg.tabId;
          const key = `host:${tabId}`;
          return sendResponse({ host: (bag[key] as string | undefined) ?? session.host ?? null });
        }
        case "af-refresh": {
          await ensureSession();
          try {
            await pull();
          } catch (e) {
            session.note = e instanceof ApiError && e.status === 0 ? "ext.offline" : "ext.syncFailed";
          }
          return sendResponse({ ok: true, lastSync: session.lastSync, note: session.note });
        }
        default:
          return sendResponse({ ok: false, error: "unknown-message" });
      }
    } catch (e) {
      const code =
        e instanceof ApiError
          ? e.status === 0
            ? "ext.offline"
            : e.status === 401
              ? "ext.badCredentials"
              : e.code
          : e instanceof Error
            ? e.message
            : "ext.error";
      return sendResponse({ ok: false, error: code, message: e instanceof Error ? e.message : "" });
    }
  })();

  touchAutoLock();
  return true; // async sendResponse
});

// ---------- alarms ----------
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "af-clear-clip") {
    // Writing an empty string needs no clipboard-read permission (spec R12).
    void writeClipboard("");
  } else if (alarm.name === "af-autolock") {
    lock(false);
  }
});

// ---------- keyboard commands ----------
async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function hostForTab(tabId: number | null): Promise<string | null> {
  if (tabId != null) {
    try {
      const r = (await chrome.tabs.sendMessage(tabId, { type: "af-ping-host" })) as { host?: string } | undefined;
      if (r?.host) return r.host;
    } catch {
      /* no content script on this page (chrome://, store, …) */
    }
  }
  const r = (await chrome.runtime.sendMessage({ type: "af-get-host", tabId })) as { host?: string } | undefined;
  return r?.host ?? null;
}

chrome.commands.onCommand.addListener(async (command) => {
  await ensureSession();
  if (!session.keys) return;
  const tabId = await activeTabId();
  const host = await hostForTab(tabId);
  const entry = (await buildEntries(host)).find((e) => e.matched && e.code);
  if (!entry?.code) return;
  if (command === "copy-code") {
    try {
      await writeClipboard(entry.code);
      scheduleClipboardClear();
    } catch {
      /* clipboard unavailable without focus */
    }
  } else if (command === "auto-fill" && tabId != null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "af-fill", code: entry.code });
    } catch {
      /* no receiver */
    }
  }
});

// Keep deriveKeys imported for the re-pair path (avoids tree-shaking surprises
// in the bundle while documenting the only other consumer of the password).
void deriveKeys;
