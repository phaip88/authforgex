// AuthForge domain model (spec §5.1, TS edition)

export type Algorithm = "SHA1" | "SHA256" | "SHA512";
export type TokenType = "totp" | "hotp" | "steam";

export interface TokenData {
  issuer: string;
  account: string;
  secret: string; // base32
  algorithm: Algorithm;
  digits: number; // 6/7/8
  period: number; // 30/60 s
  type: TokenType;
  counter?: number; // HOTP
  category?: string;
  notes?: string;
  critical?: boolean; // user-flagged "key service" (health check input)
  lastUsedAt?: number; // ms, local telemetry for health check
}

export interface VaultToken extends TokenData {
  id: string;
  version: number;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
}

export type RecoveryType = "backup_codes" | "recovery_key" | "recovery_phrase" | "custom";

export interface RecoveryCode {
  code: string;
  used: boolean;
  usedAt?: number;
}

export interface RecoveryData {
  recoveryType: RecoveryType;
  codes: RecoveryCode[];
  rawText?: string;
  notes?: string;
  addedAt: number;
}

export interface VaultRecovery extends RecoveryData {
  id: string;
  tokenId: string;
  version: number;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Wire / storage shape of an encrypted record envelope. */
export interface EncRecord {
  id: string;
  token_id?: string;
  encrypted_data: string;
  version: number;
  deleted: boolean;
  created_at: number;
  updated_at: number;
}

export function tokenFingerprint(t: Pick<TokenData, "secret" | "issuer" | "account" | "type">): string {
  const norm = (s: string) => s.trim().toLowerCase();
  return `${norm(t.secret).replace(/[\s=]/g, "")}|${norm(t.issuer)}|${norm(t.account)}|${t.type}`;
}

export const DEFAULT_TOKEN: TokenData = {
  issuer: "",
  account: "",
  secret: "",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
  type: "totp",
};
