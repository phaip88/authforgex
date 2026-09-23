"use client";

import { useEffect, useMemo, useState } from "react";
import {
  X, Copy, Check, KeyRound, Trash2, Pencil, ShieldAlert, Plus, Eye, EyeOff,
  RotateCcw, ClipboardPaste, Sparkles, Save, CircleAlert,
} from "lucide-react";
import { useVault } from "@/lib/client/store";
import { otpCode, base32Decode } from "@/lib/client/totp";
import { groupCode, maskCode, parseRecoveryText, recoveryStats } from "@/lib/client/recovery";
import { cn, copyText, fmtDate } from "@/lib/client/utils";
import { fmtAgoT, useLocale, useT } from "@/lib/client/i18n";
import { Btn, Field, Input, Select, Tag, TextArea, Toggle } from "./ui";
import { IconTile } from "./vault-home";
import type { Algorithm, RecoveryType, VaultRecovery } from "@/lib/client/types";

function useCode(tokenId: string | null) {
  const token = useVault((s) => s.tokens.find((tk) => tk.id === tokenId));
  const now = useVault((s) => s.now);
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return setCode(null);
    let alive = true;
    try {
      const bytes = base32Decode(token.secret);
      const counter = token.type === "hotp" ? token.counter ?? 0 : Math.floor(now / 1000 / token.period);
      otpCode({ secretBytes: bytes, algorithm: token.algorithm, digits: token.digits, period: token.period, type: token.type, counter }).then(
        (c) => alive && setCode(c)
      );
    } catch {
      setCode(null);
    }
    return () => {
      alive = false;
    };
  }, [token, now]);
  return code;
}

