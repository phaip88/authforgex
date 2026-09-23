"use client";

import { useMemo, useState, type FormEvent } from "react";
import { KeyRound, Lock, Server, HardDrive, ShieldCheck, ArrowRight, Delete } from "lucide-react";
import { useVault } from "@/lib/client/store";
import { useT } from "@/lib/client/i18n";
import { Btn, Field, Input, PasswordInput, SegTabs, Divider, PrefToggles } from "./ui";
import { cn, passwordFeedback } from "@/lib/client/utils";

/** Subtle mono digit-rain backdrop (CSS-only motion, very low opacity). */
export function DigitRain() {
  const cols = useMemo(() => {
    const rnd = (n: number) => Math.floor(Math.random() * n);
    return Array.from({ length: 18 }, (_, i) => ({
      left: `${(i / 18) * 100 + rnd(3)}%`,
      dur: 22 + rnd(20),
      delay: -rnd(22),
      text: Array.from({ length: 46 }, () => "0123456789ABCDEF"[rnd(16)]).join("\n"),
    }));
  }, []);
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden [mask-image:radial-gradient(120%_90%_at_50%_0%,black,transparent_75%)]">
      {cols.map((c, i) => (
        <pre
          key={i}
          className="absolute top-0 whitespace-pre font-mono text-[11px] leading-6 text-[var(--ac)] opacity-[.05] will-change-transform"
          style={{ left: c.left, animation: `digitFall ${c.dur}s linear ${c.delay}s infinite` }}
        >
          {c.text}
        </pre>
      ))}
    </div>
  );
}

function BrandMark({ size = 54 }: { size?: number }) {
  return (
    <div
      className="relative grid place-items-center rounded-2xl border border-[var(--ac)]/25 bg-gradient-to-b from-[var(--ac)]/15 to-transparent shadow-[0_0_50px_-10px_var(--ac-glow)]"
      style={{ width: size, height: size }}
    >
      <KeyRound size={size * 0.48} className="text-[var(--ac)]" strokeWidth={1.8} />
    </div>
  );
}

function AuthShell({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) {
  const t = useT();
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <DigitRain />
      <div className="fixed right-4 top-4 z-20">
        <PrefToggles />
      </div>
      <div className="relative w-full max-w-[400px] animate-[riseIn_.5s_cubic-bezier(.2,.8,.3,1)]">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <BrandMark />
          <div>
            <h1 className="font-display text-[22px] font-semibold tracking-[.06em] text-[var(--tx)]">
              Auth<span className="text-[var(--ac)]">Forge</span>
            </h1>
            <p className="mt-1 text-[11px] uppercase tracking-[.28em] text-[var(--tx-3)]">{t("brand.tag")}</p>
          </div>
        </div>
        <div className="rounded-3xl border border-[var(--line-hi)] bg-[var(--panel)]/90 p-7 shadow-2xl shadow-black/30 backdrop-blur">{children}</div>
        {footer}
      </div>
    </div>
  );
}

