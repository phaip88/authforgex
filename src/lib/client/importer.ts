// Import engine (spec §7.1): detector chain over otpauth URIs / CSV /
// Bitwarden CSV / Aegis plain / 2FAS / AuthForge (plain + encrypted .afbackup).
// Recovery-code attachment never auto-binds on ambiguity (spec §7.4):
// unmatched recoveries are returned for manual UI assignment.

import type { RecoveryData, TokenData } from "./types";
import { tokenFingerprint } from "./types";
import { isValidBase32, parseOtpAuthUri } from "./totp";
import { openAfBackup, type RecoveryBundle } from "./exporter";

export interface ImportPayload {
  sourceName: string;
  tokens: TokenData[];
  recoveries: RecoveryBundle[];
  warnings: string[];
}

export type DetectResult =
  | { kind: "ready"; payload: ImportPayload }
  | { kind: "encrypted"; format: "afbackup" }
  | { kind: "empty" };

function token(p: Partial<TokenData> & { secret: string }): TokenData | null {
  const secret = p.secret.replace(/\s/g, "").toUpperCase();
  if (!isValidBase32(secret)) return null;
  return {
    issuer: (p.issuer ?? "").trim(),
    account: (p.account ?? p.notes ?? "").trim(),
    secret,
    algorithm: p.algorithm === "SHA256" || p.algorithm === "SHA512" ? p.algorithm : "SHA1",
    digits: p.digits && p.digits >= 5 && p.digits <= 8 ? p.digits : 6,
    period: p.period && p.period >= 5 && p.period <= 300 ? p.period : 30,
    type: p.type === "hotp" ? "hotp" : p.type === "steam" ? "steam" : "totp",
    counter: p.counter,
    category: p.category,
    notes: undefined,
  };
}

