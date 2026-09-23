"use client";

import { X, Eye, EyeOff, Loader2, Sun, Moon, Languages } from "lucide-react";
import { useEffect, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/client/utils";
import { usePrefs, useT } from "@/lib/client/i18n";

// ---------- Button ----------
type BtnVariant = "primary" | "outline" | "ghost" | "danger" | "quiet";
export function Btn({
  variant = "primary",
  size = "md",
  className,
  loading,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md" | "lg"; loading?: boolean }) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium tracking-wide transition-all duration-200 select-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ac)] disabled:opacity-40 disabled:pointer-events-none active:scale-[.985]",
        size === "sm" && "h-8 px-3 text-xs",
        size === "md" && "h-10 px-4 text-sm",
        size === "lg" && "h-12 px-6 text-[15px]",
        variant === "primary" && "bg-[var(--ac)] text-[var(--on-ac)] font-semibold hover:bg-[var(--ac-hi)] shadow-[0_0_24px_-6px_var(--ac-glow)]",
        variant === "outline" && "border border-[var(--line)] bg-lift text-[var(--tx)] hover:border-[var(--line-hi)] hover:bg-lift-2",
        variant === "ghost" && "text-[var(--tx-2)] hover:text-[var(--tx)] hover:bg-lift",
        variant === "danger" && "border tone-bad hover:opacity-85",
        variant === "quiet" && "text-[var(--tx-3)] hover:text-[var(--tx-2)]",
        className
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 size={size === "sm" ? 13 : 16} className="animate-spin" />}
      {children}
    </button>
  );
}

// ---------- Inputs ----------
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "h-11 w-full rounded-xl border border-[var(--line)] bg-sunk px-3.5 text-sm text-[var(--tx)] placeholder:text-[var(--tx-3)]",
        "outline-none transition-colors focus:border-[var(--ac)]/60",
        props.className
      )}
    />
  );
}

export function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={show ? "text" : "password"} className={cn("pr-11", props.className)} />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow(!show)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--tx-3)] hover:text-[var(--tx-2)] transition-colors"
        aria-label={show ? "Hide password" : "Show password"}
      >
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        "w-full rounded-xl border border-[var(--line)] bg-sunk px-3.5 py-3 text-sm text-[var(--tx)] placeholder:text-[var(--tx-3)]",
        "outline-none transition-colors focus:border-[var(--ac)]/60 font-mono",
        props.className
      )}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        "h-11 w-full rounded-xl border border-[var(--line)] bg-sunk px-3 text-sm text-[var(--tx)] outline-none focus:border-[var(--ac)]/60 appearance-none cursor-pointer",
        "[&>option]:bg-[var(--panel)] [&>option]:text-[var(--tx)]",
        props.className
      )}
    />
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block space-y-1.5", className)}>
      <span className="block text-[11px] font-semibold uppercase tracking-[.14em] text-[var(--tx-3)]">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[var(--tx-3)]">{hint}</span>}
    </label>
  );
}

// ---------- Segmented tabs ----------
export function SegTabs<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={cn("inline-flex rounded-xl border border-[var(--line)] bg-sunk p-1 gap-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-all",
            value === o.value ? "bg-[var(--ac)]/15 text-[var(--ac)]" : "text-[var(--tx-3)] hover:text-[var(--tx-2)]"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Modal ----------
export function Modal({ open, onClose, title, children, wide, subtitle }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-[fadeIn_.18s_ease]" onClick={onClose} />
      <div
        className={cn(
          "relative w-full rounded-t-3xl sm:rounded-3xl border border-[var(--line-hi)] bg-[var(--panel)] shadow-2xl shadow-black/60",
          "animate-[modalIn_.24s_cubic-bezier(.2,.9,.3,1.1)] max-h-[92vh] overflow-y-auto",
          wide ? "sm:max-w-3xl" : "sm:max-w-lg"
        )}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-[var(--line)] bg-[var(--panel)]/95 backdrop-blur px-6 py-4">
          <div>
            <h2 className="text-base font-semibold tracking-wide text-[var(--tx)]">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-[var(--tx-3)]">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-[var(--tx-3)] hover:text-[var(--tx)] hover:bg-lift transition-colors" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// ---------- Countdown ring ----------
export function Ring({ size = 34, stroke = 3, progress, danger }: { size?: number; stroke?: number; progress: number; danger?: boolean }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={danger ? "var(--bad)" : "var(--ac)"}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(1, progress)))}
        style={{ transition: "stroke-dashoffset .25s linear, stroke .3s" }}
      />
    </svg>
  );
}

// ---------- Tag ----------
export function Tag({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "bad" | "accent"; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide uppercase",
        tone === "neutral" && "bg-lift-2 text-[var(--tx-3)]",
        tone === "ok" && "tone-ok",
        tone === "warn" && "tone-warn",
        tone === "bad" && "tone-bad",
        tone === "accent" && "bg-[var(--ac)]/15 text-[var(--ac)]",
        className
      )}
    >
      {children}
    </span>
  );
}

// ---------- Toggle ----------
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 rounded-full border transition-colors duration-200 shrink-0",
        checked ? "bg-[var(--ac)]/80 border-[var(--ac)]" : "bg-lift-2 border-[var(--line)]"
      )}
    >
      <span
        className={cn("absolute top-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-all duration-200", checked ? "left-[22px]" : "left-[3px]")}
        style={{ height: 18, width: 18 }}
      />
    </button>
  );
}

// ---------- Empty state ----------
export function EmptyState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--line)] bg-lift text-[var(--tx-3)]">{icon}</div>
      <p className="text-sm font-semibold text-[var(--tx-2)]">{title}</p>
      {hint && <p className="max-w-sm text-xs leading-relaxed text-[var(--tx-3)]">{hint}</p>}
      {action}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin text-[var(--ac)]" />;
}

export function Divider({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="h-px flex-1 bg-[var(--line)]" />
      {label && <span className="text-[10px] font-semibold uppercase tracking-[.18em] text-[var(--tx-3)]">{label}</span>}
      <span className="h-px flex-1 bg-[var(--line)]" />
    </div>
  );
}

// ---------- theme / language quick toggles ----------
export function PrefToggles({ compact = false }: { compact?: boolean }) {
  const theme = usePrefs((s) => s.theme);
  const toggleTheme = usePrefs((s) => s.toggleTheme);
  const lang = usePrefs((s) => s.lang);
  const setLang = usePrefs((s) => s.setLang);
  const t = useT();
  return (
    <div className="flex items-center gap-1 rounded-full border border-[var(--line)] bg-sunk p-1">
      <button
        onClick={toggleTheme}
        title={t("nav.theme")}
        aria-label={t("nav.theme")}
        className="grid h-7 w-7 place-items-center rounded-full text-[var(--tx-3)] transition-colors hover:bg-lift hover:text-[var(--tx)]"
      >
        {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
      </button>
      <button
        onClick={() => setLang(lang === "zh" ? "en" : "zh")}
        title={t("nav.lang")}
        aria-label={t("nav.lang")}
        className={cn(
          "flex h-7 items-center gap-1 rounded-full px-2 font-mono text-[10.5px] font-bold text-[var(--tx-3)] transition-colors hover:bg-lift hover:text-[var(--tx)]",
          compact && "px-1.5"
        )}
      >
        <Languages size={12} />
        {lang === "zh" ? "中" : "EN"}
      </button>
    </div>
  );
}
