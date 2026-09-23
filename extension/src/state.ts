// Extension vault state — pairing + Device-Key wrapping (spec §11.2 / R6).
//
// Threat model (honest, documented): the master password is NEVER persisted.
// A random 256-bit Device Key wraps the derived Auth/Encryption keys and lives
// in chrome.storage.local (per-extension isolated). Leaking storage.local is
// equivalent to leaking this device's tokens — it does NOT reveal the master
// password, other devices, or the server account.

import {
  b64ToBytes,
  bytesToB64,
  decryptJson,
  deriveKeys,
  encryptJson,
  randomBytes,
  authProofHex,
  zeroize,
  type KeyPair,
} from "../../src/lib/client/crypto";
import type { EncRecord } from "../../src/lib/client/types";

export interface ExtProfile {
  serverUrl: string;
  email: string;
  kdfParams: string;
  deviceKeyB64: string;
  wrappedEnc: string;
  wrappedAuth: string;
  refreshToken?: string;
  syncVersion: number;
  tokens: EncRecord[];
  recoveries: EncRecord[];
  autoLockMins: number;
  reauthOnLock: boolean;
}

const PROFILE_KEY = "af_ext_profile";

export async function loadProfile(): Promise<ExtProfile | null> {
  const bag = await chrome.storage.local.get(PROFILE_KEY);
  return (bag[PROFILE_KEY] as ExtProfile | undefined) ?? null;
}

export async function saveProfile(p: ExtProfile): Promise<void> {
  await chrome.storage.local.set({ [PROFILE_KEY]: p });
}

export async function clearProfile(): Promise<void> {
  await chrome.storage.local.remove(PROFILE_KEY);
}

// ---------- Device Key wrapping ----------

export interface WrappedKeys {
  wrappedEnc: string;
  wrappedAuth: string;
}

export function generateDeviceKey(): string {
  return bytesToB64(randomBytes(32));
}

export async function wrapKeys(deviceKeyB64: string, keys: KeyPair): Promise<WrappedKeys> {
  const dk = b64ToBytes(deviceKeyB64);
  const out = {
    wrappedEnc: await encryptJson(dk, "af-ext-enc", Array.from(keys.encKey)),
    wrappedAuth: await encryptJson(dk, "af-ext-auth", Array.from(keys.authKey)),
  };
  zeroize(dk);
  return out;
}

/** Unwrap into a fresh KeyPair. Caller must zeroize when done. */
export async function unwrapKeys(profile: ExtProfile): Promise<KeyPair> {
  const dk = b64ToBytes(profile.deviceKeyB64);
  const enc = new Uint8Array(await decryptJson<number[]>(dk, "af-ext-enc", profile.wrappedEnc));
  const auth = new Uint8Array(await decryptJson<number[]>(dk, "af-ext-auth", profile.wrappedAuth));
  zeroize(dk);
  return { encKey: enc, authKey: auth };
}

/**
 * First-time pairing (spec §11.2 step 1–5).
 * Derives keys from the master password, then immediately discards it.
 * `onKeys` lets the caller complete login/pull while the password-derived keys
 * are still in scope; the wrapped form is persisted, the raw password is not.
 */
export async function pair(
  serverUrl: string,
  email: string,
  password: string,
  kdfParams: string,
  onKeys: (keys: KeyPair) => Promise<KeyPair>
): Promise<{ profile: ExtProfile; keys: KeyPair }> {
  const keys = await deriveKeys(password, kdfParams);
  const returned = await onKeys(keys); // login / register happens here
  const deviceKeyB64 = generateDeviceKey();
  const wrapped = await wrapKeys(deviceKeyB64, returned);
  const profile: ExtProfile = {
    serverUrl,
    email,
    kdfParams,
    deviceKeyB64,
    wrappedEnc: wrapped.wrappedEnc,
    wrappedAuth: wrapped.wrappedAuth,
    syncVersion: 0,
    tokens: [],
    recoveries: [],
    autoLockMins: 5,
    reauthOnLock: false,
  };
  return { profile, keys: returned };
}

export { authProofHex, zeroize };
