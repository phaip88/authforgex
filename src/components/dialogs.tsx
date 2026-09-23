"use client";

import { useMemo, useState } from "react";
import {
  FileUp, Link2, PenLine, ShieldCheck, TriangleAlert, FileDown, Printer,
  KeyRound, Check, Dices, CircleAlert,
} from "lucide-react";
import { useVault } from "@/lib/client/store";
import { detectImport, decryptAfBackupImport, splitRecoveryMatches, type ImportPayload } from "@/lib/client/importer";
import { buildAfBackup, buildCsv, buildPlainJson, buildRecoveryCardHtml, buildUris, download } from "@/lib/client/exporter";
import { isValidBase32, parseOtpAuthUri, base32Encode } from "@/lib/client/totp";
import { randomBytes } from "@/lib/client/crypto";
import { cn } from "@/lib/client/utils";
import { useT } from "@/lib/client/i18n";
import { Btn, Field, Input, Modal, PasswordInput, SegTabs, Select, Tag, TextArea, Divider } from "./ui";
import { IconTile } from "./vault-home";
import type { Algorithm, TokenData, TokenType } from "@/lib/client/types";
import { tokenFingerprint, type VaultToken } from "@/lib/client/types";

// ==================== ADD TOKEN ====================
export function AddTokenDialog() {
  const open = useVault((s) => s.addOpen);
  const set = useVault((s) => s.set);
  const addToken = useVault((s) => s.addToken);
  const toast = useVault((s) => s.toast);
  const t = useT();
  const [tab, setTab] = useState<"uri" | "manual">("uri");
  const [uri, setUri] = useState("");
  const [f, setF] = useState({
    issuer: "", account: "", secret: "", category: "",
    type: "totp" as TokenType, algorithm: "SHA1" as Algorithm, digits: 6, period: 30, counter: 0,
  });
  const [busy, setBusy] = useState(false);

  const parsedUri = useMemo(() => (uri.trim() ? parseOtpAuthUri(uri) : null), [uri]);
  const secretOk = isValidBase32(f.secret);
  const up = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));

  const close = () => {
    set({ addOpen: false });
    setUri("");
    setF({ issuer: "", account: "", secret: "", category: "", type: "totp", algorithm: "SHA1", digits: 6, period: 30, counter: 0 });
  };

  async function submit() {
    setBusy(true);
    try {
      let data: TokenData;
      if (tab === "uri") {
        if (!parsedUri) return;
        data = { ...parsedUri, type: parsedUri.type };
      } else {
        data = {
          issuer: f.issuer.trim(),
          account: f.account.trim(),
          secret: f.secret.replace(/\s/g, "").toUpperCase(),
          algorithm: f.algorithm,
          digits: f.digits,
          period: f.period,
          type: f.type,
          counter: f.type === "hotp" ? f.counter : undefined,
          category: f.category.trim() || undefined,
        };
      }
      await addToken(data);
      toast("success", t("add.added", { name: data.issuer || "token" }));
      close();
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = tab === "uri" ? !!parsedUri : secretOk && (f.issuer.trim() || f.account.trim());

  return (
    <Modal open={open} onClose={close} title={t("add.title")} subtitle={t("add.subtitle")}>
      <SegTabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        options={[
          { value: "uri", label: <span className="inline-flex items-center gap-1.5"><Link2 size={13} /> {t("add.tabUri")}</span> },
          { value: "manual", label: <span className="inline-flex items-center gap-1.5"><PenLine size={13} /> {t("add.tabManual")}</span> },
        ]}
      />

      {tab === "uri" ? (
        <div className="space-y-4">
          <Field label={t("add.uriLabel")} hint={t("add.uriHint")}>
            <TextArea rows={3} value={uri} onChange={(e) => setUri(e.target.value)} placeholder={t("add.uriPh")} autoFocus />
          </Field>
          {uri.trim() && !parsedUri && (
            <p className="flex items-center gap-1.5 text-xs text-bad"><TriangleAlert size={13} /> {t("add.uriFail")}</p>
          )}
          {parsedUri && (
            <div className="flex items-center gap-3 rounded-xl border border-[var(--ac)]/25 bg-[var(--ac)]/[.06] p-3">
              <IconTile issuer={parsedUri.issuer} account={parsedUri.account} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-[var(--tx)]">{parsedUri.issuer || t("c.unnamed")}</p>
                <p className="truncate text-xs text-[var(--tx-3)]">{parsedUri.account}</p>
              </div>
              <Tag tone="accent">{parsedUri.type} · {parsedUri.algorithm} · {parsedUri.digits}d</Tag>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("d.edit.issuer")}><Input value={f.issuer} onChange={(e) => up("issuer", e.target.value)} placeholder="GitHub" autoFocus /></Field>
            <Field label={t("d.edit.account")}><Input value={f.account} onChange={(e) => up("account", e.target.value)} placeholder="you@example.com" /></Field>
          </div>
          <Field label={t("add.secretLabel")} hint={f.secret && !secretOk ? t("add.secretBad") : t("add.secretHint")}>
            <div className="relative">
              <Input
                value={f.secret}
                onChange={(e) => up("secret", e.target.value)}
                placeholder="JBSW Y3DP EHPK 3PXP"
                className={cn("pr-10 font-mono", f.secret && (secretOk ? "border-[var(--ok)]/50" : "border-[var(--bad)]/60"))}
              />
              <button
                type="button"
                title={t("add.genSecret")}
                onClick={() => up("secret", base32Encode(randomBytes(20)))}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--tx-3)] hover:text-[var(--ac)]"
              >
                <Dices size={15} />
              </button>
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label={t("add.type")}>
              <Select value={f.type} onChange={(e) => up("type", e.target.value)}>
                <option value="totp">TOTP</option>
                <option value="hotp">HOTP</option>
                <option value="steam">Steam</option>
              </Select>
            </Field>
            <Field label={t("d.algorithm")}>
              <Select value={f.algorithm} onChange={(e) => up("algorithm", e.target.value)}>
                <option>SHA1</option><option>SHA256</option><option>SHA512</option>
              </Select>
            </Field>
            <Field label={t("d.edit.digits")}>
              <Select value={f.digits} onChange={(e) => up("digits", Number(e.target.value))} disabled={f.type === "steam"}>
                {[6, 7, 8].map((d) => <option key={d}>{d}</option>)}
              </Select>
            </Field>
            {f.type === "hotp" ? (
              <Field label={t("add.counter")}><Input type="number" min={0} value={f.counter} onChange={(e) => up("counter", Number(e.target.value))} /></Field>
            ) : (
              <Field label={t("d.period")}>
                <Select value={f.period} onChange={(e) => up("period", Number(e.target.value))}>
                  <option value={30}>30s</option><option value={60}>60s</option>
                </Select>
              </Field>
            )}
          </div>
          <Field label={t("add.category")}><Input value={f.category} onChange={(e) => up("category", e.target.value)} placeholder={t("add.categoryPh")} /></Field>
        </div>
      )}

      <div className="mt-6 flex justify-end gap-2">
        <Btn variant="ghost" onClick={close}>{t("c.cancel")}</Btn>
        <Btn onClick={() => void submit()} disabled={!canSubmit} loading={busy}>
          <Check size={15} /> {t("add.confirm")}
        </Btn>
      </div>
    </Modal>
  );
}

