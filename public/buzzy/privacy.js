/**
 * The privacy control on the Talk bar: one three-position slider —
 * Advocate · Lockdown · Open (owner's roadmap, phase 5; reference A6b7ky7 shows
 * the globe + open-lock control at the bar's top right, zMWSgG0 the green
 * "Open to the world" pill).
 *
 * What each mode does on the hosted site TODAY (said in the picker, word for word):
 *   Open      — the website's default (the desktop app starts on Advocate; the server
 *               says which via GET /api/buzzy/privacy). Publishing finished work is not switched on yet,
 *               so nothing is published automatically.
 *   Advocate  — BeeZilla works only for you; nothing is published.
 *   Lockdown  — nothing extra leaves BeeZilla: no web lookups, no music, picture or
 *               3D makers (the server enforces this per turn), and the Inspiration
 *               wall is hidden. Messages still reach the AI that answers.
 *
 * Saved to the account (GET/PUT /api/buzzy/privacy — the server also applies the
 * account's Lockdown on every chat turn), mirrored in this browser
 * (localStorage "bz.privacy") so the page knows it before the network answers, and
 * sent with every chat turn as `privacy`. window.bzPrivacy() reads it; a
 * "bz:privacy" event announces changes.
 */
(function () {
  "use strict";

  var KEY = "bz.privacy";
  var MODES = {
    advocate: {
      label: "Advocate",
      long: "Advocate",
      desc: "BeeZilla works only for you. Your messages go to the AI that answers you and to the tools you ask for — nothing is published.",
    },
    lockdown: {
      label: "Lockdown",
      long: "Lockdown",
      desc: "Nothing extra leaves BeeZilla: no web lookups, and no music, picture or 3D makers. The Inspiration wall is hidden. Your messages still reach the AI that answers you — that is how the website works.",
    },
    open: {
      label: "Open",
      long: "Open to the world",
      desc: "Your finished work can be shared with everyone. Publishing is not switched on yet, so nothing is published automatically — sharing stays your choice, item by item.",
    },
  };
  var ORDER = ["advocate", "lockdown", "open"];

  var fallback = "open"; // replaced by the deployment's default once the server answers
  function read() {
    var v = null;
    try { v = localStorage.getItem(KEY); } catch (_) { /* private mode */ }
    return MODES[v] ? v : fallback;
  }
  function write(v) {
    try { localStorage.setItem(KEY, v); } catch (_) { /* best effort */ }
  }
  window.bzPrivacy = read;

  var ICONS = {
    globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>',
    unlock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.7"/></svg>',
    lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  };
  function iconsFor(mode) {
    if (mode === "open") return ICONS.globe + ICONS.unlock;
    if (mode === "lockdown") return ICONS.lock;
    return ICONS.shield;
  }

  var btn = document.getElementById("privacyBtn");
  var pop = document.getElementById("privacyPop");
  var chip = document.getElementById("privacyChip");
  if (!btn || !pop) return;
  var desc = document.getElementById("privacyDesc");
  var radios = Array.prototype.slice.call(pop.querySelectorAll("[data-mode]"));
  var slider = pop.querySelector(".pp-slider");

  function paint() {
    var mode = read();
    var m = MODES[mode];
    btn.innerHTML = '<span class="pv-icons">' + iconsFor(mode) + "</span>";
    btn.setAttribute("aria-label", "Privacy: " + m.long + " — change");
    btn.title = "Privacy: " + m.long;
    btn.setAttribute("data-mode", mode);
    if (desc) desc.textContent = m.desc;
    if (slider) slider.setAttribute("data-mode", mode);
    radios.forEach(function (r) {
      var on = r.getAttribute("data-mode") === mode;
      r.setAttribute("aria-checked", on ? "true" : "false");
      r.tabIndex = on ? 0 : -1;
    });
    if (chip) {
      chip.setAttribute("data-mode", mode);
      chip.innerHTML = '<span class="pv-icons">' + iconsFor(mode) + "</span>" + m.long + " &#9662;";
      chip.setAttribute("aria-label", "Privacy: " + m.long + " — open the privacy control");
    }
  }

  function save(mode) {
    return fetch("/api/buzzy/privacy", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: mode }),
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  function apply(mode) {
    write(mode);
    paint();
    try { window.dispatchEvent(new CustomEvent("bz:privacy", { detail: { mode: mode } })); } catch (_) { /* best effort */ }
  }

  function paintDefault(mode) {
    if (!MODES[mode]) return;
    fallback = mode;
    paint();
    try { window.dispatchEvent(new CustomEvent("bz:privacy", { detail: { mode: mode } })); } catch (_) { /* old browsers */ }
  }

  function set(mode) {
    if (!MODES[mode] || mode === read()) { paint(); return; }
    apply(mode);
    save(mode).then(function (ok) {
      if (!ok && desc) desc.textContent = MODES[mode].desc + " (Saved in this browser only — couldn't reach your account.)";
    });
  }

  // The account is the source of truth. A choice made in this browser before it
  // was saved to the account is carried up once.
  fetch("/api/buzzy/privacy", { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j || !j.ok || !MODES[j.mode]) return;
      var local = null;
      try { local = localStorage.getItem(KEY); } catch (_) { /* best effort */ }
      if (j.saved) { if (j.mode !== read()) apply(j.mode); }
      else if (MODES[local]) { if (local !== j.mode) save(local); }
      // Nothing chosen yet: show this deployment's default (Open on the website,
      // Advocate in the desktop app), without saving it as a choice.
      else if (j.mode !== read()) paintDefault(j.mode);
    })
    .catch(function () {});

  function open() {
    pop.classList.remove("hidden");
    if (chip) chip.classList.add("hidden");
    btn.setAttribute("aria-expanded", "true");
    var on = pop.querySelector('[aria-checked="true"]');
    if (on) on.focus();
  }
  function close(toChip) {
    pop.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
    // Minimise keeps the mode in view as a small pill; close puts it away.
    if (chip) chip.classList.toggle("hidden", !toChip);
  }

  btn.addEventListener("click", function () {
    if (pop.classList.contains("hidden")) open(); else close(false);
  });
  if (chip) chip.addEventListener("click", open);
  var min = document.getElementById("privacyMin");
  var x = document.getElementById("privacyClose");
  if (min) min.addEventListener("click", function () { close(true); });
  if (x) x.addEventListener("click", function () { close(false); btn.focus(); });

  radios.forEach(function (r) {
    r.addEventListener("click", function () { set(r.getAttribute("data-mode")); });
    r.addEventListener("keydown", function (e) {
      var at = ORDER.indexOf(read());
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); set(ORDER[(at + 1) % 3]); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); set(ORDER[(at + 2) % 3]); }
      else return;
      var on = pop.querySelector('[aria-checked="true"]');
      if (on) on.focus();
    });
  });
  pop.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); close(false); btn.focus(); }
  });
  document.addEventListener("click", function (e) {
    if (pop.classList.contains("hidden")) return;
    if (pop.contains(e.target) || btn.contains(e.target) || (chip && chip.contains(e.target))) return;
    close(false);
  });

  paint();
})();
