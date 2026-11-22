// CR-LINKPREVIEW.1 (Allen 11-22, "spec it for all three"; build go "skip email, build"): links to a customer's server
// that preview as "Sign in - Bervo Dashboard" / "Setup - Bervo Dashboard" instead of Cloudflare Access's own page.
//
// Every server's hostname sits behind Cloudflare Access, so a link straight to it previews (iMessage, Phase 0) as
// "Sign in · Cloudflare Access". https://bervo.ai/go/<label>/<page> is this page: our title and preview tags, then a
// same-origin script (/go.js, Phase 0 variant B) moves the browser on to https://<label>.bervo.ai/<page>.
//   * <label> = [a-z0-9-]{1,40} and not a reserved name; the target is ALWAYS https://<label>.bervo.ai, so this page
//     can never send anyone off bervo.ai (no open redirect).
//   * <page> from a fixed list: "" (home), mobile, welcome, welcome?step=texts, set-password. Anything else -> home.
//   * set-password links carry the one-time token in the FRAGMENT (/go/<label>/set-password#t=<token>), which a
//     browser never sends to bervo.ai; /go.js moves it to https://<label>.bervo.ai/set-password?t=<token>, exactly
//     the link the server issues. The page itself is the same for every token (no token is ever read here).
//   * Preview words follow the page (decision 2): "Setup - Bervo Dashboard" for set-password, welcome and
//     welcome?step=texts; "Sign in - Bervo Dashboard" for home and mobile. No names (decision 3).
//   * No data, no cookies, no third-party script. Pages does not apply _headers to a Function's response, so the
//     security headers are set here (the same as the rest of bervo.ai, with script-src 'self' for /go.js only).
//
// friendlyLink() is the one link builder for bervo.ai's own emails (mail.js) and the admin page's Copy; it mirrors
// daily-dashboard friendly_link.py (same label rule, reserved names, page list and demo hosts: keep them in step).
// friendlyLink and friendlyFromDirect are self-contained apart from the four GO_* constants, because the admin page
// embeds their source (functions/admin/invites.js) so its Copy box builds the same link in the browser.

export const GO_LABEL_RE = /^[a-z0-9-]{1,40}$/;
export const GO_RESERVED = ["www", "bervo", "connect", "api", "admin", "go", "mail", "email", "app", "apps", "cdn", "static",
  "assets", "status", "help", "support", "docs", "blog", "invite", "download", "brand", "auth", "login", "signin", "sso",
  "access", "id", "account", "accounts"];
export const GO_PAGES = ["", "mobile", "welcome", "welcome?step=texts", "set-password"];
// The public demo server is not behind Cloudflare Access (Google reviewer bypass): it keeps its direct link.
export const GO_DEMO_HOSTS = ["rehearsal.bervo.ai", "demo.bervo.ai"];

export const SETUP_TITLE = "Setup - Bervo Dashboard";
export const SIGNIN_TITLE = "Sign in - Bervo Dashboard";
export const GO_DESCRIPTION = "Your private Bervo dashboard.";
export const GO_IMAGE = "https://bervo.ai/brand/bervo-b.png";
export const GO_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'";
export const GO_CACHE = "public, max-age=300";

// The link to send for `page` on `host`. A host that is not <label>.bervo.ai (or a reserved label, or the demo)
// keeps the direct link https://<host>/<page> (?t=<token> for set-password). Unusable host -> null.
export function friendlyLink(host, page = "", token = null) {
  if (typeof host !== "string") return null;
  const h = host.trim().replace(/\/+$/, "").toLowerCase();
  if (!h || !/^[a-z0-9.-]{1,253}(?::\d{1,5})?$/.test(h)) return null;
  const p = GO_PAGES.includes(page) ? page : "";
  const withToken = p === "set-password" && token != null && token !== "";
  const direct = "https://" + h + "/" + p + (withToken ? "?t=" + token : "");
  if (withToken && !(typeof token === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(token))) return direct;
  if (GO_DEMO_HOSTS.includes(h) || !h.endsWith(".bervo.ai")) return direct;
  const label = h.slice(0, -".bervo.ai".length);
  if (!GO_LABEL_RE.test(label) || GO_RESERVED.includes(label)) return direct;
  return "https://bervo.ai/go/" + label + (p ? "/" + p : "") + (withToken ? "#t=" + token : "");
}

