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
      link.parentNode.insertBefore(out, link.nextSibling);
    });
  }

  // Canonical header labels (owner-set): Jobs | Chat | Memory | Experts.
  var LABELS = {
    jobs: ["id,jobsLink", "Jobs"],
    talk: ["id,talkLink", "Chat"],
    memory: ["id,memLink", "Memory"],
    experts: ["", "Experts"]
  };

  function renderHeader(active) {
    // Normalize nav labels in place; mark the active tab.
    var nav = document.querySelector("header nav");
    if (!nav) return;
    var links = nav.querySelectorAll("a");
    var map = ["/buzzy/", "/buzzy/talk", "/buzzy/memory", "/buzzy/experts"];
    var names = ["Jobs", "Chat", "Memory", "Experts"];
    for (var i = 0; i < links.length && i < 4; i++) {
      var href = links[i].getAttribute("href") || "";
      if (map.indexOf(href) !== -1) {
        links[i].textContent = names[i];
        if (names[i].toLowerCase() === active) links[i].classList.add("active");
      }
    }
  }

  window.__bzSession = resolveSession;
  window.__bzHeader = function (active) {
    renderHeader(active);
    renderAccount();
  };

  // Auto-run when the page declares its active tab via <body data-bz-active="...">,
  // otherwise pages call window.__bzHeader('jobs') themselves.
  if (document.body && document.body.getAttribute("data-bz-active")) {
    document.addEventListener("DOMContentLoaded", function () {
      window.__bzHeader(document.body.getAttribute("data-bz-active"));
    });
  }
})();
