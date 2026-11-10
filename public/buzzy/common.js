/* common.js — shared session resolution + header account block for all buzzy pages.
 * Plain IIFE, no imports, static-server safe. Loaded after the page's own markup,
 * so the original inline header remains as a no-JS fallback.
 */
(function () {
  "use strict";

  // Resolve the logged-in user. Never throws: errors/timeout -> null.
  function resolveSession() {
    return fetch("/api/auth/get-session", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (session) { return (session && session.user) ? session.user : null; })
      .catch(function () { return null; });
  }

  // Account identity is the chrome's job (nav.js owns the chip and its dropdown menu).
  // This file used to insert a second 'Log out' beside the nav, which is exactly the
  // duplicate identity the chrome was written to remove.
  function renderAccount() {}

  // Canonical header labels (owner-set): Jobs | Chat | Memory | Experts.
  var LABELS = {
    jobs: ["id,jobsLink", "Jobs"],
    talk: ["id,talkLink", "Chat"],
    memory: ["id,memLink", "Memory"],
    experts: ["", "Experts"]
  };

  // The nav labels and active state are owned by the page markup + the shared
  // nav script. This used to rename links BY INDEX against a hard-coded href
  // map, so once the nav order changed it relabelled the Talk link "Jobs" —
  // a link called Jobs that opened the chat. It no longer touches labels.
  function renderHeader(active) {
    var nav = document.querySelector("#bzNav") || document.querySelector("header nav");
    if (!nav || !active) return;
    var links = nav.querySelectorAll("a[data-nav]");
    for (var i = 0; i < links.length; i++) {
      var on = links[i].getAttribute("data-nav") === active;
      links[i].classList.toggle("active", on);
    }
  }

  // Signed-out visitors never see console pages — send them to the landing.
  function gateSignedOut() {
    resolveSession().then(function (user) {
      if (!user) window.location.replace("/");
    });
  }

  window.__bzSession = resolveSession;
  window.__bzGate = gateSignedOut;
  window.__bzHeader = function (active) {
    renderHeader(active);
    renderAccount();
    gateSignedOut();
  };

  // Auto-run when the page declares its active tab via <body data-bz-active="...">,
  // otherwise pages call window.__bzHeader('jobs') themselves.
  if (document.body && document.body.getAttribute("data-bz-active")) {
    document.addEventListener("DOMContentLoaded", function () {
      window.__bzHeader(document.body.getAttribute("data-bz-active"));
      gateSignedOut();
    });
  }
})();
