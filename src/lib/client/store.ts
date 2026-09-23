"use client";

// AuthForge vault store — orchestrates keys (memory-only), ciphertext IDB
// records, outbox-based sync (spec §8), audit queue, and the
// locked/setup/unlocked state machine.

import { create } from "zustand";
import {
  decryptJson,
  deriveKeys,
  encryptJson,
  authProofHex,
  newKdfParams,
  zeroize,
  type KeyPair,
} from "./crypto";
import {
  allRecoveryRecs,
  allTokenRecs,
  auditAdd,
  auditAll,
  auditRemoveSeqs,
  eraseVault,
  getRecoveryRec,
  getTokenRec,
  kvGet,
  kvSet,
  outboxAdd,
  outboxAll,
  outboxClear,
  outboxRemoveSeqs,
  putRecoveryRec,
  putTokenRec,
} from "./idb";
import { api, ApiError, setAccessToken, setBaseUrl, setRefreshHandler, type WireRec } from "./api";
import type { EncRecord, RecoveryData, TokenData, VaultRecovery, VaultToken } from "./types";
import { tokenFingerprint } from "./types";
import { getT } from "./i18n";

const VERIFIER_PLAINTEXT = "authforge-vault-v1";
const PROFILE_KEY = "profile";

// ---------- module-scoped secrets (never serialized, never persisted) ----------
let keys: KeyPair | null = null;

