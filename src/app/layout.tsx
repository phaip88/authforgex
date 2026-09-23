import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AuthForge — Zero-knowledge 2FA Vault",
  description:
    "Self-hosted, end-to-end encrypted two-factor authenticator. TOTP/HOTP/Steam codes, recovery-code management, offline-first sync. The server never sees your secrets.",
  applicationName: "AuthForge",
  icons: [{ rel: "icon", url: "/icon.svg", type: "image/svg+xml" }],
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0c10" },
    { media: "(prefers-color-scheme: light)", color: "#f0f1ea" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Applies saved theme + language before first paint (no flash of wrong theme).
const BOOT = `(function(){try{var t=localStorage.getItem('af-theme');if(!t)t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;var l=localStorage.getItem('af-lang');if(!l)l=(navigator.language||'').toLowerCase().indexOf('zh')===0?'zh':'en';document.documentElement.lang=l==='zh'?'zh-CN':'en';}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      </head>
      <body className={`${display.variable} ${mono.variable} bg-[var(--bg)] text-[var(--tx)] antialiased`}>{children}</body>
    </html>
  );
}
