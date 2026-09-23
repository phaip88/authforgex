"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus, Search, Lock, RefreshCw, KeyRound, Download, Upload, ShieldCheck,
  Copy, Check, ChevronRight, WifiOff, CloudOff, Timer, Vault,
} from "lucide-react";
import { useVault } from "@/lib/client/store";
import { resolveIcon } from "@/lib/client/icons";
import { base32Decode, otpCode, secondsRemaining, totpCounter } from "@/lib/client/totp";
import { recoveryStats, maskCode } from "@/lib/client/recovery";
import { cn, copyText } from "@/lib/client/utils";
import { fmtAgoT, useT } from "@/lib/client/i18n";
import { Btn, EmptyState, Ring, Tag } from "./ui";
import type { VaultToken } from "@/lib/client/types";

function IconTile({ issuer, account, size = 44 }: { issuer: string; account?: string; size?: number }) {
  const icon = resolveIcon(issuer, account);
  return (
    <div
      className="grid shrink-0 place-items-center rounded-xl font-display font-bold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        color: icon.color,
        background: `color-mix(in srgb, ${icon.color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${icon.color} 26%, transparent)`,
      }}
    >
      {icon.initial}
    </div>
  );
}
export { IconTile };

function useOtpCode(token: VaultToken): { code: string | null; error: boolean } {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const bytesRef = useRef<Uint8Array | null>(null);
  const secret = token.secret;
  const now = useVault((s) => s.now);
  const counter = token.type === "hotp" ? token.counter ?? 0 : totpCounter(token.period, now);

  useEffect(() => {
    let alive = true;
    try {
      bytesRef.current = base32Decode(secret);
    } catch {
      setError(true);
      return;
    }
    setError(false);
    otpCode({
      secretBytes: bytesRef.current!,
      algorithm: token.algorithm,
      digits: token.digits,
      period: token.period,
      type: token.type,
      counter: token.type === "hotp" ? token.counter ?? 0 : counter,
    })
      .then((c) => alive && setCode(c))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret, token.algorithm, token.digits, token.period, token.type, token.counter, counter]);

  return { code, error };
}

function formatCode(code: string): string {
  if (/^\d+$/.test(code)) {
    const mid = Math.ceil(code.length / 2);
    return `${code.slice(0, mid)} ${code.slice(mid)}`;
  }
  return code;
}

