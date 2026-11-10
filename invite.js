// /invite page behaviour (CR-INVITEFLOW.1 part A). No customer words here: messages live in invite.html.
(function () {
  var form = document.getElementById("invite-form");
  if (!form) return;
  // Fill-time check (the server refuses a form sent < 2 s after the page loaded).
  document.getElementById("t").value = String(Date.now());
  // Browser time zone (no question asked; the provisioning profile uses it).
  try { document.getElementById("tz").value = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
  // Personal link bervo.ai/invite?from=allen (display only on the admin page; the server allowlists it too).
  var params = new URLSearchParams(location.search);
  var from = (params.get("from") || "").toLowerCase();
  if (from === "allen") document.getElementById("referral").value = from;
  // Error notice after a server redirect (?e=invalid|retry|unavailable).
  var e = params.get("e");
  if (e && /^(invalid|retry|unavailable)$/.test(e)) document.getElementById("e-" + e).hidden = false;
  // Character count for the about box.
  var about = document.getElementById("about"), count = document.getElementById("about-count");
  var upd = function () { count.textContent = String(about.value.length); };
  about.addEventListener("input", upd); upd();
  // Turnstile: the site key comes from /api/invite-config so the page needs no edit per environment.
  var submit = document.getElementById("submit");
  submit.disabled = true;
  window.bervoTurnstileReady = function () {
    fetch("/api/invite-config", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (c) {
      if (!c || !c.site_key) { document.getElementById("e-unavailable").hidden = false; return; }
      window.turnstile.render("#turnstile", { sitekey: c.site_key, action: "invite" });
      submit.disabled = false;
    }).catch(function () { document.getElementById("e-unavailable").hidden = false; });
  };
  var s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=bervoTurnstileReady";
  s.async = true; s.defer = true;
  document.head.appendChild(s);
})();
