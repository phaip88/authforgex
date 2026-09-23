// Local-first service icon engine (spec §13 / R15): built-in brand palette,
// monogram tiles, NO CDN requests — privacy by default.

export interface ServiceInfo {
  name: string;
  color: string;
  aliases: string[];
  domains: string[];
}

const S = (name: string, color: string, aliases: string[] = [], domains: string[] = []): ServiceInfo => ({
  name,
  color,
  aliases: [name.toLowerCase(), ...aliases],
  domains: domains.length ? domains : [`${name.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`],
});

export const SERVICES: ServiceInfo[] = [
  S("Google", "#4285F4", ["gmail", "google cloud", "gcp", "youtube"], ["google.com", "gmail.com", "youtube.com"]),
  S("GitHub", "#e6edf3", ["gh"], ["github.com"]),
  S("GitLab", "#FC6D26", ["gl"], ["gitlab.com"]),
  S("Microsoft", "#00A4EF", ["ms", "office 365", "outlook", "azure", "live"], ["microsoft.com", "outlook.com", "live.com", "azure.com"]),
  S("Apple", "#A2AAAD", ["icloud", "apple id"], ["apple.com", "icloud.com"]),
  S("Amazon", "#FF9900", ["aws console"], ["amazon.com"]),
  S("AWS", "#FF9900", ["amazon web services", "aws"], ["aws.amazon.com", "amazonaws.com"]),
  S("Facebook", "#0866FF", ["fb", "meta"], ["facebook.com", "fb.com", "meta.com"]),
  S("Instagram", "#E1306C", ["ig"], ["instagram.com"]),
  S("X", "#e7e9ea", ["twitter", "x.com", "x corp"], ["x.com", "twitter.com"]),
  S("Discord", "#5865F2", [], ["discord.com", "discord.gg"]),
  S("Slack", "#4A154B", [], ["slack.com"]),
  S("Dropbox", "#0061FF", ["db"], ["dropbox.com"]),
  S("Netflix", "#E50914", ["nf"], ["netflix.com"]),
  S("Spotify", "#1DB954", [], ["spotify.com"]),
  S("Steam", "#66c0f4", ["steamguard", "steam guard", "valve"], ["steampowered.com", "steamcommunity.com"]),
  S("Epic Games", "#8a8aff", ["epic", "fortnite", "epicgames"], ["epicgames.com"]),
  S("Twitch", "#9146FF", [], ["twitch.tv"]),
  S("Reddit", "#FF4500", [], ["reddit.com"]),
  S("LinkedIn", "#0A66C2", [], ["linkedin.com"]),
  S("Binance", "#F0B90B", [], ["binance.com"]),
  S("Coinbase", "#0052FF", ["cb"], ["coinbase.com"]),
  S("Kraken", "#5A45FF", [], ["kraken.com"]),
  S("PayPal", "#003087", ["pp"], ["paypal.com"]),
  S("Stripe", "#635BFF", [], ["stripe.com"]),
  S("Shopify", "#95BF47", [], ["shopify.com", "myshopify.com"]),
  S("Cloudflare", "#F48120", ["cf"], ["cloudflare.com", "dash.cloudflare.com"]),
  S("Vercel", "#ededed", [], ["vercel.com"]),
  S("Netlify", "#00C7B7", [], ["netlify.com"]),
  S("DigitalOcean", "#0080FF", ["do"], ["digitalocean.com"]),
  S("Heroku", "#430098", [], ["heroku.com"]),
  S("Proton", "#6D4AFF", ["protonmail", "proton mail", "protonvpn"], ["proton.me", "protonmail.com"]),
  S("Bitwarden", "#175DDC", ["bw"], ["bitwarden.com"]),
  S("1Password", "#1A8CFF", ["1p", "onepassword"], ["1password.com"]),
  S("npm", "#CB3837", ["npmjs"], ["npmjs.com"]),
  S("Docker", "#1D63ED", ["docker hub", "dockerhub"], ["docker.com", "hub.docker.com"]),
  S("Atlassian", "#0052CC", [], ["atlassian.com", "atlassian.net"]),
  S("Jira", "#0052CC", [], ["jira.com", "atlassian.net"]),
  S("Notion", "#e8e6e3", [], ["notion.so"]),
  S("Figma", "#F24E1E", [], ["figma.com"]),
  S("Adobe", "#FA0F00", [], ["adobe.com"]),
  S("Zoom", "#0B5CFF", [], ["zoom.us"]),
  S("OpenAI", "#10a37f", ["chatgpt", "gpt"], ["openai.com", "chatgpt.com"]),
  S("Anthropic", "#D97757", ["claude"], ["anthropic.com", "claude.ai"]),
  S("TikTok", "#69C9D0", ["tik tok"], ["tiktok.com"]),
  S("WhatsApp", "#25D366", ["wa"], ["whatsapp.com"]),
  S("Telegram", "#2AABEE", ["tg"], ["telegram.org", "t.me"]),
  S("Signal", "#3A76F0", [], ["signal.org"]),
  S("Bitbucket", "#2684FF", ["bb"], ["bitbucket.org"]),
  S("WordPress", "#21759B", ["wp"], ["wordpress.com", "wordpress.org"]),
  S("Namecheap", "#DE3723", ["nc"], ["namecheap.com"]),
  S("GoDaddy", "#1BDBDB", [], ["godaddy.com"]),
  S("OVH", "#123F6D", ["ovhcloud"], ["ovh.com", "ovhcloud.com"]),
  S("Hetzner", "#D50C2D", [], ["hetzner.com"]),
  S("Linode", "#02B159", ["akamai"], ["linode.com"]),
  S("Vultr", "#007BFC", [], ["vultr.com"]),
  S("Firebase", "#FFCA28", [], ["firebase.google.com", "firebaseio.com"]),
  S("Supabase", "#3ECF8E", [], ["supabase.com"]),
  S("MongoDB", "#47A248", ["mongo"], ["mongodb.com"]),
  S("Twilio", "#F22F46", [], ["twilio.com"]),
  S("SendGrid", "#1A82E2", [], ["sendgrid.com"]),
  S("Mailchimp", "#FFE01B", [], ["mailchimp.com"]),
  S("Salesforce", "#00A1E0", ["sfdc"], ["salesforce.com"]),
  S("Adobe", "#FA0F00", [], ["adobe.com"]),
];

