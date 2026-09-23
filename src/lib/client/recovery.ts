// Recovery-code parsing engine (spec §6.2, R1 fixed).
// R1: never strip a prefix that would erase a code — digits may only be
// stripped when followed by '.' / ')' separator; bullets require whitespace.
// Regression vectors: "12345678" -> "12345678", "12abc34" -> "12abc34",
// "1. abc123" -> "abc123", "10) X-789" -> "X-789", "•code" -> "•code".

import type { RecoveryData, RecoveryType } from "./types";

function stripLinePrefix(line: string): string {
  const t = line.replace(/^\s+/, "");

  // bullet: single -, •, * followed by whitespace ("- code")
  const first = t[0];
  if ((first === "-" || first === "•" || first === "*") && t.length > 1 && /\s/.test(t[1])) {
    return t.slice(1).replace(/^\s+/, "");
  }

  // numbering: 1–3 digits then '.' or ')' and non-empty remainder ("10) code")
  const m = /^(\d{1,3})([.)])\s*(.+)$/.exec(t);
  if (m) return m[3];

  return t; // no recognizable prefix — keep as-is (digit-leading codes survive)
}

const MNEMONIC_COUNTS = new Set([12, 15, 18, 21, 24]);

function looksLikeMnemonic(text: string): boolean {
  const words = text.split(/\s+/);
  return (
    MNEMONIC_COUNTS.has(words.length) &&
    words.every((w) => /^[a-zA-Z]{3,8}$/.test(w))
  );
}

export interface ParsedRecovery {
  recoveryType: RecoveryType;
  codes: string[];
  rawText: string;
}

export function parseRecoveryText(input: string): ParsedRecovery {
  const trimmed = input.trim();
  if (!trimmed) return { recoveryType: "custom", codes: [], rawText: "" };

  // 1. mnemonic phrase (strict: word count + pure-alpha 3–8 chars)
  if (looksLikeMnemonic(trimmed))
    return { recoveryType: "recovery_phrase", codes: [trimmed], rawText: trimmed };

  // 2. multi-line -> backup codes
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const codes = lines.map(stripLinePrefix).filter((c) => c.length > 0);
    if (codes.length > 0) return { recoveryType: "backup_codes", codes, rawText: trimmed };
  }

  // 3. single line with , or ; -> backup codes
  if (trimmed.includes(",") || trimmed.includes(";")) {
    const codes = trimmed.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    if (codes.length > 1) return { recoveryType: "backup_codes", codes, rawText: trimmed };
  }

  // 4. single value -> recovery key
  return { recoveryType: "recovery_key", codes: [trimmed], rawText: trimmed };
}

export function makeRecoveryData(parsed: ParsedRecovery): RecoveryData {
  return {
    recoveryType: parsed.recoveryType,
    codes: parsed.codes.map((code) => ({ code, used: false })),
    rawText: parsed.rawText,
    addedAt: Date.now(),
  };
}

export interface RecoveryStats {
  total: number;
  used: number;
  remaining: number;
}

export function recoveryStats(r: RecoveryData): RecoveryStats {
  const total = r.codes.length;
  const used = r.codes.filter((c) => c.used).length;
  return { total, used, remaining: total - used };
}

/** Mask a code showing structure but not content: "••••-••••" */
export function maskCode(code: string): string {
  return code.replace(/[A-Za-z0-9]/g, "•");
}

/** Group a code for readability: "abcd-1234" style chunks of 4. */
export function groupCode(code: string): string {
  if (code.includes("-") || code.includes(" ")) return code;
  if (code.length <= 8) return code;
  return code.replace(/(.{4})/g, "$1 ").trim();
}

export const RECOVERY_TYPE_LABEL: Record<RecoveryType, string> = {
  backup_codes: "Backup codes",
  recovery_key: "Recovery key",
  recovery_phrase: "Recovery phrase",
  custom: "Custom text",
};
