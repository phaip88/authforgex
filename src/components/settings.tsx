"use client";

import { useEffect, useState } from "react";
import {
  Lock, Server, RefreshCw, LogOut, Trash2, ShieldCheck, Activity, ArrowRight,
  TimerReset, Wifi, CircleAlert, KeyRound, Palette, Sun, Moon, Languages, KeySquare,
} from "lucide-react";
import { useVault } from "@/lib/client/store";
import { api } from "@/lib/client/api";
import { fmtAgoT, usePrefs, useT } from "@/lib/client/i18n";
import { Btn, Divider, Field, Input, PasswordInput, SegTabs, Tag } from "./ui";

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5">
      <h3 className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.16em] text-[var(--tx-3)]">
        <span className="text-[var(--ac)]">{icon}</span> {title}
      </h3>
      {children}
    </section>
  );
}

function AppearanceCard() {
  const t = useT();
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const lang = usePrefs((s) => s.lang);
  const setLang = usePrefs((s) => s.setLang);
  return (
    <Card title={t("st.appearance")} icon={<Palette size={14} />}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-xs text-[var(--tx-2)]"><Globe />{t("st.language")}</p>
          <SegTabs
            value={lang}
            onChange={setLang}
            options={[
              { value: "zh", label: <span className="inline-flex items-center gap-1.5"><Languages size={12} /> 中文</span> },
              { value: "en", label: <span className="inline-flex items-center gap-1.5"><Languages size={12} /> English</span> },
            ]}
          />
        </div>
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-xs text-[var(--tx-2)]"><SunMoonIcon />{t("st.theme")}</p>
          <SegTabs
            value={theme}
            onChange={setTheme}
            options={[
              { value: "dark", label: <span className="inline-flex items-center gap-1.5"><Moon size={12} /> {t("st.dark")}</span> },
              { value: "light", label: <span className="inline-flex items-center gap-1.5"><Sun size={12} /> {t("st.light")}</span> },
            ]}
          />
        </div>
      </div>
    </Card>
  );
}
const Globe = () => <Languages size={12} className="text-[var(--tx-3)]" />;
const SunMoonIcon = () => <Palette size={12} className="text-[var(--tx-3)]" />;

function ConnectForm() {
  const connectServer = useVault((s) => s.connectServer);
  const t = useT();
  const [action, setAction] = useState<"register" | "login">("register");
  const [url, setUrl] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="space-y-3.5">
      <p className="text-xs leading-relaxed text-[var(--tx-3)]">{t("st.connectDesc")}</p>
      <SegTabs value={action} onChange={setAction} options={[
        { value: "register", label: t("st.acct.register") },
        { value: "login", label: t("st.acct.login") },
      ]} />
      <Field label={t("auth.serverUrl")}><Input value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
      <Field label={t("auth.email")}><Input value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" /></Field>
      <Field label={t("auth.masterPw")}>
        <PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} />
      </Field>
      {action === "login" && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-warn">
          <CircleAlert size={12} className="mt-0.5 shrink-0" /> {t("st.acct.mergeWarn")}
        </p>
      )}
      {err && <p className="text-xs text-bad">{err}</p>}
      <Btn
        className="w-full"
        loading={busy}
        disabled={!email || pw.length < 8 || !url}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await connectServer(email.trim().toLowerCase(), pw, url.trim(), action === "register");
          } catch (ex) {
            setErr(ex instanceof Error ? ex.message : t("st.acct.failed"));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Server size={14} /> {action === "register" ? t("st.acct.go.reg") : t("st.acct.go.login")}
      </Btn>
    </div>
  );
}