// ---------------- recovery add form ----------------
function AddRecoveryForm({ tokenId, onDone }: { tokenId: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const addRecovery = useVault((s) => s.addRecovery);
  const toast = useVault((s) => s.toast);
  const t = useT();
  const parsed = useMemo(() => (text.trim() ? parseRecoveryText(text) : null), [text]);
  const finalCodes = useMemo(
    () => (parsed ? parsed.codes.filter((_, i) => !excluded.has(i)) : []),
    [parsed, excluded]
  );

  return (
    <div className="space-y-3 rounded-xl border border-[var(--line)] bg-sunk-2 p-3.5">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.14em] text-[var(--tx-3)]">
        <ClipboardPaste size={12} /> {t("r.pasteLabel")}
      </p>
      <TextArea
        rows={4}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setExcluded(new Set());
        }}
        placeholder={t("r.pastePh")}
      />
      {parsed && (
        <div className="space-y-2.5 rounded-lg border border-[var(--line)] bg-sunk-2 p-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--ac)]">
              <Sparkles size={11} /> {t("r.detected", { type: t(`rt.${parsed.recoveryType}` as const) })}
            </span>
            <Tag tone="accent">{t("r.items", { n: finalCodes.length })}</Tag>
          </div>
          {parsed.recoveryType === "backup_codes" || parsed.recoveryType === "custom" ? (
            <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
              {parsed.codes.map((c, i) => (
                <button
                  key={i}
                  onClick={() =>
                    setExcluded((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                  title={t("r.excludeHint")}
                  className={cn(
                    "rounded-md px-2 py-1 font-mono text-[11px] transition-all",
                    excluded.has(i) ? "bg-lift text-[var(--tx-3)] line-through" : "bg-[var(--ac)]/12 text-[var(--ac)] hover:bg-[var(--ac)]/20"
                  )}
                >
                  {groupCode(c)}
                </button>
              ))}
            </div>
          ) : (
            <p className="break-words rounded-md bg-lift p-2 font-mono text-[11px] leading-relaxed text-[var(--tx-2)]">{parsed.codes[0]}</p>
          )}
          {parsed.recoveryType === "recovery_phrase" && (
            <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-warn">
              <CircleAlert size={11} className="mt-0.5 shrink-0" /> {t("r.phraseWarn")}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Btn size="sm" variant="ghost" onClick={onDone}>{t("c.cancel")}</Btn>
            <Btn
              size="sm"
              disabled={finalCodes.length === 0}
              onClick={async () => {
                await addRecovery(tokenId, {
                  recoveryType: parsed.recoveryType,
                  codes: finalCodes.map((code) => ({ code, used: false })),
                  rawText: parsed.rawText,
                  addedAt: Date.now(),
                });
                toast("success", t("r.saved", { n: finalCodes.length }));
                onDone();
              }}
            >
              <Save size={13} /> {t("r.encryptSave")}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- recovery list ----------------
function RecoveryPanel({ tokenId }: { tokenId: string }) {
  const recs = useVault((s) => s.recoveries.filter((r) => r.tokenId === tokenId && !r.deleted));
  const setCodeUsed = useVault((s) => s.setCodeUsed);
  const deleteRecovery = useVault((s) => s.deleteRecovery);
  const queueAudit = useVault((s) => s.queueAudit);
  const toast = useVault((s) => s.toast);
  const t = useT();
  const locale = useLocale();
  const [adding, setAdding] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [confirmRm, setConfirmRm] = useState<string | null>(null);

  const rec: VaultRecovery | undefined = recs[0];
  const stats = rec ? recoveryStats(rec) : null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.16em] text-[var(--tx-3)]">
          <KeyRound size={12} className="text-[var(--ac)]" /> {t("r.title")}
        </h4>
        {stats && (
          <Tag tone={stats.remaining === 0 ? "bad" : stats.remaining < 3 ? "warn" : "ok"}>
            {t("r.remaining", { a: stats.remaining, b: stats.total })}
          </Tag>
        )}
      </div>

      {!rec && !adding && (
        <button
          onClick={() => setAdding(true)}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--line-hi)] py-4 text-xs font-medium text-[var(--tx-3)] transition-colors hover:border-[var(--ac)]/40 hover:text-[var(--ac)]"
        >
          <Plus size={13} /> {t("r.addCta")}
        </button>
      )}
      {adding && <AddRecoveryForm tokenId={tokenId} onDone={() => setAdding(false)} />}

      {rec && (
        <div className="space-y-2.5 rounded-xl border border-[var(--line)] bg-sunk-2 p-3.5">
          <div className="flex items-center justify-between gap-2 text-[10.5px] uppercase tracking-wider text-[var(--tx-3)]">
            <span>{t("r.typeLine", { type: t(`rt.${rec.recoveryType}` as `rt.${RecoveryType}`), date: fmtDate(rec.addedAt, locale) })}</span>
            <div className="flex items-center gap-1">
              <button onClick={() => setRevealed(!revealed)} className="rounded-md p-1 hover:bg-lift hover:text-[var(--tx)]" aria-label={revealed ? t("r.hide") : t("r.reveal")} title={revealed ? t("r.hide") : t("r.reveal")}>
                {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
              <button
                onClick={async () => {
                  const unused = rec.codes.filter((c) => !c.used).map((c) => c.code);
                  if (unused.length === 0) return toast("info", t("r.copyNone"));
                  await copyText(unused.join("\n"));
                  queueAudit("recovery_copy", {});
                  toast("success", t("r.copyAllToast", { n: unused.length }));
                }}
                className="rounded-md p-1 hover:bg-lift hover:text-[var(--tx)]"
                aria-label={t("r.copyAll")}
                title={t("r.copyAll")}
              >
                <Copy size={13} />
              </button>
              {confirmRm === rec.id ? (
                <button
                  onClick={async () => {
                    await deleteRecovery(rec.id);
                    setConfirmRm(null);
                    toast("info", t("r.deleted"));
                  }}
                  className="rounded-md tone-bad px-1.5 py-0.5 text-[10px] font-semibold border"
                >
                  {t("c.confirmDelete")}
                </button>
              ) : (
                <button onClick={() => setConfirmRm(rec.id)} className="rounded-md p-1 hover:tone-bad hover:bg-lift" aria-label={t("r.delete")} title={t("r.delete")}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          </div>

          <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
            {rec.codes.map((c, i) => (
              <li key={i} className={cn("group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors", c.used ? "opacity-45" : "hover:bg-lift")}>
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", c.used ? "bg-[var(--tx-3)]" : "bg-[var(--ok)]")} />
                <code className={cn("flex-1 font-mono text-[12.5px] tracking-wider", c.used && "line-through")}>
                  {revealed ? groupCode(c.code) : maskCode(groupCode(c.code))}
                </code>
                {c.used && <span className="text-[9.5px] uppercase tracking-wide text-[var(--tx-3)]">{t("r.usedAgo", { ago: c.usedAt ? fmtAgoT(c.usedAt, t) : "" })}</span>}
                <button
                  onClick={async () => {
                    await copyText(c.code);
                    queueAudit("recovery_copy", {});
                    toast("info", t("r.copyToast"));
                  }}
                  className="rounded p-0.5 text-[var(--tx-3)] opacity-0 transition-opacity hover:text-[var(--ac)] group-hover:opacity-100"
                  aria-label={t("home.copyCode")}
                >
                  <Copy size={12} />
                </button>
                <button
                  onClick={() => void setCodeUsed(rec.id, i, !c.used)}
                  title={c.used ? t("r.markUnused") : t("r.markUsed")}
                  className={cn(
                    "rounded p-0.5 transition-colors",
                    c.used ? "text-[var(--tx-3)] hover:text-ok" : "text-[var(--tx-3)] opacity-0 hover:text-warn group-hover:opacity-100"
                  )}
                  aria-label={c.used ? t("r.markUnused") : t("r.markUsed")}
                >
                  <RotateCcw size={12} />
                </button>
              </li>
            ))}
          </ul>
          {stats && stats.remaining > 0 && stats.remaining < 3 && (
            <p className="flex items-center gap-1.5 text-[10.5px] text-warn">
              <ShieldAlert size={11} /> {t("r.lowWarn")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------- edit form ----------------
function EditForm({ tokenId, onDone }: { tokenId: string; onDone: () => void }) {
  const token = useVault((s) => s.tokens.find((tk) => tk.id === tokenId));
  const updateToken = useVault((s) => s.updateToken);
  const toast = useVault((s) => s.toast);
  const t = useT();
  const [f, setF] = useState(() => ({
    issuer: token?.issuer ?? "",
    account: token?.account ?? "",
    category: token?.category ?? "",
    notes: token?.notes ?? "",
    algorithm: token?.algorithm ?? "SHA1",
    digits: token?.digits ?? 6,
    period: token?.period ?? 30,
    critical: !!token?.critical,
  }));
  if (!token) return null;
  const up = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  return (
    <form
      className="space-y-3 rounded-xl border border-[var(--line)] bg-sunk-2 p-3.5"
      onSubmit={async (e) => {
        e.preventDefault();
        await updateToken(tokenId, {
          issuer: f.issuer.trim(),
          account: f.account.trim(),
          category: f.category.trim() || undefined,
          notes: f.notes.trim() || undefined,
          algorithm: f.algorithm as Algorithm,
          digits: Number(f.digits),
          period: Number(f.period),
          critical: f.critical,
        });
        toast("success", t("d.edit.saved"));
        onDone();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("d.edit.issuer")}><Input value={f.issuer} onChange={(e) => up("issuer", e.target.value)} /></Field>
        <Field label={t("d.edit.account")}><Input value={f.account} onChange={(e) => up("account", e.target.value)} /></Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label={t("d.algorithm")}>
          <Select value={f.algorithm} onChange={(e) => up("algorithm", e.target.value)}>
            <option>SHA1</option><option>SHA256</option><option>SHA512</option>
          </Select>
        </Field>
        <Field label={t("d.edit.digits")}>
          <Select value={f.digits} onChange={(e) => up("digits", Number(e.target.value))}>
            {[6, 7, 8].map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
        </Field>
        <Field label={t("d.period")}>
          <Select value={f.period} onChange={(e) => up("period", Number(e.target.value))} disabled={token.type === "hotp"}>
            {[30, 60].map((p) => <option key={p} value={p}>{p}s</option>)}
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("d.edit.category")}><Input value={f.category} onChange={(e) => up("category", e.target.value)} placeholder={t("d.edit.categoryPh")} /></Field>
        <Field label={t("d.edit.notes")}><Input value={f.notes} onChange={(e) => up("notes", e.target.value)} placeholder={t("d.edit.notesPh")} /></Field>
      </div>
      <label className="flex items-center justify-between rounded-lg border border-[var(--line)] px-3 py-2.5">
        <span className="text-xs text-[var(--tx-2)]">{t("d.edit.critical")}</span>
        <Toggle checked={f.critical} onChange={(v) => up("critical", v)} />
      </label>
      <div className="flex justify-end gap-2">
        <Btn type="button" size="sm" variant="ghost" onClick={onDone}>{t("c.cancel")}</Btn>
        <Btn type="submit" size="sm"><Save size={13} /> {t("c.save")}</Btn>
      </div>
    </form>
  );
}

// ---------------- drawer ----------------
export function TokenDetail() {
  const selectedId = useVault((s) => s.selectedTokenId);
  const token = useVault((s) => s.tokens.find((tk) => tk.id === s.selectedTokenId));
  const set = useVault((s) => s.set);
  const deleteToken = useVault((s) => s.deleteToken);
  const markTokenUsed = useVault((s) => s.markTokenUsed);
  const toast = useVault((s) => s.toast);
  const t = useT();
  const locale = useLocale();
  const code = useCode(selectedId);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    setEditing(false);
    setConfirmDel(false);
  }, [selectedId]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") set({ selectedTokenId: null });
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [set]);

  if (!selectedId || !token) return null;
  const close = () => set({ selectedTokenId: null });

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-[fadeIn_.18s_ease]" onClick={close} />
      <aside className="absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto border-l border-[var(--line-hi)] bg-[var(--panel)] shadow-2xl shadow-black/60 animate-[drawerIn_.28s_cubic-bezier(.2,.8,.3,1)]">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--line)] bg-[var(--panel)]/95 px-5 py-4 backdrop-blur">
          <div className="flex items-center gap-3">
            <IconTile issuer={token.issuer} account={token.account} size={38} />
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold text-[var(--tx)]">{token.issuer || t("c.unnamed")}</h2>
              <p className="truncate text-xs text-[var(--tx-3)]">{token.account || "—"}</p>
            </div>
          </div>
          <button onClick={close} className="rounded-lg p-1.5 text-[var(--tx-3)] hover:bg-lift hover:text-[var(--tx)]" aria-label={t("c.close")}>
            <X size={18} />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          {/* current code */}
          <button
            className={cn(
              "group flex w-full items-center justify-between rounded-2xl border px-5 py-4 transition-all",
              copied ? "border-[var(--ac)]/50 bg-[var(--ac)]/[.07]" : "border-[var(--line)] bg-sunk hover:border-[var(--line-hi)]"
            )}
            onClick={async () => {
              if (!code) return;
              await copyText(code.replace(/\s/g, ""));
              setCopied(true);
              setTimeout(() => setCopied(false), 1300);
              void markTokenUsed(token.id);
            }}
          >
            <span className={cn("font-mono text-[34px] font-bold tracking-[.14em]", copied && "text-[var(--ac)]")}>
              {code ? (/^\d+$/.test(code) ? code.replace(/(\d{3})(?=\d)/g, "$1 ") : code) : "······"}
            </span>
            <span className={cn("rounded-lg p-2", copied ? "text-[var(--ac)]" : "text-[var(--tx-3)] group-hover:text-[var(--tx)]")}>
              {copied ? <Check size={18} /> : <Copy size={18} />}
            </span>
          </button>

          {/* meta */}
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              [t("d.type"), token.type.toUpperCase()],
              [t("d.algorithm"), token.algorithm],
              [token.type === "hotp" ? t("d.counter") : t("d.period"), token.type === "hotp" ? String(token.counter ?? 0) : `${token.period}s`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl border border-[var(--line)] bg-sunk-2 px-2 py-2.5">
                <p className="text-[9.5px] font-semibold uppercase tracking-[.16em] text-[var(--tx-3)]">{k}</p>
                <p className="mt-1 font-mono text-[13px] font-semibold text-[var(--tx)]">{v}</p>
              </div>
            ))}
          </div>

          {token.notes && <p className="rounded-xl border border-[var(--line)] bg-sunk-2 px-3.5 py-2.5 text-xs italic text-[var(--tx-2)]">“{token.notes}”</p>}

          <div className="flex gap-2">
            <Btn size="sm" variant="outline" className="flex-1" onClick={() => setEditing(!editing)}>
              <Pencil size={13} /> {editing ? t("d.closeEditor") : t("c.edit")}
            </Btn>
            {confirmDel ? (
              <Btn
                size="sm"
                variant="danger"
                className="flex-1"
                onClick={async () => {
                  await deleteToken(token.id);
                  toast("info", t("d.deletedToast", { name: token.issuer || "token" }));
                  close();
                }}
              >
                <Trash2 size={13} /> {t("c.confirmDelete")}
              </Btn>
            ) : (
              <Btn size="sm" variant="ghost" className="flex-1 text-bad hover:text-bad" onClick={() => setConfirmDel(true)}>
                <Trash2 size={13} /> {t("c.delete")}
              </Btn>
            )}
          </div>

          {editing && <EditForm tokenId={token.id} onDone={() => setEditing(false)} />}

          <RecoveryPanel tokenId={token.id} />

          <p className="pb-6 text-center text-[10px] leading-relaxed text-[var(--tx-3)]">
            {t("d.addedOn", { date: fmtDate(token.createdAt, locale), v: token.version })}
            <br />
            {t("d.clipNote")}
          </p>
        </div>
      </aside>
    </div>
  );
}
