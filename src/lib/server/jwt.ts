import { SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes } from "node:crypto";

let warnedMissingSecret = false;
const secret = () => {
  if (!process.env.AF_JWT_SECRET && !warnedMissingSecret) {
    warnedMissingSecret = true;
    console.warn(
      "[authforge] WARNING: AF_JWT_SECRET is not set — using the built-in development secret. " +
        "Set a 32-byte random secret (e.g. `openssl rand -hex 32`) before exposing this server."
    );
  }
  return new TextEncoder().encode(
    process.env.AF_JWT_SECRET ||
      "authforge-dev-secret-change-me-0123456789abcdef"
  );
};

export const ACCESS_TTL_S = 15 * 60; // 15 min (spec §4.4)
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000; // 30 d rotation

export async function signAccessToken(userId: string): Promise<string> {
  return new SignJWT({ typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_S}s`)
    .sign(secret());
}

export async function verifyAccessToken(
  token: string
): Promise<{ sub: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.typ !== "access" || !payload.sub) return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}
