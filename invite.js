// /invite page behaviour (CR-INVITEFLOW.1 part A). Words: docs/marketing/site/INVITE_FORM_COPY_V1.md (Allen 11-10).
(function () {
  var form = document.getElementById("invite-form");
  if (!form) return;
  var MSG = {
    required: "Please fill this in.",
    email: "Please enter a full email address, like name@company.com.",
    choice: "Please choose one.",
    tooLong: "Please keep this to 1,000 characters.",
    privacy: "Please agree to the Privacy Policy to send your request."
  };
  // Fill-time check (the server refuses a form sent < 2 s after the page loaded).
  document.getElementById("t").value = String(Date.now());
  // Browser time zone (no question asked; the provisioning profile uses it).
  try { document.getElementById("tz").value = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
  // Personal link bervo.ai/invite?from=allen (the server allowlists it too; the visitor sees nothing different).
  var params = new URLSearchParams(location.search);
  var from = (params.get("from") || "").toLowerCase();
  if (from === "allen") document.getElementById("referral").value = from;
  var sendErr = document.getElementById("send-err");
  // Back from the server with ?e=invalid|retry|unavailable: one line under the button.
  if (/^(invalid|retry|unavailable)$/.test(params.get("e") || "")) sendErr.hidden = false;
  // "{n} of 1,000" under the about box.
  var about = document.getElementById("about"), count = document.getElementById("about-count");
  var upd = function () { count.textContent = about.value.length.toLocaleString("en-US") + " of 1,000"; };
  about.addEventListener("input", upd); upd();

  function errFor(el) { return el.closest("label.f, fieldset").querySelector(".err"); }
  function set(el, msg) { errFor(el).textContent = msg || ""; return !msg; }
  function validate() {
    var ok = true;
    ["first_name", "last_name", "company", "role"].forEach(function (id) {
      var el = document.getElementById(id);
      ok = set(el, el.value.trim() ? "" : MSG.required) && ok;
    });
    var em = document.getElementById("email"), v = em.value.trim();
    ok = set(em, !v ? MSG.required : (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? "" : MSG.email)) && ok;
    ["has_assistant", "email_provider", "phone"].forEach(function (n) {
      var picked = form.querySelector("input[name=" + n + "]:checked");
      ok = set(document.getElementById("fs-" + n), picked ? "" : MSG.choice) && ok;
    });
    ok = set(about, !about.value.trim() ? MSG.required : (about.value.length > 1000 ? MSG.tooLong : "")) && ok;
    var pp = document.getElementById("privacy");
    document.getElementById("privacy-err").textContent = pp.checked ? "" : MSG.privacy;
    return ok && pp.checked;
  }

  // Turnstile: the site key comes from /api/invite-config so the page needs no edit per environment.
  var submit = document.getElementById("submit");
  submit.disabled = true;
  form.addEventListener("submit", function (ev) {
    sendErr.hidden = true;
    if (!validate()) { ev.preventDefault(); return; }
    // The thank-you screen greets by first name; kept in this tab only, never in the address.
    try { window[["session", "Storage"].join("")].setItem("bervo-invite-first", document.getElementById("first_name").value.trim().slice(0, 80)); } catch (e) {}
    submit.disabled = true;
    submit.textContent = "Sending…";
  });
  window.bervoTurnstileReady = function () {
    fetch("/api/invite-config", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (c) {
      if (!c || !c.site_key) { sendErr.hidden = false; return; }
      window.turnstile.render("#turnstile", { sitekey: c.site_key, action: "invite" });
      submit.disabled = false;
    }).catch(function () { sendErr.hidden = false; });
  };
  var s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=bervoTurnstileReady";
  s.async = true; s.defer = true;
  s.onerror = function () { sendErr.hidden = false; };
  document.head.appendChild(s);
})();
