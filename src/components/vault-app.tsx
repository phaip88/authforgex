"use client";

import { useEffect, useRef } from "react";
import { KeyRound, Vault, HeartPulse, Settings2, X } from "lucide-react";
import { useVault } from "@/lib/client/store";
import { getT, usePrefs, useT } from "@/lib/client/i18n";
import { cn } from "@/lib/client/utils";
import { PrefToggles } from "./ui";
import { SetupScreen, LockScreen } from "./screens-auth";
import { VaultHome } from "./vault-home";
import { TokenDetail } from "./token-detail";
import { AddTokenDialog, ImportDialog, ExportDialog } from "./dialogs";
import { HealthView } from "./health";
import { SettingsView } from "./settings";

function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <div className="flex flex-col items-center gap-4">
        <div className="grid h-14 w-14 animate-[pulse_1.6s_ease-in-out_infinite] place-items-center rounded-2xl border border-[var(--ac)]/25 bg-[var(--ac)]/10">
          <KeyRound size={24} className="text-[var(--ac)]" strokeWidth={1.8} />
        </div>
        <p className="text-[10px] font-semibold uppercase tracking-[.3em] text-[var(--tx-3)]">AuthForge</p>
      </div>
    </div>
  );
}

function ToastHost() {
  const toasts = useVault((s) => s.toasts);
  const dismissToast = useVault((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-16 left-1/2 z-[70] flex w-full max-w-sm -translate-x-1/2 flex-col items-center gap-2 px-4">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            "pointer-events-auto flex w-full items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-[12.5px] shadow-xl shadow-black/30 backdrop-blur animate-[toastIn_.25s_cubic-bezier(.2,.9,.3,1.15)]",
            toast.kind === "success" && "tone-ok bg-[var(--panel-2)]/95",
            toast.kind === "error" && "tone-bad bg-[var(--panel-2)]/95",
            toast.kind === "info" && "border-[var(--line-hi)] bg-[var(--panel-2)]/95 text-[var(--tx-2)]"
          )}
        >
          <span className="flex-1 leading-snug">{toast.text}</span>
          <button onClick={() => dismissToast(toast.id)} className="shrink-0 opacity-60 hover:opacity-100" aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function TopBar() {
  const activeTab = useVault((s) => s.activeTab);
  const set = useVault((s) => s.set);
  const t = useT();
  // subscribe so top bar re-renders on theme switch (icon swap inside PrefToggles handles itself)
  usePrefs((s) => s.theme);
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--line)] bg-[var(--bg)]/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <button className="flex items-center gap-2.5" onClick={() => set({ activeTab: "vault" })} aria-label="AuthForge home">
          <span className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--ac)]/25 bg-[var(--ac)]/10">
            <KeyRound size={15} className="text-[var(--ac)]" />
          </span>
          <span className="font-display text-[15px] font-semibold tracking-[.07em] text-[var(--tx)]">
            Auth<span className="text-[var(--ac)]">Forge</span>
          </span>
        </button>
        <div className="flex items-center gap-2">
          <nav className="flex items-center gap-1 rounded-full border border-[var(--line)] bg-sunk p-1">
            {([
              ["vault", t("nav.vault"), <Vault key="v" size={13} />],
              ["health", t("nav.health"), <HeartPulse key="h" size={13} />],
              ["settings", t("nav.settings"), <Settings2 key="s" size={13} />],
            ] as const).map(([tab, label, icon]) => (
              <button
                key={tab}
                onClick={() => set({ activeTab: tab })}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-all",
                  activeTab === tab ? "bg-[var(--ac)]/15 text-[var(--ac)]" : "text-[var(--tx-3)] hover:text-[var(--tx-2)]"
                )}
              >
                {icon}
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </nav>
          <PrefToggles compact />
        </div>
      </div>
    </header>
  );
}

export default function VaultApp() {
  const status = useVault((s) => s.status);
  const activeTab = useVault((s) => s.activeTab);
  const set = useVault((s) => s.set);
  const lastActivity = useRef(Date.now());

  // boot
  useEffect(() => {
    void useVault.getState().boot();
  }, []);

  // clock (250 ms for smooth countdown rings)
  useEffect(() => {
    if (status !== "unlocked") return;
    const id = setInterval(() => set({ now: Date.now() }), 250);
    return () => clearInterval(id);
  }, [status, set]);

  // auto-lock on inactivity (spec: default 5 min, memory keys zeroed)
  useEffect(() => {
    if (status !== "unlocked") return;
    lastActivity.current = Date.now();
    const touch = () => {
      lastActivity.current = Date.now();
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const id = setInterval(() => {
      const mins = useVault.getState().autoLockMins;
      if (mins > 0 && Date.now() - lastActivity.current > mins * 60_000) {
        useVault.getState().lock();
        useVault.getState().toast("info", getT()("toast.autoLocked"));
      }
    }, 1000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch));
      clearInterval(id);
    };
  }, [status]);

  // sync cadence (spec §8.1: 30 s foreground polling is the default path;
  // WS is an optional enhancement. Pause in hidden tabs to save quota.)
  useEffect(() => {
    if (status !== "unlocked") return;
    const go = () => {
      const s = useVault.getState();
      if (s.mode === "server" && document.visibilityState === "visible") void s.syncNow();
    };
    const id = setInterval(go, 30_000);
    const onVisible = () => document.visibilityState === "visible" && go();
    window.addEventListener("online", go);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", go);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [status]);

  // online/offline chip state
  useEffect(() => {
    const up = () => set({ online: navigator.onLine });
    window.addEventListener("online", up);
    window.addEventListener("offline", up);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", up);
    };
  }, [set]);

  if (status === "boot") return <Splash />;
  if (status === "setup") return <SetupScreen />;
  if (status === "locked") return <LockScreen />;

  return (
    <div className="min-h-dvh">
      <TopBar />
      <main className="animate-[fadeIn_.3s_ease]">
        {activeTab === "vault" && <VaultHome />}
        {activeTab === "health" && <HealthView />}
        {activeTab === "settings" && <SettingsView />}
      </main>
      <TokenDetail />
      <AddTokenDialog />
      <ImportDialog />
      <ExportDialog />
      <ToastHost />
    </div>
  );
}
