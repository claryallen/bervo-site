// CR-LINKPREVIEW.1: the one script of https://bervo.ai/go/<label>/<page> (functions/_lib/golink.js). It reads the
// target from the page's own <meta name="bervo-go">, checks it is https://<label>.bervo.ai/<allowed page> again, and
// for a setup link moves the one-time token from this page's fragment (#t=..., never sent to bervo.ai) to the
// server's own ?t=. location.replace: the bervo.ai entry (and its fragment) leaves the history.
(function () {
  var m = document.querySelector('meta[name="bervo-go"]');
  if (!m) return;
  var target = m.getAttribute("content") || "";
  if (!/^https:\/\/[a-z0-9-]{1,40}\.bervo\.ai\/(mobile|welcome|welcome\?step=texts|set-password)?$/.test(target)) return;
  if (m.getAttribute("data-token") === "fragment") {
    var h = /^#t=([A-Za-z0-9_-]{16,128})$/.exec(location.hash || "");
    if (h) target += "?t=" + h[1];
  }
  location.replace(target);
})();
