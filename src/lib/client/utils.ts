export const cn = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

export function fmtClock(ts: number, locale = "en-US"): string {
  return new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

export function fmtDate(ts: number, locale = "en-US"): string {
  return new Date(ts).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

export interface PasswordFeedback {
  score: 0 | 1 | 2 | 3 | 4;
  key: "pw.0" | "pw.1" | "pw.2" | "pw.3" | "pw.4";
  ok: boolean;
}

export function passwordFeedback(pw: string): PasswordFeedback {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) || /[^A-Za-z0-9]/.test(pw)) score++;
  const clamp = Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
  return { score: clamp, key: `pw.${clamp}` as PasswordFeedback["key"], ok: pw.length >= 8 };
}

export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  return Promise.resolve();
}
