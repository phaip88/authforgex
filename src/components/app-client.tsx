"use client";

import dynamic from "next/dynamic";

// The vault needs IndexedDB + WebCrypto — render client-side only.
const VaultApp = dynamic(() => import("./vault-app"), { ssr: false });

export default function AppClient() {
  return <VaultApp />;
}
