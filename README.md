<div align="center">

# 🔑 AuthForge

**Zero-knowledge, self-hostable 2FA vault with first-class recovery-code management**

端到端加密 · 零知识服务端 · 恢复码一等公民 · 中英双语 · 明暗双主题

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/phaip88/authforge)

</div>

---

## Overview

AuthForge is a production-grade, self-hosted two-factor authenticator. Every secret is encrypted in the browser with AES-256-GCM before it is persisted; the server only ever stores ciphertext, KDF parameters, `SHA256(auth_key)`, and audit metadata. An attacker who fully compromises the server database gains nothing but the right to run 600,000 PBKDF2 rounds per password guess.

Recovery codes are a first-class citizen: they live in their own encrypted records, sync independently, track used/unused state, and travel through import/export — because losing your recovery codes *is* losing your accounts.

Feature checklist against the engineering spec (v2.0): everything listed in `### Implemented` below is live and tested; larger platform items (browser extension, WebAuthn, native mobile) are tracked in [Roadmap](#roadmap).

---

## Implemented

| Area | Details |
|---|---|
| 🔐 **Zero-knowledge auth** | PBKDF2-SHA256 **600,000 rounds** (OWASP 2023) → HKDF-SHA256 → Auth Key + Encryption Key. Login transmits only `SHA256(auth_key)`; the raw key and plaintext master password never leave the device. |
| 🛡 **Record encryption** | AES-256-GCM per record, 96-bit random IV, `AAD = record id`, envelope `{ v:1, iv, ct }`. Tokens and recovery sets are sealed independently. |
| 🔢 **OTP engine** | TOTP / HOTP / Steam (5-char custom alphabet), SHA-1/256/512 via WebCrypto, **verified against RFC 4226 & RFC 6238 test vectors** (50/50 pass) |
| 🗝 **Recovery codes** | Smart paste parser (R1-fixed prefix stripping — digit-leading codes survive), strict mnemonic detection, masked display, per-code used/unused with timestamps, remaining-count badges, cascade-tombstone on token delete |
| 🔄 **Sync** | Incremental pull (`since_version`) + atomic push, **per-user monotonic sequence** (one tenant's writes never invalidate another's base version), row-lock serialization per user, tombstone-priority LWW, **HOTP counter max-merge**, 409 with exponential backoff, 423 during credential change, `skipped[]` reporting so a rejected write is never reported as success, outbox-based offline queue |
| 🔁 **Sessions** | JWT access (15 min) + rotating refresh (30 d); **replay of a revoked token revokes the whole session set**; prelogin returns deterministic fake KDF params (anti-enumeration); unified 401; login failure backoff (5 fails → 60 s ×2, cap 15 min) |
| 🔏 **Change master password** | Full **4-step transaction** (spec §4.5): `begin` (sync lock, 10 min TTL) → local re-encryption → push under `x-change-lock` → atomic KDF rotation + all sessions revoked |
| 🗑 **Account management** | `DELETE /user` gated by live auth proof; cascades users/tokens/recovery/sessions/audit |
| 📥 **Import** | otpauth URIs, CSV (header auto-match), Bitwarden CSV, Aegis & 2FAS JSON, AuthForge plain/encrypted `.afbackup`; duplicate fingerprint detection; recovery codes that can't be matched with certainty require **manual assignment** (never silently bound) |
| 📤 **Export** | `.afbackup` (independent backup password, PBKDF2 600K + AES-256-GCM), otpauth URI list, CSV (keeps recovery codes), plaintext JSON behind explicit red-flag acknowledgement, **printable emergency recovery card** with QR codes |
| 🩺 **Health check** | Score 100 −40/−10/−2; critical-service-without-recovery, low-entropy secrets (<160 bit), SHA-1 notice, recovery depletion, 90-day staleness; per-token coverage bar |
| 🖥 **Two vault modes** | **Local-only** (no account, IndexedDB ciphertext) ⇄ **self-hosted sync** — attach/detach at any time; attaching re-encrypts the vault under account keys |
| 🌐 **i18n & themes** | Full Chinese ⇄ English UI (type-checked key alignment), dark ⇄ light themes, system-preference detection, pre-paint boot script (no flash) |
| 🧩 **Browser extension** | Chrome MV3 in `extension/` — **Device-Key wrapping** (master password never persisted), codes computed in the service worker so **secrets never enter the popup DOM**, site matching without the `tabs` permission, native-setter fill for React/Vue inputs, **guaranteed 30 s clipboard clear** (offscreen fallback), `Ctrl+Shift+C` / `Ctrl+Shift+F`, recovery-code view + mark-used sync, dark/light + 中/EN. Reuses the web app's crypto/OTP/icon/i18n modules — one implementation, bundled |
| 📋 **Audit log** | Async best-effort client queue (never blocks UX), server retains last 50 viewable events |
| 🔒 **Other hardening** | Auto-lock with memory zero-fill, RFC 7807 `problem+json` errors, **database-backed rate limiting & login backoff** (survives restarts, shared by every replica), zero background timers in server code, pool error handling, CSP/nosniff/HSTS/frame-ancestors headers, in-app security-model transparency card |

---

## Architecture

```
┌──────────────────────────── Client (browser, PWA-grade) ───────────────────────────┐
│  Master Password ── PBKDF2-600K ──> Master Key ── HKDF ──> Auth Key / Enc Key      │
│                                                                                    │
│  WebCrypto              OTP engine             IndexedDB (source of truth)         │
│  PBKDF2/HKDF/           HMAC-SHA1/256/512      tokens / recoveries (ciphertext)    │
│  AES-256-GCM            RFC 6238 · Steam       outbox · audit queue · profile      │
│                                                                                    │
│  React 19 · Zustand · Tailwind v4 · i18n (中/EN) · dark/light                      │
└──────────────────────────────┬─────────────────────────────────────────────────────┘
                               │ TLS · Bearer JWT (15m) + rotating refresh (30d)
┌──────────────────────────────▼─────────────────────────────────────────────────────┐
│                    Zero-knowledge server (Next.js route handlers)                  │
│  /api/v1/auth/*   /api/v1/sync   /api/v1/tokens   /api/v1/recovery                │
│  /api/v1/audit    /api/v1/user (change-password 4-step · delete)                  │
│                                                                                    │
│  · per-user version sequence (row-locked) · tombstone LWW · cascade delete         │
│  · RFC 7807 problem+json · per-IP/per-email rate limits · login backoff            │
│  · durable rate limiting in Postgres (correct across replicas & restarts)          │
├────────────────────────────────────────────────────────────────────────────────────┤
│  PostgreSQL — users · tokens · recovery_codes · refresh_tokens · rate_limits ·      │
│               audit_log                                                            │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### Repository layout

```
src/
├── app/
│   ├── api/
│   │   ├── health/route.ts               # liveness + version
│   │   └── v1/
│   │       ├── auth/{prelogin,register,login,refresh,logout}/route.ts
│   │       ├── sync/route.ts             # GET pull · PUT push (atomic, 409/423)
│   │       ├── tokens/route.ts           # ciphertext CRUD
│   │       ├── recovery/route.ts         # ciphertext CRUD
│   │       ├── audit/route.ts            # event report + last-50 list
│   │       └── user/route.ts + change-password/{begin,route}.ts
│   ├── layout.tsx / page.tsx / globals.css
│   └── …components (screens-auth, vault-home, token-detail, dialogs, health, settings)
├── db/{schema.ts, index.ts}              # Drizzle ORM + pg pool
├── lib/
│   ├── server/{jwt.ts, http.ts, sync.ts} # JWT, problem+json/rate-limit, merge engine
│   └── client/
│       ├── crypto.ts                     # PBKDF2/HKDF/AES-GCM (WebCrypto only)
│       ├── totp.ts                       # base32/RFC6238/Steam + otpauth URI codec
│       ├── recovery.ts                   # recovery-code parser (R1-fixed)
│       ├── idb.ts                        # IndexedDB stores
│       ├── api.ts / store.ts / sync      # API client · Zustand vault store
│       ├── importer.ts / exporter.ts     # format detectors, .afbackup, recovery card
│       ├── icons.ts / i18n.ts / utils.ts
├── extension/                            # Chrome MV3 extension — build: node extension/build.mjs
│   ├── manifest.json                     # no `tabs` permission
│   ├── build.mjs                         # esbuild bundle + deterministic PNG icon generation
│   ├── src/{background,popup,content,state,selftest}.ts + chrome.d.ts
│   └── dist/                             # load-unpacked output (git-ignored)
├── scripts/migrate.mjs                   # idempotent DDL bootstrap (no drizzle-kit at runtime)
└── deploy/{Dockerfile, docker-compose.yml}
```

---

## Security model

### Key hierarchy (all client-side)

```
Master Password
   │  PBKDF2-SHA256 · 600,000 iters · 256-bit random salt (per account)
   ▼
Master Key ── HKDF-SHA256("af-auth-v1") ──> Auth Key     → only SHA256(Auth Key) is transmitted
           └─ HKDF-SHA256("af-enc-v1")  ──> Encryption Key → never leaves the device
```

- **Encrypted record**: `JSON { v:1, iv(b64, 12B), ct(b64) }` — `AES-256-GCM`, AAD = UTF-8 record id.
- **Vault verifier**: a known plaintext encrypted at setup; unlocking decrypts it to validate the master password offline.
- **Sessions**: access JWT `HS256` (sub, typ=access, 15 min) + refresh token (256-bit random, stored as SHA-256 hash, 30 d, **rotated on every use**; reuse ⇒ `replay_detected` + full revocation).
- **Local mode**: same encryption, `sync` = no-op; attaching a server later re-encrypts every record under the account keys.

### Threat model summary

| Threat | Defense |
|---|---|
| Server DB fully exfiltrated | Ciphertext + KDF params only; 600K PBKDF2/guess offline cost; audit logs may be forged — not sole evidence |
| TLS MITM | Public CA + HSTS + CSP; WebCrypto keys never transit |
| Refresh-token theft & replay | Rotation + replay detection ⇒ whole session set revoked |
| Account/email enumeration | `prelogin` deterministic fake KDF params + unified 401 + constant-shape comparison |
| Brute-force login | 5/min/email + 10/min/IP rate limit, then 60 s ×2 backoff (cap 15 min) |
| Stolen device (vault locked) | Master password never persisted; keys memory-only, zero-filled on lock; IndexedDB holds ciphertext |
| Malicious/tab JS | Strict CSP (`object-src 'none'`, `frame-ancestors 'none'`, self-origin scripts) |
| Concurrent credential change | 10-min sync lock (`423`) + single-transaction KDF rotation; expired locks auto-release |

Not defended (declared): OS-level keyloggers/screen capture, weak master passwords (strength meter + guidance provided), social engineering.

### Sync protocol

```
GET  /api/v1/sync?since_version=N        → { server_version, tokens[], recoveries[] }
PUT  /api/v1/sync { base_version, tokens[], recoveries[] }
     → 200 { new_server_version, applied }  | 409 (stale base) + x-server-version
                                             | 423 (sync_locked during credential change,
                                                    unless x-change-lock: <lock_token>)
Merge: tombstone wins → higher updated_at wins → HOTP counter = max(local, remote)
Every accepted change: server_version += 1, record.version := server_version (atomic).
```

---

## API reference

Base `/api/v1` · errors are RFC 7807 `application/problem+json` (`type/title/status/detail/code`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/prelogin` | – | `{email}` → KDF params (fake params for unknown emails) · 30/min/IP |
| POST | `/auth/register` | – | email + kdf_params + `auth_key_hash` (64-hex) → token pair · 5/h/IP |
| POST | `/auth/login` | – | email + `auth_proof` → pair + `kdf_params` · unified 401 · 10/min/IP, 5/min/email, backoff |
| POST | `/auth/refresh` | – | rotate pair; reused token ⇒ `replay_detected`, session set revoked · 60/min/IP |
| POST | `/auth/logout` | – | revoke presented refresh token → 204 |
| GET | `/sync?since_version=N` | ✓ | incremental changes · 300/min |
| PUT | `/sync` | ✓ | atomic push; `x-change-lock` bypass during credential change · 120/min |
| GET/POST/DELETE | `/tokens`, `/recovery` | ✓ | per-record ciphertext CRUD (soft delete, cascade) |
| GET/POST | `/audit` | ✓ | report queue / last 50 events |
| POST | `/user/change-password/begin` | ✓ | engage sync lock → `{lock_token}` (409 if already locked) |
| POST | `/user/change-password` | ✓ | commit rotation; revokes **all** sessions (client re-logs-in) |
| DELETE | `/user` | ✓+proof | delete account + all server data (auth-proof second factor) |

Rate-limit responses are `429` + `Retry-After`.

---

## Quick start

### Cloudflare Workers 部署 (一键直链 / 原生 D1 / 零外部数据库)

本项目已全面重构适配为 **Cloudflare 原生 D1 存储（分布式 SQLite 边缘数据库）**，完全摆脱对外部关系型数据库（如 PostgreSQL / Supabase / Neon）的依赖，实现零配置、零外部依赖、一键即开即用。

#### 1. 网页一键直达部署 (Deploy Button)
点击下方按钮或访问一键部署直链，授权 Cloudflare 即可自动创建 D1 数据库并构建发布：

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/phaip88/authforge)

