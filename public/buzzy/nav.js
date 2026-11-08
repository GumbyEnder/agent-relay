/**
 * The site chrome: one nav, one company switcher, one way to talk.
 *
 * Three problems this file exists to end:
 *
 *  1. **The company switcher was a full-width row of tabs under the header.**
 *     It cost a whole line of vertical space on every page and grew horizontally
 *     with every company. It is a `<select>` in the nav now — one control, same
 *     height as the links, and it cannot overflow.
 *  2. **Chat lived only on /buzzy/talk.** Talking to BeeZilla is the product, so it
 *     is anchored to the nav on every page: the Ask button opens the same component
 *     (chat.js) in a panel, sharing the session cookie and bz_session_id.
 *  3. **Every page hand-wrote its own nav and they drifted.** This builds the nav
 *     from one list, computes the active link from the path, and adds anything a
 *     page is missing — by id, never by index.
 *
 * Loaded by pages.nitro.ts on every HTML page, so a new page inherits it for free.
 */
(function () {
  "use strict";

  var LINKS = [
    { id: "talk", href: "/buzzy/talk", label: "Talk" },
    { id: "sketch", href: "/buzzy/sketch", label: "Sketch" },
    { id: "studio", href: "/buzzy/studio", label: "Studio" },
    { id: "library", href: "/buzzy/library", label: "Library", blank: true },
    { id: "capabilities", href: "/buzzy/capabilities", label: "Capabilities" },
    { id: "memory", href: "/buzzy/memory", label: "Memory" },
    { id: "experts", href: "/buzzy/experts", label: "Experts" },
    { id: "recipes", href: "/buzzy/recipes", label: "Recipes" },
    { id: "wallet", href: "/buzzy/wallet", label: "Honey Drops" },
    { id: "publish", href: "/buzzy/upload", label: "Publish" },
  ];

  function section(pathname) {
    var p = (pathname || location.pathname).replace(/\.html$/, "").replace(/\/+$/, "");
    if (/^\/buzzy(\/talk)?$/.test(p)) return "talk";
    var m = /^\/buzzy\/([a-z-]+)$/.exec(p);
    if (!m) return "";
    var seg = m[1];
    if (seg === "library") return "library";
    if (seg === "memory" || seg === "remember") return "memory";
    if (seg === "upload") return "publish";
    if (seg === "profile" || seg === "landing" || seg === "login") return "";
    return seg;
  }

  function style() {
    if (document.getElementById("bz-chrome-css")) return;
    var s = document.createElement("style");
    s.id = "bz-chrome-css";
    s.textContent = [
      // the switcher row is gone; this hides it on the pages that still ship it
      "#companyTabs{display:none!important}",
      "#bzChrome{display:flex;align-items:center;gap:.55rem;flex-wrap:nowrap;min-width:0}",
      "#bzChrome .bz-co-wrap{display:flex;align-items:center;gap:.3rem;min-width:0}",
      "#bzChrome .bz-co-label{color:#8d8d8d;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}",
      "#bzChrome select.bz-co-select{appearance:none;background:#101010;color:#f2f2f2;border:1px solid #2c2c2c;border-radius:8px;padding:.28rem 1.5rem .28rem .5rem;font:inherit;font-size:.82rem;max-width:15rem;text-overflow:ellipsis;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,#8d8d8d 50%),linear-gradient(135deg,#8d8d8d 50%,transparent 50%);background-position:calc(100% - 14px) 52%,calc(100% - 9px) 52%;background-size:5px 5px,5px 5px;background-repeat:no-repeat}",
      "#bzChrome button.bz-ask{display:inline-flex;align-items:center;gap:.35rem;background:#ffd40d;color:#111;border:0;border-radius:999px;padding:.3rem .7rem;font:inherit;font-size:.82rem;font-weight:700;cursor:pointer;white-space:nowrap}",
      "#bzChrome button.bz-ask[aria-expanded='true']{background:#fff0a8}",
      "#bzPanel{position:fixed;right:1rem;top:64px;width:min(420px,calc(100vw - 2rem));height:min(560px,calc(100vh - 88px));background:#101010;border:1px solid #2c2c2c;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.55);display:none;flex-direction:column;z-index:900;padding:.6rem}",
      "#bzPanel.open{display:flex}",
      "#bzPanel .bz-panel-head{display:flex;align-items:center;justify-content:space-between;padding:0 .2rem .45rem;font-size:.82rem;color:#8d8d8d}",
      "#bzPanel .bz-panel-body{flex:1;min-height:0}",
      "#bzPanel .bz-panel-close{background:none;border:0;color:#8d8d8d;font-size:1rem;cursor:pointer;padding:0 .2rem}",
      ".bz-navbar{display:flex;align-items:center;gap:.9rem;height:48px;min-height:48px;border-bottom:1px solid #242424;background:#0d0d0d;overflow-x:auto;scrollbar-width:none}",
      ".bz-navbar::-webkit-scrollbar{display:none}",
      // The chrome must style itself: /buzzy/landing has no nav CSS of its own, so
      // links fell back to the browser default (blue, underlined) on the one page
      // every visitor sees first. Page styles that are more specific still win.
      "#bzNav a{color:#9a9a9a;text-decoration:none;font-size:.86rem;font-weight:500;white-space:nowrap;padding:.15rem 0;border:0}",
      "#bzNav a:hover{color:#f2f2f2}",
      "#bzNav a:focus-visible{outline:2px solid #ffd40d;outline-offset:3px;border-radius:4px}",
      "#bzNav a.active{color:#ffd40d;font-weight:700}",
      ".bz-chrome-scroll{overflow-x:auto;scrollbar-width:none}",
      "#bzChrome .bz-account{color:#8d8d8d;font-size:.82rem;text-decoration:none;white-space:nowrap}",
      "#bzChrome .bz-account:hover{color:#ffd40d}",
      ".bz-chrome-scroll::-webkit-scrollbar{display:none}",
    ].join("");
    document.head.appendChild(s);
  }

  function ensureNav() {
    var nav = document.getElementById("bzNav");
    if (!nav) {
      var header = document.querySelector("header") || document.createElement("header");
      if (!header.parentNode) document.body.insertBefore(header, document.body.firstChild);
      header.style.cssText += ";padding:.6rem 1rem;border-bottom:1px solid #242424;background:#0d0d0d;position:sticky;top:0;z-index:800";
      var row = document.createElement("div");
      row.className = "bz-chrome-scroll";
      row.style.cssText = "display:flex;align-items:center;gap:.9rem";
      nav = document.createElement("nav");
      nav.id = "bzNav";
      nav.style.cssText = "display:flex;gap:.9rem;flex-wrap:nowrap;align-items:center;margin:0;padding:0";
      row.appendChild(nav);
      header.appendChild(row);
    }
    nav.style.flexWrap = "nowrap";
    // One strip, same height everywhere; page-specific header content stays below it.
    if (!nav.closest(".bz-navbar")) {
      var bar = document.createElement("div");
      bar.className = "bz-navbar";
      nav.parentNode.insertBefore(bar, nav);
      bar.appendChild(nav);
    }

    // Add any missing link, in canonical order, without disturbing existing ones.
    LINKS.forEach(function (l) {
      if (nav.querySelector('a[data-nav="' + l.id + '"]')) return;
      var a = document.createElement("a");
      a.href = l.href;
      a.textContent = l.label;
      a.setAttribute("data-nav", l.id);
      if (l.blank) { a.target = "_blank"; a.rel = "noopener"; }
      nav.appendChild(a);
    });

    // Active state from the path — the single implementation.
    var active = section();
    Array.prototype.forEach.call(nav.querySelectorAll("a[data-nav]"), function (a) {
      var on = a.getAttribute("data-nav") === active;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    return nav;
  }

  /** Companies: one select, driven by the shared BZCompanies store. */
  function companyControl(nav) {
    var wrap = document.createElement("span");
    wrap.className = "bz-co-wrap";
    var label = document.createElement("span");
    label.className = "bz-co-label";
    label.textContent = "Company";
    var sel = document.createElement("select");
    sel.className = "bz-co-select";
    sel.title = "Which company you are working for";
    sel.setAttribute("aria-label", "Active company");
    sel.innerHTML = '<option value="">Loading…</option>';
    sel.disabled = true;
    wrap.appendChild(label);
    wrap.appendChild(sel);
    nav.appendChild(wrap);

    function fill() {
      var api = window.BZCompanies;
      if (!api || !api.ready()) return;
      var list = api.list() || [];
      var activeId = api.activeId();
      sel.innerHTML = "";
      if (!list.length) {
        var o = document.createElement("option");
        o.value = "";
        o.textContent = "No company yet";
        sel.appendChild(o);
      }
      list.forEach(function (c) {
        var o = document.createElement("option");
        o.value = c.id;
        o.textContent = c.name || "Untitled company";
        if (c.id === activeId) o.selected = true;
        sel.appendChild(o);
      });
      var add = document.createElement("option");
      add.value = "__add";
      add.textContent = "＋ Add a company…";
      sel.appendChild(add);
      sel.disabled = false;
      if (window.BZCompanies.onChange && !sel._wired) {
        sel._wired = true;
        window.BZCompanies.onChange(function () { fill(); });
      }
    }

    sel.addEventListener("change", function () {
      var id = sel.value;
      if (id === "__add") {
        location.href = "/buzzy/talk?addCompany=1";
        return;
      }
      var api = window.BZCompanies;
      if (api && typeof api.select === "function") api.select(id);
      else {
        try { localStorage.setItem("bz_active_company", id); } catch (e) {}
        location.reload();
      }
    });

    // companies.js loads async; poll briefly rather than assume it is ready.
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      fill();
      if ((window.BZCompanies && window.BZCompanies.ready()) || tries > 40) clearInterval(t);
    }, 150);
    fill();
  }

  /** Who is signed in? The nav shows it once, instead of each page guessing. */
  function accountControl(chrome) {
    var a = document.createElement("a");
    a.className = "bz-account";
    a.href = "/buzzy/landing";
    a.textContent = "…";
    chrome.appendChild(a);
    fetch("/api/buzzy/sessions", { credentials: "same-origin" })
      .then(function (r) { return { ok: r.ok, body: r.ok ? null : null }; })
      .then(function (res) {
        if (res.ok) { a.textContent = "Account"; a.href = "/buzzy/profile"; a.title = "Your account"; }
        else { a.textContent = "Sign in"; a.href = "/buzzy/landing"; }
      })
      .catch(function () { a.textContent = "Sign in"; });
  }

  /** Ask: the chat, on every page, in a panel anchored to the nav. */
  function askControl(nav) {
    var btn = document.createElement("button");
    btn.className = "bz-ask";
    btn.type = "button";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "bzPanel");
    btn.innerHTML = "&#128172; Ask";
    nav.appendChild(btn);

    var panel = document.createElement("div");
    panel.id = "bzPanel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Ask BeeZilla");
    var head = document.createElement("div");
    head.className = "bz-panel-head";
    var title = document.createElement("span");
    title.textContent = "Ask BeeZilla";
    var close = document.createElement("button");
    close.className = "bz-panel-close";
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = "&times;";
    head.appendChild(title);
    head.appendChild(close);
    var body = document.createElement("div");
    body.className = "bz-panel-body";
    panel.appendChild(head);
    panel.appendChild(body);
    document.body.appendChild(panel);

    var mounted = false;
    function mountChat() {
      if (mounted) return;
      mounted = true;
      var boot = function () {
        if (!window.BeeZillaChat) return;
        window.BeeZillaChat.mount(body, { title: "BeeZilla", placeholder: "Ask anything — or say what to make" });
      };
      if (window.BeeZillaChat) return boot();
      var s = document.createElement("script");
      s.src = "/buzzy/chat.js";
      s.onload = boot;
      document.head.appendChild(s);
    }

    function open() {
      panel.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      mountChat();
      var input = body.querySelector(".bzc-in");
      if (input) input.focus();
    }
    function shut() {
      panel.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
    }
    btn.addEventListener("click", function () {
      if (panel.classList.contains("open")) shut();
      else open();
    });
    close.addEventListener("click", shut);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && panel.classList.contains("open")) shut();
    });
  }

  function loadCompanies() {
    if (window.BZCompanies) return;
    if (document.querySelector('script[src="/buzzy/companies.js"]')) return;
    var s = document.createElement("script");
    s.src = "/buzzy/companies.js";
    document.head.appendChild(s);
  }

  function boot() {
    style();
    var nav = ensureNav();
    if (!document.getElementById("bzChrome")) {
      var chrome = document.createElement("span");
      chrome.id = "bzChrome";
      // sit the controls at the end of the nav row, after the links
      nav.appendChild(chrome);
      loadCompanies();
      companyControl(chrome);
      accountControl(chrome);
      // On Talk the composer is already in front of you; a second chat button there
      // is noise. Everywhere else the panel is the only way to talk, so it is always
      // present.
      if (section() !== "talk") askControl(chrome);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
