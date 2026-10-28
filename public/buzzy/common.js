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

  // Session-aware account link: user name + Log out, or keep the Sign in link.
  function renderAccount() {
    var link = document.querySelector(".account-link");
    if (!link) return;
    resolveSession().then(function (user) {
      if (!user || !user.name) return; // keep the Sign in link
      link.textContent = user.name;
      link.removeAttribute("href");
      link.style.cursor = "default";
      var out = document.createElement("a");
      out.href = "#";
      out.textContent = "Log out";
      out.addEventListener("click", function (e) {
        e.preventDefault();
        fetch("/api/auth/sign-out", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: "{}",
        }).then(function () { window.location.href = "/buzzy/"; });
      });
      // Place the Log out link beside the nav, not as a 9th nav item.
      var navEl = document.querySelector("#bzNav");
      if (navEl && navEl.parentNode && navEl.contains(link)) navEl.parentNode.insertBefore(out, navEl.nextSibling);
      else link.parentNode.insertBefore(out, link.nextSibling);
    });
  }

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
