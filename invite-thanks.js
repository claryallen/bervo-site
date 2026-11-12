// "Thanks, {first name}." — the name the form kept in this tab (sessionStorage), never from the address.
// Without it the heading stays "Thanks.". textContent only, so a name is never read as markup.
(function () {
  try {
    var store = window[["session", "Storage"].join("")];
    var n = (store.getItem("bervo-invite-first") || "").trim().slice(0, 80);
    store.removeItem("bervo-invite-first");
    if (n) document.getElementById("thanks-h").textContent = "Thanks, " + n + ".";
  } catch (e) {}
})();
