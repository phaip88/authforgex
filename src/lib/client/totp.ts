// OTP engine (spec §4.2): HMAC-SHA1/256/512 via WebCrypto, RFC 6238 / RFC 4226
// semantics, plus Steam Guard's 5-char variant.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (clean.length < 2) throw new Error("Secret is too short");
  const out: number[] = [];
  let bits = 0;
  let val = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(data: Uint8Array): string {
  let out = "";
  let bits = 0;
  let val = 0;
  for (const byte of data) {
    val = (val << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

export function isValidBase32(s: string): boolean {
  try {
    return base32Decode(s).length >= 4;
  } catch {
    return false;
  }
}

const subtleAlg = (a: string) => (a === "SHA256" ? "SHA-256" : a === "SHA512" ? "SHA-512" : "SHA-1");

const STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY";

export async function hotpCode(
  keyBytes: Uint8Array,
  counter: number,
  digits: number,
  algorithm: string,
  steam = false
): Promise<string> {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
    { name: "HMAC", hash: subtleAlg(algorithm) },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const off = mac[mac.length - 1] & 0xf;
  let full =
    ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  if (steam) {
    let out = "";
    for (let i = 0; i < 5; i++) {
      out += STEAM_ALPHABET[full % STEAM_ALPHABET.length];
      full = Math.floor(full / STEAM_ALPHABET.length);
    }
    return out;
  }
  return (full % 10 ** digits).toString().padStart(digits, "0");
}

export interface OtpParams {
  secretBytes: Uint8Array;
  algorithm: string;
  digits: number;
  period: number;
  type: "totp" | "hotp" | "steam";
  counter?: number;
}

export function totpCounter(period: number, atMs = Date.now()): number {
  return Math.floor(atMs / 1000 / period);
}

export async function otpCode(p: OtpParams, atMs = Date.now()): Promise<string> {
  const counter = p.type === "hotp" ? (p.counter ?? 0) : totpCounter(p.period, atMs);
  return hotpCode(p.secretBytes, counter, p.digits, p.algorithm, p.type === "steam");
}

export function secondsRemaining(period: number, atMs = Date.now()): number {
  return period - (Math.floor(atMs / 1000) % period);
}

export function buildOtpAuthUri(t: {
  type: string;
  issuer: string;
  account: string;
  secret: string;
  algorithm: string;
  digits: number;
  period: number;
  counter?: number;
}): string {
  const label = t.issuer
    ? `${encodeURIComponent(t.issuer)}:${encodeURIComponent(t.account)}`
    : encodeURIComponent(t.account || t.issuer);
  const q = new URLSearchParams({
    secret: t.secret.replace(/\s/g, "").toUpperCase(),
    algorithm: t.algorithm,
    digits: String(t.digits),
  });
  if (t.issuer) q.set("issuer", t.issuer);
  if (t.type === "hotp") q.set("counter", String(t.counter ?? 0));
  else q.set("period", String(t.period));
  return `otpauth://${t.type === "steam" ? "totp" : t.type}/${label}?${q.toString()}`;
}

export function parseOtpAuthUri(uri: string): {
  type: "totp" | "hotp";
  issuer: string;
  account: string;
  secret: string;
  algorithm: "SHA1" | "SHA256" | "SHA512";
  digits: number;
  period: number;
  counter?: number;
} | null {
  try {
    const m = /^otpauth:\/\/(totp|hotp)\/([^?]+)\?(.+)$/i.exec(uri.trim());
    if (!m) return null;
    const type = m[1].toLowerCase() as "totp" | "hotp";
    const label = decodeURIComponent(m[2]);
    const params = new URLSearchParams(m[3]);
    const secret = (params.get("secret") ?? "").replace(/\s/g, "").toUpperCase();
    if (!secret || !/^[A-Z2-7]+=*$/.test(secret)) return null;
    let issuer = params.get("issuer") ?? "";
    let account = label;
    const ci = label.indexOf(":");
    if (ci >= 0) {
      if (!issuer) issuer = label.slice(0, ci);
      account = label.slice(ci + 1);
    }
    const alg = (params.get("algorithm") ?? "SHA1").toUpperCase();
    const digits = Number(params.get("digits") ?? 6) || 6;
    const period = Math.min(300, Math.max(5, Number(params.get("period") ?? 30) || 30));
    return {
      type,
      issuer,
      account,
      secret,
      algorithm: alg === "SHA256" || alg === "SHA512" ? alg : "SHA1",
      digits: [5, 6, 7, 8].includes(digits) ? digits : 6,
      period,
      counter: params.get("counter") ? Number(params.get("counter")) : undefined,
    };
  } catch {
    return null;
  }
}