function TokenCard({ token }: { token: VaultToken }) {
  const now = useVault((s) => s.now);
  const set = useVault((s) => s.set);
  const recoveries = useVault((s) => s.recoveries);
  const markTokenUsed = useVault((s) => s.markTokenUsed);
  const bumpHotp = useVault((s) => s.bumpHotp);
  const queueAudit = useVault((s) => s.queueAudit);
  const t = useT();
  const { code, error } = useOtpCode(token);
  const [copied, setCopied] = useState(false);

  const rec = useMemo(() => recoveries.find((r) => r.tokenId === token.id && !r.deleted), [recoveries, token.id]);
  const stats = rec ? recoveryStats(rec) : null;
  const remaining = token.type === "hotp" ? null : secondsRemaining(token.period, now);
  const danger = remaining !== null && remaining <= 5;
  const progress = remaining !== null ? remaining / token.period : 1;

  async function copy() {
    if (!code) return;
    await copyText(code.replace(/\s/g, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 1300);
    void markTokenUsed(token.id);
  }

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-[var(--panel)] p-4 transition-all duration-200",
        "hover:-translate-y-0.5 hover:border-[var(--line-hi)] hover:shadow-xl hover:shadow-black/20 cursor-pointer",
        copied ? "border-[var(--ac)]/50" : "border-[var(--line)]"
      )}
      onClick={() => set({ selectedTokenId: token.id })}
    >
      {copied && <div className="pointer-events-none absolute inset-0 rounded-2xl bg-[var(--ac)]/[.06] animate-[fadeIn_.15s_ease]" />}
      <div className="flex items-start gap-3">
        <IconTile issuer={token.issuer} account={token.account} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[13.5px] font-semibold tracking-wide text-[var(--tx)]">{token.issuer || t("c.unnamed")}</h3>
            {token.critical && <ShieldCheck size={12} className="shrink-0 text-warn" aria-label="Critical service" />}
          </div>
          <p className="truncate text-xs text-[var(--tx-3)]">{token.account || "—"}</p>
        </div>
        {token.type === "hotp" ? (
          <span className="grid place-items-center rounded-full border border-[var(--line)] p-1.5 text-[var(--tx-3)]" title={t("home.hotp")}>
            <Timer size={14} />
          </span>
        ) : (
          <Ring size={32} stroke={3} progress={progress} danger={danger} />
        )}
      </div>

      <div className="mt-3.5 flex items-end justify-between gap-2">
        <button
          className={cn(
            "font-mono text-[26px] font-bold leading-none tracking-[.14em] transition-colors",
            error ? "text-bad" : copied ? "text-[var(--ac)]" : danger ? "text-bad" : "text-[var(--tx)]",
            error && "text-sm tracking-normal"
          )}
          onClick={(e) => {
            e.stopPropagation();
            void copy();
          }}
          title={t("d.copyTitle")}
        >
          {error ? t("d.invalidSecret") : code ? formatCode(code) : "······"}
        </button>
        <button
          className={cn(
            "rounded-lg p-1.5 transition-colors",
            copied ? "text-[var(--ac)]" : "text-[var(--tx-3)] hover:bg-lift hover:text-[var(--tx)]"
          )}
          onClick={(e) => {
            e.stopPropagation();
            void copy();
          }}
          aria-label={t("home.copyCode")}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--line)] pt-2.5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1.5 min-w-0">
          {stats ? (
            <button
              onClick={() => set({ selectedTokenId: token.id })}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide transition-colors",
                stats.remaining === 0 ? "tone-bad" : stats.remaining < 3 ? "tone-warn" : "tone-ok"
              )}
              title={t("home.recTitle")}
            >
              <KeyRound size={10} /> {stats.remaining}/{stats.total}
            </button>
          ) : (
            <button
              onClick={() => set({ selectedTokenId: token.id })}
              className="inline-flex items-center gap-1 rounded-md bg-lift-2 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--tx-3)] transition-colors hover:text-[var(--tx-2)]"
              title={t("home.recNone")}
            >
              <KeyRound size={10} /> —
            </button>
          )}
          {token.category && <Tag>{token.category}</Tag>}
        </div>
        {token.type === "hotp" ? (
          <Btn
            size="sm"
            variant="outline"
            onClick={() => {
              void bumpHotp(token.id);
              queueAudit("token_update", { hotp: true });
            }}
          >
            {t("home.nextCode")}
          </Btn>
        ) : (
          <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--tx-3)]">
            {token.type === "steam" ? "steam" : `${token.digits}d·${token.period}s`}
          </span>
        )}
      </div>
    </article>
  );
}

export function SyncPill() {
  const mode = useVault((s) => s.mode);
  const syncing = useVault((s) => s.syncing);
  const outboxCount = useVault((s) => s.outboxCount);
  const syncNote = useVault((s) => s.syncNote);
  const serverVersion = useVault((s) => s.serverVersion);
  const syncNow = useVault((s) => s.syncNow);
  const t = useT();

  if (mode !== "server") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-lift px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--tx-3)]">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--ac)]" /> {t("home.localChip")}
      </span>
    );
  }
  const err = !!syncNote;
  return (
    <button
      onClick={() => void syncNow()}
      title={syncNote ?? t("sync.clickTo")}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider transition-colors",
        err ? "tone-warn" : "tone-ok"
      )}
    >
      {syncing ? (
        <RefreshCw size={10} className="animate-spin" />
      ) : err ? (
        <CloudOff size={10} />
      ) : outboxCount > 0 ? (
        <Upload size={10} />
      ) : (
        <Check size={10} />
      )}
      {syncing ? t("sync.syncing") : err ? t("sync.pending") : outboxCount > 0 ? t("sync.queued", { n: outboxCount }) : t("sync.synced", { v: serverVersion })}
    </button>
  );
}

