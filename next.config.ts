import type { NextConfig } from "next";

// Security headers (spec §9 / R23 production hardening).
// - No cookies are used (Authorization header only), so cross-origin browser
//   calls are blocked by default: no CORS surface.
// - script-src keeps 'unsafe-inline' because Next's RSC payload and the
//   pre-paint theme boot script are inline; everything else is self-origin.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // 'self' = same-origin API; https: lets the PWA attach a remote self-hosted server
      "connect-src 'self' https:",
      "worker-src 'self' blob:",
      "form-action 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

if (process.env.NODE_ENV === "development") {
  initOpenNextCloudflareForDev();
}

// AF_TARGET=cloudflare produces the OpenNext-compatible build (no `standalone`
// output, which OpenNext rejects); every other build keeps the Docker entrypoint.
const forCloudflare =
  process.env.AF_TARGET === "cloudflare" ||
  process.env.npm_lifecycle_event === "build:worker" ||
  process.env.npm_lifecycle_event === "deploy";

const nextConfig: NextConfig = {
  ...(forCloudflare ? {} : { output: "standalone" }),
  // Cloudflare Workers has no public filesystem; static assets ship in the
  // Worker's asset bucket.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