function AuditPanel() {
  const t = useT();
  const [events, setEvents] = useState<{ id: number; action: string; ip: string | null; created_at: number }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.auditList()
      .then((r) => alive && setEvents(r.events))
      .catch(() => alive && setErr(t("st.audit.unavail")));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (err) return <p className="text-xs text-[var(--tx-3)]">{err}</p>;
  if (!events) return <p className="text-xs text-[var(--tx-3)]">{t("st.audit.loading")}</p>;
  if (events.length === 0) return <p className="text-xs text-[var(--tx-3)]">{t("st.audit.none")}</p>;
  return (
    <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
      {events.map((e) => (
        <li key={e.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-xs hover:bg-lift">
          <Tag tone={/fail|replay/.test(e.action) ? "bad" : /delete|export/.test(e.action) ? "warn" : "neutral"}>{e.action.replace(/_/g, " ")}</Tag>
          <span className="flex-1 truncate text-[var(--tx-3)]">{e.ip ?? ""}</span>
          <span className="font-mono text-[10.5px] text-[var(--tx-3)]">{fmtAgoT(e.created_at, t)}</span>
        </li>
      ))}
    </ul>
  );
}

function ChangePasswordCard() {
  const t = useT();
  const mode = useVault((s) => s.mode);
  const changeMasterPassword = useVault((s) => s.changeMasterPassword);
  const toast = useVault((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <Card title={t("st.changepw")} icon={<KeySquare size={14} />}>
      {!open ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-md text-xs leading-relaxed text-[var(--tx-3)]">{t("st.changepwDesc")}</p>
          <Btn variant="outline" size="sm" onClick={() => setOpen(true)}>{t("st.changepwOpen")}</Btn>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            if (pw.length < 8) return setErr(t("auth.errShort"));
            if (pw !== pw2) return setErr(t("auth.errMismatch"));
            setBusy(true);
            try {
              await changeMasterPassword(pw);
              toast("success", t("st.changepwDone"));
              setOpen(false);
              setPw(""); setPw2("");
            } catch (ex) {
              setErr(ex instanceof Error ? ex.message : "failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("st.newPw")}><PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="new-password" /></Field>
            <Field label={t("st.newPwRepeat")}><PasswordInput value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Field>
          </div>
          {mode === "server" && <p className="text-[11px] text-warn">{t("st.changepwDesc")}</p>}
          {err && <p className="rounded-lg border tone-bad px-3 py-2 text-xs">{err}</p>}
          <div className="flex gap-2">
            <Btn type="submit" size="sm" loading={busy} disabled={!pw}>{busy ? t("st.changepwWorking") : t("st.changepwBtn")}</Btn>
            <Btn type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>{t("c.cancel")}</Btn>
          </div>
        </form>
      )}
    </Card>
  );
}

export function SettingsView() {
  const mode = useVault((s) => s.mode);
  const email = useVault((s) => s.email);
  const serverVersion = useVault((s) => s.serverVersion);
  const outboxCount = useVault((s) => s.outboxCount);
  const syncing = useVault((s) => s.syncing);
  const autoLockMins = useVault((s) => s.autoLockMins);
  const setAutoLock = useVault((s) => s.setAutoLock);
  const lock = useVault((s) => s.lock);
  const syncNow = useVault((s) => s.syncNow);
  const disconnectServer = useVault((s) => s.disconnectServer);
  const eraseAll = useVault((s) => s.eraseAll);
  const deleteAccount = useVault((s) => s.deleteAccount);
  const tokens = useVault((s) => s.tokens);
  const recoveries = useVault((s) => s.recoveries);
  const toast = useVault((s) => s.toast);
  const t = useT();
  const [confirmErase, setConfirmErase] = useState(false);
  const [confirmDisc, setConfirmDisc] = useState(false);
  const [delPw, setDelPw] = useState("");
  const [delOpen, setDelOpen] = useState(false);
  const [delBusy, setDelBusy] = useState(false);

  const smItems = [
    ["st.sm.1t", "st.sm.1d"], ["st.sm.2t", "st.sm.2d"], ["st.sm.3t", "st.sm.3d"],
    ["st.sm.4t", "st.sm.4d"], ["st.sm.5t", "st.sm.5d"], ["st.sm.6t", "st.sm.6d"],
  ] as const;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-24 sm:px-6">
      {/* appearance */}
      <AppearanceCard />

      {/* session */}
      <Card title={t("st.session")} icon={<TimerReset size={14} />}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-[var(--tx)]">{t("st.autoLock")}</p>
            <p className="mt-0.5 text-xs text-[var(--tx-3)]">{t("st.autoLockDesc")}</p>
          </div>
          <div className="flex items-center gap-2">
            <SegTabs
              value={String(autoLockMins)}
              onChange={(v) => void setAutoLock(Number(v))}
              options={[
                { value: "1", label: "1m" },
                { value: "5", label: "5m" },
                { value: "15", label: "15m" },
                { value: "0", label: t("st.never") },
              ]}
            />
            <Btn variant="outline" size="sm" onClick={lock}>
              <Lock size={13} /> {t("st.lockNow")}
            </Btn>
          </div>
        </div>
      </Card>

      {/* master password change (spec §4.5) */}
      <ChangePasswordCard />

      {/* sync */}
      <Card title={t("st.sync")} icon={<Wifi size={14} />}>
        {mode === "server" ? (
          <div className="space-y-3.5">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {[
                [t("st.k.account"), email ?? "—"],
                [t("st.k.serverV"), `v${serverVersion}`],
                [t("st.k.outbox"), String(outboxCount)],
                [t("st.k.synced"), t("st.k.syncedV", { t: tokens.length, r: recoveries.length })],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl border border-[var(--line)] bg-sunk-2 px-3 py-2.5">
                  <p className="text-[9.5px] font-semibold uppercase tracking-[.14em] text-[var(--tx-3)]">{k}</p>
                  <p className="mt-1 truncate font-mono text-[12.5px] font-semibold text-[var(--tx)]">{v}</p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn size="sm" onClick={() => void syncNow()} loading={syncing}>
                <RefreshCw size={13} /> {t("st.syncNow")}
              </Btn>
              {confirmDisc ? (
                <Btn size="sm" variant="danger" onClick={() => void disconnectServer()}>
                  {t("st.disconnectConfirm")}
                </Btn>
              ) : (
                <Btn size="sm" variant="ghost" onClick={() => setConfirmDisc(true)}>
                  <LogOut size={13} /> {t("st.disconnect")}
                </Btn>
              )}
            </div>
          </div>
        ) : (
          <ConnectForm />
        )}
      </Card>

      {/* security model */}
      <Card title={t("st.secModel")} icon={<ShieldCheck size={14} />}>
        <ul className="space-y-2 text-[12px] leading-relaxed text-[var(--tx-3)]">
          {smItems.map(([tk, dk]) => (
            <li key={tk} className="flex gap-2.5">
              <KeyRound size={12} className="mt-1 shrink-0 text-[var(--ac)]" />
              <p><span className="font-medium text-[var(--tx-2)]">{t(tk)}</span> — {t(dk)}</p>
            </li>
          ))}
        </ul>
      </Card>

      {/* audit */}
      {mode === "server" && (
        <Card title={t("st.audit")} icon={<Activity size={14} />}>
          <AuditPanel />
        </Card>
      )}

      <Divider />

      {/* danger zone */}
      <Card title={t("st.danger")} icon={<CircleAlert size={14} />}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-bad">{t("st.eraseTitle")}</p>
            <p className="mt-0.5 max-w-md text-xs leading-relaxed text-[var(--tx-3)]">
              {t("st.eraseDesc")}
              {mode === "server" ? t("st.eraseDescServer") : t("st.eraseDescLocal")}
            </p>
          </div>
          {confirmErase ? (
            <div className="flex items-center gap-2">
              <Btn size="sm" variant="danger" onClick={() => void eraseAll()}>
                <Trash2 size={13} /> {t("st.eraseConfirm")}
              </Btn>
              <Btn size="sm" variant="ghost" onClick={() => setConfirmErase(false)}>{t("c.cancel")}</Btn>
            </div>
          ) : (
            <Btn size="sm" variant="outline" className="border-[var(--bad)]/30 text-bad hover:bg-lift" onClick={() => setConfirmErase(true)}>
              {t("st.erase")}
            </Btn>
          )}
        </div>

        {mode === "server" && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
            <div>
              <p className="text-sm font-medium text-bad">{t("st.delAccount")}</p>
              <p className="mt-0.5 max-w-md text-xs leading-relaxed text-[var(--tx-3)]">{t("st.delAccountDesc")}</p>
            </div>
            {!delOpen ? (
              <Btn size="sm" variant="outline" className="border-[var(--bad)]/30 text-bad hover:bg-lift" onClick={() => setDelOpen(true)}>
                {t("st.delAccountBtn")}
              </Btn>
            ) : (
              <form
                className="flex items-center gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!delPw) return;
                  setDelBusy(true);
                  try {
                    await deleteAccount();
                    toast("info", t("st.delAccountDone"));
                  } catch (ex) {
                    toast("error", ex instanceof Error ? ex.message : "failed");
                    setDelBusy(false);
                    setDelPw("");
                  }
                }}
              >
                <PasswordInput
                  value={delPw}
                  onChange={(e) => setDelPw(e.target.value)}
                  placeholder={t("st.delAccountPw")}
                  className="h-9 w-52 text-xs"
                />
                <Btn type="submit" size="sm" variant="danger" loading={delBusy} disabled={!delPw}>
                  {t("st.delAccountConfirm")}
                </Btn>
                <Btn type="button" size="sm" variant="ghost" onClick={() => { setDelOpen(false); setDelPw(""); }} disabled={delBusy}>
                  {t("c.cancel")}
                </Btn>
              </form>
            )}
          </div>
        )}
      </Card>

      <button className="mx-auto flex items-center gap-1.5 py-2 text-[11px] text-[var(--tx-3)] transition-colors hover:text-[var(--tx-2)]" onClick={lock}>
        <ArrowRight size={11} className="rotate-180" /> {t("st.backToVault")}
      </button>
    </div>
  );
}
