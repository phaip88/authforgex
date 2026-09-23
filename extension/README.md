# AuthForge Browser Extension (Chrome MV3)

Zero-knowledge 2FA codes for the site you're on. The extension shares its
cryptography, OTP engine, service-icon data **and translations** with the web
app — there is exactly one implementation of each, bundled at build time.

## Build

```bash
node extension/build.mjs            # readable output (auditable)
node extension/build.mjs --minify   # smaller output
node extension/dist/selftest.mjs    # verify the SHIPPED bundle (RFC vectors)
```

Outputs a load-unpacked-ready folder at `extension/dist/` (manifest, bundles,
offscreen document, and PNG icons generated deterministically at build time —
no binary assets are committed).

## Install (development)

1. `node extension/build.mjs`
2. `chrome://extensions` → enable **Developer mode**
3. **Load unpacked** → select `extension/dist/`
4. Click the toolbar icon → enter your self-hosted server URL, email and master
   password → **Pair**

## Security design

### Key residency (spec §11.2 / R6)

```
pairing:  Master Password ──PBKDF2-600K──▶ Auth Key + Encryption Key
          random 256-bit Device Key (DK)
          storage.local ← { wrappedEnc = AES-GCM(EncKey, DK),
                            wrappedAuth = AES-GCM(AuthKey, DK),
                            DK, ciphertext tokens, sync_version }
          master password is DISCARDED — never persisted

popup:    SW wakes ── DK unwrap ──▶ keys in memory only
```

`chrome.storage.local` is per-extension isolated. Leaking it is equivalent to
losing this device's tokens — it does **not** reveal the master password, other
devices, or the server account. This is the documented, honest threat model.

### Guarantees

| Property | How |
|---|---|
| Master password never on disk | Used once during pairing, then dropped |
| Secrets never enter the popup DOM | The service worker decrypts and returns **only** the computed code + expiry |
| Keys wiped on idle | MV3 evicts idle service workers (~30 s) + explicit auto-lock alarm + manual **Lock** |
| Clipboard cleared after 30 s | `clipboardWrite` writes an empty string — no read permission needed. An offscreen document provides the fallback path when the woken service worker has no clipboard focus, so the clear is **guaranteed**, not best-effort |
| No `tabs` permission | The content script reports `location.hostname` on injection; the popup pings the tab for it. `tab.url` is never read |
| Controlled inputs filled correctly | Value set through `HTMLInputElement.prototype`'s native setter + bubbling `input`/`change` events, so React/Vue/Svelte state updates |
| Never auto-submits | Filling happens only on explicit action (popup button or `Ctrl+Shift+F`) |
| Site matching never drifts | `matchesHost()` lives in `src/lib/client/icons.ts` and is shared with the web app |

### Permissions

`storage`, `clipboardWrite`, `alarms`, `offscreen` — that's all. No `tabs`, no
`<all_urls>` **host** permissions, no remote code, no network calls except to
the server URL you configure.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+C` (`⌘⇧C`) | Copy the matching code for the current site |
| `Ctrl+Shift+F` (`⌘⇧F`) | Fill the code into the detected 2FA input |

## Features

- Site-aware list: matching tokens float to the top, badge shows the match count
- Live TOTP/HOTP/Steam codes with countdown
- Recovery codes per token: reveal, copy, mark used/unused (synced back to the
  server through the same `/api/v1/sync` protocol as the web app)
- Full-text search, dark/light theme, Chinese ⇄ English
- Auto-lock (1/5/15 min or never), optional "require re-pairing after lock"
  (deletes the wrapped keys so the master password is needed again)

## Files

```
extension/
├── manifest.json          MV3 manifest (no `tabs` permission)
├── build.mjs              esbuild bundling + deterministic PNG icon generation
├── popup.html / popup.css / offscreen.html / offscreen.js
└── src/
    ├── background.ts      service worker: keys, sync, OTP, clipboard, alarms
    ├── popup.ts           popup UI (no secrets, codes only)
    ├── content.ts         hostname report, 2FA input detection, native-setter fill
    ├── state.ts           pairing + Device-Key wrapping
    ├── selftest.ts        RFC vectors run against the compiled bundle
    └── chrome.d.ts        narrow MV3 typings (no @types/chrome dependency)
```

## Firefox

Not yet wired up. The code avoids Chrome-only APIs except
`chrome.offscreen` (Firefox uses `browser.offscreen` since 109) and
`chrome.action.setBadge*`. Adaptation is mostly a manifest + namespace swap, as
planned for Phase 3.
