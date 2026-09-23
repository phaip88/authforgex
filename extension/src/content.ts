// AuthForge content script (spec §11.2 / R11).
//
// 1. Reports location.hostname to the service worker on injection. This is the
//    documented replacement for reading tab.url, which would require the `tabs`
//    permission (activeTab gives no URL to extension pages).
// 2. Detects 2FA input fields and fills a code ONLY on explicit request
//    (popup button or Ctrl+Shift+F). It never auto-submits a form.

(() => {
  const HOST = location.hostname;

  const report = () => {
    chrome.runtime.sendMessage({ type: "af-host", host: HOST }).catch(() => undefined);
  };
  report();

  // Selector chain — most-specific first. Case-insensitive attribute matching
  // ([attr*="x" i]) is supported in Chrome 49+.
  const SELECTORS = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[name*="totp" i]',
    'input[name*="2fa" i]',
    'input[name*="mfa" i]',
    'input[name*="verification_code" i]',
    'input[id*="otp" i]',
    'input[placeholder*="验证码"]',
    'input[placeholder*="verification" i]',
    'input[placeholder*="code" i]',
    'input[maxlength="6"][inputmode="numeric"]',
    'input[maxlength="6"][type="tel"]',
    'input[maxlength="8"][inputmode="numeric"]',
  ];

  function isVisible(el: HTMLElement): boolean {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  }

  function findOtpInput(): HTMLInputElement | null {
    for (const sel of SELECTORS) {
      for (const el of Array.from(document.querySelectorAll<HTMLInputElement>(sel))) {
        if (el.disabled || el.readOnly || !isVisible(el)) continue;
        if (el.type === "hidden" || el.type === "checkbox" || el.type === "radio") continue;
        return el;
      }
    }
    return null;
  }

  /**
   * React/Vue/Svelte controlled inputs ignore direct `value` assignment — the
   * framework's virtual DOM overwrites it on the next render. Setting through
   * the prototype's native setter and dispatching bubbling `input`/`change`
   * events is the only reliable path (spec R11).
   */
  function fillInput(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.focus({ preventScroll: true });
    const end = value.length;
    el.setSelectionRange?.(end, end);
  }

  let lastFilled = 0;

  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    const msg = raw as { type?: string; host?: string; code?: string };
    switch (msg?.type) {
      // Late-opening popup asks for the host directly (content script always
      // knows its own URL — no permission needed).
      case "af-ping-host":
        sendResponse({ host: HOST, hasOtpInput: !!findOtpInput() });
        return true;
      case "af-fill": {
        if (!msg.code) {
          sendResponse({ ok: false, error: "no-code" });
          return true;
        }
        const el = findOtpInput();
        if (!el) {
          sendResponse({ ok: false, error: "no-otp-input" });
          return true;
        }
        // Guard against a page replaying a fill message in a tight loop.
        const now = Date.now();
        if (now - lastFilled < 400) {
          sendResponse({ ok: false, error: "rate-limited" });
          return true;
        }
        lastFilled = now;
        fillInput(el, msg.code);
        sendResponse({ ok: true });
        return true;
      }
      case "af-has-input":
        sendResponse({ ok: !!findOtpInput() });
        return true;
      default:
        return undefined;
    }
  });

  // Re-report when the page navigates inside the same document (SPA route
  // changes keep the hostname, but a fresh report keeps the badge accurate).
  let lastUrl = location.href;
  const obs = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      report();
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
