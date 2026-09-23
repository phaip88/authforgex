// Client cryptographic sync integration — needs a live server.
// Usage: BASE=http://localhost:3000 node scripts/tests/crypto-sync.mjs  (build via esbuild first)
import { api, setBaseUrl, setAccessToken } from "../../src/lib/client/api";
import { deriveKeys, encryptJson, decryptJson, authProofHex, newKdfParams } from "../../src/lib/client/crypto";
import { base32Decode, otpCode } from "../../src/lib/client/totp";
const BASE = process.env.BASE ?? "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x = "") => { c ? pass++ : fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? "  → " + x : ""}`); };

const EMAIL = `crypto-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@t.dev`, PW = "integration-master-pw";
const kdfFast = JSON.stringify({ ...JSON.parse(newKdfParams()), iterations: 100000 });
setBaseUrl(BASE);
const devA = await deriveKeys(PW, kdfFast);
const reg = await api.register({ email: EMAIL, kdf_params: kdfFast, auth_key_hash: await authProofHex(devA.authKey), device_name: "web" });
setAccessToken(reg.access_token);
ok("register", !!reg.access_token);
ok("new account starts at version 0", (await api.pull(0)).server_version === 0);

const v0 = (await api.pull(0)).server_version;
const TID = crypto.randomUUID(), RID = crypto.randomUUID();
const td = { issuer: "GitHub", account: "octocat@example.com", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30, type: "totp" as const };
const rd = { recoveryType: "backup_codes" as const, codes: [{ code: "a1b2-c3d4", used: false }, { code: "e5f6-g7h8", used: false }], addedAt: Date.now() };
const p1 = await api.push(v0,
  [{ id: TID, encrypted_data: await encryptJson(devA.encKey, TID, td), updated_at: Date.now() }],
  [{ id: RID, token_id: TID, encrypted_data: await encryptJson(devA.encKey, RID, rd), updated_at: Date.now() }]);
ok("push token + recovery", p1.applied.total === 2, `v${p1.new_server_version}`);
ok("no skipped writes", (p1 as unknown as { skipped: unknown[] }).skipped.length === 0);

const pre = await api.prelogin(EMAIL);
const devB = await deriveKeys(PW, pre.kdf_params);
ok("second device derives identical auth key", (await authProofHex(devB.authKey)) === (await authProofHex(devA.authKey)));
const login = await api.login({ email: EMAIL, auth_proof: await authProofHex(devB.authKey), device_name: "ext" });
setAccessToken(login.access_token);
const pulled = await api.pull(0);
ok("second device pulls records", pulled.tokens.length === 1 && pulled.recoveries.length === 1);
const dec = await decryptJson<typeof td>(devB.encKey, pulled.tokens[0].id, pulled.tokens[0].encrypted_data!);
ok("second device decrypts", dec.secret === td.secret);
const code = await otpCode({ secretBytes: base32Decode(dec.secret), algorithm: dec.algorithm, digits: dec.digits, period: dec.period, type: dec.type });
ok("computes valid TOTP", /^\d{6}$/.test(code), code);

const rec = await decryptJson<typeof rd>(devB.encKey, pulled.recoveries[0].id, pulled.recoveries[0].encrypted_data!);
const upd = { ...rec, codes: rec.codes.map((c: { code: string; used: boolean; usedAt?: number }, i: number) => (i === 0 ? { ...c, used: true, usedAt: Date.now() } : c)) };
const p2 = await api.push(pulled.server_version, [], [{ id: RID, token_id: TID, encrypted_data: await encryptJson(devB.encKey, RID, upd), updated_at: Date.now() }]);
ok("push recovery mark-used", p2.applied.total === 1, `v${p2.new_server_version}`);
const delta = await api.pull(pulled.server_version);
ok("delta contains only the changed record", delta.recoveries.length === 1 && delta.tokens.length === 0);
const back = await decryptJson<typeof upd>(devA.encKey, delta.recoveries[0].id, delta.recoveries[0].encrypted_data!);
ok("device A sees code marked used", back.codes[0].used === true);
const stranger = await deriveKeys("another-vault-password", kdfFast);
let rejected = false; try { await decryptJson(stranger.encKey, RID, pulled.recoveries[0].encrypted_data!); } catch { rejected = true; }
ok("foreign key cannot decrypt", rejected);
const p3 = await api.push(p2.new_server_version, [{ id: TID, deleted: true, updated_at: Date.now() }], []);
ok("token delete cascades recovery tombstone", p3.applied.recoveries.length === 1 && p3.applied.recoveries[0].deleted);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
