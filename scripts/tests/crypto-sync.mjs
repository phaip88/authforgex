// src/lib/client/api.ts
var ApiError = class extends Error {
  constructor(status, code2, message, retryAfter, serverVersion) {
    super(message);
    this.status = status;
    this.code = code2;
    this.retryAfter = retryAfter;
    this.serverVersion = serverVersion;
  }
};
var accessToken = null;
var setAccessToken = (t) => {
  accessToken = t;
};
var tryRefresh = null;
var baseUrl = "";
var setBaseUrl = (u) => {
  baseUrl = u.replace(/\/$/, "");
};
async function request(path, opts = {}, retried = false) {
  const headers = { ...opts.headers };
  if (opts.body !== void 0) headers["content-type"] = "application/json";
  if (opts.auth !== false && accessToken) headers.authorization = `Bearer ${accessToken}`;
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: opts.method ?? (opts.body !== void 0 ? "POST" : "GET"),
      headers,
      body: opts.body !== void 0 ? JSON.stringify(opts.body) : void 0
    });
  } catch {
    throw new ApiError(0, "offline", "Network unavailable");
  }
  if (res.status === 401 && opts.auth !== false && !retried && tryRefresh) {
    const ok2 = await tryRefresh();
    if (ok2) return request(path, opts, true);
  }
  if (!res.ok) {
    let code2 = "unknown";
    let title = `Request failed (${res.status})`;
    try {
      const p = await res.json();
      if (p.code) code2 = p.code;
      if (p.title) title = p.title;
    } catch {
    }
    const ra = res.headers.get("retry-after");
    const sv = res.headers.get("x-server-version");
    throw new ApiError(res.status, code2, title, ra ? Number(ra) : void 0, sv ? Number(sv) : void 0);
  }
  if (res.status === 204) return void 0;
  return await res.json();
}
var api = {
  prelogin: (email) => request("/api/v1/auth/prelogin", { body: { email }, auth: false }),
  register: (payload) => request("/api/v1/auth/register", { body: payload, auth: false }),
  login: (payload) => request("/api/v1/auth/login", { body: payload, auth: false }),
  refresh: (refresh_token) => request(
    "/api/v1/auth/refresh",
    { body: { refresh_token }, auth: false }
  ),
  logout: (refresh_token) => request("/api/v1/auth/logout", { body: { refresh_token }, auth: false }),
  pull: (since) => request(
    `/api/v1/sync?since_version=${since}`
  ),
  push: (base_version, tokens, recoveries, headers) => request("/api/v1/sync", { method: "PUT", body: { base_version, tokens, recoveries }, headers }),
  changePwBegin: () => request("/api/v1/user/change-password/begin", { body: {} }),
  changePwCommit: (payload) => request("/api/v1/user/change-password", { body: payload }),
  deleteUser: (auth_proof) => request("/api/v1/user", { method: "DELETE", body: { auth_proof } }),
  reportAudit: (events) => request("/api/v1/audit", { body: { events } }),
  auditList: () => request("/api/v1/audit"),
  health: () => request("/api/health", { auth: false })
};

// src/lib/client/crypto.ts
var KDF_ITERATIONS = 6e5;
var te = new TextEncoder();
var td = new TextDecoder();
function bytesToB64(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 32768)
    s += String.fromCharCode(...b.subarray(i, i + 32768));
  return btoa(s);
}
function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
async function sha256hex(data) {
  const d = await crypto.subtle.digest("SHA-256", toAB(data));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function toAB(b) {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
async function deriveMasterKey(password, saltB64, iterations = KDF_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: toAB(b64ToBytes(saltB64)), iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}
async function hkdf(masterKey, info) {
  const key = await crypto.subtle.importKey("raw", toAB(masterKey), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode(info) },
    key,
    256
  );
  return new Uint8Array(bits);
}
async function deriveKeys(password, kdfParamsJson) {
  const p = JSON.parse(kdfParamsJson);
  const master = await deriveMasterKey(password, p.salt, p.iterations);
  const [authKey, encKey] = await Promise.all([
    hkdf(master, "af-auth-v1"),
    hkdf(master, "af-enc-v1")
  ]);
  zeroize(master);
  return { authKey, encKey };
}
function authProofHex(authKey) {
  return sha256hex(authKey);
}
function newKdfParams() {
  return JSON.stringify({
    algorithm: "PBKDF2-SHA256",
    iterations: KDF_ITERATIONS,
    salt: bytesToB64(randomBytes(32))
  });
}
async function aesKey(encKey) {
  return crypto.subtle.importKey("raw", toAB(encKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function encryptJson(encKey, aadId, value) {
  const iv = randomBytes(12);
  const key = await aesKey(encKey);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toAB(iv), additionalData: toAB(te.encode(aadId)) },
    key,
    toAB(te.encode(JSON.stringify(value)))
  );
  return JSON.stringify({ v: 1, iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) });
}
async function decryptJson(encKey, aadId, payload) {
  const env = JSON.parse(payload);
  if (env.v !== 1) throw new Error("unsupported record version");
  const key = await aesKey(encKey);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toAB(b64ToBytes(env.iv)), additionalData: toAB(te.encode(aadId)) },
    key,
    toAB(b64ToBytes(env.ct))
  );
  return JSON.parse(td.decode(pt));
}
function zeroize(b) {
  b.fill(0);
}