export function detectImport(text: string): DetectResult {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };

  // --- JSON family ---
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const j = JSON.parse(trimmed);
      if (j?.format === "afbackup") return { kind: "encrypted", format: "afbackup" };

      // AuthForge plain export
      if (j?.format === "authforge" && Array.isArray(j.tokens)) {
        const tokens: TokenData[] = [];
        const warnings: string[] = [];
        (j.tokens as unknown[]).forEach((raw, i) => {
          const t = token(raw as Partial<TokenData> & { secret: string });
          if (t) tokens.push(t);
          else warnings.push(`Entry ${i + 1}: invalid secret, skipped`);
        });
        const recoveries: RecoveryBundle[] = Array.isArray(j.recoveries)
          ? j.recoveries
              .filter((r: { fingerprint?: string; data?: RecoveryData }) => r?.fingerprint && r?.data?.codes)
              .map((r: { fingerprint: string; data: RecoveryData }) => ({ fingerprint: r.fingerprint, data: r.data }))
          : [];
        return { kind: "ready", payload: { sourceName: "AuthForge", tokens, recoveries, warnings } };
      }

      // Aegis (plain)
      if (j?.db?.entries && Array.isArray(j.db.entries)) {
        const tokens: TokenData[] = [];
        const warnings: string[] = [];
        for (const e of j.db.entries as Record<string, unknown>[]) {
          const info = (e.info ?? {}) as Record<string, unknown>;
          const t = token({
            secret: String(info.secret ?? ""),
            issuer: String(e.issuer ?? ""),
            account: String(e.name ?? ""),
            algorithm: String(info.algo ?? "SHA1") as TokenData["algorithm"],
            digits: Number(info.digits ?? 6),
            period: Number(info.period ?? 30),
            type: e.type === "steam" ? "steam" : e.type === "hotp" ? "hotp" : "totp",
            counter: info.counter != null ? Number(info.counter) : undefined,
          });
          if (t) tokens.push(t);
          else warnings.push(`"${String(e.issuer ?? e.name ?? "?")}": invalid secret, skipped`);
        }
        return { kind: "ready", payload: { sourceName: "Aegis", tokens, recoveries: [], warnings } };
      }

      // 2FAS
      if (Array.isArray(j?.services)) {
        const tokens: TokenData[] = [];
        const warnings: string[] = [];
        for (const s of j.services as Record<string, unknown>[]) {
          const otp = (s.otp ?? {}) as Record<string, unknown>;
          const t = token({
            secret: String(s.secret ?? otp.secret ?? otp.source ?? ""),
            issuer: String(otp.issuer ?? s.name ?? ""),
            account: String(otp.label ?? otp.account ?? ""),
            algorithm: String(otp.algorithm ?? "SHA1") as TokenData["algorithm"],
            digits: Number(otp.digits ?? 6),
            period: Number(otp.period ?? 30),
            type: String(otp.tokenType ?? "TOTP").toLowerCase() === "hotp" ? "hotp" : "totp",
            counter: otp.counter != null ? Number(otp.counter) : undefined,
          });
          if (t) tokens.push(t);
          else warnings.push(`"${String(s.name ?? "?")}": invalid secret, skipped`);
        }
        return { kind: "ready", payload: { sourceName: "2FAS", tokens, recoveries: [], warnings } };
      }

      // generic array of {secret,...}
      if (Array.isArray(j)) {
        const tokens: TokenData[] = [];
        for (const raw of j) {
          if (raw && typeof raw === "object" && "secret" in raw) {
            const t = token(raw as Partial<TokenData> & { secret: string });
            if (t) tokens.push(t);
          }
        }
        if (tokens.length) return { kind: "ready", payload: { sourceName: "Generic JSON", tokens, recoveries: [], warnings: [] } };
      }
    } catch {
      /* not JSON — fall through */
    }
  }

  // --- otpauth URI text (possibly multi-line) ---
  const uriLines = trimmed.match(/otpauth:\/\/[^\s"']+/gi);
  if (uriLines?.length) {
    const tokens: TokenData[] = [];
    const warnings: string[] = [];
    for (const u of uriLines) {
      const p = parseOtpAuthUri(u);
      if (p) {
        const t = token({ ...p, account: p.account });
        if (t) tokens.push(t);
        else warnings.push("One URI had an invalid secret");
      } else warnings.push("One URI could not be parsed");
    }
    return { kind: "ready", payload: { sourceName: "otpauth URIs", tokens, recoveries: [], warnings } };
  }

  // --- CSV family (Bitwarden & AuthForge & generic) ---
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.includes(",")) {
    const rows = parseCsv(trimmed);
    if (rows.length >= 2) {
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
      const iSecret = idx(["secret"]);
      const iTotp = idx(["login_totp", "totp"]);
      const iIssuer = idx(["issuer"]);
      const iName = idx(["name"]);
      const iAccount = idx(["account", "login_username", "username", "email"]);
      const iAlg = idx(["algorithm"]);
      const iDigits = idx(["digits"]);
      const iPeriod = idx(["period"]);
      const iType = idx(["type"]);
      const iCategory = idx(["category", "folder"]);
      const iRecovery = idx(["recovery_codes", "recovery"]);
      const isBitwarden = iTotp >= 0 && iSecret < 0;

      const tokens: TokenData[] = [];
      const recoveries: RecoveryBundle[] = [];
      const warnings: string[] = [];
      for (const r of rows.slice(1)) {
        const rawSecret = iSecret >= 0 ? r[iSecret] : "";
        const totpField = iTotp >= 0 ? r[iTotp] : "";
        let t: TokenData | null = null;
        if (rawSecret) {
          t = token({
            secret: rawSecret,
            issuer: iIssuer >= 0 ? r[iIssuer] : iName >= 0 ? r[iName] : "",
            account: iAccount >= 0 ? r[iAccount] : "",
            algorithm: (iAlg >= 0 ? r[iAlg] : "SHA1") as TokenData["algorithm"],
            digits: iDigits >= 0 ? Number(r[iDigits]) : 6,
            period: iPeriod >= 0 ? Number(r[iPeriod]) : 30,
            type: (iType >= 0 ? r[iType] : "totp") as TokenData["type"],
            category: iCategory >= 0 ? r[iCategory] : undefined,
          });
        } else if (totpField) {
          const parsed = totpField.startsWith("otpauth://") ? parseOtpAuthUri(totpField) : null;
          t = parsed
            ? token({ ...parsed })
            : token({ secret: totpField, issuer: iName >= 0 ? r[iName] : "", account: iAccount >= 0 ? r[iAccount] : "" });
        }
        if (t) {
          tokens.push(t);
          if (iRecovery >= 0 && r[iRecovery]?.trim()) {
            recoveries.push({
              fingerprint: tokenFingerprint(t),
              data: {
                recoveryType: "backup_codes",
                codes: r[iRecovery].trim().split(/\s+/).map((code) => ({ code, used: false })),
                addedAt: Date.now(),
              },
            });
          }
        }
      }
      if (tokens.length) {
        return {
          kind: "ready",
          payload: {
            sourceName: isBitwarden ? "Bitwarden CSV" : "CSV",
            tokens,
            recoveries,
            warnings: tokens.length < rows.length - 1 ? [`${rows.length - 1 - tokens.length} row(s) had no usable TOTP field`] : [],
          },
        };
      }
    }
  }

  return { kind: "empty" };
}

export async function decryptAfBackupImport(raw: string, password: string): Promise<ImportPayload> {
  const plain = await openAfBackup(raw, password);
  const tokens = plain.tokens.map((t) => token(t)).filter((t): t is TokenData => !!t);
  return {
    sourceName: "AuthForge backup",
    tokens,
    recoveries: plain.recoveries.filter((r) => r.data?.codes?.length),
    warnings: [],
  };
}

/** spec §7.4: attach recoveries to vault tokens by fingerprint; unmatched
 *  ones MUST be reviewed by the user in the UI. */
export function splitRecoveryMatches(
  bundles: RecoveryBundle[],
  candidates: { fingerprint: string; tokenId: string }[]
): { matched: { tokenId: string; data: RecoveryData }[]; unmatched: RecoveryBundle[] } {
  const matched: { tokenId: string; data: RecoveryData }[] = [];
  const unmatched: RecoveryBundle[] = [];
  const byFp = new Map<string, string[]>();
  for (const c of candidates) {
    const list = byFp.get(c.fingerprint) ?? [];
    list.push(c.tokenId);
    byFp.set(c.fingerprint, list);
  }
  for (const b of bundles) {
    const list = byFp.get(b.fingerprint);
    if (list && list.length === 1) matched.push({ tokenId: list[0], data: b.data });
    else unmatched.push(b); // zero or ambiguous -> manual review, never silent
  }
  return { matched, unmatched };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}
