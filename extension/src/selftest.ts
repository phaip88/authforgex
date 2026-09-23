// Bundle self-test: runs the RFC vectors against the *compiled* extension
// bundle, so what gets shipped is what gets verified (spec §15).
//
//   node extension/dist/selftest.mjs

import { base32Decode, base32Encode, hotpCode } from "../../src/lib/client/totp";
import { decryptJson, deriveKeys, encryptJson, newKdfParams } from "../../src/lib/client/crypto";

let pass = 0;
let fail = 0;
const ok = (name: string, got: unknown, want: unknown) => {
  if (got === want) {
    pass++;
    console.log(`ok   ${name} = ${got}`);
  } else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
};

async function main() {
  // ---- RFC 4226 appendix D (HMAC-SHA1, secret = "12345678901234567890") ----
  const rfcSecret = new TextEncoder().encode("12345678901234567890");
  const expect = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  for (let i = 0; i < expect.length; i++) {
    ok(`RFC4226 c${i}`, await hotpCode(rfcSecret, i, 6, "SHA1"), expect[i]);
  }

  // ---- RFC 6238 (8-digit, T = 59s ⇒ counter 1) ----
  ok(
    "RFC6238 SHA1 T=59",
    await hotpCode(rfcSecret, 1, 8, "SHA1"),
    "94287082"
  );
  ok(
    "RFC6238 SHA256 T=59",
    await hotpCode(new TextEncoder().encode("12345678901234567890123456789012"), 1, 8, "SHA256"),
    "46119246"
  );
  ok(
    "RFC6238 SHA512 T=59",
    await hotpCode(
      new TextEncoder().encode("1234567890123456789012345678901234567890123456789012345678901234"),
      1,
      8,
      "SHA512"
    ),
    "90693936"
  );

  // ---- base32 roundtrip ----
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  ok("base32 roundtrip", Buffer.from(base32Decode(base32Encode(bytes))).toString("hex"), Buffer.from(bytes).toString("hex"));
  ok("base32 known vector", Buffer.from(base32Decode("JBSWY3DPEHPK3PXP")).toString("utf8").startsWith("Hello!"), true);

  // ---- key derivation + AES-GCM envelope (fast KDF params for CI) ----
  const params = JSON.stringify({ algorithm: "PBKDF2-SHA256", iterations: 1000, salt: newKdfParams() ? JSON.parse(newKdfParams()).salt : "" });
  const keys = await deriveKeys("correct horse battery staple", params);
  const payload = await encryptJson(keys.encKey, "rec-1", { issuer: "GitHub", secret: "JBSWY3DPEHPK3PXP" });
  ok("AES-GCM roundtrip", (await decryptJson<{ issuer: string }>(keys.encKey, "rec-1", payload)).issuer, "GitHub");

  // AAD = record id ⇒ tampering with the id must break the tag
  let aadRejected = false;
  try {
    await decryptJson(keys.encKey, "rec-2", payload);
  } catch {
    aadRejected = true;
  }
  ok("AAD binding rejects wrong record id", aadRejected, true);

  // wrong password ⇒ different keys ⇒ decryption fails
  const other = await deriveKeys("wrong password", params);
  let wrongKeyRejected = false;
  try {
    await decryptJson(other.encKey, "rec-1", payload);
  } catch {
    wrongKeyRejected = true;
  }
  ok("wrong key rejected", wrongKeyRejected, true);

  // keys must differ per HKDF info label
  ok(
    "HKDF separates auth/enc keys",
    Buffer.from(keys.authKey).toString("hex") === Buffer.from(keys.encKey).toString("hex"),
    false
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
