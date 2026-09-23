// IndexedDB — the single source of truth on the client (spec §11.1 / R9).
// Stores: tokens (ciphertext), recoveries (ciphertext), outbox (pending sync
// changes), kv (profile: kdf params, verifier, session, server version).

import type { EncRecord } from "./types";

const DB_NAME = "authforge";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("tokens")) db.createObjectStore("tokens", { keyPath: "id" });
      if (!db.objectStoreNames.contains("recoveries")) db.createObjectStore("recoveries", { keyPath: "id" });
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("auditq")) db.createObjectStore("auditq", { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null; // don't cache a rejected open — let the next call retry
      reject(req.error);
    };
  });
  return dbPromise;
}

/** Run a request inside a transaction and resolve with its result. */
function req<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const r = fn(t);
        let result: T;
        r.onsuccess = () => { result = r.result; };
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

/** Run mutations inside a transaction. */
function run(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => void): Promise<void> {
  return open().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        fn(t);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

// ---------- kv ----------
export const kvGet = <T>(key: string) => req(["kv"], "readonly", (t) => t.objectStore("kv").get(key) as IDBRequest<T | undefined>);
export const kvSet = (key: string, value: unknown) => run(["kv"], "readwrite", (t) => { t.objectStore("kv").put(value as IDBValidKey, key); });
export const kvDel = (key: string) => run(["kv"], "readwrite", (t) => { t.objectStore("kv").delete(key); });

// ---------- encrypted records ----------
export const putTokenRec = (r: EncRecord) => run(["tokens"], "readwrite", (t) => { t.objectStore("tokens").put(r); });
export const putRecoveryRec = (r: EncRecord) => run(["recoveries"], "readwrite", (t) => { t.objectStore("recoveries").put(r); });
export const getTokenRec = (id: string) => req(["tokens"], "readonly", (t) => t.objectStore("tokens").get(id) as IDBRequest<EncRecord | undefined>);
export const getRecoveryRec = (id: string) => req(["recoveries"], "readonly", (t) => t.objectStore("recoveries").get(id) as IDBRequest<EncRecord | undefined>);
export const allTokenRecs = () => req(["tokens"], "readonly", (t) => t.objectStore("tokens").getAll() as IDBRequest<EncRecord[]>);
export const allRecoveryRecs = () => req(["recoveries"], "readonly", (t) => t.objectStore("recoveries").getAll() as IDBRequest<EncRecord[]>);

// ---------- outbox ----------
export interface OutboxOp {
  seq?: number;
  entity: "token" | "recovery";
  record: EncRecord;
  ts: number;
}
export const outboxAdd = (op: Omit<OutboxOp, "seq">) =>
  run(["outbox"], "readwrite", (t) => { t.objectStore("outbox").add(op); });
export const outboxAll = () => req(["outbox"], "readonly", (t) => t.objectStore("outbox").getAll() as IDBRequest<OutboxOp[]>);
export const outboxRemoveSeqs = (seqs: number[]) =>
  run(["outbox"], "readwrite", (t) => { for (const s of seqs) t.objectStore("outbox").delete(s); });
export const outboxClear = () => run(["outbox"], "readwrite", (t) => { t.objectStore("outbox").clear(); });

// ---------- audit queue (best-effort, spec §12.6) ----------
export interface AuditEvent {
  seq?: number;
  action: string;
  ts: number;
  details?: Record<string, unknown>;
}
export const auditAdd = (e: Omit<AuditEvent, "seq">) =>
  run(["auditq"], "readwrite", (t) => { t.objectStore("auditq").add(e); });
export const auditAll = () => req(["auditq"], "readonly", (t) => t.objectStore("auditq").getAll() as IDBRequest<AuditEvent[]>);
export const auditRemoveSeqs = (seqs: number[]) =>
  run(["auditq"], "readwrite", (t) => { for (const s of seqs) t.objectStore("auditq").delete(s); });

// ---------- erase everything (danger zone) ----------
export async function eraseVault(): Promise<void> {
  await run(["tokens", "recoveries", "outbox", "kv", "auditq"], "readwrite", (t) => {
    for (const s of ["tokens", "recoveries", "outbox", "kv", "auditq"]) t.objectStore(s).clear();
  });
}