export function VaultHome() {
  const tokens = useVault((s) => s.tokens);
  const search = useVault((s) => s.search);
  const set = useVault((s) => s.set);
  const lock = useVault((s) => s.lock);
  const email = useVault((s) => s.email);
  const mode = useVault((s) => s.mode);
  const syncNote = useVault((s) => s.syncNote);
  const t = useT();
  const [category, setCategory] = useState<string | null>(null);

  const categories = useMemo(() => [...new Set(tokens.map((tk) => tk.category).filter((c): c is string => !!c))].sort(), [tokens]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tokens
      .filter((tk) => !category || tk.category === category)
      .filter((tk) => !q || tk.issuer.toLowerCase().includes(q) || tk.account.toLowerCase().includes(q) || (tk.notes ?? "").toLowerCase().includes(q))
      .sort((a, b) => a.issuer.localeCompare(b.issuer) || a.account.localeCompare(b.account));
  }, [tokens, search, category]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-6">
      {/* toolbar */}
      <div className="sticky top-16 z-30 -mx-4 mb-6 border-b border-[var(--line)] bg-[var(--bg)]/85 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
        <div className="flex items-center gap-2.5">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--tx-3)]" />
            <input
              value={search}
              onChange={(e) => set({ search: e.target.value })}
              placeholder={t("home.searchPh")}
              className="h-9 w-full rounded-xl border border-[var(--line)] bg-sunk pr-3 text-[13px] text-[var(--tx)] placeholder:text-[var(--tx-3)] outline-none focus:border-[var(--ac)]/50"
              style={{ paddingLeft: 34 }}
            />
          </div>
          <Btn variant="outline" size="sm" className="h-9" onClick={() => set({ importOpen: true })}>
            <Upload size={13} /> <span className="hidden sm:inline">{t("home.import")}</span>
          </Btn>
          <Btn variant="outline" size="sm" className="h-9" onClick={() => set({ exportOpen: true })}>
            <Download size={13} /> <span className="hidden sm:inline">{t("home.export")}</span>
          </Btn>
          <Btn size="sm" className="h-9" onClick={() => set({ addOpen: true })}>
            <Plus size={14} /> <span className="hidden sm:inline">{t("home.addToken")}</span>
          </Btn>
        </div>
        {categories.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setCategory(null)}
              className={cn("rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors", !category ? "bg-[var(--ac)]/15 text-[var(--ac)]" : "text-[var(--tx-3)] hover:text-[var(--tx-2)]")}
            >
              {t("home.all")}
            </button>
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(category === c ? null : c)}
                className={cn("rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors", category === c ? "bg-[var(--ac)]/15 text-[var(--ac)]" : "text-[var(--tx-3)] hover:text-[var(--tx-2)]")}
              >
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      {syncNote && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border tone-warn px-3.5 py-2.5 text-xs">
          <WifiOff size={13} className="shrink-0" /> {syncNote}
        </div>
      )}

      {tokens.length === 0 ? (
        <EmptyState
          icon={<Vault size={24} />}
          title={t("home.emptyTitle")}
          hint={t("home.emptyHint")}
          action={
            <div className="mt-2 flex gap-2">
              <Btn onClick={() => set({ addOpen: true })}>
                <Plus size={15} /> {t("home.addToken")}
              </Btn>
              <Btn variant="outline" onClick={() => set({ importOpen: true })}>
                <Upload size={14} /> {t("home.import")}
              </Btn>
            </div>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<Search size={24} />} title={t("home.noMatches", { q: search })} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((tk, i) => (
            <div key={tk.id} className="animate-[riseIn_.4s_cubic-bezier(.2,.8,.3,1)_both]" style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
              <TokenCard token={tk} />
            </div>
          ))}
        </div>
      )}

      <div className="pointer-events-none fixed bottom-0 left-0 right-0 z-30 flex items-center justify-between gap-3 border-t border-[var(--line)] bg-[var(--bg)]/85 px-4 py-2 backdrop-blur sm:px-6">
        <p className="pointer-events-auto flex items-center gap-2 text-[10.5px] text-[var(--tx-3)]">
          <ShieldCheck size={11} className="text-[var(--ac)]" />
          <span className="hidden sm:inline">{t("home.footerSecure")}</span>
          {mode === "server" ? t("home.account", { email: email ?? "" }) : t("home.localMode")}
        </p>
        <div className="pointer-events-auto flex items-center gap-2">
          {filtered.length > 0 && <span className="text-[10.5px] font-mono text-[var(--tx-3)]">{t("home.tokensN", { n: filtered.length })}</span>}
          <SyncPill />
          <button
            onClick={lock}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-lift px-3 py-1.5 text-[11px] font-semibold text-[var(--tx-2)] transition-colors hover:border-[var(--bad)]/40 hover:text-bad"
          >
            <Lock size={11} /> {t("home.lock")}
          </button>
        </div>
      </div>
      <div className="h-8" />
    </div>
  );
}

export function LastUsedHint({ ts }: { ts?: number }) {
  const t = useT();
  if (!ts) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--tx-3)]">
      {t("home.lastUsed", { ago: fmtAgoT(ts, t) })} <ChevronRight size={9} />
    </span>
  );
}

export { maskCode };
