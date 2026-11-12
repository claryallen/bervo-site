// /invite page behaviour (CR-INVITEFLOW.1 part A). Words: docs/marketing/site/INVITE_FORM_COPY_V1.md (Allen 11-10).
(function () {
  var form = document.getElementById("invite-form");
  if (!form) return;
  var MSG = {
    required: "Please fill this in.",
    email: "Please enter a full email address, like name@company.com.",
    choice: "Please choose one.",
    choiceAny: "Please choose at least one.",
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
  // The Pricing page buttons pre-select a plan: ?plan=standard | ?plan=private (allowlisted).
  var plan = (params.get("plan") || "").toLowerCase();
  if (plan === "standard" || plan === "private") {
    var r = form.querySelector('input[name=plan][value="' + plan + '"]');
    if (r) r.checked = true;
  }
  var sendErr = document.getElementById("send-err");
  // Back from the server with ?e=invalid|retry|unavailable: one line under the button.
  if (/^(invalid|retry|unavailable)$/.test(params.get("e") || "")) sendErr.hidden = false;
  // "{n} of 1,000" under the about box.
  var about = document.getElementById("about"), count = document.getElementById("about-count");
  var upd = function () { count.textContent = about.value.length.toLocaleString("en-US") + " of 1,000"; };
  about.addEventListener("input", upd); upd();

  // Other email provider: "What other email account(s)?" shows only while Other is ticked (Allen 11-11).
  var epOther = document.getElementById("ep-other"), otherWrap = document.getElementById("other-wrap"),
    otherEmail = document.getElementById("other_email");
  var showOther = function () {
    otherWrap.hidden = !epOther.checked;
    otherEmail.disabled = !epOther.checked;          // a hidden answer is never sent
  };
  epOther.addEventListener("change", showOther); showOther();

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
    ["has_assistant", "email_provider", "phone", "plan"].forEach(function (n) {
      var picked = form.querySelector("input[name=" + n + "]:checked");
      ok = set(document.getElementById("fs-" + n), picked ? "" : (n === "email_provider" ? MSG.choiceAny : MSG.choice)) && ok;
    });
    if (epOther.checked) ok = set(otherEmail, otherEmail.value.trim() ? "" : MSG.required) && ok;
    ok = set(about, !about.value.trim() ? MSG.required : (about.value.length > 1000 ? MSG.tooLong : "")) && ok;
    var pp = document.getElementById("privacy");
    document.getElementById("privacy-err").textContent = pp.checked ? "" : MSG.privacy;
    return ok && pp.checked;
  }

  // Turnstile: the site key comes from /api/invite-config so the page needs no edit per environment.
  // The button looks normal from the start and nothing red shows at load. If Turnstile is not ready (config
  // missing, script blocked, or no token yet) a press shows the could-not-send line and sends nothing:
  // without a Turnstile token no request is ever sent (and the server refuses one anyway).
  var submit = document.getElementById("submit");
  var ready = false;
  form.addEventListener("submit", function (ev) {
    sendErr.hidden = true;
    if (!validate()) { ev.preventDefault(); return; }
    var tok = form.querySelector('[name="cf-turnstile-response"]');
    if (!ready || !tok || !tok.value) { ev.preventDefault(); sendErr.hidden = false; return; }
    // The thank-you screen greets by first name; kept in this tab only, never in the address.
    try { window[["session", "Storage"].join("")].setItem("bervo-invite-first", document.getElementById("first_name").value.trim().slice(0, 80)); } catch (e) {}
    submit.disabled = true;
    submit.textContent = "Sending…";
  });
  window.bervoTurnstileReady = function () {
    fetch("/api/invite-config", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (c) {
      if (!c || !c.site_key) return;                 // not configured: fail closed, quietly until a press
      window.turnstile.render("#turnstile", { sitekey: c.site_key, action: "invite" });
      ready = true;
    }).catch(function () {});
  };
  var s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=bervoTurnstileReady";
  s.async = true; s.defer = true;
  document.head.appendChild(s);
})();
