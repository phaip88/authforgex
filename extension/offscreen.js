// Offscreen clipboard writer (spec §12.3 / R12).
// MV3 service workers can lose clipboard focus (notably when an ALARM wakes
// them 30 s later with no user gesture). An offscreen document owns a real
// DOM, so its clipboard writes succeed — this is what makes the "extension
// guarantees clipboard clearing" claim true rather than best-effort.
chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = raw && typeof raw === "object" ? raw : {};
  if (msg.type !== "af-clip-write") return undefined;
  navigator.clipboard
    .writeText(String(msg.text ?? ""))
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true; // async response
});
