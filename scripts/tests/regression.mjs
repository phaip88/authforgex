// AuthForge end-to-end API regression — runs against a live server.
// Usage: BASE=http://localhost:3000 node scripts/tests/regression.mjs
import { createHash, randomBytes } from "node:crypto";
const BASE = process.env.BASE ?? "http://localhost:3000";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const kdf = () => JSON.stringify({ algorithm: "PBKDF2-SHA256", iterations: 600000, salt: randomBytes(32).toString("base64") });
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? "  → " + x : ""}`); };
const J = async (r) => ({ s: r.status, b: await r.json().catch(() => ({})) });
const ip = () => "10.44." + Math.floor(Math.random() * 250) + "." + Math.floor(Math.random() * 250);

async function mkUser(tag) {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@t.dev`;
  const r = await J(await fetch(`${BASE}/api/v1/auth/register`, { method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip() },
    body: JSON.stringify({ email, kdf_params: kdf(), auth_key_hash: sha(email) }) }));
  if (r.s !== 200) throw new Error(`register failed ${r.s} ${JSON.stringify(r.b)}`);
  return { email, tok: r.b.access_token, status: r.s };
}
const H = (t) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });
const pull = async (t) => (await J(await fetch(`${BASE}/api/v1/sync?since_version=0`, { headers: H(t) }))).b;
const push = async (t, base, tokens = [], recs = [], extra = {}) => J(await fetch(`${BASE}/api/v1/sync`,
  { method: "PUT", headers: { ...H(t), ...extra }, body: JSON.stringify({ base_version: base, tokens, recoveries: recs }) }));

console.log("──── per-user 同步序列 ────");
const A = await mkUser("ra"), B = await mkUser("rb");
ok("两个新账户各自从 0 起算", (await pull(A.tok)).server_version === 0 && (await pull(B.tok)).server_version === 0);
await push(A.tok, 0, [{ id: `t-${Date.now()}a`, encrypted_data: "x", updated_at: 1 }]);
const rB = await push(B.tok, 0, [{ id: `t-${Date.now()}b`, encrypted_data: "y", updated_at: 1 }]);
ok("租户A 的写入不影响租户B", rB.s === 200, `B got HTTP ${rB.s}`);
ok("A 自己的版本已推进", (await pull(A.tok)).server_version === 1);
const stale = await push(A.tok, 0, [{ id: `t-${Date.now()}c`, encrypted_data: "z", updated_at: 1 }]);
ok("A 用过期 base 推送被 409 拦截", stale.s === 409 && stale.b.code === "version_conflict");

console.log("──── 写入结果诚实化 ────");
const C = await mkUser("rc");
const shared = `dup-${Date.now()}`;
await push(A.tok, (await pull(A.tok)).server_version, [{ id: shared, encrypted_data: "owned-by-A", updated_at: 5 }]);
const steal = await J(await fetch(`${BASE}/api/v1/tokens`, { method: "POST", headers: H(C.tok),
  body: JSON.stringify({ id: shared, encrypted_data: "attempt", updated_at: 9 }) }));
ok("写入他人 id → 409 id_conflict", steal.s === 409 && steal.b.code === "id_conflict", `HTTP ${steal.s} ${steal.b.code}`);
const own = `own-${Date.now()}`;
await J(await fetch(`${BASE}/api/v1/tokens`, { method: "POST", headers: H(C.tok), body: JSON.stringify({ id: own, encrypted_data: "v2", updated_at: 100 }) }));
const older = await J(await fetch(`${BASE}/api/v1/tokens`, { method: "POST", headers: H(C.tok), body: JSON.stringify({ id: own, encrypted_data: "v1", updated_at: 50 }) }));
ok("旧版本覆盖 → 409 stale_write", older.s === 409 && older.b.code === "stale_write", `HTTP ${older.s}`);
await fetch(`${BASE}/api/v1/tokens?id=${own}`, { method: "DELETE", headers: H(C.tok) });
const resurrect = await J(await fetch(`${BASE}/api/v1/tokens`, { method: "POST", headers: H(C.tok), body: JSON.stringify({ id: own, encrypted_data: "back", updated_at: 999 }) }));
ok("写入墓碑 → 409 record_deleted", resurrect.s === 409 && resurrect.b.code === "record_deleted", `HTTP ${resurrect.s}`);
const delAgain = await fetch(`${BASE}/api/v1/tokens?id=${own}`, { method: "DELETE", headers: H(C.tok) });
ok("重复删除幂等 204", delAgain.status === 204, `HTTP ${delAgain.status}`);
const skipReport = await push(C.tok, (await pull(C.tok)).server_version, [{ id: shared, encrypted_data: "nope", updated_at: 7 }]);
ok("批量同步回报 skipped 明细", skipReport.s === 200 && skipReport.b.skipped?.[0]?.reason === "owned_by_other_user");

console.log("──── 换密锁竞态 ────");
const D = await mkUser("rd");
const both = await Promise.all([
  J(await fetch(`${BASE}/api/v1/user/change-password/begin`, { method: "POST", headers: H(D.tok), body: "{}" })),
  J(await fetch(`${BASE}/api/v1/user/change-password/begin`, { method: "POST", headers: H(D.tok), body: "{}" })),
]);
const won = both.filter((r) => r.s === 200), lost = both.filter((r) => r.s === 409);
ok("并发 begin 恰好一胜一负", won.length === 1 && lost.length === 1, both.map((r) => r.s).join("/"));
const lockTok = won[0].b.lock_token;
ok("持锁期间其他推送 423", (await push(D.tok, 0, [{ id: `x${Date.now()}`, encrypted_data: "q", updated_at: 1 }])).s === 423);
ok("锁持有者可继续推送", (await push(D.tok, 0, [{ id: `y${Date.now()}`, encrypted_data: "q", updated_at: 1 }], [], { "x-change-lock": lockTok })).s === 200);

console.log("──── 持久化限流 ────");
const probeIp = ip();
let codes = [];
for (let i = 0; i < 8; i++) {
  const r = await fetch(`${BASE}/api/v1/auth/login`, { method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": probeIp },
    body: JSON.stringify({ email: `nobody-${probeIp}@t.dev`, auth_proof: sha("bad") }) });
  codes.push(r.status);
}
ok("登录失败达阈值转 429", codes.includes(401) && codes.includes(429), codes.join(","));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
