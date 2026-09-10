"use strict";

/*
 * Task-31A product routing helper (no credentials / no sensitive data).
 *
 * Centralizes the public product base path so pages do not hardcode "/task21/".
 * The product may be served from a newer base like "/chat/" while the legacy
 * "/task21/" entry stays compatible. All helpers derive the base from the
 * current location.pathname, so the same file works under either base.
 *
 * Exposed as window.TASK31_ROUTING in the browser and module.exports in Node
 * so tests can import it directly.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TASK31_ROUTING = factory();
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  // Recognized product base directory names, newest first.
  const KNOWN_BASES = ["/chat", "/task21"];

  function currentPathname() {
    if (typeof window !== "undefined" && window.location) return window.location.pathname || "";
    return "";
  }

  // Returns the leading product base directory (no trailing slash), e.g.
  // "/chat" for "/chat/login.html", or "/task21" for "/task21/index.html".
  function productBasePath(pathname) {
    const p = String(pathname || currentPathname() || "");
    for (let i = 0; i < KNOWN_BASES.length; i++) {
      const base = KNOWN_BASES[i];
      if (p === base || p === base + "/" || p.indexOf(base + "/") === 0) return base;
    }
    // Fallback: the directory of the current page.
    const idx = p.lastIndexOf("/");
    if (idx > 0) return p.slice(0, idx);
    return "/";
  }

  function productBaseUrl(pathname) { return productBasePath(pathname) + "/"; }
  function productHomeUrl(pathname) { return productBaseUrl(pathname); }
  function productLoginUrl(pathname) { return productBaseUrl(pathname) + "login.html"; }

  return {
    productBasePath,
    productBaseUrl,
    productHomeUrl,
    productLoginUrl,
  };
});
