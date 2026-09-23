// AuthForge extension popup (spec §11.2).
//
// Security note: the popup never sees secrets. The service worker decrypts the
// token records and returns only the computed code + its expiry. The master
// password is used once during pairing and then discarded.

try {
  const t = localStorage.getItem("af-theme") || (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.dataset.theme = t;
  document.documentElement.style.colorScheme = t;
  const l = localStorage.getItem("af-lang") || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
  document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
} catch {}

import { resolveIcon } from "../../src/lib/client/icons";
import { getT, usePrefs } from "../../src/lib/client/i18n";
import { fmtAgoT, type Key } from "../../src/lib/client/i18n";
import type { CodeEntry } from "./background";

interface RecCode {
  code: string;
  used: boolean;
  usedAt: number | null;
}

interface StatusReply {
  state: "unpaired" | "ready" | "error";
  email?: string;
  serverUrl?: string;
  tokenCount?: number;
  lastSync?: number;
  note?: string | null;
  autoLockMins?: number;
  reauthOnLock?: boolean;
}

interface CodesReply {
  ok: boolean;
  entries?: CodeEntry[];
  lastSync?: number;
  note?: string | null;
  email?: string;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

async function send<T>(msg: unknown): Promise<T> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch {
    return { ok: false, error: "ext.offline" } as unknown as T;
  }
}

// ---------- i18n ----------
const t = () => getT();

function applyI18n(): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n as Key;
    el.textContent = t()(key);
  });
  document.querySelectorAll<HTMLInputElement>("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t()(el.dataset.i18nPh as Key);
  });
}

function toast(text: string): void {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  window.setTimeout(() => {
    el.hidden = true;
  }, 2200);
}

// ---------- theme / language ----------
function paintToggles(): void {
  const { theme, lang } = usePrefs.getState();
  $("btn-theme").textContent = theme === "dark" ? "☀" : "☾";
  $("btn-lang").textContent = lang === "zh" ? "中" : "EN";
}

// ---------- state ----------
let entries: CodeEntry[] = [];
let recEntries: CodeEntry[] = []; // filtered view
let currentHost: string | null = null;
let activeTabId: number | null = null;
let recTokenId: string | null = null;

async function resolveHost(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  if (activeTabId != null) {
    try {
      const r = (await chrome.tabs.sendMessage(activeTabId, { type: "af-ping-host" })) as
        | { host?: string }
        | undefined;
      if (r?.host) return r.host;
    } catch {
      /* chrome:// pages, Web Store, … have no content script */
    }
  }
  const r = (await send<{ host?: string }>({ type: "af-get-host", tabId: activeTabId })) ?? {};
  return r.host ?? null;
}

function noteText(note: string | null | undefined): { text: string; bad: boolean } {
  if (!note) return { text: "", bad: false };
  const key = (note.startsWith("ext.") ? note : `note.failed`) as Key;
  return { text: t()(key), bad: true };
}

function renderList(): void {
  const list = $("list");
  const q = ($("search") as HTMLInputElement).value.trim().toLowerCase();
  recEntries = entries.filter(
    (e) => !q || e.issuer.toLowerCase().includes(q) || e.account.toLowerCase().includes(q)
  );
  list.textContent = "";

  const now = Date.now();
  for (const e of recEntries) {
    const icon = resolveIcon(e.issuer, e.account);
    const li = document.createElement("li");
    li.className = `item${e.matched ? " matched" : ""}`;

    const tile = document.createElement("span");
    tile.className = "tile";
    tile.textContent = icon.initial;
    tile.style.color = icon.color;
    tile.style.background = `color-mix(in srgb, ${icon.color} 13%, transparent)`;
    tile.style.border = `1px solid color-mix(in srgb, ${icon.color} 26%, transparent)`;

    const who = document.createElement("span");
    who.className = "who";
    const issuer = document.createElement("span");
    issuer.className = "issuer";
    issuer.textContent = e.issuer || t()("c.unnamed");
    const account = document.createElement("span");
    account.className = "account";
    account.textContent = e.account || "—";
    who.append(issuer, account);

    const codeBtn = document.createElement("button");
    codeBtn.className = "code";
    codeBtn.textContent = e.code ? e.code : "······";
    codeBtn.title = t()("d.copyTitle");
    if (e.code) {
      codeBtn.addEventListener("click", async () => {
        const r = await send<{ ok: boolean }>({ type: "af-copy", code: e.code });
        if (r.ok) {
          codeBtn.classList.add("copied");
          window.setTimeout(() => codeBtn.classList.remove("copied"), 1200);
          toast(t()("ext.clipboard"));
        }
      });
    }

    const meta = document.createElement("span");
    meta.className = "meta";
    const ttl = document.createElement("span");
    ttl.className = "ttl";
    const remain = Math.max(0, Math.ceil((e.expiresAt - now) / 1000));
    if (e.type === "hotp") ttl.textContent = "HOTP";
    else {
      ttl.textContent = String(remain);
      if (remain <= 5) ttl.classList.add("urgent");
    }
    const badge = document.createElement("button");
    badge.className = "badge";
    if (e.hasRecovery) {
      badge.classList.add(e.remainingRecovery === 0 ? "warn" : e.remainingRecovery! < 3 ? "warn" : "ok");
      badge.textContent = `${e.remainingRecovery}`;
      badge.title = t()("ext.recovery");
      badge.addEventListener("click", () => void openRecovery(e.id));
    } else {
      badge.classList.add("none");
      badge.textContent = "—";
      badge.title = t()("ext.noRecovery");
    }
    meta.append(ttl, badge);

    li.append(tile, who, codeBtn, meta);
    list.append(li);
  }

  const empty = $("empty");
  if (recEntries.length === 0) {
    empty.hidden = false;
    empty.textContent = entries.length === 0 ? t()("ext.noMatch") : t()("home.noMatches", { q });
  } else {
    empty.hidden = true;
  }
}

