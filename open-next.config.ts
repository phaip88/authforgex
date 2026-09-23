import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Minimal single-function configuration; override per-function limits if the
// sync endpoints ever need longer wall time (cf. opennext.js.org/cloudflare).
export default defineCloudflareConfig({});
