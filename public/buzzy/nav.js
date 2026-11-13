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
    // The owner's roadmap names five main places: Talk, Library, Memory, Experts,
    // Recipes. Everything else stays one click away under "More" (`more: true`).
    { id: "talk", href: "/buzzy/talk", label: "Talk" },
    // No longer opens a new tab: the page shell below keeps Talk (and the mic)
    // alive while you move around, so the reason for the `_blank` is gone.
    { id: "library", href: "/buzzy/library", label: "Library" },
    { id: "memory", href: "/buzzy/memory", label: "Memory" },
    { id: "experts", href: "/buzzy/experts", label: "Experts" },
    { id: "recipes", href: "/buzzy/recipes", label: "Recipes" },
    { id: "sketch", href: "/buzzy/sketch", label: "Sketch", more: true },
    { id: "studio", href: "/buzzy/studio", label: "Studio", more: true },
    { id: "capabilities", href: "/buzzy/capabilities", label: "Capabilities", more: true },
    { id: "wallet", href: "/buzzy/wallet", label: "Honey Drops", more: true },
    { id: "publish", href: "/buzzy/upload", label: "Publish", more: true },
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

  // The header cancels whatever horizontal padding its containing page puts on
  // <body> so the bar can span the viewport. That number is a SNAPSHOT of the
  // current page's CSS, so it must be re-derived whenever the active page (and
  // therefore its body rule) changes: a soft navigation from Capabilities (body
  // padding 17.6px) to Talk (none) used to leave margin-left at -17.6px with no
  // padding left to cancel, pushing the header 18px off the viewport (BZ-11
  // residual, "after stopping voice"). boot() returns early when the chrome
  // already exists, so the re-derive lives in applyBleed() and boot() calls it.
  var chromeBleedHeader = null;
  function applyBleed() {
    var h = chromeBleedHeader;
    if (!h || !h.isConnected) h = chromeBleedHeader = document.querySelector("#bzChrome") ? document.querySelector("#bzChrome").closest("header") : null;
    if (!h) return;
    var bcs = window.getComputedStyle(document.body);
    var padL = parseFloat(bcs.paddingLeft) || 0;
    var padR = parseFloat(bcs.paddingRight) || 0;
    h.style.marginLeft = (-padL) + "px";
    h.style.marginRight = (-padR) + "px";
  }
  window.addEventListener("resize", applyBleed);

  function style() {
    if (document.getElementById("bz-chrome-css")) return;
    var s = document.createElement("style");
    s.id = "bz-chrome-css";
    s.textContent = [
      // BZ-23: the dead `#companyTabs` divs are gone from talk/library/memory and
      // companies.js no longer mounts into a cached copy, so there is nothing left
      // to hide here. The visible switcher is the #bzSelect row below.
      "#bzChrome{display:flex;align-items:center;gap:.55rem;flex-wrap:nowrap;min-width:0}",
      "#bzChrome .bz-co-wrap{display:flex;align-items:center;gap:.3rem;min-width:0}",
      "#bzChrome .bz-co-label{color:#8d8d8d;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}",
      "#bzChrome select.bz-co-select{appearance:none;background:#101010;color:#f2f2f2;border:1px solid #2c2c2c;border-radius:8px;padding:.28rem 1.5rem .28rem .5rem;font:inherit;font-size:.82rem;max-width:15rem;text-overflow:ellipsis;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,#8d8d8d 50%),linear-gradient(135deg,#8d8d8d 50%,transparent 50%);background-position:calc(100% - 14px) 52%,calc(100% - 9px) 52%;background-size:5px 5px,5px 5px;background-repeat:no-repeat}",
      "#bzChrome button.bz-ask{display:inline-flex;align-items:center;gap:.35rem;background:#ffd40d;color:#111;border:0;border-radius:999px;padding:.3rem .7rem;font:inherit;font-size:.82rem;font-weight:700;cursor:pointer;white-space:nowrap}",
      "#bzChrome button.bz-ask[aria-expanded='true']{background:#fff0a8}",
      "#bzChrome button.bz-voice{display:inline-flex;align-items:center;gap:.35rem;background:#161616;color:#f2f2f2;border:1px solid #3a3a3a;border-radius:999px;padding:.3rem .7rem;font:inherit;font-size:.82rem;font-weight:600;cursor:pointer;white-space:nowrap}",
      "#bzChrome button.bz-voice[aria-pressed='true']{background:#ffd40d;color:#111;border-color:#ffd40d}",
      "#bzChrome button.bz-voice:focus-visible{outline:2px solid #ffd40d;outline-offset:2px}",
      "#bzPanel{position:fixed;right:1rem;top:64px;width:min(420px,calc(100vw - 2rem));height:min(560px,calc(100vh - 88px));background:#101010;border:1px solid #2c2c2c;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.55);display:none;flex-direction:column;z-index:900;padding:.6rem}",
      "#bzPanel.open{display:flex}",
      "#bzPanel .bz-panel-head{display:flex;align-items:center;justify-content:space-between;padding:0 .2rem .45rem;font-size:.82rem;color:#8d8d8d}",
      "#bzPanel .bz-panel-body{flex:1;min-height:0}",
      "#bzPanel .bz-panel-close{background:none;border:0;color:#8d8d8d;font-size:1rem;cursor:pointer;padding:0 .2rem}",
      "#bzPanel .bz-panel-tools{display:flex;align-items:center;gap:.35rem}",
      "#bzPanel .bz-panel-close:hover{color:#ffd40d}",
      "#bzPanel .bz-panel-close:focus-visible{outline:2px solid #ffd40d;outline-offset:2px;border-radius:4px}",
      "#bzPanel.min{height:auto;top:auto;bottom:1rem;width:auto;min-width:230px;padding:.5rem .7rem}",
      "#bzPanel.min .bz-panel-body{display:none}",
      "#bzPanel.min .bz-panel-head{padding:0;color:#e6e6e6;cursor:pointer}",
      // The chrome renders inside eleven different page stylesheets, and three of
      // them set their own body font-size/line-height (sketch+studio 14px/1.5,
      // capabilities 15px/1.55, memory inherits the browser default). An inherited
      // unitless line-height therefore changed the identity cluster's height and
      // dropped the chips 2px on memory alone (BZ-11 residual, Nov 2026). The
      // chrome pins its OWN metrics so no host page can move it again.
      // ...and the font. Three hosts ship three different body stacks, and only
      // memory actually LOADS Inter (Google Fonts) — the other ten just name it and
      // fall through to the system face. So the company <select> and the chips
      // measured 1-6px wider on memory and the identity cluster's left edge wandered.
      // The chrome is one identity in one place: it names a stack every host can
      // resolve the same way instead of inheriting whatever the page happened to load.
      ".bz-brandrow,.bz-brandrow *{line-height:1.55;font-family:system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif}",
      ".bz-brandrow{display:flex;align-items:center;gap:.9rem;height:56px;min-height:56px;padding:0 .1rem;font-size:16px}",
      ".bz-brandrow .bz-brand{display:flex;align-items:center;gap:.5rem;text-decoration:none;color:#f2f2f2}",
      ".bz-brandrow .bz-brand img{width:26px;height:26px;border-radius:6px;display:block}",
      ".bz-brandrow .bz-brand strong{font-size:.98rem;letter-spacing:.01em}",
      ".bz-brandrow .bz-cluster{margin-left:auto;display:flex;align-items:center;gap:.7rem;min-width:0}",
      // The link row is centred, not left-anchored: the brand owns the left edge and the
      // identity cluster owns the right, so a left-hugging link row reads as a mistake.
      // 'safe center' falls back to start the moment the row is wider than the bar, so
      // centring can never clip the first link on a narrow window.
      ".bz-navbar{display:flex;align-items:center;justify-content:safe center;gap:.9rem;height:48px;min-height:48px;border-bottom:1px solid #242424;background:#0d0d0d;overflow-x:auto;scrollbar-width:none;padding:0 8px}",
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
      // The dropdown is chrome, so the chrome styles it: pages without a local
      // .account-menu rule (landing, wallet) would otherwise get an unstyled block.
      "#bzChrome .account-menu{position:absolute;top:100%;right:0;margin-top:.4rem;background:#141414;border:1px solid #2A2A2A;border-radius:6px;padding:.7rem .9rem;min-width:200px;z-index:60;box-shadow:0 6px 20px rgba(0,0,0,.5);text-align:left}",
      "#bzChrome .account-menu .am-name{font-weight:600;color:#fff;font-size:.9rem}",
      "#bzChrome .account-menu .am-email{font-size:.75rem;color:#888;margin:.15rem 0 .6rem;word-break:break-all}",
      "#bzChrome .account-menu .am-signout{width:100%;font-size:.8rem;padding:.4rem .6rem;background:#1b1b1b;color:#e8e8e8;border:1px solid #333;border-radius:6px;cursor:pointer}",
      "#bzChrome .bz-plan{display:inline-flex;align-items:center;border:1px solid #3a3a3a;border-radius:999px;padding:.1rem .5rem;font-size:.7rem;font-weight:800;letter-spacing:.06em;color:#cfcfcf;text-decoration:none;white-space:nowrap}",
      "#bzChrome .bz-plan-pro{background:#ffd40d;color:#111;border-color:#ffd40d}",
      "#bzChrome .bz-plan-starter{background:#1d2b22;color:#a9f0c4;border-color:#2c5138}",
      "#bzChrome .bz-voice{display:inline-flex;align-items:center;gap:.3rem}",
      "#bzChrome button.bz-voice-mic{display:inline-flex;align-items:center;gap:.3rem;background:#141414;color:#e8e8e8;border:1px solid #2c2c2c;border-radius:999px;padding:.28rem .7rem;font:inherit;font-size:.82rem;font-weight:700;cursor:pointer;white-space:nowrap}",
      // Half-duplex is a promise the owner has to be able to SEE. While a reply
      // is playing the mic is not being listened to, and a chip that just says
      // "Speaking" reads as "busy", not "you are not being heard".
      "#bzChrome .bz-voice-hint{margin-left:.35rem;font-size:.68rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;opacity:.8}",
      "@media (max-width:900px){#bzChrome .bz-voice-hint{display:none}}",
      "#bzChrome button.bz-voice-mic.on{background:#ffd40d;color:#111;border-color:#ffd40d}",
      "#bzChrome button.bz-voice-stop{background:#2a1214;color:#ffb4b4;border:1px solid #5b1f24;border-radius:999px;padding:.28rem .55rem;font:inherit;font-size:.8rem;cursor:pointer}",
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
    // Page CSS owns `#bzNav { padding: 0 0 1rem }` on sketch/capabilities (id selector,
    // so the shared stylesheet cannot outrank it): the link row measured 26px on Talk,
    // 34 on Sketch and 42 on Capabilities inside a 48px bar. The bar is chrome; the row
    // inside it is chrome. Pin both.
    nav.style.padding = "0";
    nav.style.margin = "0";
    // The bar is one bar; the TYPE inside it has to be one type. Sketch, Studio and
    // Capabilities style body (14px/1.5, 15px/1.55) and the row inherited it, so the
    // links measured 21.3px tall on six pages and 26.1px on those three: the row sat
    // 2.5px lower, and the company select rendered in a second typeface. Same rule as
    // `.bz-brandrow` — the chrome names its own font, size and leading. Inline, because
    // the page's `#bzNav`/`#bzNav a` id rules outrank any stylesheet we ship.
    var CHROME_FONT = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
    nav.style.fontFamily = CHROME_FONT;
    nav.style.fontSize = "16px";
    nav.style.lineHeight = "1.55";
    // One strip, same height everywhere; page-specific header content stays below it.
    if (!nav.closest(".bz-navbar")) {
      var bar = document.createElement("div");
      bar.className = "bz-navbar";
      nav.parentNode.insertBefore(bar, nav);
      bar.appendChild(nav);
    }

    // REBUILD, don't append. Pages still hand-write their own <nav>, and they had
    // drifted into different orders (Library and Wallet shipped Talk, Library,
    // Capabilities… while Talk shipped Talk, Sketch, Studio…). Appending only what
    // was missing preserved whatever order the page happened to ship. One list
    // means one order, identical on every page and on every future page.
    var wanted = {};
    LINKS.forEach(function (l) { wanted[l.id] = true; });
    Array.prototype.forEach.call(nav.querySelectorAll("a[data-nav]"), function (a) {
      if (!wanted[a.getAttribute("data-nav")]) a.parentNode.removeChild(a);
    });
    var ordered = [];
    LINKS.forEach(function (l) {
      var a = nav.querySelector('a[data-nav="' + l.id + '"]');
      if (!a) {
        a = document.createElement("a");
        a.textContent = l.label;
        a.setAttribute("data-nav", l.id);
      }
      a.href = l.href;
      // Pages still hand-write `<a data-nav="library" target="_blank">`: the anchor
      // is reused here, so a link that should no longer open a tab kept its target
      // and the shell's click handler skipped it (it bails on any non-_self target).
      // That is how a lap of the site ended in three tabs and a dead mic (BZ-14).
      // The LIST decides, not the markup it inherited.
      if (l.blank) { a.target = "_blank"; a.rel = "noopener"; }
      else { a.removeAttribute("target"); a.removeAttribute("rel"); }
      ordered.push(a);
    });
    // Main places in the row; the rest in one "More" menu (idempotent: this runs
    // again after every soft navigation, so reuse the menu if it exists).
    var more = nav.querySelector(".bz-more");
    if (!more) {
      more = document.createElement("div");
      more.className = "bz-more";
      more.innerHTML =
        '<button type="button" class="bz-more-btn" aria-haspopup="true" aria-expanded="false">More <span aria-hidden="true">&#9662;</span></button>' +
        '<div class="bz-more-menu" hidden></div>';
      var moreBtn = more.querySelector(".bz-more-btn");
      var moreMenu = more.querySelector(".bz-more-menu");
      var setOpen = function (open) {
        moreMenu.hidden = !open;
        moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
        if (!open) return;
        // The link row scrolls sideways, which clips anything absolutely placed in
        // it: pin the menu to the viewport under the button instead.
        var r = moreBtn.getBoundingClientRect();
        var w = moreMenu.offsetWidth || 180;
        moreMenu.style.top = Math.round(r.bottom + 6) + "px";
        moreMenu.style.left = Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))) + "px";
      };
      window.addEventListener("resize", function () { setOpen(false); });
      window.addEventListener("scroll", function () { if (!moreMenu.hidden) setOpen(false); }, { passive: true });
      moreBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        setOpen(moreMenu.hidden);
        if (!moreMenu.hidden) { var first = moreMenu.querySelector("a"); if (first) first.focus(); }
      });
      moreMenu.addEventListener("click", function () { setOpen(false); });
      more.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && !moreMenu.hidden) { setOpen(false); moreBtn.focus(); }
      });
      document.addEventListener("click", function (e) {
        if (!more.contains(e.target)) setOpen(false);
      });
    }
    var menu = more.querySelector(".bz-more-menu");
    ordered.forEach(function (a, i) {
      if (LINKS[i].more) menu.appendChild(a);
      else nav.appendChild(a);
    });
    nav.appendChild(more);
    // Anchors too: `#bzNav a` is a page-owned id rule on sketch/studio/capabilities,
    // so an inherited value cannot reach them. 0.86rem is the shared nav.css size;
    // writing it inline keeps the label box identical wherever the row is rendered.
    Array.prototype.forEach.call(nav.querySelectorAll("a[data-nav]"), function (a) {
      a.style.fontFamily = CHROME_FONT;
      a.style.fontSize = "0.86rem";
      a.style.lineHeight = "1.55";
    });

    // Active state from the path — the single implementation.
    var active = section();
    Array.prototype.forEach.call(nav.querySelectorAll("a[data-nav]"), function (a) {
      var on = a.getAttribute("data-nav") === active;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    // A page that lives under More lights up More.
    var moreButton = nav.querySelector(".bz-more-btn");
    if (moreButton) {
      moreButton.classList.toggle("active", LINKS.some(function (l) { return l.more && l.id === active; }));
      moreButton.style.fontFamily = CHROME_FONT;
      moreButton.style.fontSize = "0.86rem";
    }
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
        // Soft hop: a /buzzy/ URL assigned to location.href is a document load,
        // and Talk's document is where the recogniser lives (BZ-16).
        if (window.BeeZillaShell) window.BeeZillaShell.go("/buzzy/talk?addCompany=1");
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

  /** Who is signed in? One place, right beside the logo. */
  function accountControl(chrome) {
    // The identity is ALWAYS a visible name link owned by the chrome. Talk and Library
    // build their own `.account-menu` (name, email, Log out) and hide it behind a click;
    // adopting that menu and deleting our link left the row with no identity at all
    // (BZ-15: name on landing/login/wallet/sketch, blank on talk/library). The page's
    // menu becomes the DROPDOWN of the chrome's link, never a replacement for it.
    var a = document.getElementById("accountLink");
    if (!a) {
      a = document.createElement("a");
      a.id = "accountLink";
    }
    a.className = "bz-account account-link";
    a.href = "/buzzy/landing";
    // No "…" placeholder: an empty label with a reserved width cannot be mistaken
    // for a name, and it does not flash "Sign in" at a signed-in user.
    a.style.minWidth = "5.5rem";
    chrome.appendChild(a); // moves it out of the nav when the page shipped one there
    chrome.style.position = "relative";

    function paint(name, email) {
      user = name ? { name: name, email: email || "" } : null;
      a.textContent = name || "Sign in";
      a.href = name ? "/buzzy/profile" : "/buzzy/landing";
      a.title = email || name || "Sign in";
      if (user) ensureMenu();
    }
    var user = null;

    /**
     * Last known identity, so the header never lies for a round trip.
     *
     * The page ships `Sign in` in its markup and the chrome only painted after
     * /api/auth/get-session answered, so a signed-in reader watched "Sign in"
     * flash on every page (loudest on Sketch, whose header is otherwise empty).
     * `undefined` = never cached, `null` = known signed out, object = identity.
     * The response always wins; this only covers the gap before it lands.
     */
    function readIdentityCache() {
      try {
        var raw = window.localStorage.getItem("bz_identity");
        if (raw === null) return undefined;
        if (raw === "null") return null;
        var v = JSON.parse(raw);
        return v && (v.name || v.email) ? v : null;
      } catch (e) {
        return undefined;
      }
    }
    function writeIdentityCache(u) {
      try {
        window.localStorage.setItem(
          "bz_identity",
          u ? JSON.stringify({ name: u.name || "", email: u.email || "" }) : "null",
        );
      } catch (e) { /* private mode: fall back to the round trip */ }
    }
    var cached = readIdentityCache();
    if (cached !== undefined) paint(cached ? cached.name : null, cached ? cached.email : null);

    function signOut(e) {
      if (e) e.preventDefault();
      writeIdentityCache(null); // next page must not paint the name we just dropped
      // The plan and balance chips are cached for the same reason; a signed-out page
      // that paints PRO and a Honey balance is the same lie in a different chip.
      try {
        window.localStorage.setItem("bz_plan", "null");
        window.localStorage.setItem("bz_honey", "null");
      } catch (err) { /* private mode: the next load's 401 clears them anyway */ }
      fetch("/api/auth/sign-out", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: "{}",
      }).then(function () {
        // Sign-out is the one place a hard load is correct: the session is gone,
        // so the engine in this document MUST die with it. Everything else in
        // /buzzy/* navigates through the shell (BZ-16).
        window.location.href = "/buzzy/";
      });
    }

    function fillMenu(m) {
      if (!user) return;
      m.innerHTML = "";
      var n = document.createElement("div"); n.className = "am-name"; n.textContent = user.name;
      m.appendChild(n);
      if (user.email) {
        var em = document.createElement("div"); em.className = "am-email"; em.textContent = user.email;
        m.appendChild(em);
      }
      var out = document.createElement("button");
      out.type = "button"; out.className = "am-signout"; out.textContent = "Log out";
      out.addEventListener("click", signOut);
      m.appendChild(out);
    }

    // One menu, owned by the chrome. Pages that build their own get adopted; pages
    // that never build one still get a Log out instead of a name that leads nowhere.
    function ensureMenu() {
      if (!user) return;
      var m = chrome.querySelector(".account-menu");
      if (m) { fillMenu(m); return; }
      m = document.createElement("div");
      m.className = "account-menu bz-account-menu";
      m.setAttribute("data-bz-adopted", "1");
      m.style.display = "none";
      m.style.top = "100%";
      m.style.right = "0";
      chrome.appendChild(m);
      fillMenu(m);
    }
    if (!a.textContent) a.textContent = "";
    fetch("/api/auth/get-session", { credentials: "same-origin" })
      // A non-2xx or a non-JSON body is an outage, not a logout: 200 with
      // `{user: null}` is the only shape that proves nobody is signed in. Treating
      // every failed round trip as signed-out repainted "Sign in" over a real name,
      // which is the same lie this cache exists to prevent.
      .then(function (r) { return r.ok ? r.json() : undefined; })
      .then(function (res) {
        if (res === undefined) return; // inconclusive: keep whatever we painted
        var u = res && res.user;
        if (u && (u.name || u.email)) {
          writeIdentityCache({ name: u.name || u.email, email: u.email || "" });
          paint(u.name || u.email, u.email);
        } else {
          writeIdentityCache(null);
          paint(null, null);
        }
      })
      // A failed round trip proves nothing about who is signed in, so it must not
      // overwrite the cached identity or repaint "Sign in" over a real name.
      .catch(function () { /* keep whatever we painted */ });

    // Adopt a page-built menu as the dropdown. clone the link once so a page's own
    // click handler (Talk binds a toggle to `.account-link`) cannot double-toggle ours.
    function adopt(menu) {
      if (!menu) return;
      if (menu.getAttribute("data-bz-adopted") === "1") return;
      menu.setAttribute("data-bz-adopted", "1");
      menu.classList.add("bz-account-menu");
      menu.style.display = "none";
      menu.style.top = "100%";
      menu.style.right = "0";
      chrome.appendChild(menu);
      var fresh = a.cloneNode(true);
      if (a.parentNode) a.parentNode.replaceChild(fresh, a);
      else chrome.appendChild(fresh);
      a = fresh;
    }
    adopt(document.querySelector("header .account-menu"));

    // One click handler for chrome + menu, installed once per chrome.
    if (!chrome.getAttribute("data-bz-acct")) {
      chrome.setAttribute("data-bz-acct", "1");
      chrome.addEventListener("click", function (e) {
        var menu = chrome.querySelector(".account-menu");
        if (!menu) return;
        if (a === e.target || a.contains(e.target)) {
          e.preventDefault();
          menu.style.display = menu.style.display === "none" ? "block" : "none";
        }
      });
      document.addEventListener("click", function (e) {
        var menu = chrome.querySelector(".account-menu");
        if (!menu) return;
        if (a.contains(e.target) || menu.contains(e.target)) return;
        menu.style.display = "none";
      });
    }

    // The page may build its menu after us (Talk does, on every re-execution of its
    // script during a soft navigation). Watch briefly, adopt it, and drop strays.
    var tries = 0;
    var watch = setInterval(function () {
      tries++;
      Array.prototype.forEach.call(document.querySelectorAll("header .account-menu"), function (m) {
        if (m.getAttribute("data-bz-adopted") === "1") return;
        var twin = chrome.querySelector(".account-menu");
        if (twin) { m.remove(); return; }
        adopt(m);
      });
      if (tries > 24) clearInterval(watch);
    }, 250);
  }

  /** Honey Drops: the balance, in the chrome, on every page. */
  function honeyControl(chrome) {
    // pages that still ship wallet-chip.js inserted a chip beside the nav; one chip only
    Array.prototype.forEach.call(document.querySelectorAll("header .hd-chip"), function (c) { c.remove(); });
    var chip = document.createElement("a");
    chip.id = "bzHoneyChip";
    chip.className = "hd-chip";
    chip.href = "/buzzy/wallet";
    chip.setAttribute("aria-label", "Your Honey Drops wallet");
    chip.textContent = "\u25c8";           // mark only, no "…" placeholder
    chip.style.minWidth = "3.6rem";
    chrome.appendChild(chip);

    // Same rule as the plan chip and the identity: paint the last known balance
    // before the round trip, or a signed-in reader watches the header assemble
    // itself chip by chip on every load (BZ-15 residual). The response wins; a
    // failed call changes nothing; an authoritative answer with no balance clears
    // the cache so a stale number cannot outlive the session.
    var CACHE = "bz_honey";
    function paint(n) {
      if (typeof n === "number") {
        chip.textContent = "\u25c8 " + Number(n).toLocaleString();
        chip.title = Number(n).toLocaleString() + " Honey Drops";
      } else {
        chip.textContent = "\u25c8";
        chip.title = "";
      }
    }
    try {
      var raw = window.localStorage.getItem(CACHE);
      if (raw !== null) {
        if (raw === "null") paint(null);
        else paint(Number(raw));
      }
    } catch (e) { /* private mode: the round trip is still the truth */ }

    fetch("/api/wallet", { credentials: "same-origin" })
      // 401 is an answer (nobody is signed in), not an outage: clear the chip.
      .then(function (r) { return r.status === 401 ? { balance: null } : r.ok ? r.json() : undefined; })
      .then(function (d) {
        if (d === undefined) return; // inconclusive: keep whatever we painted
        if (d && typeof d.balance === "number") {
          paint(d.balance);
          try { window.localStorage.setItem(CACHE, String(d.balance)); } catch (e) {}
        } else {
          paint(null);
          try { window.localStorage.setItem(CACHE, "null"); } catch (e) {}
        }
      })
      .catch(function () { /* keep whatever we painted */ });
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

    // On Talk the chat is the page. Opening a second chat engine in a panel over it
    // would be two composers and two sessions on one screen, so the nav control
    // takes you to the one that exists.
    if (section() === "talk") {
      btn.title = "Talk to BeeZilla";
      btn.addEventListener("click", function () {
        var input = document.getElementById("chatInput");
        if (input) {
          input.scrollIntoView({ block: "center", behavior: "smooth" });
          input.focus();
        }
      });
      return;
    }

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
    // Every pop-up has close and minimise (roadmap phase 3). Minimised, the panel
    // folds to its title bar at the bottom right and keeps the conversation.
    var min = document.createElement("button");
    min.className = "bz-panel-close bz-panel-min";
    min.type = "button";
    var tools = document.createElement("span");
    tools.className = "bz-panel-tools";
    tools.appendChild(min);
    tools.appendChild(close);
    head.appendChild(title);
    head.appendChild(tools);
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

    function setMin(on) {
      panel.classList.toggle("min", on);
      min.textContent = on ? "\u25A1" : "\u2013";
      min.setAttribute("aria-label", on ? "Restore Ask BeeZilla" : "Minimise Ask BeeZilla");
      min.title = on ? "Restore" : "Minimise";
      btn.setAttribute("aria-expanded", panel.classList.contains("open") && !on ? "true" : "false");
    }
    function focusInput() {
      var input = body.querySelector(".bzc-in");
      if (input) input.focus();
    }
    function open() {
      panel.classList.add("open");
      setMin(false);
      mountChat();
      focusInput();
    }
    function shut() {
      panel.classList.remove("open");
      setMin(false);
      btn.setAttribute("aria-expanded", "false");
    }
    setMin(false);
    btn.addEventListener("click", function () {
      // A minimised panel comes back; an open one closes.
      if (panel.classList.contains("open") && !panel.classList.contains("min")) shut();
      else open();
    });
    close.addEventListener("click", function (e) { e.stopPropagation(); shut(); });
    min.addEventListener("click", function (e) {
      e.stopPropagation();
      var folding = !panel.classList.contains("min");
      setMin(folding);
      if (folding) btn.focus(); else focusInput();
    });
    head.addEventListener("click", function () {
      if (panel.classList.contains("min")) { setMin(false); focusInput(); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && panel.classList.contains("open") && !panel.classList.contains("min")) shut();
    });
  }

  function loadCompanies() {
    if (window.BZCompanies) return;
    if (document.querySelector('script[src="/buzzy/companies.js"]')) return;
    var s = document.createElement("script");
    s.src = "/buzzy/companies.js";
    document.head.appendChild(s);
  }

  /**
   * The brand for row one — ALWAYS the canonical one.
   *
   * BZ-11 residual: this used to return whatever the page shipped
   * (`.brand-link, .brand, .bz-brand`), so talk/library/memory rendered their
   * own large BEEZILLA mark while sketch/studio/capabilities fell through to
   * this file's 26px mark. Same nav row, two brands, and each page's header CSS
   * decided where the chips sat. The chrome owns the brand now; page markup is
   * discarded by the `header.innerHTML = ""` below, so the shipped header is
   * identical by construction on every page.
   */
  function findBrand(_header) {
    var a = document.createElement("a");
    a.className = "bz-brand";
    a.href = "/buzzy/talk";
    a.innerHTML =
      '<img src="/buzzy/brand/revision6_expressions_16-smiling.png" alt="" /><strong>BeeZilla</strong>';
    return a;
  }

  function boot() {
    style();
    // The Ask panel lives outside the page wrapper, so a soft navigation would
    // otherwise leave the previous page's panel in the document with the same id
    // and a dead mount. One panel at a time.
    Array.prototype.forEach.call(document.querySelectorAll("#bzPanel"), function (n) {
      var page = document.getElementById("bzPage");
      if (!page || !page.contains(n)) n.remove();
    });
    var nav = ensureNav();
    if (document.getElementById("bzChrome")) {
      // Re-derive the body-padding bleed for the page that is active NOW.
      applyBleed();
      return;
    }
    var header = nav.closest("header") || document.querySelector("header") || document.body;
    chromeBleedHeader = header;

    var brand = findBrand(header);
    var account = document.getElementById("accountLink");

    // Flatten one level of wrapper (.header-inner) so extras and the nav are seen.
    var flat = [];
    Array.prototype.forEach.call(header.children, function (child) {
      if (child.classList && child.classList.contains("header-inner")) {
        Array.prototype.forEach.call(child.children, function (c) { flat.push(c); });
      } else flat.push(child);
    });

    var extras = flat.filter(function (el) {
      if (el.tagName === "SCRIPT") return false;
      if (el === nav || el.contains(nav)) return false;
      if (el === brand || el.contains(brand)) return false;
      // The page's own brand mark is superseded by the canonical one above; keeping
      // it in extras is how a page shipped two logos — its large BEEZILLA beside the
      // chrome's 26px mark (BZ-11 residual).
      if (el.matches && el.matches(".brand-link, .brand, .bz-brand")) return false;
      if (el.querySelector && el.querySelector(".brand-link, .brand, .bz-brand")) return false;
      if (el === account) return false;
      return true;
    });

    // Row one: brand, then the identity cluster. Row two: the links. The rows must
    // STACK — a header that is itself a flex row put them side by side.
    // Page CSS may constrain the header (`header.top{max-width:…}`, `header{padding:…}`),
    // which pulled the identity cluster in from the right edge on Capabilities while
    // every other page had it flush (BZ-11 residual). Inline wins; the chrome owns its
    // own box, so the shipped header lands in the same place on every page.
    // The body's own horizontal padding counts too: Capabilities ships
    // `body{padding:0 17.6px}`, which inset the header by 18px even after the header
    // itself was pinned. Negative margins cancel it, so the bar spans the viewport.
    header.style.display = "block";
    header.style.width = "auto";
    header.style.maxWidth = "none";
    header.style.boxSizing = "border-box";
    header.style.margin = "0";
    applyBleed();
    header.style.padding = "12px 24px 8px";
    header.innerHTML = "";

    var brandRow = document.createElement("div");
    brandRow.className = "bz-brandrow";
    brandRow.appendChild(brand);
    var chrome = document.createElement("span");
    chrome.id = "bzChrome";
    chrome.className = "bz-cluster";
    brandRow.appendChild(chrome);

    var bar = document.createElement("div");
    bar.className = "bz-navbar";
    bar.appendChild(nav);

    header.appendChild(brandRow);
    header.appendChild(bar);
    // The header owns the two chrome rows and NOTHING else. Page toolbars used to be
    // appended into it, so the header measured 132px on Talk, 155 on Sketch and 219 on
    // Capabilities and the chrome read as a different component per page (BZ-11, frodo's
    // "move the page content out of <header>"). They go into a sibling strip instead; the
    // page's own class selectors still apply because they are class-based, not
    // `header > …`. One header height everywhere, without touching eleven markup files.
    if (extras.length) {
      var tools = document.createElement("div");
      tools.className = "bz-toolbar";
      extras.forEach(function (el) { tools.appendChild(el); });
      if (header.parentNode) header.parentNode.insertBefore(tools, header.nextSibling);
      else header.appendChild(tools);
    }

    loadCompanies();
    honeyControl(chrome);
    planChip(chrome);
    voiceDock(chrome);
    companyControl(chrome);
    accountControl(chrome);
    askControl(chrome);
  }

  /**
   * Which plan am I on? Visible everywhere, not just under the Talk composer.
   *
   * The chip only appeared once /api/buzzy/entitlement answered, so a signed-in
   * reader saw the header snap from no chip to PRO a round trip after paint (loudest
   * on Sketch, which ships an empty header). The last answer is cached and painted
   * first; the response still wins, a failed round trip changes nothing, and an
   * authoritative "no plan" clears the cache so a signed-out page cannot show PRO.
   */
  function planChip(chrome) {
    if (document.getElementById("bzPlanChip")) return;
    var a = document.createElement("a");
    a.id = "bzPlanChip";
    a.className = "bz-plan";
    a.href = "/buzzy/profile";
    a.textContent = "";
    a.style.display = "none";
    chrome.appendChild(a);

    var CACHE = "bz_plan";
    function readCache() {
      try {
        var raw = window.localStorage.getItem(CACHE);
        if (!raw || raw === "null") return null;
        var v = JSON.parse(raw);
        return v && v.plan ? v : null;
      } catch (e) {
        return null;
      }
    }
    function writeCache(d) {
      try {
        window.localStorage.setItem(
          CACHE,
          d && d.plan ? JSON.stringify({ plan: d.plan, remaining: d.remaining || null, planUntil: d.planUntil || null }) : "null",
        );
      } catch (e) { /* private mode: the round trip is still the truth */ }
    }
    function paint(d) {
      if (!d || !d.plan) {
        a.textContent = "";
        a.style.display = "none";
        return;
      }
      var label = d.plan === "pro" ? "PRO" : d.plan === "starter" ? "STARTER" : "FREE";
      a.textContent = label;
      a.title =
        d.plan.charAt(0).toUpperCase() + d.plan.slice(1) + " plan" +
        (d.remaining ? " \u00b7 " + Number(d.remaining.inference || 0).toLocaleString() + " chats left" : "") +
        (d.planUntil ? " \u00b7 renews " + String(d.planUntil).slice(0, 10) : "");
      a.className = "bz-plan bz-plan-" + d.plan;
      a.style.display = "";
    }

    var cached = readCache();
    if (cached) paint(cached);

    fetch("/api/buzzy/entitlement", { credentials: "same-origin" })
      // 401 is an answer (nobody is signed in), not an outage: clear the chip.
      .then(function (r) { return r.status === 401 ? { ok: false } : r.ok ? r.json() : undefined; })
      .then(function (d) {
        if (!d || typeof d.ok === "undefined") return; // transport oddity: keep the cache
        if (d.ok && d.plan) {
          writeCache(d);
          paint(d);
        } else {
          writeCache(null); // signed out, or no plan: the chip must not outlive it
          paint(null);
        }
      })
      .catch(function () { /* a plan chip is not worth an error toast */ });
  }

  /**
   * The voice control, anchored in the nav on EVERY page.
   *
   * The engine lives on Talk (one voice, one recogniser), so this control is a
   * remote for it: it shows the live state, can stop it with one click, and can
   * start it from any page (navigating to Talk first when Talk has not been
   * mounted in this session yet). The page shell keeps Talk's DOM alive while
   * you navigate, which is what makes the session survive the click.
   */
  // The tab title has TWO inputs: the page's own name and the live-mic marker.
  // One authority, in the CHROME's scope, because the dock repaints the marker
  // and the shell sets the page name from another IIFE. Before this, a soft hop
  // to Library renamed the tab "BeeZilla \u2014 Library" while the mic was still
  // running — QA caught it, and the marker only came back on the hop to Talk.
  var bzTitle = {
    page: document.title,
    listening: function () {
      var eng = window.BeeZillaVoice && window.BeeZillaVoice.state ? window.BeeZillaVoice.state() : null;
      return !!(eng && (eng.mic || eng.armed));
    },
    apply: function () {
      var t = this.listening() ? "\ud83c\udf99 BeeZilla \u2014 Listening" : this.page;
      if (t && document.title !== t) document.title = t;
    },
    setPage: function (t) {
      if (!t) return;
      this.page = t;
      this.apply();
    },
  };
  window.BeeZillaTitle = bzTitle;

  function voiceDock(chrome) {
    if (document.getElementById("bzVoiceDock")) return;
    var dock = document.createElement("span");
    dock.id = "bzVoiceDock";
    dock.className = "bz-voice";
    var mic = document.createElement("button");
    mic.id = "bzVoiceMic";
    mic.type = "button";
    mic.className = "bz-voice-mic";
    mic.innerHTML = "&#127908; <span class=\"bz-voice-label\">Listen</span><span class=\"bz-voice-hint\" hidden>mic off</span>";
    mic.setAttribute("aria-pressed", "false");
    mic.title = "Talk to BeeZilla \u2014 the conversation continues as you navigate";
    var stop = document.createElement("button");
    stop.id = "bzVoiceStop";
    stop.type = "button";
    stop.className = "bz-voice-stop";
    stop.innerHTML = "&#9632;";
    stop.title = "Stop listening";
    stop.style.display = "none";
    dock.appendChild(mic);
    dock.appendChild(stop);
    chrome.appendChild(dock);

    function engine() { return window.BeeZillaVoice || null; }
    function paint(st) {
      st = st || (engine() && engine().state ? engine().state() : null);
      var on = !!(st && st.mic);
      var armed = !!(st && st.armed);
      var speaking = !!(st && st.speaking);
      mic.classList.toggle("on", on);
      mic.classList.toggle("armed", armed && !on);
      // aria-pressed means "the mic is running", so an armed (paused) session is
      // false. The label carries the offer; the state stays honest.
      mic.setAttribute("aria-pressed", on ? "true" : "false");
      var label = mic.querySelector(".bz-voice-label");
      if (label) label.textContent = on ? (speaking ? "Speaking" : "Listening") : armed ? "Resume" : "Listen";
      var hint = mic.querySelector(".bz-voice-hint");
      if (hint) hint.hidden = !(on && speaking);
      mic.title = on
        ? speaking
          ? "Mic is off while I talk \u2014 click to cut me off and speak"
          : "Listening \u2014 click to stop"
        : armed
          ? "Microphone paused after a reload \u2014 click to listen again"
          : "Talk to BeeZilla \u2014 the conversation continues as you navigate";
      mic.setAttribute("aria-label",
        on ? (speaking ? "Speaking, microphone off" : "Listening") : armed ? "Resume listening" : "Listen");
      stop.style.display = on ? "" : "none";
      // The mic marker is a property of the TAB, not of the page: this is the
      // one writer for it, so a soft hop and a start/stop both land here.
      bzTitle.apply();
    }
    // Talk publishes its state here; a page with no engine leaves the dock idle.
    window.BeeZillaVoiceChip = { update: paint };

    function startHere() {
      if (engine() && engine().toggle) { engine().toggle(); paint(); return; }
      var btn = document.getElementById("micBtn");
      if (btn) { btn.click(); paint(); return; }
      // Talk is not mounted in this session: go there, then start.
      if (window.BeeZillaShell) {
        window.BeeZillaShell.go("/buzzy/talk").then(function () {
          setTimeout(function () {
            if (engine() && engine().toggle) engine().toggle();
            else { var b = document.getElementById("micBtn"); if (b) b.click(); }
            paint();
          }, 250);
        });
      }
    }

    mic.addEventListener("click", function () {
      var st = engine() && engine().state ? engine().state() : null;
      if (st && st.mic && st.speaking) {
        // Manual barge-in: one click cuts the reply short and hands the mic
        // back without ending the session. Killing the whole listen session
        // because the owner wanted to talk over me is the wrong trade.
        if (engine() && engine().interrupt) { engine().interrupt(); paint(); return; }
      }
      if (st && st.mic) {
        if (engine() && engine().stop) engine().stop();
        else { var b = document.getElementById("micBtn"); if (b) b.click(); }
        paint();
        return;
      }
      startHere();
    });
    stop.addEventListener("click", function () {
      if (engine() && engine().stop) engine().stop();
      else { var b = document.getElementById("micBtn"); if (b) b.click(); }
      paint();
    });

    // A session started on Talk before this chrome existed still shows up.
    paint();
    setInterval(function () { paint(); }, 1500);

    // On Talk the page ships its own "Voice" pill, which toggles spoken replies.
    // Two controls both labelled Voice is the confusion this work exists to end,
    // so the page one says what it actually does.
    if (section() === "talk") {
      var t2 = setInterval(function () {
        var vt = document.getElementById("voiceToggle");
        var label = vt && vt.querySelector(".vt-label");
        if (label) {
          if (label.textContent !== "Speak replies") label.textContent = "Speak replies";
          vt.title = "Read BeeZilla's replies aloud";
          clearInterval(t2);
        }
      }, 300);
      setTimeout(function () { clearInterval(t2); }, 15000);
    }
  }

  window.BeeZillaChrome = { boot: boot, section: section, syncBleed: applyBleed };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

/**
 * The page shell: navigation that does not reload the document.
 *
 * Why: the voice session lives in Talk's JavaScript. Every `/buzzy/*` page was a
 * full document load, so clicking one nav link destroyed the recogniser, the
 * audio context and the half-finished sentence. The fix is not "resume the mic
 * on load" (you still lose what you were saying) but keeping one document alive
 * across navigation:
 *
 *  - Talk's DOM is CACHED, hidden, still attached. Its closures, recogniser and
 *    audio stay valid, so the conversation genuinely continues while you move.
 *  - Other pages are fetched, their scripts executed in order, and rebuilt.
 *
 * It is deliberately small and additive: a hard reload still works, every page
 * still renders on its own, and a browser without `fetch`/`pushState` falls back
 * to ordinary links.
 */
(function () {
  "use strict";
  if (window.BeeZillaShell) return;
  if (!window.fetch || !history.pushState) return;

  // Pages whose DOM must survive navigation, because something live lives in it.
  var KEEP_ALIVE = ["/buzzy/talk"];
  var cache = Object.create(null); // key -> { el, title, styles }
  var busy = false;
  // popstate fires AFTER location has changed, so "which page am I stashing?" must
  // come from our own record, never from location.href.
  var currentKey = keyOf(location.href);

  // A hard load ships the page's own <style> tags with NO data-bz-style, so the
  // "only the active page's CSS is enabled" switch never saw them: after soft
  // navigating off Capabilities its `body{padding:0 1.1rem}` stayed live on every
  // following page, and the chrome's negative margin then cancelled padding that
  // page did not have (header x = -18px on Talk — BZ-11 residual). Claim the
  // initial page's stylesheets for its own key so the switch owns them from the
  // first hop. The chrome's stylesheet is never claimed: it must survive every page.
  Array.prototype.forEach.call(
    document.querySelectorAll('head style, head link[rel="stylesheet"]'),
    function (el) {
      if (el.id === "bz-chrome-css" || el.hasAttribute("data-bz-style")) return;
      el.setAttribute("data-bz-style", currentKey);
    }
  );

  function keyOf(url) {
    var u = url instanceof URL ? url : new URL(url, location.href);
    return u.pathname.replace(/\/+$/, "") + u.search;
  }
  function isShellPath(u) {
    return u.origin === location.origin && /^\/buzzy(\/|$)/.test(u.pathname);
  }
  function keepAlive(key) {
    return KEEP_ALIVE.indexOf(key.replace(/\?.*$/, "")) >= 0;
  }

  function ensurePageWrapper() {
    var page = document.getElementById("bzPage");
    if (!page) {
      page = document.createElement("div");
      page.id = "bzPage";
      var kids = Array.prototype.slice.call(document.body.children);
      kids.forEach(function (k) {
        if (k.id === "bzPageCache") return;
        page.appendChild(k);
      });
      document.body.appendChild(page);
    }
    if (!document.getElementById("bzPageCache")) {
      var c = document.createElement("div");
      c.id = "bzPageCache";
      c.style.display = "none";
      document.body.appendChild(c);
    }
    return page;
  }

  // The page name is one of the title's two inputs; the live-mic marker is the
  // other, and the chrome owns it (window.BeeZillaTitle). This delegates so the
  // two IIFEs cannot each rename the tab.
  function setTitle(t) {
    if (!t) return;
    if (window.BeeZillaTitle) window.BeeZillaTitle.setPage(t);
    else document.title = t;
  }

  function adoptStyles(doc, key) {
    var cachedEntry = cache[key];
    var holder;
    if (doc) {
      holder = Array.prototype.slice.call(document.querySelectorAll('[data-bz-style="' + key + '"]'));
      var fresh = holder.length === 0;
      if (!fresh) {
        if (cachedEntry) cachedEntry.styles = holder;
        holder = null;
        Array.prototype.forEach.call(document.querySelectorAll("[data-bz-style]"), function (el) {
          try { el.disabled = el.getAttribute("data-bz-style") !== key; } catch (e) {}
        });
        return;
      }
      holder = [];
      Array.prototype.forEach.call(doc.querySelectorAll('style, link[rel="stylesheet"]'), function (el) {
        var mine = el.cloneNode(true);
        mine.setAttribute("data-bz-style", key);
        document.head.appendChild(mine);
        holder.push(mine);
      });
      if (cachedEntry) cachedEntry.styles = holder;
    } else if (cachedEntry && cachedEntry.styles) {
      holder = cachedEntry.styles;
    }
    // Only the active page's stylesheets are enabled. Pages style `body`, `#app`
    // and bare element selectors, so leaving two pages' CSS on at once repaints
    // the current page with the previous one's rules.
    Array.prototype.forEach.call(document.querySelectorAll("[data-bz-style]"), function (el) {
      var on = el.getAttribute("data-bz-style") === key;
      try { el.disabled = !on; } catch (e) { /* link elements on some browsers */ }
    });
    if (holder) {
      holder.forEach(function (el) { try { el.disabled = false; } catch (e) {} });
    }
  }

  function runScripts(root) {
    var scripts = Array.prototype.slice.call(root.querySelectorAll("script"));
    // One document runs every page's scripts, so a top-level `const` on page B collides
    // with page A's — "Identifier 'QUESTIONS' has already been declared" killed the
    // whole Library script on a soft navigation out of Talk (BZ-16). Each run of
    // CONSECUTIVE inline blocks now executes inside one function scope: the names stay
    // private to that page, cross-block references inside the page still work, and the
    // page's globals can no longer overwrite the cached page's state. <script src>
    // tags keep their own file scope and their position in the order.
    var batch = [];
    function flush() {
      if (!batch.length) return Promise.resolve();
      var src = batch.join("\n;\n");
      batch = [];
      var n = document.createElement("script");
      n.textContent = "(function(){\n" + src + "\n})();";
      document.head.appendChild(n);
      return Promise.resolve();
    }
    return scripts.reduce(function (chain, s) {
      return chain.then(function () {
        if (s.src && /\/buzzy\/nav\.js(\?|$)/.test(s.src)) { s.remove(); return; }
        if (s.src) {
          return flush().then(function () {
            return new Promise(function (resolve) {
              var n = document.createElement("script");
              Array.prototype.forEach.call(s.attributes, function (a) { n.setAttribute(a.name, a.value); });
              n.onload = resolve;
              n.onerror = resolve;
              document.head.appendChild(n);
              s.remove();
            });
          });
        }
        batch.push(s.textContent);
        s.remove();
      });
    }, Promise.resolve()).then(flush);
  }

  // Chrome-owned nodes must not ride in with the page.
  // A hard load calls boot(), which empties the page's <header> and rebuilds it from
  // the chrome; a SOFT load does not (boot() returns early once #bzChrome exists), so
  // the fetched header used to land inside #bzPage as a SECOND header — a duplicate
  // nav row and a second identity link, which is where the visible `Sign in` inside
  // the page came from (BZ-18, and the stray "Sign in" BZ-15 kept reporting). Strip
  // the chrome's parts and keep whatever the page genuinely owns in that header
  // (toolbars, search boxes), so the page does not lose its controls.
  var CHROME_OWNED = [
    "#bzNav", ".bz-navbar", ".bz-brandrow", ".bz-brand", ".brand", ".brand-link",
    "#accountLink", ".account-link", ".account-menu", ".hd-chip", "#bzVoiceDock",
    "#bzPlanChip", "#bzHoneyChip", "#bzPanel",
  ].join(",");
  function stripChrome(root) {
    Array.prototype.forEach.call(root.querySelectorAll(CHROME_OWNED), function (n) {
      if (n.closest("#bzChrome")) return; // the live chrome, not the imported copy
      n.parentNode && n.parentNode.removeChild(n);
    });
    // Whatever the page kept in its own <header> (a toolbar, a search box) is page
    // content, not chrome: unwrap it into the page so there is exactly one header
    // on the document and the page's controls still render.
    Array.prototype.forEach.call(root.querySelectorAll("header"), function (h) {
      if (h.closest("#bzChrome")) return;
      var p = h.parentNode;
      if (!p) return;
      while (h.firstChild) p.insertBefore(h.firstChild, h);
      p.removeChild(h);
    });
  }

  function buildFromDoc(doc, key) {
    var page = document.createElement("div");
    page.id = "bzPage";
    page.setAttribute("data-bz-path", key);
    Array.prototype.forEach.call(doc.body.children, function (child) {
      if (child.tagName === "SCRIPT" && /\/buzzy\/nav\.js/.test(child.getAttribute("src") || "")) return;
      page.appendChild(document.importNode(child, true));
    });
    stripChrome(page);
    return page;
  }

  function finish(key, title, scrollY) {
    currentKey = key;
    adoptStyles(null, key);
    setTitle(title);
    if (window.BeeZillaChrome) window.BeeZillaChrome.boot();
    // Pages that wait for DOMContentLoaded (memory.html) never see it again in a
    // soft navigation; a synthetic event keeps their boot code honest.
    try { document.dispatchEvent(new Event("DOMContentLoaded")); } catch (e) {}
    try { window.scrollTo(0, scrollY || 0); } catch (e) {}
    busy = false;
  }

  function stashCurrent() {
    var page = document.getElementById("bzPage");
    if (!page) return;
    var key = page.getAttribute("data-bz-path") || currentKey;
    if (keepAlive(key)) {
      // The chrome is rebuilt on restore, so the cached copy must not keep a
      // second #bzNav / #bzVoiceDock / #bzPlanChip alive: duplicate ids make
      // getElementById return the hidden copy and the visible control "vanish".
      var staleHeader = page.querySelector("header");
      if (staleHeader) staleHeader.remove();
      cache[key] = {
        el: page,
        title: window.BeeZillaTitle ? window.BeeZillaTitle.page : document.title,
        scrollY: window.scrollY,
        styles: Array.prototype.slice.call(document.querySelectorAll('[data-bz-style="' + key + '"]')),
      };
      document.getElementById("bzPageCache").appendChild(page);
      // A stashed page keeps its content (that is what keep-alive is for) but must not
      // keep the id: two elements answering `bzPage` makes getElementById pick whichever
      // is first in document order, which is how a probe sees "a second <main>" and how
      // a page's own code can end up measuring the hidden copy. restore() puts it back.
      page.removeAttribute("id");
    } else {
      page.parentNode && page.parentNode.removeChild(page);
    }
  }

  function restore(key) {
    var entry = cache[key];
    var page = entry.el;
    document.getElementById("bzPageCache").removeChild(page);
    page.id = "bzPage";
    document.body.insertBefore(page, document.getElementById("bzPageCache"));
    finish(key, entry.title, entry.scrollY);
  }

  function go(href, opts) {
    opts = opts || {};
    var url;
    try { url = new URL(href, location.href); } catch (e) { return Promise.resolve(); }
    if (!isShellPath(url)) { location.href = url.href; return Promise.resolve(); }
    var key = keyOf(url);
    if (key === keyOf(location.href)) return Promise.resolve();
    if (busy) return Promise.resolve();
    busy = true;

    ensurePageWrapper();
    var target = document.getElementById("bzPage");
    if (target) target.setAttribute("data-bz-path", currentKey);
    stashCurrent();
    currentKey = key;
    // Default is to push; only popstate passes push:false (history already moved).
    if (opts.push !== false) history.pushState({ bzShell: key }, "", url.pathname + url.search);

    if (cache[key]) { restore(key); return Promise.resolve(); }

    return fetch(url.href, { credentials: "same-origin", headers: { "x-bz-shell": "1" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var page = buildFromDoc(doc, key);
        document.body.insertBefore(page, document.getElementById("bzPageCache"));
        adoptStyles(doc, key);
        return runScripts(page).then(function () {
          finish(key, doc.title, 0);
        });
      })
      .catch(function () {
        // A shell that cannot fetch must not trap the user: fall back to a real
        // navigation, which is the old behaviour and always works.
        busy = false;
        location.href = url.href;
      });
  }

  document.addEventListener(
    "click",
    function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a) return;
      // The identity chip is a dropdown trigger, not a page link. The shell used to
      // soft-navigate on it before the chrome's own click handler could toggle the
      // menu, so clicking your name took you to /buzzy/profile and no menu ever showed.
      if (a.id === "accountLink") return;
      if (a.target && a.target !== "_self") return;
      if (a.hasAttribute("download")) return;
      var href = a.getAttribute("href");
      if (!href || href.charAt(0) === "#") return;
      var url;
      try { url = new URL(href, location.href); } catch (err) { return; }
      if (!isShellPath(url)) return;
      e.preventDefault();
      go(url.href);
    },
    true
  );

  window.addEventListener("popstate", function () {
    go(location.href, { push: false });
  });

  window.BeeZillaShell = { go: go, cache: cache, get busy() { return busy; }, get currentKey() { return currentKey; } };
})();