function tick(): void {
  const now = Date.now();
  let expired = false;
  document.querySelectorAll<HTMLLIElement>("#list li").forEach((li, i) => {
    const e = recEntries[i];
    if (!e || e.type === "hotp") return;
    const ttl = li.querySelector<HTMLSpanElement>(".ttl");
    if (!ttl) return;
    const remain = Math.max(0, Math.ceil((e.expiresAt - now) / 1000));
    ttl.textContent = String(remain);
    ttl.classList.toggle("urgent", remain <= 5);
    if (remain === 0) expired = true;
  });
  if (expired) void loadCodes();
}

async function loadCodes(): Promise<void> {
  const r = await send<CodesReply>({ type: "af-codes" });
  if (!r.ok || !r.entries) {
    const note = noteText(r.note ?? (r as { error?: string }).error);
    $("empty").hidden = false;
    $("empty").textContent = note.text || t()("ext.locked");
    $("list").textContent = "";
    return;
  }
  entries = r.entries;
  const note = noteText(r.note);
  const sync = $("sync-note");
  sync.textContent = note.bad ? note.text : t()("ext.synced", { ago: r.lastSync ? fmtAgoT(r.lastSync, t()) : "—" });
  sync.classList.toggle("bad", note.bad);
  $("email").textContent = r.email ?? "";
  renderList();
}

// ---------- recovery ----------
async function openRecovery(tokenId: string): Promise<void> {
  recTokenId = tokenId;
  const r = await send<{ ok: boolean; codes?: RecCode[]; recoveryType?: string }>({
    type: "af-recovery",
    tokenId,
  });
  const list = $("rec-list");
  list.textContent = "";
  if (!r.ok || !r.codes || r.codes.length === 0) {
    const li = document.createElement("li");
    li.className = "rec-row";
    const span = document.createElement("code");
    span.textContent = t()("ext.noRecovery");
    li.append(span);
    list.append(li);
  } else {
    const unused = r.codes.filter((c) => !c.used).length;
    $("rec-badge").textContent = t()("ext.remaining", { n: unused });
    r.codes.forEach((c, i) => {
      const row = document.createElement("li");
      row.className = `rec-row${c.used ? " used" : ""}`;
      const dot = document.createElement("span");
      dot.className = "dot";
      const code = document.createElement("code");
      code.textContent = c.code;
      const copy = document.createElement("button");
      copy.className = "copy";
      copy.textContent = "⧉";
      copy.title = t()("home.copyCode");
      copy.addEventListener("click", async () => {
        const res = await send<{ ok: boolean }>({ type: "af-copy", code: c.code });
        if (res.ok) toast(t()("ext.clipboard"));
      });
      const toggle = document.createElement("button");
      toggle.className = "copy";
      toggle.textContent = c.used ? "↺" : "✓";
      toggle.title = c.used ? t()("r.markUnused") : t()("r.markUsed");
      toggle.addEventListener("click", async () => {
        await send({ type: "af-recovery-use", tokenId, index: i, used: !c.used });
        void openRecovery(tokenId);
      });
      row.append(dot, code, copy, toggle);
      list.append(row);
    });
  }
  $("overlay").hidden = false;
}