> **直达链接**：[https://deploy.workers.cloudflare.com/?url=https://github.com/phaip88/authforge](https://deploy.workers.cloudflare.com/?url=https://github.com/phaip88/authforge)

#### 2. 命令行快速构建与发布 (CLI)
```bash
# 1. 安装依赖
npm install

# 2. 创建 Cloudflare 原生 D1 数据库（如尚未创建）
npx wrangler d1 create authforge-db

# 3. 初始化 D1 表结构（14 条 DDL 语句自动建表）
npx wrangler d1 execute authforge-db --remote --file=./scripts/schema-d1.sql

# 4. 配置 JWT 密钥（通过 Cloudflare 平台受管 Secrets 注入，严禁明文硬编码）
npx wrangler secret put AF_JWT_SECRET   # 输入 32 字节随机密钥，例如：openssl rand -hex 32

# 5. 一键编译并部署到 Cloudflare Workers
npm run build:worker
npx wrangler deploy
```

#### 必备配置项说明
| 配置项 | 类型 | 说明 |
|---|---|---|
| `DB` | D1 Binding | Cloudflare 原生 D1 数据库绑定（已在 `wrangler.jsonc` 预置绑定名 `DB`） |
| `AF_JWT_SECRET` | Secret | JWT 签名密钥（32 字节随机十六进制） |
| `DATABASE_URL` | *(已弃用)* | **无需配置**。已完全迁移至 Cloudflare 原生 D1 存储，零外部数据库依赖 |

### Development

```bash
npm ci
createdb authforge            # or point DATABASE_URL at any Postgres 14+
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/authforge
npx drizzle-kit push --force  # apply schema
npm run dev                   # http://localhost:3000
```

### Docker (production, one command)

```bash
export AF_JWT_SECRET=$(openssl rand -hex 32)
export AF_DB_PASSWORD=$(openssl rand -hex 16)
docker compose -f deploy/docker-compose.yml up -d --build
# app on :8080 — put a TLS reverse proxy in front for real deployments
```

The container boots `scripts/migrate.mjs` (idempotent DDL) then the Next standalone server. Image ≈ 200 MB (node:22-slim); app RSS ≈ 120–180 MB.

### Browser extension

```bash
node extension/build.mjs          # bundle + generate icons -> extension/dist
node extension/dist/selftest.mjs  # verify the shipped bundle against RFC vectors
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist`.
Details, threat model and permissions: [`extension/README.md`](extension/README.md).

### First-run flow

1. Open the app → choose **Local vault** (no account) or **Self-hosted** (create account on this server).
2. Set a master password → keys derive (PBKDF2 600K) → vault unlocked.
3. Add tokens (URI / manual / import) — codes render live with countdown rings.
4. Attach recovery codes per token (paste anything — the parser classifies it).
5. In server mode, sync runs automatically (30 s foreground polling + on-change push).

---

## Configuration

| Env var | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✓ | – | Postgres connection string |
| `AF_JWT_SECRET` | ✓ prod | dev value + loud warning | `openssl rand -hex 32` |
| `AF_DB_SSL` | – | `false` | `true` enables SSL in `migrate.mjs` |
| `PORT` | – | `3000` | container/listen port |
| `AF_DB_POOL_MAX` | – | `10` | per-replica pool size; keep `replicas × this` under Postgres `max_connections` |
| `AF_DB_IDLE_MS` | – | `30000` | idle client timeout |
| `AF_DB_CONNECT_TIMEOUT_MS` | – | `10000` | connection acquisition timeout |

**Production checklist** — set `AF_JWT_SECRET`; terminate TLS at a proxy (HSTS is already emitted); keep the DB private; back up Postgres (it holds only ciphertext, but it's your sync chain); rotate `AF_JWT_SECRET` via rolling restart (active access tokens expire ≤15 min); monitor `/api/health`.

---

## Engineering verification

| Suite | Result |
|---|---|
| `next typegen` / `tsc --noEmit` / `next build` | ✅ clean |
| RFC 4226 (10 HOTP vectors) + RFC 6238 SHA1/256/512 | ✅ 13/13 |
| Independent Buffer-based HMAC cross-check (SHA1/256/512 × digits 6/7/8 × counters) | ✅ 36/36 |
| Recovery prefix regression vectors incl. `12345678`, `12abc34`, `•code` (P0 data-loss class) | ✅ 9/9 |
| API smoke: register → login → pull/push → 409 stale-base → cascade tombstone → refresh rotation → replay 401 | ✅ |
| Change-password tx: 423 w/o lock · 409 double-begin · push under `x-change-lock` · commit · old refresh rejected · new proof login | ✅ |
| Account deletion: wrong proof 401 · correct 204 · subsequent login 401 | ✅ |
| i18n: zh dictionary is type-checked 1:1 against en keys | ✅ compile-time enforced |

---

## Spec conformance audit (v2.0)

Honest status against every section of the engineering spec. Nothing here is
claimed unless it is in the source tree.

| Spec § | Area | Status |
|---|---|---|
| 4.1–4.3 | PBKDF2-600K → HKDF → AES-256-GCM, zero-knowledge server | ✅ implemented, vector-tested |
| 4.4 | JWT 15 m + refresh 30 d rotation, replay revocation, login backoff, anti-enumeration | ✅ |
| 4.5 | Change master password — 4-step transaction (`begin` → re-encrypt → push under lock → commit) | ✅ |
| 4.6 | Duress codes | ❌ deferred |
| 5.1–5.2 | Data model, ciphertext records, tombstones, cascade delete | ✅ |
| 5.3 | Lifecycle: cascade ✅ · tombstone GC ❌ · 90-day audit retention ❌ |
| 6 | Recovery-code engine (R1 prefix fix, mnemonics, masked UI, used/unused, cascade) | ✅ |
| 7 | Import: otpauth, CSV, Bitwarden CSV, Aegis plain, 2FAS, AuthForge plain + **encrypted** `.afbackup` | ✅ |
| 7 | Import: Google Authenticator protobuf, Aegis **encrypted**, Authy, Ente, FreeOTP, AndOTP | ❌ deferred (needs real-file format spikes) |
| 7.2 | Export: `.afbackup`, otpauth list, CSV, gated plaintext, printable recovery card | ✅ |
| 7.4 | Recovery association: fingerprint match, ambiguity forces manual assignment | ✅ |
| 8.1 | Incremental pull/push, atomic `server_version`, 409 backoff, 423 lock, offline outbox | ✅ |
| 8.1 | WebSocket push | ❌ — 30 s foreground polling is the default path, as specified |
| 8.2 | Tombstone-priority LWW + HOTP counter `max` | ✅ |
| 9 | API surface, RFC 7807, rate limits, refresh / change-password / delete-account | ✅ |
| 9 | WebAuthn endpoints, `devices`, `backups` | ❌ deferred |
| 10.1 | Cloudflare Workers + D1/KV/R2 | ➖ re-targeted — see platform note |
| 10.2 | Docker / VPS production deployment | ✅ multi-stage, non-root, healthcheck, idempotent migration |
| 10.3 | `npx authforge` standalone | ❌ (Docker path covers self-hosting) |
| 11.1 | PWA: IndexedDB source of truth, outbox, **no API caching in the service worker** | ✅ |
| 11.1 | Local-only ⇄ server mode with upgrade re-encryption | ✅ |
| 11.1 | WebAuthn biometric unlock | ❌ deferred |
| 11.1 | App-shell precache | ❌ (vault data is offline via IndexedDB; the shell is not cached) |
| 11.2 | **Browser extension** | ✅ **implemented in `extension/`** — see `extension/README.md` |
| 11.3 | Mobile: installable responsive PWA ✅ · native Kotlin/Swift ❌ (Phase 4, conditional) | ✅ / ❌ |
| 12.1 | WebAuthn / FIDO2 login | ❌ deferred |
| 12.2 | Duress codes | ❌ deferred |
| 12.3 | Clipboard tiering: extension **guaranteed** (offscreen fallback) / web best-effort notice | ✅ |
| 12.4 | Health check (entropy, recovery depletion, SHA-1, staleness, critical flag) | ✅ |
| 12.5 | Emergency recovery: `.afbackup` ✅ · printable card ✅ · waiting period ❌ (spec moved it to v1.1) | ✅ |
| 12.6 | Audit log (best-effort queue, last-50 viewer) | ✅ |
| 13 | Local-first service icons, monogram fallback, no CDN | ✅ |
| 14 | Threat model documented | ✅ |
| 15 | Test strategy: RFC vectors, shipped-bundle self-test, API smoke | ✅ · CI pipeline ❌ |
| — | i18n (中/EN) + dark/light themes | ✅ beyond the original spec |

## Scaling & deployment topology

| Concern | Status |
|---|---|
| **Horizontal scaling** | ✅ Supported. Rate limits, login backoff and sync sequencing all live in Postgres; replicas share one source of truth. Set `AF_DB_POOL_MAX` so `replicas × pool ≤ max_connections`. |
| **Restart resilience** | ✅ Ban lists and counters survive process restarts (they are rows, not `Map`s). |
| **Sync contention** | ✅ The push transaction row-locks only the pushing user. Other tenants are never blocked and never see a spurious 409. |
| **Background jobs** | ✅ None. Server code has zero `setInterval`/`setTimeout`; expired rate-limit rows are swept opportunistically inside request handling. |
| **Stateless runtimes** | ✅ 原生支持 Cloudflare Workers。代码零背景定时器，数据库连接层已针对 workerd 与 Hyperdrive 深度优化。 |

### Cloudflare Workers (已全面原生适配)

本项目已完成对 **Cloudflare Workers (workerd)** 边缘运行时的完整生产级适配：
- **无状态按需数据库连接**：`src/db/index.ts` 采用惰性 Proxy 获取机制，无缝支持 Cloudflare Hyperdrive 边缘连接加速池及 Neon / Supabase 直连，彻底杜绝跨请求复用已冻结 TCP 套接字所导致的挂起；
- **OpenNext 构建链路**：基于 `@opennextjs/cloudflare` 构建，全面支持 Next.js 16 App Router、动态 API 路由与静态资产自动分离；
- **原生驱动兼容**：`src/lib/server/http.ts` 原生兼容 `postgres.js` 的原生数据返回格式，保证原子限流与登录失败退避逻辑稳定生效。

```bash
# 一键编译与本地仿真
npm run build:worker
npm run dev:worker
```

## Roadmap

- WebAuthn / passkey login + biometric unlock
- Duress codes (second key pair, decoy vault, silent webhook)
- Remaining importers (Google Authenticator protobuf, Aegis encrypted, Authy)
- Tombstone GC + audit retention as scheduled jobs
- Server-side encrypted backups (object storage / filesystem)
- WebSocket sync notification (polling stays the default)
- Firefox adaptation of the extension (manifest + namespace swap)
- CI wiring for the existing vector tests
- Native mobile via a Rust core + UniFFI (deliberately out of scope)

## License

AGPL-3.0 — self-hosting friendly; network use doesn't trigger distribution.

---

## 中文摘要

**AuthForge 是一个零知识、可自托管的 2FA 保险库。** 所有秘密在浏览器内使用 PBKDF2-SHA256（60 万轮）→ HKDF → AES-256-GCM 链加密后才落盘；服务器只存密文、KDF 参数与 SHA256 认证摘要，即使数据库被完整脱裤，攻击者每次猜密码仍需付出 60 万轮 PBKDF2 的离线成本。

**恢复码是一等公民**：独立加密记录、智能粘贴识别（已修复数字开头码被剥空的 P0 级缺陷）、遮罩显示、逐码已用/未用状态、随导入导出/同步全权流转。

**已实现**：TOTP/HOTP/Steam（RFC 4226/6238 全向量通过）、本地/服务器双模式（IDB 单一事实源 + outbox 离线队列）、增量同步（单事务版本推进、墓碑优先 LWW、HOTP 计数器 max 合并、409 退避、423 凭据锁）、JWT+refresh 轮换与重放吊销、防邮箱枚举、登录指数退避、**四步更换主密码事务**、账户删除、多格式导入导出（含加密 `.afbackup` 与可打印紧急恢复卡）、健康检查、审计日志、中英双语与明暗主题（首帧前应用，无闪烁）。

**部署**：
- **Cloudflare Workers（推荐）**：支持[网页一键部署直链](https://deploy.workers.cloudflare.com/?url=https://github.com/phaip88/authforge)或执行 `npm run build:worker && npx wrangler deploy` 发布至全球边缘节点，原生适配 Hyperdrive 数据库连接加速池与 Neon / Supabase；
- **本地开发**：`npm run dev` + `npx drizzle-kit push --force`；
- **生产 Docker 容器**：`docker compose -f deploy/docker-compose.yml up -d --build`（含幂等迁移与健康检查），需配置 `AF_JWT_SECRET` 密钥并在前方配置 TLS 反向代理。