// ================= SETUP =================
export function SetupScreen() {
  const setupLocal = useVault((s) => s.setupLocal);
  const setupServer = useVault((s) => s.setupServer);
  const set = useVault((s) => s.set);
  const t = useT();
  const [mode, setMode] = useState<"local" | "server">("local");
  const [serverAction, setServerAction] = useState<"register" | "login">("register");
  const [serverUrl, setServerUrl] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const feedback = passwordFeedback(pw);
  const isRegister = mode === "server" && serverAction === "register";
  const needsConfirm = mode === "local" || isRegister;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (needsConfirm && pw !== pw2) return setErr(t("auth.errMismatch"));
    if (!feedback.ok) return setErr(t("auth.errShort"));
    if (mode === "server" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setErr(t("auth.errEmail"));
    setBusy(true);
    try {
      if (mode === "local") await setupLocal(pw);
      else await setupServer(email.trim().toLowerCase(), pw, serverUrl.trim(), isRegister);
      useVault.getState().toast("success", t(mode === "local" ? "t.createdLocal" : "t.accountReady"));
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : t("auth.errSetup"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      footer={
        <p className="mt-6 text-center text-[11px] leading-relaxed text-[var(--tx-3)]">
          {t("auth.footerLine1")}
          <br />
          {t("auth.footerLine2")}
        </p>
      }
    >
      <SegTabs
        value={mode}
        onChange={setMode}
        className="mb-6 w-full justify-center"
        options={[
          { value: "local", label: <span className="inline-flex items-center gap-1.5"><HardDrive size={13} /> {t("auth.localVault")}</span> },
          { value: "server", label: <span className="inline-flex items-center gap-1.5"><Server size={13} /> {t("auth.server")}</span> },
        ]}
      />

      <form onSubmit={submit} className="space-y-4">
        {mode === "server" && (
          <>
            <SegTabs
              value={serverAction}
              onChange={setServerAction}
              className="w-full justify-center"
              options={[
                { value: "register", label: t("auth.createAccount") },
                { value: "login", label: t("auth.signIn") },
              ]}
            />
            <Field label={t("auth.serverUrl")}>
              <Input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://2fa.example.com" inputMode="url" autoComplete="url" />
            </Field>
            <Field label={t("auth.email")}>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" inputMode="email" autoComplete="email" />
            </Field>
          </>
        )}

        <Field label={isRegister || mode === "local" ? t("auth.chooseMaster") : t("auth.masterPw")} hint={mode === "local" ? t("auth.masterPwHint") : undefined}>
          <PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete={needsConfirm ? "new-password" : "current-password"} placeholder="••••••••••••" />
        </Field>

        {needsConfirm && pw.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex gap-1">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={cn("h-1 flex-1 rounded-full transition-colors", i < feedback.score ? (feedback.score >= 3 ? "bg-[var(--ac)]" : "bg-[var(--warn)]") : "bg-track")} />
              ))}
            </div>
            <p className="text-[11px] text-[var(--tx-3)]">{t(feedback.key)} {t("auth.pwRounds")}</p>
          </div>
        )}

        {needsConfirm && (
          <Field label={t("auth.confirmMaster")}>
            <PasswordInput value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" placeholder="••••••••••••" />
          </Field>
        )}

        {err && <p className="rounded-lg border tone-bad px-3 py-2 text-xs">{err}</p>}

        <Btn type="submit" size="lg" className="w-full" loading={busy}>
          {busy ? t("auth.creating") : mode === "local" ? t("auth.createLocal") : isRegister ? t("auth.createServer") : t("auth.signInUnlock")}
          {!busy && <ArrowRight size={16} />}
        </Btn>
      </form>

      <div className="mt-5 flex items-start gap-2 rounded-xl border border-[var(--line)] bg-sunk-2 px-3 py-2.5">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-[var(--ac)]" />
        <p className="text-[11px] leading-relaxed text-[var(--tx-3)]">
          {mode === "local" ? t("auth.noteLocal") : t("auth.noteServer")}
        </p>
      </div>

      <div className="mt-4 text-center">
        <button
          type="button"
          onClick={() => {
            set({ status: "boot" });
            void useVault.getState().boot();
          }}
          className="text-[11px] text-[var(--tx-3)] underline-offset-2 hover:text-[var(--tx-2)] hover:underline"
        >
          {t("auth.alreadyVault")}
        </button>
      </div>
    </AuthShell>
  );
}

// ================= LOCK =================
export function LockScreen() {
  const unlock = useVault((s) => s.unlock);
  const mode = useVault((s) => s.mode);
  const email = useVault((s) => s.email);
  const eraseAll = useVault((s) => s.eraseAll);
  const t = useT();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!pw) return;
    setBusy(true);
    setErr(null);
    try {
      await unlock(pw);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : t("auth.wrongPw"));
      setPw("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <div className="mb-5 flex items-center justify-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-lift px-3 py-1 text-[11px] font-medium text-[var(--tx-2)]">
          <Lock size={11} className="text-[var(--ac)]" />
          {mode === "server" ? email ?? t("auth.server") : t("auth.localVault")}
        </span>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <Field label={t("auth.masterPw")}>
          <PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" placeholder="••••••••••••" />
        </Field>
        {err && <p className="rounded-lg border tone-bad px-3 py-2 text-xs">{err}</p>}
        <Btn type="submit" size="lg" className="w-full" loading={busy}>
          {busy ? t("auth.unlocking") : t("auth.unlock")}
        </Btn>
      </form>

      <p className="mt-4 text-center text-[11px] text-[var(--tx-3)]">
        {busy ? t("auth.unlockBusyNote") : t("auth.unlockIdleNote")}
      </p>

      <Divider label={t("auth.dangerZone")} />
      {confirmWipe ? (
        <div className="space-y-2 rounded-xl border tone-bad p-3">
          <p className="text-[11px] leading-relaxed">{t("auth.wipeLine")}</p>
          <div className="flex gap-2">
            <Btn size="sm" variant="danger" onClick={() => void eraseAll()}>{t("auth.wipeBtn")}</Btn>
            <Btn size="sm" variant="ghost" onClick={() => setConfirmWipe(false)}>{t("c.cancel")}</Btn>
          </div>
        </div>
      ) : (
        <button onClick={() => setConfirmWipe(true)} className="mx-auto flex items-center gap-1.5 text-[11px] text-[var(--tx-3)] transition-colors hover:text-bad">
          <Delete size={11} /> {t("auth.forgotPw")}
        </button>
      )}
    </AuthShell>
  );
}