interface Profile {
  mode: "local" | "server";
  email?: string;
  kdfParams: string;
  verifier: string;
  serverUrl?: string;
  refreshToken?: string;
  serverVersion: number;
  autoLockMins: number;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

export type DupPolicy = "skip" | "overwrite";

function tokenDataOf(t: VaultToken): TokenData {
  return {
    issuer: t.issuer, account: t.account, secret: t.secret, algorithm: t.algorithm,
    digits: t.digits, period: t.period, type: t.type, counter: t.counter,
    category: t.category, notes: t.notes, critical: t.critical, lastUsedAt: t.lastUsedAt,
  };
}
function recoveryDataOf(r: VaultRecovery): RecoveryData {
  return { recoveryType: r.recoveryType, codes: r.codes, rawText: r.rawText, notes: r.notes, addedAt: r.addedAt };
}

async function encToken(t: VaultToken): Promise<EncRecord> {
  return {
    id: t.id,
    encrypted_data: await encryptJson(keys!.encKey, t.id, tokenDataOf(t)),
    version: t.version,
    deleted: t.deleted,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}
async function encRecovery(r: VaultRecovery): Promise<EncRecord> {
  return {
    id: r.id,
    token_id: r.tokenId,
    encrypted_data: await encryptJson(keys!.encKey, r.id, recoveryDataOf(r)),
    version: r.version,
    deleted: r.deleted,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function uuid(): string {
  return crypto.randomUUID();
}

function deviceName(): string {
  const ua = /(Firefox|Edg|Chrome|Safari)/.exec(navigator.userAgent)?.[1] ?? "Browser";
  return `${ua} on ${navigator.platform || "device"}`;
}

export interface VaultState {
  status: "boot" | "setup" | "locked" | "unlocked";
  mode: "local" | "server" | null;
  email: string | null;
  tokens: VaultToken[];
  recoveries: VaultRecovery[];
  outboxCount: number;
  serverVersion: number;
  syncing: boolean;
  online: boolean;
  syncNote: string | null;
  autoLockMins: number;
  now: number;
  toasts: Toast[];
  activeTab: "vault" | "health" | "settings";
  search: string;
  selectedTokenId: string | null;
  addOpen: boolean;
  importOpen: boolean;
  exportOpen: boolean;

  boot: () => Promise<void>;
  setupLocal: (password: string) => Promise<void>;
  setupServer: (email: string, password: string, serverUrl: string, register: boolean) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  lock: () => void;
  connectServer: (email: string, password: string, serverUrl: string, register: boolean) => Promise<void>;
  disconnectServer: () => Promise<void>;
  eraseAll: () => Promise<void>;
  changeMasterPassword: (newPassword: string) => Promise<void>;
  deleteAccount: () => Promise<void>;
  setAutoLock: (mins: number) => Promise<void>;

  addToken: (data: TokenData) => Promise<VaultToken>;
  updateToken: (id: string, patch: Partial<TokenData>) => Promise<void>;
  deleteToken: (id: string) => Promise<void>;
  addTokensBulk: (list: TokenData[], policy: DupPolicy) => Promise<{ added: number; skipped: number; overwritten: number; fpMap: Map<string, string> }>;
  bumpHotp: (id: string) => Promise<void>;
  markTokenUsed: (id: string) => Promise<void>;

  addRecovery: (tokenId: string, data: RecoveryData) => Promise<VaultRecovery>;
  updateRecovery: (id: string, data: RecoveryData) => Promise<void>;
  deleteRecovery: (id: string) => Promise<void>;
  setCodeUsed: (id: string, index: number, used: boolean) => Promise<void>;

  syncNow: () => Promise<void>;
  queueAudit: (action: string, details?: Record<string, unknown>) => void;

  toast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;
  set: (p: Partial<VaultState>) => void;
}

async function loadProfile(): Promise<Profile | null> {
  return (await kvGet<Profile>(PROFILE_KEY).catch(() => undefined)) ?? null;
}
async function saveProfile(p: Profile): Promise<void> {
  await kvSet(PROFILE_KEY, p);
}

export const useVault = create<VaultState>((set, get) => {
  let toastSeq = 0;
  let syncRunning = false;
  // set while a change-password transaction holds the server-side sync lock,
  // so OUR push can present the lock token (spec §4.5 step 3, x-change-lock).
  let changeLockHeader: string | null = null;

  const toast = (kind: Toast["kind"], text: string) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), 4200);
  };

  async function persistToken(t: VaultToken) {
    const rec = await encToken(t);
    await putTokenRec(rec);
    await outboxAdd({ entity: "token", record: rec, ts: Date.now() });
    const ops = await outboxAll();
    set({ outboxCount: ops.length });
  }
  async function persistRecovery(r: VaultRecovery) {
    const rec = await encRecovery(r);
    await putRecoveryRec(rec);
    await outboxAdd({ entity: "recovery", record: rec, ts: Date.now() });
    const ops = await outboxAll();
    set({ outboxCount: ops.length });
  }

  /** Re-read + decrypt every record from IDB into memory. */
  async function reloadVault() {
    const [tRecs, rRecs] = await Promise.all([allTokenRecs(), allRecoveryRecs()]);
    let corrupt = 0;
    const tokens: VaultToken[] = [];
    for (const r of tRecs) {
      if (r.deleted) continue;
      try {
        const d = await decryptJson<TokenData>(keys!.encKey, r.id, r.encrypted_data);
        tokens.push({ ...d, id: r.id, version: r.version, deleted: false, createdAt: r.created_at, updatedAt: r.updated_at });
      } catch {
        corrupt++;
      }
    }
    const recoveries: VaultRecovery[] = [];
    for (const r of rRecs) {
      if (r.deleted) continue;
      try {
        const d = await decryptJson<RecoveryData>(keys!.encKey, r.id, r.encrypted_data);
        recoveries.push({ ...d, id: r.id, tokenId: r.token_id ?? "", version: r.version, deleted: false, createdAt: r.created_at, updatedAt: r.updated_at });
      } catch {
        corrupt++;
      }
    }
    if (corrupt > 0) toast("error", getT()("t.corrupt", { n: corrupt }));
    const ops = await outboxAll();
    set({ tokens, recoveries, outboxCount: ops.length });
  }

  async function refreshSession(): Promise<boolean> {
    const profile = await loadProfile();
    if (!profile?.refreshToken) return false;
    try {
      const res = await api.refresh(profile.refreshToken);
      setAccessToken(res.access_token);
      profile.refreshToken = res.refresh_token;
      await saveProfile(profile);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        profile.refreshToken = undefined;
        await saveProfile(profile);
        set({ syncNote: getT()("note.sessionExpired") });
      } else {
        set({ syncNote: getT()("note.unreachable") });
      }
      return false;
    }
  }
  setRefreshHandler(refreshSession);

  /** Local LWW predicate mirroring the server rule (spec §8.2). */
  function incomingWins(local: { updatedAt: number; deleted: boolean } | null, inc: { updated_at: number; deleted: boolean }): boolean {
    if (!local) return true;
    if (local.deleted && !inc.deleted) return false;
    if (inc.deleted && !local.deleted) return true;
    return inc.updated_at > local.updatedAt;
  }

  return {
    status: "boot",
    mode: null,
    email: null,
    tokens: [],
    recoveries: [],
    outboxCount: 0,
    serverVersion: 0,
    syncing: false,
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    syncNote: null,
    autoLockMins: 5,
    now: Date.now(),
    toasts: [],
    activeTab: "vault",
    search: "",
    selectedTokenId: null,
    addOpen: false,
    importOpen: false,
    exportOpen: false,
    toast,
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    set: (p) => set(p),

    boot: async () => {
      const profile = await loadProfile();
      if (!profile) {
        set({ status: "setup" });
        return;
      }
      setBaseUrl(profile.serverUrl ?? "");
      set({ status: "locked", mode: profile.mode, email: profile.email ?? null, autoLockMins: profile.autoLockMins ?? 5, serverVersion: profile.serverVersion });
    },

    setupLocal: async (password) => {
      const kdfParams = newKdfParams();
      keys = await deriveKeys(password, kdfParams);
      const verifier = await encryptJson(keys.encKey, "vault-verifier", VERIFIER_PLAINTEXT);
      const profile: Profile = { mode: "local", kdfParams, verifier, serverVersion: 0, autoLockMins: 5 };
      await saveProfile(profile);
      set({ status: "unlocked", mode: "local", email: null, tokens: [], recoveries: [], outboxCount: 0 });
    },

    setupServer: async (email, password, serverUrl, register) => {
      setBaseUrl(serverUrl);
      let kdfParams: string;
      if (register) {
        kdfParams = newKdfParams();
        keys = await deriveKeys(password, kdfParams);
        const proof = await authProofHex(keys.authKey);
        const res = await api.register({ email, kdf_params: kdfParams, auth_key_hash: proof, device_name: deviceName() });
        setAccessToken(res.access_token);
        const verifier = await encryptJson(keys.encKey, "vault-verifier", VERIFIER_PLAINTEXT);
        const profile: Profile = {
          mode: "server", email: res.user.email, kdfParams, verifier,
          serverUrl, refreshToken: res.refresh_token, serverVersion: 0, autoLockMins: 5,
        };
        await saveProfile(profile);
        set({ status: "unlocked", mode: "server", email: res.user.email, tokens: [], recoveries: [] });
      } else {
        const pre = await api.prelogin(email);
        kdfParams = pre.kdf_params;
        keys = await deriveKeys(password, kdfParams);
        const proof = await authProofHex(keys.authKey);
        const res = await api.login({ email, auth_proof: proof, device_name: deviceName() });
        setAccessToken(res.access_token);
        const verifier = await encryptJson(keys.encKey, "vault-verifier", VERIFIER_PLAINTEXT);
        const profile: Profile = {
          mode: "server", email: res.user.email, kdfParams, verifier,
          serverUrl, refreshToken: res.refresh_token, serverVersion: 0, autoLockMins: 5,
        };
        await saveProfile(profile);
        set({ status: "unlocked", mode: "server", email: res.user.email });
        await reloadVault();
        void get().syncNow();
      }
    },

    unlock: async (password) => {
      const profile = await loadProfile();
      if (!profile) {
        set({ status: "setup" });
        return;
      }
      const derived = await deriveKeys(password, profile.kdfParams);
      try {
        const plain = await decryptJson<string>(derived.encKey, "vault-verifier", profile.verifier);
        if (plain !== VERIFIER_PLAINTEXT) throw new Error("bad");
      } catch {
        throw new Error(getT()("auth.wrongPw"));
      }
      keys = derived;
      setBaseUrl(profile.serverUrl ?? "");
      set({ mode: profile.mode, email: profile.email ?? null, serverVersion: profile.serverVersion, autoLockMins: profile.autoLockMins ?? 5 });
      await reloadVault();
      // zero tombstone display artifacts
      set({ status: "unlocked" });
      if (profile.mode === "server") {
        void (async () => {
          const ok = await refreshSession();
          if (ok) {
            set({ syncNote: null });
            await get().syncNow();
          }
        })();
      }
    },

    lock: () => {
      if (keys) {
        zeroize(keys.authKey);
        zeroize(keys.encKey);
      }
      keys = null;
      setAccessToken(null);
      set({ status: "locked", tokens: [], recoveries: [], selectedTokenId: null, addOpen: false, importOpen: false, exportOpen: false, activeTab: "vault", search: "" });
    },

    /** spec §11.1: Local-only → connect a server later (re-key + full merge). */
    connectServer: async (email, password, serverUrl, register) => {
      const profile = await loadProfile();
      if (!profile || !keys) throw new Error("Vault is locked");
      setBaseUrl(serverUrl);

      let newKdf: string;
      let newKeys: KeyPair;
      let refreshToken: string;
      let userEmail: string;
      if (register) {
        newKdf = newKdfParams();
        newKeys = await deriveKeys(password, newKdf);
        const proof = await authProofHex(newKeys.authKey);
        const res = await api.register({ email, kdf_params: newKdf, auth_key_hash: proof, device_name: deviceName() });
        setAccessToken(res.access_token);
        refreshToken = res.refresh_token;
        userEmail = res.user.email;
      } else {
        const pre = await api.prelogin(email);
        newKdf = pre.kdf_params;
        newKeys = await deriveKeys(password, newKdf);
        const proof = await authProofHex(newKeys.authKey);
        const res = await api.login({ email, auth_proof: proof, device_name: deviceName() });
        setAccessToken(res.access_token);
        refreshToken = res.refresh_token;
        userEmail = res.user.email;
      }

      // re-key everything under the new account keys (spec §4.5 re-encryption step).
      // CRITICAL: clear the outbox first — its entries are encrypted with the OLD
      // key; pushing them (they sort before the re-keyed records) would leave stale
      // ciphertext on the server that no device can decrypt.
      await outboxClear();
      const oldKeys = keys;
      const [tRecs, rRecs] = await Promise.all([allTokenRecs(), allRecoveryRecs()]);
      for (const rec of tRecs) {
        if (rec.deleted) continue;
        try {
          const d = await decryptJson<TokenData>(oldKeys.encKey, rec.id, rec.encrypted_data);
          rec.encrypted_data = await encryptJson(newKeys.encKey, rec.id, d);
          await putTokenRec(rec);
          await outboxAdd({ entity: "token", record: rec, ts: Date.now() });
        } catch { /* skip corrupt */ }
      }
      for (const rec of rRecs) {
        if (rec.deleted) continue;
        try {
          const d = await decryptJson<RecoveryData>(oldKeys.encKey, rec.id, rec.encrypted_data);
          rec.encrypted_data = await encryptJson(newKeys.encKey, rec.id, d);
          await putRecoveryRec(rec);
          await outboxAdd({ entity: "recovery", record: rec, ts: Date.now() });
        } catch { /* skip corrupt */ }
      }
      zeroize(oldKeys.authKey);
      zeroize(oldKeys.encKey);
      keys = newKeys;
      const verifier = await encryptJson(newKeys.encKey, "vault-verifier", VERIFIER_PLAINTEXT);
      await saveProfile({
        mode: "server", email: userEmail, kdfParams: newKdf, verifier,
        serverUrl, refreshToken, serverVersion: 0, autoLockMins: profile.autoLockMins,
      });
      set({ mode: "server", email: userEmail, serverVersion: 0 });
      await reloadVault();
      await get().syncNow();
      toast("success", getT()(register ? "t.connectReg" : "t.connectLogin"));
    },

    disconnectServer: async () => {
      const profile = await loadProfile();
      if (profile?.refreshToken) {
        try { await api.logout(profile.refreshToken); } catch { /* offline ok */ }
      }
      if (profile) {
        await saveProfile({ ...profile, mode: "local", refreshToken: undefined, serverVersion: 0 });
      }
      setAccessToken(null);
      set({ mode: "local", email: null, serverVersion: 0, syncNote: null });
      toast("info", getT()("t.disconnected"));
    },

    eraseAll: async () => {
      const profile = await loadProfile();
      if (profile?.refreshToken) {
        setBaseUrl(profile.serverUrl ?? "");
        try { await api.logout(profile.refreshToken); } catch { /* ignore */ }
      }
      if (keys) { zeroize(keys.authKey); zeroize(keys.encKey); }
      keys = null;
      setAccessToken(null);
      await eraseVault();
      set({ status: "setup", mode: null, email: null, tokens: [], recoveries: [], outboxCount: 0, serverVersion: 0, activeTab: "vault" });
    },

    /** spec §4.5 — 4-step credential change:
     *  1. begin (server locks sync for this user, 10 min TTL)
     *  2. re-encrypt every record under freshly derived keys
     *  3. push the batch (holding the lock via x-change-lock)
     *  4. commit = atomic KDF/auth-hash rotation + all sessions revoked
     *  In local mode it's a pure re-key (steps 2 + profile update). */
    changeMasterPassword: async (newPassword) => {
      const profile = await loadProfile();
      if (!profile || !keys) throw new Error("Vault is locked");
      const newKdf = newKdfParams();
      const fresh = await deriveKeys(newPassword, newKdf);

      let lockToken: string | null = null;
      if (profile.mode === "server") {
        const begin = await api.changePwBegin();
        lockToken = begin.lock_token;
      }

      const oldKeys = keys;
      await outboxClear(); // see connectServer: outbox invariant = current-key ciphertext only
      const [tRecs, rRecs] = await Promise.all([allTokenRecs(), allRecoveryRecs()]);
      for (const rec of tRecs) {
        if (rec.deleted) continue;
        try {
          const d = await decryptJson<TokenData>(oldKeys.encKey, rec.id, rec.encrypted_data);
          rec.encrypted_data = await encryptJson(fresh.encKey, rec.id, d);
          await putTokenRec(rec);
          await outboxAdd({ entity: "token", record: rec, ts: Date.now() });
        } catch { /* skip corrupt */ }
      }
      for (const rec of rRecs) {
        if (rec.deleted) continue;
        try {
          const d = await decryptJson<RecoveryData>(oldKeys.encKey, rec.id, rec.encrypted_data);
          rec.encrypted_data = await encryptJson(fresh.encKey, rec.id, d);
          await putRecoveryRec(rec);
          await outboxAdd({ entity: "recovery", record: rec, ts: Date.now() });
        } catch { /* skip corrupt */ }
      }

      if (profile.mode === "server" && lockToken) {
        changeLockHeader = lockToken;
        try {
          await get().syncNow(); // pull-merge + push the re-encrypted batch under the lock
        } finally {
          changeLockHeader = null;
        }
        const remaining = await outboxAll();
        if (remaining.length > 0) {
          // push did not complete — nothing committed, old params still live; retry is safe
          throw new Error(getT()("note.failed"));
        }
        const proof = await authProofHex(fresh.authKey);
        await api.changePwCommit({ lock_token: lockToken, new_kdf_params: newKdf, new_auth_key_hash: proof });
        // server revoked every session (incl. ours) — mint a fresh pair with the new proof
        const res = await api.login({ email: profile.email!, auth_proof: proof, device_name: deviceName() });
        setAccessToken(res.access_token);
        profile.refreshToken = res.refresh_token;
      }

      const verifier = await encryptJson(fresh.encKey, "vault-verifier", VERIFIER_PLAINTEXT);
      zeroize(oldKeys.authKey);
      zeroize(oldKeys.encKey);
      keys = fresh;
      await saveProfile({ ...profile, kdfParams: newKdf, verifier });
      await reloadVault();
      set({ syncNote: null });
    },

    /** spec §9 — DELETE /user: requires the live auth proof, wipes everything. */
    deleteAccount: async () => {
      const profile = await loadProfile();
      if (!profile || profile.mode !== "server" || !keys) throw new Error("No server account");
      await api.deleteUser(await authProofHex(keys.authKey));
      await get().eraseAll();
    },

    setAutoLock: async (mins) => {
      const profile = await loadProfile();
      if (profile) await saveProfile({ ...profile, autoLockMins: mins });
      set({ autoLockMins: mins });
    },

    // ---------- tokens ----------
    addToken: async (data) => {
      const now = Date.now();
      const t: VaultToken = { ...data, id: uuid(), version: 0, deleted: false, createdAt: now, updatedAt: now };
      await persistToken(t);
      set((s) => ({ tokens: [...s.tokens, t] }));
      get().queueAudit("token_create", { issuer: data.issuer });
      return t;
    },

    updateToken: async (id, patch) => {
      const cur = get().tokens.find((t) => t.id === id);
      if (!cur) return;
      const next: VaultToken = { ...cur, ...patch, updatedAt: Date.now() };
      await persistToken(next);
      set((s) => ({ tokens: s.tokens.map((x) => (x.id === id ? next : x)) }));
    },

    deleteToken: async (id) => {
      const s = get();
      const cur = s.tokens.find((t) => t.id === id);
      if (!cur) return;
      const now = Date.now();
      await persistToken({ ...cur, deleted: true, updatedAt: now });
      // spec §5.3: cascade tombstone to recovery records (offline-consistent)
      for (const r of s.recoveries.filter((r) => r.tokenId === id)) {
        await persistRecovery({ ...r, deleted: true, updatedAt: now });
      }
      set((st) => ({
        tokens: st.tokens.filter((t) => t.id !== id),
        recoveries: st.recoveries.filter((r) => r.tokenId !== id),
        selectedTokenId: st.selectedTokenId === id ? null : st.selectedTokenId,
      }));
      get().queueAudit("token_delete", { issuer: cur.issuer });
    },

    addTokensBulk: async (list, policy) => {
      const existing = new Map(get().tokens.map((t) => [tokenFingerprint(t), t]));
      let added = 0, skipped = 0, overwritten = 0;
      const fpMap = new Map<string, string>(); // fingerprint -> vault token id
      for (const t of get().tokens) fpMap.set(tokenFingerprint(t), t.id);
      for (const data of list) {
        const fp = tokenFingerprint(data);
        const hit = existing.get(fp);
        if (hit) {
          if (policy === "skip") {
            skipped++;
          } else {
            await get().updateToken(hit.id, { ...data, category: data.category ?? hit.category });
            fpMap.set(fp, hit.id);
            overwritten++;
          }
          continue;
        }
        if (fpMap.has(fp)) {
          skipped++;
          continue;
        }
        const t = await get().addToken(data);
        fpMap.set(fp, t.id);
        added++;
      }
      return { added, skipped, overwritten, fpMap };
    },

    bumpHotp: async (id) => {
      const cur = get().tokens.find((t) => t.id === id);
      if (!cur) return;
      await get().updateToken(id, { counter: (cur.counter ?? 0) + 1 });
    },

    markTokenUsed: async (id) => {
      const cur = get().tokens.find((t) => t.id === id);
      if (cur) await get().updateToken(id, { lastUsedAt: Date.now() });
    },

    // ---------- recovery ----------
    addRecovery: async (tokenId, data) => {
      const now = Date.now();
      const r: VaultRecovery = { ...data, id: uuid(), tokenId, version: 0, deleted: false, createdAt: now, updatedAt: now };
      await persistRecovery(r);
      set((s) => ({ recoveries: [...s.recoveries, r] }));
      get().queueAudit("recovery_create", {});
      return r;
    },

    updateRecovery: async (id, data) => {
      const cur = get().recoveries.find((r) => r.id === id);
      if (!cur) return;
      const next: VaultRecovery = { ...cur, ...data, updatedAt: Date.now() };
      await persistRecovery(next);
      set((s) => ({ recoveries: s.recoveries.map((x) => (x.id === id ? next : x)) }));
    },

    deleteRecovery: async (id) => {
      const cur = get().recoveries.find((r) => r.id === id);
      if (!cur) return;
      await persistRecovery({ ...cur, deleted: true, updatedAt: Date.now() });
      set((s) => ({ recoveries: s.recoveries.filter((r) => r.id !== id) }));
    },

    setCodeUsed: async (id, index, used) => {
      const cur = get().recoveries.find((r) => r.id === id);
      if (!cur) return;
      const codes = cur.codes.map((c, i) => (i === index ? { ...c, used, usedAt: used ? Date.now() : undefined } : c));
      await get().updateRecovery(id, { ...recoveryDataOf(cur), codes });
      if (used) get().queueAudit("recovery_use", {});
    },

    // ---------- sync (spec §8.1: pull → push, 409 backoff) ----------
    syncNow: async () => {
      const st = get();
      if (st.mode !== "server" || syncRunning || !keys) return;
      const profile = await loadProfile();
      if (!profile?.refreshToken) return;
      syncRunning = true;
      set({ syncing: true, syncNote: null });
      try {
        // flush audit queue (best-effort)
        try {
          const pending = await auditAll();
          if (pending.length) {
            await api.reportAudit(pending.map((e) => ({ action: e.action, ts: e.ts, details: e.details })));
            await auditRemoveSeqs(pending.map((e) => e.seq!));
          }
        } catch { /* leave queued */ }

        for (let round = 0; round < 3; round++) {
          // ---- pull ----
          const pulled = await api.pull(profile.serverVersion);
          const dirtyIds = new Set((await outboxAll()).map((o) => o.record.id));
          let changed = false;
          for (const r of pulled.tokens) {
            if (dirtyIds.has(r.id)) continue;
            const local = await getTokenRec(r.id);
            const inc = { updated_at: r.updated_at, deleted: !!r.deleted };
            if (local && !incomingWins({ updatedAt: local.updated_at, deleted: local.deleted }, inc)) continue;
            if (!local && r.deleted) continue; // unknown tombstone
            // HOTP counter max-merge (spec §8.2) — needs plaintext of both sides
            let incomingData: TokenData | null = null;
            try {
              incomingData = r.deleted ? null : await decryptJson<TokenData>(keys!.encKey, r.id, r.encrypted_data ?? "");
            } catch { /* keep incoming ciphertext as-is */ }
            let encrypted = r.encrypted_data ?? local?.encrypted_data ?? "";
            let requeue = false;
            if (!r.deleted && local && !local.deleted && incomingData) {
              try {
                const localData = await decryptJson<TokenData>(keys!.encKey, local.id, local.encrypted_data);
                const maxCounter = Math.max(localData.counter ?? -1, incomingData.counter ?? -1);
                if (maxCounter >= 0 && maxCounter !== (incomingData.counter ?? -1)) {
                  incomingData.counter = maxCounter;
                  encrypted = await encryptJson(keys!.encKey, r.id, incomingData);
                  requeue = true; // push max'd counter back
                }
              } catch { /* ignore */ }
            }
            const next: EncRecord = {
              id: r.id,
              encrypted_data: encrypted,
              version: r.version ?? local?.version ?? 0,
              deleted: !!r.deleted,
              created_at: r.created_at ?? local?.created_at ?? Date.now(),
              updated_at: r.updated_at,
            };
            await putTokenRec(next);
            if (requeue) await outboxAdd({ entity: "token", record: next, ts: Date.now() });
            changed = true;
          }
          for (const r of pulled.recoveries) {
            if (dirtyIds.has(r.id)) continue;
            const local = await getRecoveryRec(r.id);
            const inc = { updated_at: r.updated_at, deleted: !!r.deleted };
            if (local && !incomingWins({ updatedAt: local.updated_at, deleted: local.deleted }, inc)) continue;
            if (!local && r.deleted) continue;
            await putRecoveryRec({
              id: r.id,
              token_id: r.token_id ?? local?.token_id ?? "",
              encrypted_data: r.encrypted_data ?? local?.encrypted_data ?? "",
              version: r.version ?? local?.version ?? 0,
              deleted: !!r.deleted,
              created_at: r.created_at ?? local?.created_at ?? Date.now(),
              updated_at: r.updated_at,
            });
            changed = true;
          }
          profile.serverVersion = pulled.server_version;
          await saveProfile(profile);
          set({ serverVersion: pulled.server_version });
          if (changed) await reloadVault();

          // ---- push ----
          const ops = (await outboxAll()).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
          if (ops.length === 0) break;
          const tokens: WireRec[] = [];
          const recoveries: WireRec[] = [];
          for (const o of ops) {
            const rec: WireRec = {
              id: o.record.id,
              token_id: o.record.token_id,
              encrypted_data: o.record.deleted ? undefined : o.record.encrypted_data,
              deleted: o.record.deleted,
              created_at: o.record.created_at,
              updated_at: o.record.updated_at,
            };
            (o.entity === "token" ? tokens : recoveries).push(rec);
          }
          try {
            const res = await api.push(
              profile.serverVersion,
              tokens,
              recoveries,
              changeLockHeader ? { "x-change-lock": changeLockHeader } : undefined
            );
            for (const e of res.applied.tokens) {
              const local = await getTokenRec(e.id);
              if (local) await putTokenRec({ ...local, version: e.version });
            }
            for (const e of res.applied.recoveries) {
              const local = await getRecoveryRec(e.id);
              if (local) await putRecoveryRec({ ...local, version: e.version });
            }
            await outboxRemoveSeqs(ops.map((o) => o.seq!));
            profile.serverVersion = res.new_server_version;
            await saveProfile(profile);
            set({ serverVersion: res.new_server_version });
            await reloadVault();
            break;
          } catch (e) {
            if (e instanceof ApiError && e.status === 409 && round < 2) {
              await new Promise((r) => setTimeout(r, 800 * 2 ** round)); // exp backoff
              continue;
            }
            if (e instanceof ApiError && e.status === 423) {
              set({ syncNote: getT()("note.locked") });
              break;
            }
            throw e;
          }
        }
        set({ syncNote: null });
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) set({ syncNote: getT()("note.offline") });
        else if (e instanceof ApiError && e.status === 401) set({ syncNote: getT()("note.expiredRelock") });
        else set({ syncNote: getT()("note.failed") });
      } finally {
        syncRunning = false;
        const ops = await outboxAll();
        set({ syncing: false, outboxCount: ops.length });
      }
    },

    queueAudit: (action, details) => {
      void auditAdd({ action, ts: Date.now(), details }).catch(() => undefined);
      const st = get();
      if (st.mode === "server" && navigator.onLine) void st.syncNow();
    },
  };
});
