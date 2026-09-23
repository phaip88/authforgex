// AuthForge client crypto — WebCrypto only, zero custom primitives (spec §4).
// Master Password --PBKDF2-600K--> Master Key --HKDF--> Auth Key / Encryption Key.
// Wire format per record: JSON { v:1, iv(12B b64), ct(b64) }, AAD = record id.

export const KDF_ITERATIONS = 600_000;

const te = new TextEncoder();
const td = new TextDecoder();

export function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000)
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export async function sha256hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", toAB(data));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function toAB(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export async function deriveMasterKey(
  password: string,
  saltB64: string,
  iterations = KDF_ITERATIONS
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: toAB(b64ToBytes(saltB64)), iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function hkdf(masterKey: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", toAB(masterKey), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode(info) },
    key,
    256
  );
  return new Uint8Array(bits);
}

export interface KeyPair {
  authKey: Uint8Array;
  encKey: Uint8Array;
}

export async function deriveKeys(password: string, kdfParamsJson: string): Promise<KeyPair> {
  const p = JSON.parse(kdfParamsJson) as { iterations: number; salt: string };
  const master = await deriveMasterKey(password, p.salt, p.iterations);
  const [authKey, encKey] = await Promise.all([
    hkdf(master, "af-auth-v1"),
    hkdf(master, "af-enc-v1"),
  ]);
  zeroize(master);
  return { authKey, encKey };
}

/** spec §4.3: login sends only SHA256(Auth Key) — raw key never leaves the client. */
export function authProofHex(authKey: Uint8Array): Promise<string> {
  return sha256hex(authKey);
}

export function newKdfParams(): string {
  return JSON.stringify({
    algorithm: "PBKDF2-SHA256",
    iterations: KDF_ITERATIONS,
    salt: bytesToB64(randomBytes(32)),
  });
}

async function aesKey(encKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toAB(encKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptJson(encKey: Uint8Array, aadId: string, value: unknown): Promise<string> {
  const iv = randomBytes(12);
  const key = await aesKey(encKey);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toAB(iv), additionalData: toAB(te.encode(aadId)) },
    key,
    toAB(te.encode(JSON.stringify(value)))
  );
  return JSON.stringify({ v: 1, iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) });
}

export async function decryptJson<T>(encKey: Uint8Array, aadId: string, payload: string): Promise<T> {
  const env = JSON.parse(payload) as { v: number; iv: string; ct: string };
  if (env.v !== 1) throw new Error("unsupported record version");
  const key = await aesKey(encKey);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toAB(b64ToBytes(env.iv)), additionalData: toAB(te.encode(aadId)) },
    key,
    toAB(b64ToBytes(env.ct))
  );
  return JSON.parse(td.decode(pt)) as T;
}

export function zeroize(b: Uint8Array): void {
  b.fill(0);
}
