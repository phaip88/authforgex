// Thin API client for the zero-knowledge server (spec §9).
// Handles problem+json errors, attach/refresh of the 15-min access token.

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter?: number;
  serverVersion?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number, serverVersion?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.serverVersion = serverVersion;
  }
}

let accessToken: string | null = null;
export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const getAccessToken = () => accessToken;

/** Wired by the vault store: attempts a refresh-token rotation. */
export let tryRefresh: (() => Promise<boolean>) | null = null;
export const setRefreshHandler = (fn: typeof tryRefresh) => {
  tryRefresh = fn;
};

let baseUrl = "";
export const setBaseUrl = (u: string) => {
  baseUrl = u.replace(/\/$/, "");
};
export const getBaseUrl = () => baseUrl;

async function request<T>(path: string, opts: { method?: string; body?: unknown; auth?: boolean; headers?: Record<string, string> } = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.auth !== false && accessToken) headers.authorization = `Bearer ${accessToken}`;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "offline", "Network unavailable");
  }

  if (res.status === 401 && opts.auth !== false && !retried && tryRefresh) {
    const ok = await tryRefresh();
    if (ok) return request<T>(path, opts, true);
  }

  if (!res.ok) {
    let code = "unknown";
    let title = `Request failed (${res.status})`;
    try {
      const p = await res.json();
      if (p.code) code = p.code;
      if (p.title) title = p.title;
    } catch {
      /* keep defaults */
    }
    const ra = res.headers.get("retry-after");
    const sv = res.headers.get("x-server-version");
    throw new ApiError(res.status, code, title, ra ? Number(ra) : undefined, sv ? Number(sv) : undefined);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  prelogin: (email: string) =>
    request<{ kdf_params: string }>("/api/v1/auth/prelogin", { body: { email }, auth: false }),
  register: (payload: { email: string; kdf_params: string; auth_key_hash: string; device_name?: string }) =>
    request<AuthResponse>("/api/v1/auth/register", { body: payload, auth: false }),
  login: (payload: { email: string; auth_proof: string; device_name?: string }) =>
    request<AuthResponse>("/api/v1/auth/login", { body: payload, auth: false }),
  refresh: (refresh_token: string) =>
    request<{ access_token: string; expires_in: number; refresh_token: string }>(
      "/api/v1/auth/refresh",
      { body: { refresh_token }, auth: false }
    ),
  logout: (refresh_token: string) => request<void>("/api/v1/auth/logout", { body: { refresh_token }, auth: false }),
  pull: (since: number) =>
    request<{ server_version: number; tokens: WireRec[]; recoveries: WireRec[] }>(
      `/api/v1/sync?since_version=${since}`
    ),
  push: (base_version: number, tokens: WireRec[], recoveries: WireRec[], headers?: Record<string, string>) =>
    request<PushResponse>("/api/v1/sync", { method: "PUT", body: { base_version, tokens, recoveries }, headers }),
  changePwBegin: () =>
    request<{ lock_token: string; expires_in: number }>("/api/v1/user/change-password/begin", { body: {} }),
  changePwCommit: (payload: { lock_token: string; new_kdf_params: string; new_auth_key_hash: string }) =>
    request<{ ok: boolean; reauth_required: boolean }>("/api/v1/user/change-password", { body: payload }),
  deleteUser: (auth_proof: string) =>
    request<void>("/api/v1/user", { method: "DELETE", body: { auth_proof } }),
  reportAudit: (events: { action: string; ts: number; details?: Record<string, unknown> }[]) =>
    request<{ accepted: number }>("/api/v1/audit", { body: { events } }),
  auditList: () =>
    request<{ events: { id: number; action: string; ip: string | null; details: Record<string, unknown> | null; created_at: number }[] }>("/api/v1/audit"),
  health: () => request<{ status?: string }>("/api/health", { auth: false }),
};

export interface WireRec {
  id: string;
  token_id?: string;
  encrypted_data?: string;
  version?: number;
  deleted?: boolean;
  created_at?: number;
  updated_at: number;
}

export interface AuthResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  user: { id: string; email: string };
  kdf_params: string;
  settings_enc?: string | null;
  session_mode?: string;
}

export interface PushResponse {
  new_server_version: number;
  applied: {
    tokens: { id: string; version: number; updated_at: number; deleted: boolean }[];
    recoveries: { id: string; version: number; updated_at: number; deleted: boolean }[];
    total: number;
  };
}