// A direct server link as the Mini / the router hand it to bervo.ai (https://<host>/set-password?t=<token>,
// https://<host>/, https://<host>/welcome?step=texts, https://<host>/mobile, https://<host>/welcome) -> the friendly
// link for the same page. Anything else comes back unchanged.
export function friendlyFromDirect(link) {
  let u;
  try { u = new URL(String(link)); } catch (e) { return link; }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash) return link;
  const keys = Array.from(u.searchParams.keys());
  let out = null;
  if (u.pathname === "/set-password" && keys.length === 1 && keys[0] === "t") out = friendlyLink(u.hostname, "set-password", u.searchParams.get("t"));
  else if (u.pathname === "/" && !u.search) out = friendlyLink(u.hostname, "");
  else if (u.pathname === "/mobile" && !u.search) out = friendlyLink(u.hostname, "mobile");
  else if (u.pathname === "/welcome" && !u.search) out = friendlyLink(u.hostname, "welcome");
  else if (u.pathname === "/welcome" && u.search === "?step=texts") out = friendlyLink(u.hostname, "welcome?step=texts");
  return out || link;
}

// The bervo.ai/go route. -> { status, label, page, target, title } (status 404 when the label is not allowed).
export function resolveGo(url) {
  const u = url instanceof URL ? url : new URL(String(url));
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] !== "go") return { status: 404 };
  const label = String(parts[1] || "").toLowerCase();
  if (!GO_LABEL_RE.test(label) || GO_RESERVED.includes(label)) return { status: 404 };
  const rest = parts.slice(2).join("/");
  let page = "";
  if (rest === "mobile" || rest === "set-password") page = rest;
  else if (rest === "welcome") page = u.searchParams.get("step") === "texts" ? "welcome?step=texts" : "welcome";
  const target = "https://" + label + ".bervo.ai/" + page;
  const title = page === "set-password" || page.startsWith("welcome") ? SETUP_TITLE : SIGNIN_TITLE;
  return { status: 200, label, page, target, title };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function goHeaders(extra = {}) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": GO_CSP,
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "accelerometer=(), bluetooth=(), browsing-topics=(), camera=(), display-capture=(), geolocation=(), " +
      "gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=()",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "Cache-Control": GO_CACHE,
    ...extra,
  };
}

export function goPage(r) {
  const setup = r.title === SETUP_TITLE;
  const words = setup ? "Opening your Bervo setup page..." : "Opening your Bervo sign-in page...";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${esc(r.title)}</title>
<meta property="og:title" content="${esc(r.title)}">
<meta property="og:site_name" content="Bervo">
<meta property="og:description" content="${esc(GO_DESCRIPTION)}">
<meta property="og:image" content="${esc(GO_IMAGE)}">
<meta property="og:type" content="website">
<meta name="bervo-go" content="${esc(r.target)}"${r.page === "set-password" ? ' data-token="fragment"' : ""}>
<script src="/go.js"></script>
<style>body{font-family:system-ui,sans-serif;background:#f6f8fb;color:#111;text-align:center;padding:4rem 1rem}</style>
</head><body><p>${esc(words)}</p><p><a href="${esc(r.target)}">Continue</a></p></body></html>
`;
}

const NOT_FOUND = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Not found - Bervo</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f8fb;color:#111;text-align:center;padding:4rem 1rem}</style>
</head><body><p>This link is not a Bervo address.</p><p><a href="https://bervo.ai/">bervo.ai</a></p></body></html>
`;

export function goResponse(request) {
  const r = resolveGo(new URL(request.url));
  if (r.status !== 200) return new Response(NOT_FOUND, { status: 404, headers: goHeaders({ "Cache-Control": "no-store" }) });
  return new Response(goPage(r), { status: 200, headers: goHeaders() });
}