const byAlias = new Map<string, ServiceInfo>();
for (const s of SERVICES) for (const a of s.aliases) byAlias.set(a, s);

function clean(s: string): string {
  return s.toLowerCase().replace(/\b(inc|llc|ltd|corp|gmbh|co)\b\.?/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

export interface ResolvedIcon {
  name: string | null; // service name when matched
  color: string; // brand color or hash-derived fallback
  initial: string;
}

/** True when a token's issuer/account is associated with `host` (e.g. the
 *  extension matching tokens to the site you're on). Shared by web + extension
 *  so matching semantics never drift between surfaces. */
export function matchesHost(issuer: string, account: string | undefined, host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  if (!h) return false;
  const svc = resolveIcon(issuer, account);
  if (svc.name) {
    const s = SERVICES.find((x) => x.name === svc.name);
    if (s?.domains.some((d) => h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`))) return true;
  }
  if (account && account.includes("@")) {
    const domain = account.split("@")[1]?.toLowerCase() ?? "";
    if (domain && (h === domain || h.endsWith(`.${domain}`) || domain.endsWith(`.${h}`))) return true;
  }
  const c = clean(issuer);
  const bare = h.split(".")[0] ?? "";
  return !!c && (c === bare || c.replace(/\s/g, "") === h.replace(/[.-]/g, ""));
}

/** spec §13: exact alias → fuzzy contains → email-domain reverse lookup →
 *  local monogram with stable hash color (never a network request). */
export function resolveIcon(issuer: string, account?: string): ResolvedIcon {
  const raw = issuer.trim();
  const c = clean(raw);

  let hit = byAlias.get(c) ?? byAlias.get(raw.toLowerCase()) ?? null;
  if (!hit && c) {
    for (const s of SERVICES) {
      if (s.aliases.some((a) => c === a || c.includes(a) || a.includes(c))) {
        hit = s;
        break;
      }
    }
  }
  if (!hit && account && account.includes("@")) {
    const domain = account.split("@")[1]?.toLowerCase() ?? "";
    if (domain) {
      for (const s of SERVICES) {
        if (s.domains.some((d) => domain === d || domain.endsWith(`.${d}`) || d.endsWith(domain))) {
          hit = s;
          break;
        }
      }
    }
  }
  if (hit) return { name: hit.name, color: hit.color, initial: hit.name[0]!.toUpperCase() };

  // stable local fallback: initial + hue from issuer hash
  const seed = raw || account || "?";
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { name: null, color: `hsl(${hue} 62% 62%)`, initial: (raw[0] ?? account?.[0] ?? "?").toUpperCase() };
}