// ---------- boot ----------
async function boot(): Promise<void> {
  paintToggles();
  applyI18n();

  $("btn-theme").addEventListener("click", () => {
    usePrefs.getState().toggleTheme();
    paintToggles();
  });
  $("btn-lang").addEventListener("click", () => {
    const { lang, setLang } = usePrefs.getState();
    setLang(lang === "zh" ? "en" : "zh");
    paintToggles();
    applyI18n();
    renderList();
  });
  usePrefs.subscribe(() => {
    paintToggles();
  });

  $("rec-close").addEventListener("click", () => {
    $("overlay").hidden = true;
    recTokenId = null;
  });
  $("overlay").addEventListener("click", (ev) => {
    if (ev.target === $("overlay")) {
      $("overlay").hidden = true;
      recTokenId = null;
    }
  });

  const status = await send<StatusReply>({ type: "af-status" });

  if (!status || status.state === "unpaired" || !status.state) {
    $("view-pair").hidden = false;
    $("view-main").hidden = true;
    let mode: "login" | "register" = "login";
    document.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((b) => {
      b.addEventListener("click", () => {
        mode = (b.dataset.mode as "login" | "register") ?? "login";
        document.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      });
    });
    $("pair-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const btn = $("pair-btn") as HTMLButtonElement;
      const err = $("pair-err");
      err.hidden = true;
      btn.disabled = true;
      btn.textContent = t()("ext.working");
      try {
        const r = await send<{ ok: boolean; error?: string; message?: string }>({
          type: "af-pair",
          serverUrl: ($("pair-url") as HTMLInputElement).value.trim(),
          email: ($("pair-email") as HTMLInputElement).value.trim(),
          password: ($("pair-pw") as HTMLInputElement).value,
          register: mode === "register",
        });
        if (!r.ok) {
          let errText = "";
          if (r.error && r.error.startsWith("ext.")) {
            errText = t()(r.error as Key);
          } else if (r.message && !r.message.startsWith("[")) {
            errText = r.message;
          } else {
            errText = t()("ext.badCredentials");
          }
          if (r.message && errText !== r.message && !r.message.startsWith("[")) {
            errText += ` (${r.message})`;
          }
          err.textContent = errText;
          err.hidden = false;
          return;
        }
        ($("pair-pw") as HTMLInputElement).value = "";
        const freshStatus = await send<StatusReply>({ type: "af-status" });
        await enterMain(freshStatus || status);
      } finally {
        btn.disabled = false;
        btn.textContent = t()("ext.pairBtn");
      }
    });
    return;
  }
  await enterMain(status);
}

async function enterMain(status: StatusReply): Promise<void> {
  $("view-pair").hidden = true;
  $("view-main").hidden = false;
  $("email").textContent = status.email ?? "";

  currentHost = await resolveHost();
  $("host-name").textContent = currentHost ?? t()("ext.noHost");

  if (status.autoLockMins != null) ($("autolock") as HTMLSelectElement).value = String(status.autoLockMins);
  ($("reauth") as HTMLInputElement).checked = !!status.reauthOnLock;

  $("search").addEventListener("input", renderList);
  $("btn-refresh").addEventListener("click", async () => {
    await send({ type: "af-refresh" });
    await loadCodes();
  });
  $("btn-lock").addEventListener("click", async () => {
    const reauth = ($("reauth") as HTMLInputElement).checked;
    await send({ type: "af-lock", dropKeys: reauth });
    window.close();
  });
  $("btn-settings").addEventListener("click", () => {
    const s = $("settings");
    s.hidden = !s.hidden;
  });
  $("autolock").addEventListener("change", async (ev) => {
    await send({ type: "af-settings", autoLockMins: Number((ev.target as HTMLSelectElement).value) });
  });
  $("reauth").addEventListener("change", async (ev) => {
    await send({ type: "af-settings", reauthOnLock: (ev.target as HTMLInputElement).checked });
  });
  $("btn-unpair").addEventListener("click", async () => {
    await send({ type: "af-disconnect" });
    window.close();
  });

  await loadCodes();
  window.setInterval(tick, 500);
  // Re-check the host when the popup regains focus (tab switch while open).
  window.addEventListener("focus", async () => {
    const h = await resolveHost();
    if (h !== currentHost) {
      currentHost = h;
      $("host-name").textContent = h ?? t()("ext.noHost");
      await loadCodes();
    }
  });
}

void boot();
