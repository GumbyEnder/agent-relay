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
      "#bzChrome button.bz-voice{display:inline-flex;align-items:center;gap:.35rem;background:#161616;color:#f2f2f2;border:1px solid #3a3a3a;border-radius:999px;padding:.3rem .7rem;font:inherit;font-size:.82rem;font-weight:600;cursor:pointer;white-space:nowrap}",
      "#bzChrome button.bz-voice[aria-pressed='true']{background:#ffd40d;color:#111;border-color:#ffd40d}",
      "#bzChrome button.bz-voice:focus-visible{outline:2px solid #ffd40d;outline-offset:2px}",
      "#bzPanel{position:fixed;right:1rem;top:64px;width:min(420px,calc(100vw - 2rem));height:min(560px,calc(100vh - 88px));background:#101010;border:1px solid #2c2c2c;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.55);display:none;flex-direction:column;z-index:900;padding:.6rem}",
      "#bzPanel.open{display:flex}",
      "#bzPanel .bz-panel-head{display:flex;align-items:center;justify-content:space-between;padding:0 .2rem .45rem;font-size:.82rem;color:#8d8d8d}",
      "#bzPanel .bz-panel-body{flex:1;min-height:0}",
      "#bzPanel .bz-panel-close{background:none;border:0;color:#8d8d8d;font-size:1rem;cursor:pointer;padding:0 .2rem}",
      ".bz-brandrow{display:flex;align-items:center;gap:.9rem;height:56px;min-height:56px;padding:0 .1rem}",
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
      if (l.blank) { a.target = "_blank"; a.rel = "noopener"; }
      ordered.push(a);
    });
    ordered.forEach(function (a) { nav.appendChild(a); });

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

  /** Who is signed in? One place, right beside the logo. */
  function accountControl(chrome) {
    // Pages that already render a full account menu (name, email, Log out) keep it;
    // adding our own link beside it produced 'Shane' twice on Talk.
    var menu = document.querySelector("header .account-menu");
    if (menu) {
      var stray = chrome.querySelector("a.bz-account");
      if (stray) stray.remove();
      chrome.appendChild(menu);
      return;
    }
    var existing = document.getElementById("accountLink");
    var a = existing || document.createElement("a");
    a.id = "accountLink";
    a.className = "bz-account account-link";
    a.href = "/buzzy/landing";
    chrome.appendChild(a); // moves it out of the nav when the page shipped one there
    // No "…" placeholder: an empty label with a reserved width cannot be mistaken
    // for a name, and it does not flash "Sign in" at a signed-in user.
    a.textContent = "";
    a.style.minWidth = "5.5rem";
    fetch("/api/auth/get-session", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) {
        var user = res && res.user;
        if (user && (user.name || user.email)) {
          a.textContent = user.name || user.email;
          a.href = "/buzzy/profile";
          a.title = user.email || "Your account";
        } else {
          a.textContent = "Sign in";
          a.href = "/buzzy/landing";
          a.title = "Sign in";
        }
      })
      .catch(function () { a.textContent = "Sign in"; });

    // The page may build its own account menu after us (Talk does). Watch briefly and
    // hand over to it, so the logo line never reads 'Shane  Shane  shane@…  Log out'.
    var tries = 0;
    var watch = setInterval(function () {
      tries++;
      var later = document.querySelector("header .account-menu");
      if (later) {
        if (a.parentNode) a.remove();
        chrome.appendChild(later);
        clearInterval(watch);
      } else if (tries > 24) clearInterval(watch);
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
    fetch("/api/wallet", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && typeof d.balance === "number") {
          chip.textContent = "\u25c8 " + Number(d.balance).toLocaleString();
          chip.title = Number(d.balance).toLocaleString() + " Honey Drops";
        }
      })
      .catch(function () { chip.textContent = "\u25c8"; });
  }

  /**
   * Voice: one control, in the chrome, on every page.
   *
   * Stage 1 of the nav voice work. On Talk the pill drives the page's own mic, so
   * there is exactly one voice button visible. On every other page it takes you to
   * Talk with the mic armed — because the audio pipeline still lives in the Talk
   * document, a hard navigation kills it. Making that honest in the UI beats a
   * mic button on Sketch that silently does nothing.
   */
  function voiceControl(chrome) {
    var btn = document.createElement("button");
    btn.id = "bzVoiceNav";
    btn.className = "bz-voice";
    btn.type = "button";
    btn.setAttribute("aria-pressed", "false");
    btn.innerHTML = '<span aria-hidden="true">&#127908;</span> Voice';
    chrome.appendChild(btn);

    var onTalk = section() === "talk";
    function sync() {
      var mic = document.getElementById("micBtn");
      var live = !!(mic && mic.getAttribute("aria-pressed") === "true");
      btn.setAttribute("aria-pressed", live ? "true" : "false");
      btn.innerHTML = live
        ? '<span aria-hidden="true">&#127908;</span> Listening \u2014 End'
        : '<span aria-hidden="true">&#127908;</span> Voice';
      btn.title = live ? "End the voice session" : "Talk to BeeZilla out loud";
    }

    if (onTalk) {
      btn.addEventListener("click", function () {
        var mic = document.getElementById("micBtn");
        if (mic) mic.click();
        sync();
      });
      // The page owns the state; the chrome only mirrors it.
      var t = setInterval(sync, 400);
      setTimeout(function () { clearInterval(t); }, 120000);
      sync();
    } else {
      btn.title = "Voice lives on Talk — this takes you there with the mic armed";
      btn.addEventListener("click", function () {
        try { localStorage.setItem("bz_listen_mode", "1"); } catch (e) {}
        location.href = "/buzzy/talk";
      });
    }

    // On Talk the page ships its own "Voice" pill, which toggles spoken replies.
    // Two pills both labelled Voice is the confusion this work exists to end, so
    // the page one says what it actually does.
    if (onTalk) {
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

  /** The brand for row one: whatever the page has, or a plain BeeZilla mark. */
  function findBrand(header) {
    var existing = header.querySelector(".brand-link, .brand, .bz-brand");
    if (existing) return existing;
    var a = document.createElement("a");
    a.className = "bz-brand";
    a.href = "/buzzy/talk";
    a.innerHTML =
      '<img src="/buzzy/brand/revision6_expressions_16-smiling.png" alt="" /><strong>BeeZilla</strong>';
    return a;
  }

  function boot() {
    style();
    var nav = ensureNav();
    if (document.getElementById("bzChrome")) return;
    var header = nav.closest("header") || document.querySelector("header") || document.body;

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
      if (el === account) return false;
      return true;
    });

    // Row one: brand, then the identity cluster. Row two: the links. The rows must
    // STACK — a header that is itself a flex row put them side by side.
    header.style.display = "block";
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
    extras.forEach(function (el) { header.appendChild(el); });

    loadCompanies();
    honeyControl(chrome);
    companyControl(chrome);
    voiceControl(chrome);
    accountControl(chrome);
    askControl(chrome);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