// ==================== IMPORT ====================
interface UnmatchedRecovery {
  fingerprint: string;
  data: ImportPayload["recoveries"][number]["data"];
  assignedTo?: string;
  skip?: boolean;
}

export function ImportDialog() {
  const open = useVault((s) => s.importOpen);
  const set = useVault((s) => s.set);
  const tokens = useVault((s) => s.tokens);
  const addTokensBulk = useVault((s) => s.addTokensBulk);
  const addRecovery = useVault((s) => s.addRecovery);
  const queueAudit = useVault((s) => s.queueAudit);
  const toast = useVault((s) => s.toast);
  const t = useT();

  const [raw, setRaw] = useState("");
  const [payload, setPayload] = useState<ImportPayload | null>(null);
  const [needPw, setNeedPw] = useState(false);
  const [pw, setPw] = useState("");
  const [policy, setPolicy] = useState<"skip" | "overwrite">("skip");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [unmatched, setUnmatched] = useState<UnmatchedRecovery[]>([]);

  const reset = () => {
    setRaw(""); setPayload(null); setNeedPw(false); setPw(""); setErr(null); setUnmatched([]);
  };
  const close = () => { reset(); set({ importOpen: false }); };

  const existingFps = useMemo(() => new Set(tokens.map((tk) => tokenFingerprint(tk))), [tokens]);
  const dupCount = useMemo(
    () => (payload ? payload.tokens.filter((tk) => existingFps.has(tokenFingerprint(tk))).length : 0),
    [payload, existingFps]
  );

  async function analyze(text: string) {
    setErr(null);
    setRaw(text);
    setPayload(null);
    setNeedPw(false);
    const res = detectImport(text);
    if (res.kind === "encrypted") setNeedPw(true);
    else if (res.kind === "ready") setPayload(res.payload);
    else setErr(t("im.analyzeFail"));
  }

  async function decrypt() {
    setBusy(true);
    setErr(null);
    try {
      const p = await decryptAfBackupImport(raw, pw);
      setPayload(p);
      setNeedPw(false);
    } catch {
      setErr(t("im.wrongPw"));
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!payload) return;
    setBusy(true);
    try {
      const res = await addTokensBulk(payload.tokens, policy);
      // attach recoveries by fingerprint (spec §7.4 — never silently mis-assign)
      const candidates = [...res.fpMap.entries()].map(([fingerprint, tokenId]) => ({ fingerprint, tokenId }));
      const split = splitRecoveryMatches(payload.recoveries, candidates);
      let attached = 0;
      for (const m of split.matched) {
        await addRecovery(m.tokenId, m.data);
        attached++;
      }
      setUnmatched(split.unmatched.map((u) => ({ ...u })));
      queueAudit("import", { tokens: res.added, source: payload.sourceName });
      const extra =
        (res.overwritten ? t("im.doneOverwritten", { n: res.overwritten }) : "") +
        (res.skipped ? t("im.doneSkipped", { n: res.skipped }) : "") +
        (attached ? t("im.doneRecs", { n: attached }) : "");
      toast("success", t("im.done", { added: res.added, extra }));
      if (split.unmatched.length === 0) close();
      else setPayload(null);
    } finally {
      setBusy(false);
    }
  }

  async function resolveUnmatched() {
    let attached = 0;
    for (const u of unmatched) {
      if (u.assignedTo && !u.skip) {
        await addRecovery(u.assignedTo, u.data);
        attached++;
      }
    }
    if (attached) toast("success", t("im.attachedToast", { n: attached }));
    close();
  }

  return (
    <Modal open={open} onClose={close} title={t("im.title")} subtitle={t("im.subtitle")} wide>
      {/* step 1: choose data */}
      {!payload && !needPw && unmatched.length === 0 && (
        <div className="space-y-4">
          <label
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--line-hi)] py-8 text-center transition-colors hover:border-[var(--ac)]/40"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file) file.text().then(analyze);
            }}
          >
            <FileUp size={22} className="text-[var(--ac)]" />
            <p className="text-sm font-medium text-[var(--tx-2)]">{t("im.dropTitle")}</p>
            <p className="text-[11px] text-[var(--tx-3)]">{t("im.dropHint")}</p>
            <input
              type="file"
              className="hidden"
              accept=".json,.csv,.txt,.afbackup,application/json,text/plain"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) file.text().then(analyze);
                e.target.value = "";
              }}
            />
          </label>
          <Field label={t("im.pasteLabel")}>
            <TextArea rows={5} value={raw} onChange={(e) => void analyze(e.target.value)} placeholder={t("im.pastePh")} />
          </Field>
          {err && <p className="flex items-start gap-1.5 text-xs text-bad"><CircleAlert size={13} className="mt-0.5 shrink-0" /> {err}</p>}
        </div>
      )}

      {/* step 1b: decrypt backup */}
      {needPw && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl border border-[var(--ac)]/25 bg-[var(--ac)]/[.06] p-3.5">
            <ShieldCheck size={20} className="shrink-0 text-[var(--ac)]" />
            <p className="text-xs leading-relaxed text-[var(--tx-2)]">{t("im.encDetected")}</p>
          </div>
          <Field label={t("im.backupPw")}>
            <PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && void decrypt()} />
          </Field>
          {err && <p className="text-xs text-bad">{err}</p>}
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={reset}>{t("c.back")}</Btn>
            <Btn onClick={() => void decrypt()} loading={busy} disabled={!pw}>{t("im.decrypt")}</Btn>
          </div>
        </div>
      )}

      {/* step 2: review & import */}
      {payload && (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-xl border border-[var(--line)] bg-sunk-2 p-3.5">
            <div>
              <p className="text-sm font-semibold text-[var(--tx)]">{payload.sourceName}</p>
              <p className="mt-0.5 text-xs text-[var(--tx-3)]">
                {t("im.summary", { tokens: payload.tokens.length, recs: payload.recoveries.length })}
                {dupCount > 0 && <span className="text-warn">{t("im.summaryDup", { n: dupCount })}</span>}
              </p>
            </div>
            <Tag tone="accent">{t("im.ready")}</Tag>
          </div>

          <div className="max-h-44 space-y-1 overflow-y-auto rounded-xl border border-[var(--line)] p-2">
            {payload.tokens.slice(0, 50).map((tk, i) => (
              <div key={i} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                <IconTile issuer={tk.issuer} account={tk.account} size={26} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--tx-2)]">{tk.issuer || t("c.unnamed")} <span className="text-[var(--tx-3)]">· {tk.account || "—"}</span></span>
                {existingFps.has(tokenFingerprint(tk)) && <Tag tone="warn">dup</Tag>}
              </div>
            ))}
            {payload.tokens.length > 50 && <p className="px-2 py-1 text-[11px] text-[var(--tx-3)]">{t("im.more", { n: payload.tokens.length - 50 })}</p>}
          </div>

          {payload.warnings.length > 0 && (
            <div className="rounded-xl border tone-warn p-3 text-[11px] leading-relaxed">
              {payload.warnings.slice(0, 4).map((w, i) => <p key={i}>· {w}</p>)}
            </div>
          )}

          {dupCount > 0 && (
            <Field label={t("im.dupPolicy")}>
              <SegTabs value={policy} onChange={setPolicy} options={[
                { value: "skip", label: t("im.dup.skip") },
                { value: "overwrite", label: t("im.dup.overwrite") },
              ]} />
            </Field>
          )}

          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={reset}>{t("c.back")}</Btn>
            <Btn onClick={() => void runImport()} loading={busy}>{t("im.runBtn", { n: payload.tokens.length })}</Btn>
          </div>
        </div>
      )}

      {/* step 3: manual recovery assignment (spec §7.4) */}
      {unmatched.length > 0 && (
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-xl border tone-warn p-3.5 text-xs leading-relaxed">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            {t("im.unmatchedTitle", { n: unmatched.length })}
          </p>
          <div className="space-y-2.5">
            {unmatched.map((u, i) => (
              <div key={i} className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-sunk-2 p-3">
                <KeyRound size={15} className="shrink-0 text-[var(--ac)]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[11.5px] text-[var(--tx-2)]">{u.data.codes[0]?.code ?? "recovery"} · {t("im.codesN", { n: u.data.codes.length })}</p>
                  <p className="text-[10.5px] text-[var(--tx-3)]">{t("im.recLine", { who: u.fingerprint.split("|").slice(1).join(" / ") || t("im.unknownSvc") })}</p>
                </div>
                <Select
                  value={u.skip ? "__skip" : (u.assignedTo ?? "")}
                  onChange={(e) => {
                    const v = e.target.value;
                    setUnmatched((prev) => prev.map((x, j) => (j === i ? { ...x, assignedTo: v === "__skip" ? undefined : v || undefined, skip: v === "__skip" } : x)));
                  }}
                  className="h-9 max-w-44 text-xs"
                >
                  <option value="">{t("im.assignToken")}</option>
                  {tokens.map((tk: VaultToken) => (
                    <option key={tk.id} value={tk.id}>{tk.issuer || t("c.unnamed")} · {tk.account || "—"}</option>
                  ))}
                  <option value="__skip">{t("im.dontImport")}</option>
                </Select>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <Btn onClick={() => void resolveUnmatched()}>{t("c.finish")}</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ==================== EXPORT ====================
export function ExportDialog() {
  const open = useVault((s) => s.exportOpen);
  const set = useVault((s) => s.set);
  const tokens = useVault((s) => s.tokens);
  const recoveries = useVault((s) => s.recoveries);
  const queueAudit = useVault((s) => s.queueAudit);
  const toast = useVault((s) => s.toast);
  const t = useT();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [plainAck, setPlainAck] = useState(false);

  const close = () => { set({ exportOpen: false }); setPlainAck(false); setPw(""); setPw2(""); };
  const stamp = new Date().toISOString().slice(0, 10);

  return (
    <Modal open={open} onClose={close} title={t("ex.title")} subtitle={t("ex.subtitle")} wide>
      <div className="space-y-5">
        {/* encrypted backup */}
        <div className="rounded-2xl border border-[var(--ac)]/25 bg-[var(--ac)]/[.05] p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-2 text-sm font-semibold text-[var(--tx)]"><ShieldCheck size={16} className="text-[var(--ac)]" />{t("ex.encTitle")} <Tag tone="accent">{t("ex.recommended")}</Tag></p>
          </div>
          <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--tx-3)]">
            <code className="text-[var(--tx-2)]">.afbackup</code> {t("ex.encDesc")}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("ex.pw")}><PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
            <Field label={t("ex.pwRepeat")}><PasswordInput value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
          </div>
          <div className="mt-3 flex justify-end">
            <Btn
              loading={busy === "af"}
              disabled={pw.length < 8 || pw !== pw2 || tokens.length === 0}
              onClick={async () => {
                setBusy("af");
                try {
                  const out = await buildAfBackup(tokens, recoveries, pw);
                  download(`authforge-backup-${stamp}.afbackup.json`, out, "application/json");
                  queueAudit("backup_create", {});
                  toast("success", t("ex.afDone"));
                } finally { setBusy(null); }
              }}
            >
              <FileDown size={14} /> {t("ex.downloadAf")}
            </Btn>
          </div>
          {pw && pw2 && pw !== pw2 && <p className="mt-2 text-[11px] text-bad">{t("ex.mismatch")}</p>}
        </div>

        {/* printable card */}
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--line)] bg-sunk-2 p-4">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold text-[var(--tx)]"><Printer size={15} className="text-[var(--tx-2)]" /> {t("ex.cardTitle")}</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--tx-3)]">{t("ex.cardDesc")}</p>
          </div>
          <Btn
            variant="outline"
            loading={busy === "card"}
            disabled={tokens.length === 0}
            onClick={async () => {
              setBusy("card");
              try {
                const html = await buildRecoveryCardHtml(tokens, recoveries);
                const w = window.open("", "_blank");
                if (w) { w.document.write(html); w.document.close(); }
                else toast("error", t("ex.popupBlocked"));
                queueAudit("export", { format: "recovery-card" });
              } finally { setBusy(null); }
            }}
          >
            {t("ex.generate")}
          </Btn>
        </div>

        {/* quick formats */}
        <div className="grid grid-cols-2 gap-3">
          <Btn variant="outline" disabled={tokens.length === 0} onClick={() => { download(`authforge-uris-${stamp}.txt`, buildUris(tokens), "text/plain"); queueAudit("export", { format: "otpauth" }); toast("success", t("ex.urisDone")); }}>
            {t("ex.uris")}
          </Btn>
          <Btn variant="outline" disabled={tokens.length === 0} onClick={() => { download(`authforge-${stamp}.csv`, buildCsv(tokens, recoveries), "text/csv"); queueAudit("export", { format: "csv" }); toast("success", t("ex.csvDone")); }}>
            {t("ex.csv")}
          </Btn>
        </div>

        <Divider label={t("ex.dangerZone")} />
        <label className="flex items-start gap-2.5 rounded-xl border tone-bad p-3.5">
          <input type="checkbox" className="mt-0.5 accent-[var(--bad)]" checked={plainAck} onChange={(e) => setPlainAck(e.target.checked)} />
          <span className="text-[11.5px] leading-relaxed">
            {t("ex.plainAckPre")}<b>{t("ex.plainAckBold")}</b>{t("ex.plainAckPost")}
          </span>
        </label>
        <Btn
          variant="danger"
          className="w-full"
          disabled={!plainAck || tokens.length === 0}
          onClick={() => {
            download(`authforge-PLAINTEXT-${stamp}.json`, buildPlainJson(tokens, recoveries), "application/json");
            queueAudit("export", { format: "plain-json" });
            toast("info", t("ex.plainDone"));
          }}
        >
          <TriangleAlert size={14} /> {t("ex.plainBtn")}
        </Btn>
      </div>
    </Modal>
  );
}