// src/lib/client/totp.ts
var B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(input) {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (clean.length < 2) throw new Error("Secret is too short");
  const out = [];
  let bits = 0;
  let val = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    val = val << 5 | idx;
    bits += 5;
    if (bits >= 8) {
      out.push(val >>> bits - 8 & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
var subtleAlg = (a) => a === "SHA256" ? "SHA-256" : a === "SHA512" ? "SHA-512" : "SHA-1";
var STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY";
async function hotpCode(keyBytes, counter, digits, algorithm, steam = false) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength),
    { name: "HMAC", hash: subtleAlg(algorithm) },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const off = mac[mac.length - 1] & 15;
  let full = (mac[off] & 127) << 24 | mac[off + 1] << 16 | mac[off + 2] << 8 | mac[off + 3];
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
function totpCounter(period, atMs = Date.now()) {
  return Math.floor(atMs / 1e3 / period);
}
async function otpCode(p, atMs = Date.now()) {
  const counter = p.type === "hotp" ? p.counter ?? 0 : totpCounter(p.period, atMs);
  return hotpCode(p.secretBytes, counter, p.digits, p.algorithm, p.type === "steam");
}

// scripts/tests/crypto-sync.ts
var BASE = process.env.BASE ?? "http://localhost:3000";
var pass = 0;
var fail = 0;
var ok = (n, c, x = "") => {
  c ? pass++ : fail++;
  console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? "  \u2192 " + x : ""}`);
};
var EMAIL = `crypto-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@t.dev`;
var PW = "integration-master-pw";
var kdfFast = JSON.stringify({ ...JSON.parse(newKdfParams()), iterations: 1e5 });
setBaseUrl(BASE);
var devA = await deriveKeys(PW, kdfFast);
var reg = await api.register({ email: EMAIL, kdf_params: kdfFast, auth_key_hash: await authProofHex(devA.authKey), device_name: "web" });
setAccessToken(reg.access_token);
ok("register", !!reg.access_token);
ok("new account starts at version 0", (await api.pull(0)).server_version === 0);
var v0 = (await api.pull(0)).server_version;
var TID = crypto.randomUUID();
var RID = crypto.randomUUID();
var td2 = { issuer: "GitHub", account: "octocat@example.com", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30, type: "totp" };
var rd = { recoveryType: "backup_codes", codes: [{ code: "a1b2-c3d4", used: false }, { code: "e5f6-g7h8", used: false }], addedAt: Date.now() };
var p1 = await api.push(
  v0,
  [{ id: TID, encrypted_data: await encryptJson(devA.encKey, TID, td2), updated_at: Date.now() }],
  [{ id: RID, token_id: TID, encrypted_data: await encryptJson(devA.encKey, RID, rd), updated_at: Date.now() }]
);
ok("push token + recovery", p1.applied.total === 2, `v${p1.new_server_version}`);
ok("no skipped writes", p1.skipped.length === 0);
var pre = await api.prelogin(EMAIL);
var devB = await deriveKeys(PW, pre.kdf_params);
ok("second device derives identical auth key", await authProofHex(devB.authKey) === await authProofHex(devA.authKey));
var login = await api.login({ email: EMAIL, auth_proof: await authProofHex(devB.authKey), device_name: "ext" });
setAccessToken(login.access_token);
var pulled = await api.pull(0);
ok("second device pulls records", pulled.tokens.length === 1 && pulled.recoveries.length === 1);
var dec = await decryptJson(devB.encKey, pulled.tokens[0].id, pulled.tokens[0].encrypted_data);
ok("second device decrypts", dec.secret === td2.secret);
var code = await otpCode({ secretBytes: base32Decode(dec.secret), algorithm: dec.algorithm, digits: dec.digits, period: dec.period, type: dec.type });
ok("computes valid TOTP", /^\d{6}$/.test(code), code);
var rec = await decryptJson(devB.encKey, pulled.recoveries[0].id, pulled.recoveries[0].encrypted_data);
var upd = { ...rec, codes: rec.codes.map((c, i) => i === 0 ? { ...c, used: true, usedAt: Date.now() } : c) };
var p2 = await api.push(pulled.server_version, [], [{ id: RID, token_id: TID, encrypted_data: await encryptJson(devB.encKey, RID, upd), updated_at: Date.now() }]);
ok("push recovery mark-used", p2.applied.total === 1, `v${p2.new_server_version}`);
var delta = await api.pull(pulled.server_version);
ok("delta contains only the changed record", delta.recoveries.length === 1 && delta.tokens.length === 0);
var back = await decryptJson(devA.encKey, delta.recoveries[0].id, delta.recoveries[0].encrypted_data);
ok("device A sees code marked used", back.codes[0].used === true);
var stranger = await deriveKeys("another-vault-password", kdfFast);
var rejected = false;
try {
  await decryptJson(stranger.encKey, RID, pulled.recoveries[0].encrypted_data);
} catch {
  rejected = true;
}
ok("foreign key cannot decrypt", rejected);
var p3 = await api.push(p2.new_server_version, [{ id: TID, deleted: true, updated_at: Date.now() }], []);
ok("token delete cascades recovery tombstone", p3.applied.recoveries.length === 1 && p3.applied.recoveries[0].deleted);
console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
