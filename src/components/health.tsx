"use client";

import { useMemo } from "react";
import { ShieldAlert, ShieldCheck, ShieldX, ArrowRight, HeartPulse, KeyRound, Timer, Flame } from "lucide-react";
import { useVault } from "@/lib/client/store";
import { base32Decode } from "@/lib/client/totp";
import { recoveryStats } from "@/lib/client/recovery";
import { cn } from "@/lib/client/utils";
import { useT, type TFunc, type Key } from "@/lib/client/i18n";
import { Btn, EmptyState } from "./ui";
import type { VaultToken } from "@/lib/client/types";

interface Issue {
  severity: "critical" | "warning" | "info";
  tokenId?: string;
  title: string;
  detail: string;
  action?: string;
}

const NINETY_DAYS = 90 * 24 * 3600 * 1000;

function nameOf(t: VaultToken) {
  return t.issuer || t.account || "?";
}

export function HealthView() {
  const tokens = useVault((s) => s.tokens);
  const recoveries = useVault((s) => s.recoveries);
  const set = useVault((s) => s.set);
  const t = useT();

  const { score, issues } = useMemo(() => {
    const issues: Issue[] = [];
    const byToken = new Map<string, typeof recoveries>();
    for (const r of recoveries) {
      if (r.deleted) continue;
      const list = byToken.get(r.tokenId) ?? [];
      list.push(r);
      byToken.set(r.tokenId, list);
    }
    const now = Date.now();
    for (const tk of tokens) {
      const recs = byToken.get(tk.id) ?? [];
      const totalRemaining = recs.reduce((acc, r) => acc + recoveryStats(r).remaining, 0);
      const totalCodes = recs.reduce((acc, r) => acc + r.codes.length, 0);
      const name = nameOf(tk);

      if (recs.length === 0) {
        issues.push(
          tk.critical
            ? { severity: "critical", tokenId: tk.id, title: t("h.i.critNoRec.t"), detail: t("h.i.critNoRec.d", { name }), action: t("h.act.addRec") }
            : { severity: "info", tokenId: tk.id, title: t("h.i.noRec.t"), detail: t("h.i.noRec.d", { name }), action: t("h.act.addRec") }
        );
      } else if (totalRemaining === 0) {
        issues.push({ severity: "warning", tokenId: tk.id, title: t("h.i.allUsed.t"), detail: t("h.i.allUsed.d", { name, n: totalCodes }), action: t("h.act.review") });
      } else if (totalRemaining < 3) {
        issues.push({ severity: "warning", tokenId: tk.id, title: t("h.i.lowRec.t"), detail: t("h.i.lowRec.d", { name, n: totalRemaining }), action: t("h.act.review") });
      }

      try {
        const entropyBits = base32Decode(tk.secret).length * 8;
        if (entropyBits < 160)
          issues.push({ severity: "warning", tokenId: tk.id, title: t("h.i.entropy.t"), detail: t("h.i.entropy.d", { name, bits: entropyBits }), action: t("h.act.review") });
      } catch {
        issues.push({ severity: "warning", tokenId: tk.id, title: t("h.i.badB32.t"), detail: t("h.i.badB32.d", { name }), action: t("h.act.review") });
      }

      if (tk.algorithm === "SHA1")
        issues.push({ severity: "info", tokenId: tk.id, title: t("h.i.sha1.t"), detail: t("h.i.sha1.d", { name }), action: t("h.act.review") });

      if (tk.lastUsedAt && now - tk.lastUsedAt > NINETY_DAYS)
        issues.push({ severity: "info", tokenId: tk.id, title: t("h.i.stale.t"), detail: t("h.i.stale.d", { name }), action: t("h.act.review") });
    }

    let score = 100;
    for (const i of issues) score -= i.severity === "critical" ? 40 : i.severity === "warning" ? 10 : 2;
    return { score: Math.max(0, score), issues: issues.sort((a, b) => rank(b.severity) - rank(a.severity)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens, recoveries, t]);

  const counts = {
    critical: issues.filter((i) => i.severity === "critical").length,
    warning: issues.filter((i) => i.severity === "warning").length,
    info: issues.filter((i) => i.severity === "info").length,
  };

  const tone = score >= 80 ? "var(--ok)" : score >= 50 ? "var(--warn)" : "var(--bad)";
  const openToken = (id?: string) => id && set({ selectedTokenId: id });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 sm:px-6">
      <div className="mb-8 flex flex-col items-center gap-5 rounded-3xl border border-[var(--line)] bg-[var(--panel)] p-8">
        <ScoreArc score={score} color={tone} label={t("h.score")} />
        <div className="flex items-center gap-6">
          <Stat icon={<ShieldX size={13} />} n={counts.critical} label={t("h.critical")} cls="text-bad" />
          <Stat icon={<ShieldAlert size={13} />} n={counts.warning} label={t("h.warnings")} cls="text-warn" />
          <Stat icon={<ShieldCheck size={13} />} n={counts.info} label={t("h.advisory")} cls="text-info" />
        </div>
        <p className="max-w-md text-center text-[11px] leading-relaxed text-[var(--tx-3)]">{t("h.scoringNote")}</p>
      </div>

      {tokens.length === 0 ? (
        <EmptyState icon={<HeartPulse size={24} />} title={t("h.emptyTitle")} hint={t("h.emptyHint")} />
      ) : issues.length === 0 ? (
        <EmptyState icon={<ShieldCheck size={24} />} title={t("h.excellentTitle")} hint={t("h.excellentHint")} />
      ) : (
        <ul className="space-y-2.5">
          {issues.map((i, idx) => (
            <li
              key={idx}
              className={cn(
                "flex items-center gap-3.5 rounded-2xl border p-4 transition-colors",
                i.severity === "critical" && "tone-bad",
                i.severity === "warning" && "tone-warn",
                i.severity === "info" && "border-[var(--line)] bg-[var(--panel)]"
              )}
            >
              <span className={cn("shrink-0", i.severity === "info" && "text-info")}>
                {i.severity === "critical" ? <Flame size={18} /> : i.severity === "warning" ? <ShieldAlert size={18} /> : <Timer size={18} />}
              </span>
              <div className={cn("min-w-0 flex-1", i.severity === "info" && "text-[var(--tx)]")}>
                <p className={cn("text-[13px] font-semibold", i.severity === "info" ? "text-[var(--tx)]" : "inherit")}>{i.title}</p>
                <p className={cn("mt-0.5 text-xs leading-relaxed", i.severity === "info" ? "text-[var(--tx-3)]" : "opacity-80")}>{i.detail}</p>
              </div>
              {i.action && (
                <Btn size="sm" variant="outline" onClick={() => openToken(i.tokenId)}>
                  {i.action} <ArrowRight size={12} />
                </Btn>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8 rounded-2xl border border-[var(--line)] bg-sunk-2 p-4">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.15em] text-[var(--tx-3)]">
          <KeyRound size={12} className="text-[var(--ac)]" /> {t("h.coverage")}
        </p>
        <CoverageBar tokens={tokens} t={t} />
      </div>
    </div>
  );
}

function rank(s: Issue["severity"]) {
  return s === "critical" ? 3 : s === "warning" ? 2 : 1;
}

function Stat({ icon, n, label, cls }: { icon: React.ReactNode; n: number; label: string; cls: string }) {
  return (
    <span className={cn("flex items-center gap-1.5 text-sm font-semibold", cls)}>
      {icon} {n} <span className="text-[10.5px] font-medium uppercase tracking-wider text-[var(--tx-3)]">{label}</span>
    </span>
  );
}

function ScoreArc({ score, color, label }: { score: number; color: string; label: string }) {
  const size = 132;
  const stroke = 9;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative grid place-items-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - score / 100)}
          style={{ transition: "stroke-dashoffset .8s cubic-bezier(.2,.8,.3,1), stroke .4s" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center">
          <p className="font-display text-4xl font-bold" style={{ color }}>{score}</p>
          <p className="text-[9.5px] font-semibold uppercase tracking-[.22em] text-[var(--tx-3)]">{label}</p>
        </div>
      </div>
    </div>
  );
}

function CoverageBar({ tokens, t }: { tokens: VaultToken[]; t: TFunc }) {
  const recoveries = useVault((s) => s.recoveries);
  const set = useVault((s) => s.set);
  const withRec = tokens.filter((tk) => recoveries.some((r) => r.tokenId === tk.id && !r.deleted));
  const pct = tokens.length === 0 ? 0 : Math.round((withRec.length / tokens.length) * 100);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-xs text-[var(--tx-2)]">{t("h.coverageLine", { a: withRec.length, b: tokens.length })}</p>
        <span className={cn("font-mono text-sm font-bold", pct === 100 ? "text-ok" : pct >= 50 ? "text-warn" : "text-bad")}>{pct}%</span>
      </div>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
        {tokens.map((tk) => {
          const has = recoveries.some((r) => r.tokenId === tk.id && !r.deleted);
          return (
            <button
              key={tk.id}
              title={`${tk.issuer || "Unnamed"} — ${has ? "✓" : "✕"}`}
              onClick={() => set({ selectedTokenId: tk.id })}
              className="h-full flex-1 transition-opacity hover:opacity-70"
              style={{ background: has ? "var(--ok)" : "color-mix(in srgb, var(--bad) 65%, transparent)" }}
            />
          );
        })}
        {tokens.length === 0 && <span className="h-full w-full bg-track" />}
      </div>
      <p className="mt-2 text-[10.5px] text-[var(--tx-3)]">{t("h.coverageHint")}</p>
    </div>
  );
}
