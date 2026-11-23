/**
 * The site chrome: one nav, one company switcher, one settings gear.
 *
 * Three problems this file exists to end:
 *
 *  1. **The company switcher was a full-width row of tabs under the header.**
 *     It cost a whole line of vertical space on every page and grew horizontally
 *     with every company. It is a `<select>` in the nav now — one control, same
 *     height as the links, and it cannot overflow.
 *  2. **The header was crowded with personal things.** A Honey Drops chip, a plan
 *     chip, Listen and Ask sat beside the company switcher. The owner asked for
 *     them to go: the header keeps the company and your name, and everything
 *     personal (account, plan, usage, Honey Drops) lives behind one gear in the
 *     bottom-right corner of every page (settingsDock).
 *  3. **Every page hand-wrote its own nav and they drifted.** This builds the nav
 *     from one list, computes the active link from the path, and adds anything a
 *     page is missing — by id, never by index.
 *
 * Loaded by pages.nitro.ts on every HTML page, so a new page inherits it for free.
 */
(function () {
  "use strict";

  /**
   * CR-6 diagnostic ring buffer. Ships with the nav so every page that has the
   * header has it, and lives only in memory: nothing is written to storage and
   * nothing is transmitted unless the user ticks the box.
   *
   * The failure worth reporting usually happened BEFORE the panel was clicked,
   * which is why this is always-on rather than panel-only. Only three sources:
   * console.error, window.onerror and unhandledrejection. Never console.log,
   * never request bodies, never response bodies.
   */
  var bzDiagLog = { errors: [], requests: [] };
  function bzPush(list, item, cap) {
    list.push(item);
    if (list.length > cap) list.splice(0, list.length - cap);
  }
  (function () {
    var MAX = 50;
    var origError = console.error;
    console.error = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          parts.push(typeof a === "string" ? a : a && a.message ? String(a.message) : String(a));
        }
        bzPush(bzDiagLog.errors, {
          at: new Date().toISOString(),
          kind: "error",
          message: parts.join(" ").slice(0, 500),
          source: (document.currentScript && document.currentScript.src) || location.pathname,
        }, MAX);
      } catch (e) { /* never break logging */ }
      return origError.apply(console, arguments);
    };
    window.addEventListener("error", function (ev) {
      bzPush(bzDiagLog.errors, {
        at: new Date().toISOString(),
        kind: "onerror",
        message: String((ev && ev.message) || "script error").slice(0, 500),
        source: ev && ev.filename ? ev.filename + ":" + (ev.lineno || 0) : location.pathname,
      }, MAX);
    });
    window.addEventListener("unhandledrejection", function (ev) {
      var r = ev && ev.reason;
      bzPush(bzDiagLog.errors, {
        at: new Date().toISOString(),
        kind: "unhandledrejection",
        message: String((r && (r.message || r)) || "unhandled rejection").slice(0, 500),
        source: location.pathname,
      }, MAX);
    });
    if (window.fetch) {
      var origFetch = window.fetch;
      window.fetch = function (input, init) {
        var started = Date.now();
        var method = (init && init.method) || (input && input.method) || "GET";
        var url = typeof input === "string" ? input : (input && input.url) || "";
        return origFetch.apply(this, arguments).then(function (res) {
          if (!res.ok && res.status !== 401) {
            bzPush(bzDiagLog.requests, {
              at: new Date().toISOString(),
              method: String(method).toUpperCase(),
              url: url,
              status: res.status,
              ms: Date.now() - started,
            }, MAX);
          }
          return res;
        }, function (err) {
          bzPush(bzDiagLog.requests, {
            at: new Date().toISOString(),
            method: String(method).toUpperCase(),
            url: url,
            status: 0,
            ms: Date.now() - started,
          }, MAX);
          throw err;
        });
      };
    }
  })();

  /**
   * Client-side twin of src/lib/buzzy/feedback.ts's redaction list. It runs over
   * the diagnostic object before the expander renders it, so the preview IS the
   * payload. The server runs the same rules again before insert — belt and
   * braces, because "we redacted in the browser" is a claim about a client we
   * do not control.
   */
  function bzRedact(value) {
    var count = 0;
    var kinds = {};
    var rules = [
      ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, null],
      ["api_key", /\b(?:sk|rk|ark|pk|ghp|gho|ghu|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g, null],
      ["aws_key", /\bAKIA[0-9A-Z]{16}\b/g, null],
      ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, null],
      ["key_query_param", /([?&](?:token|key|api_?key|secret|password|passwd|code|sig|signature|access_token)=)[^&#\s"']+/gi, "$1[redacted]"],
      ["high_entropy", /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{40,}(?![A-Za-z0-9+/=_-])/g, null]
    ];
    function clean(s) {
      var text = String(s);
      for (var i = 0; i < rules.length; i++) {
        var kind = rules[i][0], re = rules[i][1], repl = rules[i][2];
        text = text.replace(re, function () {
          count += 1;
          kinds[kind] = true;
          if (repl) return repl.replace("$1", arguments[1] || arguments[0]);
          return "[redacted]";
        });
      }
      return text;
    }
    function walk(v, key) {
      if (typeof v === "string") return clean(v);
      if (Array.isArray(v)) return v.map(function (x) { return walk(x); });
      if (v && typeof v === "object") {
        var out = {};
        for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = walk(v[k], k);
        return out;
      }
      return v;
    }
    var result = walk(value);
    return { value: result, count: count, kinds: Object.keys(kinds).sort() };
  }

  /** The object the expander renders and the POST carries — one builder. */
  function bzDiagPayload(signedIn) {
    var d = {
      captured_at: new Date().toISOString(),
      page: {
        // Path only. The server strips the query and fragment again; doing it
        // here is what makes the preview honest.
        url: location.pathname,
        route: section(),
      },
      browser: {
        user_agent: navigator.userAgent,
        platform: navigator.platform || "",
        language: navigator.language || "",
      },
      display: {
        screen: (screen.width || 0) + "x" + (screen.height || 0),
        viewport: (window.innerWidth || 0) + "x" + (window.innerHeight || 0),
        device_pixel_ratio: window.devicePixelRatio || 1,
      },
      account: { signed_in: Boolean(signedIn), user_id: null },
      console_errors: bzDiagLog.errors.slice(-50),
      failed_requests: bzDiagLog.requests.slice(-50).map(function (r) {
        return { at: r.at, method: r.method, url: r.url.split(/[?#]/)[0], status: r.status, ms: r.ms };
      }),
    };
    return bzRedact(d);
  }

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
    { id: "studio", href: "/buzzy/studio", label: "Music studio", more: true },
    { id: "capabilities", href: "/buzzy/capabilities", label: "What BeeZilla can do", more: true },
    // The installer is a place in the product, not a README footnote: a person
    // who arrives wanting the desktop app should not have to open "More" to
    // find it. It sits in the row with the other places (and in #bzPlaces).
    { id: "download", href: "/buzzy/download", label: "Download" },
    // "Honey", not "Honey Drops": #bzPlaces says Honey, and this label is what an
    // anchor looks like on a page that did not hand-write one.
    { id: "wallet", href: "/buzzy/wallet", label: "Honey", more: true },
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
      // ── Settings dock (settingsDock): the gear, its panel and the live-mic pill ──
      // Pinned to the bottom-right corner. z-index 45 sits above page content and the
      // back-to-top button (40) but UNDER every pop-up a page opens — account menus and
      // the recipe purchase modal (50), the History drawer (60/61), share and the
      // Inspiration viewer (10000) — so a dialog always covers the gear, never the reverse.
      // Every rule is id-scoped and names its own box: pages style bare `button` and `a`
      // (filled yellow buttons, page link colours), and the dock must look the same on all.
      "#bzDock{position:fixed;right:22px;bottom:22px;z-index:45;display:flex;align-items:center;gap:10px;font-family:system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;font-size:16px;line-height:1.4}",
      "#bzDock [hidden]{display:none!important}",
      "#bzGear{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:44px;height:44px;min-width:0;min-height:0;margin:0;padding:0;border-radius:50%;border:1px solid #3a3a3a;background:#161616;color:#d6d6d6;box-shadow:0 6px 18px rgba(0,0,0,.45);cursor:pointer;transition:color .15s,border-color .15s}",
      "#bzGear svg{width:22px;height:22px;display:block;transition:transform .25s}",
      "#bzGear:hover,#bzGear[aria-expanded='true']{color:#ffd40d;border-color:#ffd40d;background:#161616}",
      "#bzGear[aria-expanded='true'] svg{transform:rotate(45deg)}",
      "#bzGear:focus-visible{outline:2px solid #ffd40d;outline-offset:3px}",
      "@media (prefers-reduced-motion:reduce){#bzGear svg,#bzSettings .bzs-bar span{transition:none}}",
      "#bzMicLive{display:inline-flex;align-items:center;gap:8px;box-sizing:border-box;height:36px;padding:0 6px 0 12px;border-radius:999px;border:1px solid #5b4a10;background:#1a1606;color:#ffe680;font-size:13px;font-weight:700;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.45)}",
      "#bzMicLive .bz-mic-dot{width:8px;height:8px;border-radius:50%;background:#ff5a5a;box-shadow:0 0 0 3px rgba(255,90,90,.2)}",
      "#bzMicLive.paused .bz-mic-dot{background:#9a9a9a;box-shadow:none}",
      "#bzMicLive.paused{padding-right:12px}",
      "#bzMicLive button{display:inline-flex;align-items:center;box-sizing:border-box;height:26px;min-height:0;min-width:0;margin:0;box-shadow:none;padding:0 10px;border-radius:999px;font:inherit;font-size:12px;font-weight:700;letter-spacing:normal;text-transform:none;cursor:pointer}",
      "#bzMicLive button:focus-visible{outline:2px solid #ffd40d;outline-offset:2px}",
      "#bzMicCut{border:1px solid #6b5a1e;background:#2a2306;color:#ffe680}",
      "#bzMicCut:hover{background:#3a300a}",
      "#bzMicStop{border:1px solid #5b1f24;background:#2a1214;color:#ffb4b4}",
      "#bzMicStop:hover{background:#3a171a}",
      "#bzSettings{position:fixed;right:22px;bottom:78px;box-sizing:border-box;width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 110px);overflow-y:auto;padding:14px 16px 16px;border-radius:14px;border:1px solid #2c2c2c;background:#121212;color:#e8e8e8;box-shadow:0 24px 60px rgba(0,0,0,.6);text-align:left}",
      "#bzSettings .bzs-head{display:flex;align-items:center;justify-content:space-between;margin:0 0 4px}",
      "#bzSettings .bzs-title{font-size:15px;font-weight:700;color:#f2f2f2;margin:0}",
      "#bzSettings .bzs-close{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;min-height:0;min-width:0;margin:0;box-shadow:none;padding:0;border:0;border-radius:8px;background:none;color:#8d8d8d;font:inherit;font-size:20px;line-height:1;cursor:pointer}",
      "#bzSettings .bzs-close:hover{color:#ffd40d;background:#1c1c1c}",
      "#bzSettings .bzs-sec{padding:12px 0;border-top:1px solid #232323}",
      "#bzSettings .bzs-sec:last-child{padding-bottom:0}",
      "#bzSettings .bzs-h{margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8d8d8d}",
      "#bzSettings .bzs-name{font-size:15px;font-weight:600;color:#f2f2f2;word-break:break-word}",
      "#bzSettings .bzs-email{font-size:13px;color:#9a9a9a;margin-top:2px;word-break:break-all}",
      "#bzSettings .bzs-row{display:flex;align-items:center;justify-content:space-between;gap:10px}",
      "#bzSettings .bzs-name + .bzs-row,#bzSettings .bzs-email + .bzs-row{margin-top:12px}",
      "#bzSettings a.bzs-link{color:#ffd40d;text-decoration:none;font-size:13px;font-weight:600;white-space:nowrap}",
      "#bzSettings a.bzs-link:hover{text-decoration:underline}",
      "#bzSettings .bzs-btn{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:0;min-width:0;margin:0;box-shadow:none;padding:6px 12px;border-radius:8px;border:1px solid #333;background:#1b1b1b;color:#e8e8e8;font:inherit;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer}",
      "#bzSettings .bzs-btn:hover{border-color:#ffd40d;color:#ffd40d;background:#1b1b1b}",
      "#bzSettings .bzs-btn.primary{background:#ffd40d;border-color:#ffd40d;color:#111}",
      "#bzSettings .bzs-btn.primary:hover{background:#ffe14d;color:#111}",
      "#bzSettings a:focus-visible,#bzSettings button:focus-visible{outline:2px solid #ffd40d;outline-offset:2px}",
      "#bzSettings .bzs-plan{display:inline-flex;align-items:center;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:800;letter-spacing:.04em;border:1px solid #3a3a3a;color:#cfcfcf}",
      "#bzSettings .bzs-plan.pro{background:#ffd40d;color:#111;border-color:#ffd40d}",
      "#bzSettings .bzs-plan.starter{background:#1d2b22;color:#a9f0c4;border-color:#2c5138}",
      "#bzSettings .bzs-renew{font-size:12px;color:#9a9a9a}",
      "#bzSettings .bzs-meter{margin-top:12px}",
      "#bzSettings .bzs-meter-top{display:flex;justify-content:space-between;gap:10px;font-size:13px;color:#cfcfcf}",
      "#bzSettings .bzs-meter-top b{font-weight:600;color:#f2f2f2}",
      "#bzSettings .bzs-bar{height:6px;margin-top:6px;border-radius:999px;background:#262626;overflow:hidden}",
      "#bzSettings .bzs-bar span{display:block;height:100%;width:0;border-radius:999px;background:#ffd40d;transition:width .3s}",
      "#bzSettings .bzs-bar.low span{background:#ff7a59}",
      "#bzSettings .bzs-note{margin:10px 0 0;font-size:12px;color:#7d7d7d}",
      "#bzSettings .bzs-honey{font-size:15px;font-weight:700;color:#ffd40d}",
      "#bzSettings .bzs-muted{font-size:13px;color:#9a9a9a;margin:0}",
      // Phone width: the corner insets match the 16px page gutter, and the panel's
      // buttons grow to thumb size (Talk asks for 48px targets on a phone).
      "@media (max-width:640px){#bzDock{right:16px;bottom:16px}#bzSettings{right:16px;bottom:72px;max-height:calc(100vh - 100px)}#bzSettings .bzs-close{width:40px;height:40px}#bzSettings .bzs-btn{min-height:40px;padding:8px 14px}#bzMicLive button{height:32px}}",
      // The Feedback pill (CR-6) wears the class the Ask pill had, and its panel opens
      // under the header. Minimised it docks bottom-LEFT, the app's corner for folded
      // panels (share, Inspiration): bottom-right is the settings gear's.
      "#bzChrome button.bz-ask{display:inline-flex;align-items:center;gap:.35rem;background:#ffd40d;color:#111;border:0;border-radius:999px;padding:.3rem .7rem;font:inherit;font-size:.82rem;font-weight:700;cursor:pointer;white-space:nowrap}",
      "#bzChrome button.bz-ask[aria-expanded='true']{background:#fff0a8}",
      "#bzChrome button.bz-ask:focus-visible{outline:2px solid #ffd40d;outline-offset:2px}",
      "#bzFeedback{position:fixed;right:1rem;top:64px;width:min(440px,calc(100vw - 2rem));max-height:min(640px,calc(100vh - 88px));background:#101010;border:1px solid #2c2c2c;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.55);display:none;flex-direction:column;z-index:900;padding:.7rem}",
      "#bzFeedback.open{display:flex}",
      "#bzFeedback .bz-panel-head{display:flex;align-items:center;justify-content:space-between;padding:0 .2rem .5rem;font-size:.85rem;color:#c9c9c9}",
      "#bzFeedback .bz-panel-close{background:none;border:0;color:#8d8d8d;font-size:1rem;cursor:pointer;padding:0 .2rem}",
      "#bzFeedback .bz-panel-close:hover{color:#ffd40d}",
      "#bzFeedback .bz-panel-tools{display:flex;align-items:center;gap:.35rem}",
      "#bzFeedback.min{max-height:60px;top:auto;bottom:1rem;width:auto;min-width:220px}",
      "#bzFeedback.min .bz-panel-body{display:none}",
      "#bzFeedback .bz-fb-body{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:.55rem;padding:0 .1rem .2rem}",
      "#bzFeedback .bz-fb-label{font-size:.8rem;color:#c9c9c9}",
      "#bzFeedback .bz-fb-text{width:100%;box-sizing:border-box;background:#0b0b0b;color:#f2f2f2;border:1px solid #333;border-radius:10px;padding:.6rem .7rem;font:inherit;font-size:.9rem;resize:vertical;min-height:96px}",
      "#bzFeedback .bz-fb-text:focus{outline:2px solid #ffd40d;outline-offset:1px}",
      "#bzFeedback .bz-fb-row{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap}",
      "#bzFeedback .bz-fb-mic{background:#1b1b1b;color:#f2f2f2;border:1px solid #3a3a3a;border-radius:999px;padding:.32rem .75rem;font:inherit;font-size:.82rem;cursor:pointer}",
      "#bzFeedback .bz-fb-mic[aria-pressed='true']{background:#ffd40d;color:#111;border-color:#ffd40d}",
      "#bzFeedback .bz-fb-hint{font-size:.75rem;color:#8d8d8d}",
      "#bzFeedback .bz-fb-check{display:flex;align-items:center;gap:.45rem;font-size:.82rem;color:#c9c9c9}",
      "#bzFeedback .bz-fb-link{background:none;border:0;color:#ffd40d;font:inherit;font-size:.8rem;cursor:pointer;padding:0;text-align:left}",
      "#bzFeedback .bz-fb-diag{margin:0;max-height:220px;overflow:auto;background:#070707;border:1px solid #262626;border-radius:8px;padding:.5rem;font-size:.7rem;line-height:1.35;color:#bdbdbd;white-space:pre-wrap;word-break:break-word}",
      "#bzFeedback .bz-fb-never{font-size:.72rem;line-height:1.4;color:#7d7d7d;margin:0}",
      "#bzFeedback .bz-fb-actions{display:flex;justify-content:flex-end}",
      "#bzFeedback .bz-fb-send{background:#ffd40d;color:#111;border:0;border-radius:999px;padding:.45rem 1rem;font:inherit;font-size:.85rem;font-weight:700;cursor:pointer}",
      "#bzFeedback .bz-fb-send:disabled{opacity:.55;cursor:default}",
      "#bzFeedback .bz-fb-status{font-size:.78rem;color:#c9c9c9;margin:0;min-height:1em}",
      "#bzFeedback .bz-fb-done p{margin:.25rem 0;font-size:.88rem;color:#e6e6e6}",
      "#bzFeedback .bz-fb-done code{background:#1b1b1b;border-radius:6px;padding:.1rem .35rem;color:#ffd40d}",
      "@media (max-width:560px){#bzFeedback{left:.5rem;right:.5rem;top:56px;width:auto;max-height:calc(100vh - 68px)}}",
      "#bzFeedback.min{left:1rem;right:auto}",
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
      // The link row lives IN the brand row now (owner's markup, Nov 2026): the
      // nav was a second full-width bar that cost a whole row of vertical space on
      // every page. It sits between the brand and the identity cluster, centred,
      // and shrinks (scrolls sideways) before the cluster does. `safe center` falls
      // back to `start` the moment the row is wider than the bar, so centring can
      // never clip the first link.
      ".bz-brandrow #bzNav{flex:1 1 auto;min-width:0;display:flex;align-items:center;justify-content:safe center;gap:.9rem;overflow-x:auto;scrollbar-width:none;padding:0 4px}",
      ".bz-brandrow #bzNav::-webkit-scrollbar{display:none}",
      "#bzChrome{flex:0 0 auto}",
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
      "#bzChrome .account-menu .am-plan{font-size:.74rem;color:#b9b9b9;line-height:1.35;margin:0 0 .6rem;padding-top:.5rem;border-top:1px solid #2a2a2a}",
      "#bzChrome .account-menu .am-signout{width:100%;font-size:.8rem;padding:.4rem .6rem;background:#1b1b1b;color:#e8e8e8;border:1px solid #333;border-radius:6px;cursor:pointer}",
      ".bz-chrome-scroll::-webkit-scrollbar{display:none}",
      // ── Phone width (≤640px) ─────────────────────────────────────────────
      // At 390px the identity cluster (then honey · plan · Listen · mic · company ·
      // account · Ask) was wider than the screen, so it pushed the document to
      // 571px and clipped every label on the right: "Recip", "Mor", and a company
      // select hanging off the edge. Wrapping the cluster and the link row keeps
      // each label whole; the bars grow taller instead of the page growing wider.
      // `#bzNav` needs !important because ensureNav() pins flex-wrap:nowrap inline
      // (the desktop bar is one unbroken strip) — the inline value cannot be
      // outranked by a stylesheet any other way.
      "@media (max-width:640px){",
      ".bz-brandrow{height:auto;min-height:0;flex-wrap:wrap;row-gap:.4rem;padding:.35rem 0}",
      ".bz-brandrow .bz-cluster{margin-left:0;width:100%;flex-wrap:wrap;row-gap:.4rem;gap:.5rem}",
      // The link row keeps its place under the brand on a phone, but it is the
      // SAME row as the brand (no second bar a page can style away).
      ".bz-brandrow #bzNav{order:3;flex:1 1 100%;width:100%;flex-wrap:wrap!important;justify-content:flex-start;gap:.3rem .85rem;overflow-x:visible}",
      "#bzChrome{flex-wrap:wrap;row-gap:.35rem}",
      "#bzChrome .bz-co-wrap{flex:1 1 8rem;min-width:0}",
      "#bzChrome select.bz-co-select{max-width:100%;width:100%}",
      ".bz-navbar{display:none}",
      ".bz-navbar::-webkit-scrollbar{display:none}",
      "#bzNav{flex-wrap:wrap!important;gap:.3rem .85rem}",
      "}",
      // Honey Drops, plan and company: inside the menu under your name, never in the bar.
      ".bz-account[href='/buzzy/profile']::after{content:' \\25BE';font-size:1em;opacity:.85}",
      // ── Pages with the website's header (#bzHead) ─────────────────────────────
      // The places live in the header's row under the search, on every page (owner,
      // 2026-11-20), so the old link row up here hides; the bar is the same quiet bar
      // with the real face on every page, and it scrolls away with the page rather
      // than pinning over it. Talk to BeeZilla is the voice switch on every page, so
      // the Listening pill by the gear stays out of the way.
      "html.bz-has-head #bzNav,html.bz-has-head .bz-navbar{display:none!important}",
      "html.bz-has-head header:has(#bzChrome){position:relative!important;top:auto!important;border-bottom:0!important;background:transparent!important}",
      "html.bz-has-head .bz-brandrow .bz-brand img{width:44px;height:44px;border-radius:10px;object-fit:contain}",
      "html.bz-has-head .bz-brandrow .bz-brand strong{font-size:1.1rem;font-weight:800;letter-spacing:.01em}",
      "html.bz-has-head #bzMicLive{display:none!important}",
      // Tooltips you can read, beside the thing, never under the pointer (bzTips below).
      "#bzTip{position:fixed;left:0;top:0;z-index:2147483600;box-sizing:border-box;max-width:min(340px,calc(100vw - 24px));padding:9px 13px;border-radius:10px;border:1px solid #3a3a3a;background:#1b1b1b;color:#f4f4f4;font:500 15px/1.4 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;letter-spacing:normal;text-transform:none;text-align:left;white-space:normal;box-shadow:0 12px 32px rgba(0,0,0,.55);pointer-events:none}",
      "#bzTip[hidden]{display:none}",
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
    // ONE row: the links sit in the brand row (boot()). Older builds wrapped them
    // in a `.bz-navbar` strip of their own; unwrap on sight so a soft navigation
    // cannot resurrect the second row.
    if (nav.closest(".bz-navbar")) {
      var old = nav.closest(".bz-navbar");
      if (old.parentNode) old.parentNode.insertBefore(nav, old);
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
        try { localStorage.setItem("bz_active_company", id); } catch (e) { /* nothing to do */ }
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

  /** Log out. The header's account menu and the settings panel both end here. */
  function signOut(e) {
    if (e) e.preventDefault();
    writeIdentityCache(null); // next page must not paint the name we just dropped
    // The account menu's plan line caches its last answer under bz_plan; the Honey
    // Drops chip that used to sit in the header cached under bz_honey. A signed-out
    // page must paint neither, so a sign-out drops both.
    try {
      window.localStorage.removeItem("bz_plan");
      window.localStorage.removeItem("bz_honey");
    } catch (err) { /* private mode: nothing was stored */ }
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

    var cached = readIdentityCache();
    if (cached !== undefined) paint(cached ? cached.name : null, cached ? cached.email : null);

    function fillMenu(m) {
      if (!user) return;
      m.innerHTML = "";
      var n = document.createElement("div"); n.className = "am-name"; n.textContent = user.name;
      m.appendChild(n);
      if (user.email) {
        var em = document.createElement("div"); em.className = "am-email"; em.textContent = user.email;
        m.appendChild(em);
      }
      // Plan + remaining quota lives HERE, not under the composer (owner, Nov 2026).
      var planText = planLineText(planInfo);
      if (planText) {
        var pl = document.createElement("div"); pl.className = "am-plan"; pl.textContent = planText;
        m.appendChild(pl);
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
          var opening = menu.style.display === "none";
          menu.style.display = opening ? "block" : "none";
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

  /**
   * Feedback — the yellow pill (CR-6). One panel, `#bzFeedback`, anchored the
   * same way as the chat panel: full-width sheet at 390px, top-right at 1280px.
   *
   * The reference number is the anonymous user's only handle, so it is shown on
   * the confirmation and nowhere else. Nothing is sent until Send is pressed;
   * the mic only fills the textarea.
   */
  function feedbackControl(nav) {
    var btn = document.createElement("button");
    btn.className = "bz-ask";
    btn.type = "button";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "bzFeedback");
    btn.innerHTML = "Feedback";
    nav.appendChild(btn);

    var panel = document.createElement("div");
    panel.id = "bzFeedback";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Send feedback");
    var head = document.createElement("div");
    head.className = "bz-panel-head";
    var title = document.createElement("span");
    title.textContent = "Send feedback";
    var close = document.createElement("button");
    close.className = "bz-panel-close";
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = "&times;";
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
    body.className = "bz-panel-body bz-fb-body";
    panel.appendChild(head);
    panel.appendChild(body);
    document.body.appendChild(panel);

    var mounted = false;
    var sending = false;
    var recorder = null;

    function signedIn() {
      try {
        return Boolean(window.BZIdentity && window.BZIdentity.email);
      } catch (e) {
        return false;
      }
    }

    function mount() {
      if (mounted) return;
      mounted = true;
      body.innerHTML = [
        '<label class="bz-fb-label" for="bzFbText">What happened, or what would help?</label>',
        '<textarea id="bzFbText" class="bz-fb-text" maxlength="5000" rows="4" placeholder="The more concrete the better — what you did, what you expected, what happened."></textarea>',
        '<div class="bz-fb-row">',
        '  <button type="button" id="bzFbMic" class="bz-fb-mic" aria-pressed="false">&#127908; Speak</button>',
        '  <span class="bz-fb-hint" id="bzFbHint">Up to 60 seconds.</span>',
        '</div>',
        '<label class="bz-fb-check"><input type="checkbox" id="bzFbDiag" /> Include a diagnostic file</label>',
        '<div class="bz-fb-row">',
        '  <label class="bz-fb-link" for="bzFbShot">Attach a screenshot (optional)</label>',
        '  <input type="file" id="bzFbShot" accept="image/png,image/jpeg,image/webp" hidden />',
        '  <span class="bz-fb-hint" id="bzFbShotHint">The picture you were looking at.</span>',
        '</div>',
        '<div class="bz-fb-row" id="bzFbShotRow" hidden>',
        '  <img id="bzFbShotImg" alt="The screenshot you attached" style="max-width:100%;max-height:160px;border:1px solid #333;border-radius:8px;display:block" />',
        '  <button type="button" id="bzFbShotDrop" class="bz-fb-link">Remove</button>',
        '</div>',
        '<button type="button" id="bzFbSee" class="bz-fb-link" aria-expanded="false">See what\u2019s included</button>',
        '<pre id="bzFbDiagBox" class="bz-fb-diag" hidden></pre>',
        '<p class="bz-fb-never" id="bzFbStamped" hidden>The server stamps this record with its build sha, shown in the report as \u201cstamped by the server\u201d. Nothing else is added to the preview above.</p>',
        '<p class="bz-fb-never">Never included: cookies, session or auth tokens, passwords, API keys, request or response bodies, chat text or history, audio, localStorage, other tabs, or your IP address.</p>',
        '<div class="bz-fb-actions"><button type="button" id="bzFbSend" class="bz-fb-send">Send feedback</button></div>',
        '<p class="bz-fb-status" id="bzFbStatus" role="status"></p>'
      ].join("");
    }

    var text, diagBox, diagSee, mic, hint, send, status;
    var shot = null;
    function refs() {
      if (text) return;
      text = body.querySelector("#bzFbText");
      diagBox = body.querySelector("#bzFbDiagBox");
      diagSee = body.querySelector("#bzFbSee");
      mic = body.querySelector("#bzFbMic");
      hint = body.querySelector("#bzFbHint");
      send = body.querySelector("#bzFbSend");
      status = body.querySelector("#bzFbStatus");
    }

    // ── WAV recording: the feedback transcriber measures the header, so the
    // page must record WAV rather than let MediaRecorder pick webm. ─────────
    function encodeWav(samples, rate) {
      var buf = new ArrayBuffer(44 + samples.length * 2);
      var view = new DataView(buf);
      var writeStr = function (off, s) {
        for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
      };
      writeStr(0, "RIFF");
      view.setUint32(4, 36 + samples.length * 2, true);
      writeStr(8, "WAVE");
      writeStr(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeStr(36, "data");
      view.setUint32(40, samples.length * 2, true);
      var off = 44;
      for (var i = 0; i < samples.length; i++, off += 2) {
        var s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return new Blob([buf], { type: "audio/wav" });
    }

    function downsample(input, from, to) {
      if (from === to) return input;
      var ratio = from / to;
      var out = new Float32Array(Math.round(input.length / ratio));
      var pos = 0;
      for (var i = 0; i < out.length; i++) {
        var start = Math.round(i * ratio);
        var end = Math.min(Math.round((i + 1) * ratio), input.length);
        var sum = 0, n = 0;
        for (var j = start; j < end; j++) { sum += input[j]; n++; }
        out[i] = n ? sum / n : 0;
      }
      return out;
    }

    function stopRecording() {
      if (!recorder) return;
      var r = recorder;
      recorder = null;
      try { r.stop(); } catch (e) { /* already stopped */ }
      mic.setAttribute("aria-pressed", "false");
      mic.innerHTML = "&#127908; Speak";
      hint.textContent = "Transcribing\u2026";
      var chunks = r.chunks;
      var rate = r.rate;
      if (r.ctx && r.ctx.state !== "closed") { try { r.ctx.close(); } catch (e) { /* nothing to do */ } }
      if (r.stream) { r.stream.getTracks().forEach(function (t) { t.stop(); }); }
      var total = 0;
      chunks.forEach(function (c) { total += c.length; });
      if (total < rate * 0.4) {
        hint.textContent = "Too short to hear \u2014 try again.";
        return;
      }
      var merged = new Float32Array(total);
      var at = 0;
      chunks.forEach(function (c) { merged.set(c, at); at += c.length; });
      var wav = encodeWav(downsample(merged, rate, 16000), 16000);
      fetch("/api/buzzy/feedback/transcribe", {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: wav,
      }).then(function (res) { return res.json().then(function (j) { return { res: res, j: j }; }); })
        .then(function (out) {
          if (out.res.ok && out.j && out.j.text) {
            var t = out.j.text.trim();
            text.value = (text.value ? text.value.replace(/\s*$/, " ") : "") + t;
            hint.textContent = "Said what you wanted? You can edit it.";
          } else {
            hint.textContent = (out.j && out.j.error) || "Could not transcribe \u2014 type it instead.";
          }
        })
        .catch(function () { hint.textContent = "Could not transcribe \u2014 type it instead."; });
    }

    function startRecording() {
      if (recorder) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        hint.textContent = "This browser will not record \u2014 type your feedback.";
        return;
      }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var AC = window.AudioContext || window.webkitAudioContext;
        var ctx = new AC();
        var src = ctx.createMediaStreamSource(stream);
        var proc = ctx.createScriptProcessor(4096, 1, 1);
        var chunks = [];
        var started = Date.now();
        proc.onaudioprocess = function (ev) {
          chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
          if (Date.now() - started > 60000) stopRecording();
        };
        src.connect(proc);
        proc.connect(ctx.destination);
        recorder = { ctx: ctx, stream: stream, proc: proc, chunks: chunks, rate: ctx.sampleRate, stop: function () {
          try { proc.disconnect(); } catch (e) { /* nothing to do */ }
          try { src.disconnect(); } catch (e) { /* nothing to do */ }
        } };
        mic.setAttribute("aria-pressed", "true");
        mic.innerHTML = "&#9632; Stop";
        hint.textContent = "Listening\u2026 up to 60 seconds.";
      }).catch(function () {
        hint.textContent = "Microphone blocked \u2014 type your feedback instead.";
      });
    }

    function paintDiag() {
      var d = bzDiagPayload(signedIn());
      diagBox.textContent = JSON.stringify(d.value, null, 2);
      if (d.count) diagSee.textContent = "See what\u2019s included (" + d.count + " redaction" + (d.count === 1 ? "" : "s") + ")";
      return d;
    }

    function open() {
      // The panel belongs on <body>. Anything that detached it, or carried it into a
      // page wrapper (a stashed page is display:none), would leave this button opening
      // a panel nobody can see, so put it back first.
      if (panel.parentNode !== document.body) document.body.appendChild(panel);
      mount();
      refs();
      panel.classList.add("open");
      panel.classList.remove("min");
      min.textContent = "\u2013";
      btn.setAttribute("aria-expanded", "true");
      text.focus();
    }
    function shut() {
      panel.classList.remove("open");
      panel.classList.remove("min");
      btn.setAttribute("aria-expanded", "false");
    }

    btn.addEventListener("click", function () {
      if (panel.classList.contains("open") && !panel.classList.contains("min")) shut();
      else open();
    });
    close.addEventListener("click", function (e) { e.stopPropagation(); shut(); });
    min.addEventListener("click", function (e) {
      e.stopPropagation();
      var folding = !panel.classList.contains("min");
      panel.classList.toggle("min", folding);
      min.textContent = folding ? "\u25A1" : "\u2013";
      btn.setAttribute("aria-expanded", folding ? "false" : "true");
    });
    head.addEventListener("click", function () {
      if (panel.classList.contains("min")) { panel.classList.remove("min"); min.textContent = "\u2013"; if (text) text.focus(); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && panel.classList.contains("open") && !panel.classList.contains("min")) shut();
    });

    // Event delegation: the body is re-rendered on success, so per-element
    // listeners added at mount would die with the old nodes.
    body.addEventListener("click", function (e) {
      refs();
      var el = e.target;
      if (!el || !el.id) return;
      if (el.id === "bzFbMic") {
        if (recorder) stopRecording();
        else startRecording();
      } else if (el.id === "bzFbSee") {
        var openNow = diagBox.hidden;
        if (openNow) paintDiag();
        diagBox.hidden = !openNow;
        var stamped = body.querySelector("#bzFbStamped");
        if (stamped) stamped.hidden = !openNow;
        el.setAttribute("aria-expanded", openNow ? "true" : "false");
      } else if (el.id === "bzFbSend") {
        submit();
      } else if (el.id === "bzFbShotDrop") {
        shot = null;
        var row = body.querySelector("#bzFbShotRow");
        var input = body.querySelector("#bzFbShot");
        if (row) row.hidden = true;
        if (input) input.value = "";
        var h = body.querySelector("#bzFbShotHint");
        if (h) h.textContent = "The picture you were looking at.";
      }
    });

    // A screenshot comes in as a data URL because the server stores the row, not
    // a file: one admin read has to reproduce the report. Anything over the cap
    // is refused here as well as at the door, so the person is told before they
    // wait for a round trip that will fail.
    var SHOT_MAX = 1500000;
    document.addEventListener("change", function (e) {
      var input = e.target;
      if (!input || input.id !== "bzFbShot") return;
      var h = body.querySelector("#bzFbShotHint");
      var row = body.querySelector("#bzFbShotRow");
      var img = body.querySelector("#bzFbShotImg");
      var file = input.files && input.files[0];
      if (!file) return;
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        if (h) h.textContent = "Pick a PNG, JPEG or WebP picture.";
        input.value = "";
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        var data = String(reader.result || "");
        if (data.length > SHOT_MAX) {
          shot = null;
          if (row) row.hidden = true;
          if (h) h.textContent = "That picture is too big \u2014 pick one under about 1 MB.";
          input.value = "";
          return;
        }
        shot = data;
        if (img) img.src = data;
        if (row) row.hidden = false;
        if (h) h.textContent = "Attached. It is stored with your report.";
      };
      reader.readAsDataURL(file);
    });

    function submit() {
      if (sending) return;
      refs();
      var words = (text.value || "").trim();
      if (!words) {
        status.textContent = "Tell us what happened first.";
        text.focus();
        return;
      }
      var withDiag = Boolean(body.querySelector("#bzFbDiag") && body.querySelector("#bzFbDiag").checked);
      var payload = {
        body: words,
        page_url: location.pathname,
        route: section(),
      };
      if (shot) payload.screenshot = shot;
      if (withDiag) {
        var d = paintDiag();
        payload.diag = d.value;
        payload.diag.redactions = { count: d.count, kinds: d.kinds };
      }
      sending = true;
      send.disabled = true;
      status.textContent = "Sending\u2026";
      fetch("/api/buzzy/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).then(function (res) {
        return res.json().then(function (j) { return { res: res, j: j }; });
      }).then(function (out) {
        sending = false;
        if (out.res.ok && out.j && out.j.ok) {
          body.innerHTML =
            '<div class="bz-fb-done"><p><strong>Thank you \u2014 that reached us.</strong></p>' +
            '<p>Your reference is <code>' + out.j.ref + "</code>.</p>" +
            '<p class="bz-fb-hint">Keep it if you follow up; it is how we find your report.</p>' +
            '<button type="button" class="bz-fb-link" id="bzFbAgain">Send another</button></div>';
          body.querySelector("#bzFbAgain").addEventListener("click", function () {
            mounted = false;
            body.innerHTML = "";
            mount();
            refs();
            text.focus();
          });
        } else {
          send.disabled = false;
          status.textContent = (out.j && out.j.error) || "Could not send \u2014 try again in a moment.";
        }
      }).catch(function () {
        sending = false;
        send.disabled = false;
        status.textContent = "Could not send \u2014 check your connection and try again.";
      });
    }
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
    // The real brand face, content by default (owner, 2026-11-18: "he has an apathetic
    // face as his default face… it should be in the repo, the proper faces"). On Talk,
    // voice-stage.js switches it to the face for what BeeZilla is doing.
    a.innerHTML =
      '<img class="bz-face" src="/buzzy/brand/revision6_expressions_12-content.png" alt="" /><strong>BeeZilla</strong>';
    return a;
  }

  function boot() {
    style();
    // Before the early return below: the dock outlives soft navigations, and each
    // page it lands on decides whether the gear shows (not on the sign-in pages).
    settingsDock();
    var nav = ensureNav();
    // Talk keeps its places along the bottom (owner: "put the top menu below everything
    // else"), so the link row hides there; every other page keeps it.
    document.documentElement.classList.toggle("bz-on-talk", section() === "talk");
    // The website's header (#bzHead: Talk to BeeZilla, the search, the row of places)
    // is on every page that has it, so the old link row up here hides there too.
    document.documentElement.classList.toggle("bz-has-head", !!document.getElementById("bzHead"));
    if (document.getElementById("bzChrome")) {
      // Re-derive the body-padding bleed for the page that is active NOW.
      applyBleed();
      // The chrome survived this hop, so its Feedback button survives, and so must the
      // panel that button opens. The stale-panel sweep used to run above this return:
      // it deleted the live panel on every hop that kept the chrome, and the yellow pill
      // stayed wired to the deleted node. After Talk → Sketch → Talk, Feedback did
      // nothing on any page until a reload (owner report, 19 Nov 2026).
      return;
    }
    // The chrome is rebuilt below and feedbackControl() makes a new panel for the new
    // button, so any older panel (on <body>, or carried into a stashed page by
    // ensurePageWrapper) belongs to a button that no longer exists. One panel at a time.
    Array.prototype.forEach.call(document.querySelectorAll("#bzFeedback"), function (n) {
      n.remove();
    });
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
    // The links live between the brand and the identity cluster. One row, one bar:
    // a nav on its own row spent 48px of every page's height on nothing (owner's
    // marked-up screenshot, Nov 2026).
    brandRow.appendChild(nav);
    var chrome = document.createElement("span");
    chrome.id = "bzChrome";
    chrome.className = "bz-cluster";
    brandRow.appendChild(chrome);

    header.appendChild(brandRow);
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
    companyControl(chrome);
    accountControl(chrome);
    menuPlanLine();
    feedbackControl(chrome);
  }

  /**
   * Which plan am I on? One line in the account menu, beside your name.
   *
   * The PRO chip that sat in the header left with the owner's 2026-11-18 cleanup
   * (the settings gear reads the plan fresh for its own panel). What stays is the
   * account-menu line and the refresh Talk asks for after a turn that may have
   * spent quota. The last answer is cached and painted first, so an opened menu
   * never waits on the round trip; the response still wins, a failed round trip
   * changes nothing, and an authoritative "no plan" clears the cache so a
   * signed-out page cannot show a plan.
   */
  var planInfo = null;
  // One line, in the account menu: "Pro plan · 1,234 chats left · 12 min music left".
  // It used to sit under the Talk composer; a running total there was noise, and a
  // plan belongs beside the name it applies to (owner, Nov 2026).
  function planLineText(d) {
    if (!d || !d.plan) return "";
    var name = String(d.plan);
    var bits = [name.charAt(0).toUpperCase() + name.slice(1) + " plan"];
    var left = d.remaining || {};
    bits.push(Number(left.inference || 0).toLocaleString() + " chats left");
    var musicLeft = Number(left.musicSeconds || 0);
    bits.push(musicLeft > 0 ? Math.floor(musicLeft / 60) + " min music left" : "no music on this plan");
    if (name === "free") bits.push("upgrade for music");
    return bits.join(" \u00b7 ");
  }
  function paintMenuPlan() {
    var menus = document.querySelectorAll("#bzChrome .account-menu");
    var text = planLineText(planInfo);
    for (var i = 0; i < menus.length; i++) {
      var m = menus[i];
      var line = m.querySelector(".am-plan");
      if (!line && text) {
        line = document.createElement("div");
        line.className = "am-plan";
        var out = m.querySelector(".am-signout");
        if (out) m.insertBefore(line, out); else m.appendChild(line);
      }
      if (line) {
        line.textContent = text;
        line.style.display = text ? "" : "none";
      }
    }
  }

  function menuPlanLine() {
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
      planInfo = d && d.plan ? d : null;
      paintMenuPlan();
    }

    var cached = readCache();
    if (cached) paint(cached);

    function refresh() {
      return fetch("/api/buzzy/entitlement", { credentials: "same-origin" })
        // 401 is an answer (nobody is signed in), not an outage: clear the line.
        .then(function (r) { return r.status === 401 ? { ok: false } : r.ok ? r.json() : undefined; })
        .then(function (d) {
          if (!d || typeof d.ok === "undefined") return; // transport oddity: keep the cache
          if (d.ok && d.plan) {
            writeCache(d);
            paint(d);
          } else {
            writeCache(null); // signed out, or no plan: the line must not outlive it
            paint(null);
          }
        })
        .catch(function () { /* a plan line is not worth an error toast */ });
    }
    refresh();
    // Talk asks for a refresh after a turn may have spent quota.
    window.bzRefreshPlan = refresh;
  }

  // The tab title has TWO inputs: the page's own name and the live-mic marker.
  // One authority, in the CHROME's scope, because the mic pill repaints the marker
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

  /**
   * Settings: one gear in the bottom-right corner of every page.
   *
   * The header used to carry a Honey Drops chip, a plan chip, Listen and Ask. The
   * owner asked for all four to go and for one gear, bottom right, to hold "all
   * your personal settings, including usage": who is signed in, the plan and what
   * is left of it today, the Honey Drops balance, and the way to the business
   * profile, the wallet and Log out.
   *
   * Every number is read fresh each time the panel opens (session, entitlement,
   * wallet) and nothing is cached, so the panel cannot show a plan or a balance
   * that is no longer true, and a closed panel costs no requests at all.
   *
   * The dock is a child of <body>, outside the page shell's #bzPage
   * (ensurePageWrapper skips it), so a soft navigation never stashes or deletes
   * it: one gear for the life of the document.
   */
  var GEAR_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="' +
    "M9.59 4.37L9.98 1.59A10.6 10.6 0 0 1 14.02 1.59L14.41 4.37A8 8 0 0 1 15.69 4.9L17.93 3.21A10.6 10.6 0 0 1 20.79 6.07" +
    "L19.1 8.31A8 8 0 0 1 19.63 9.59L22.41 9.98A10.6 10.6 0 0 1 22.41 14.02L19.63 14.41A8 8 0 0 1 19.1 15.69L20.79 17.93" +
    "A10.6 10.6 0 0 1 17.93 20.79L15.69 19.1A8 8 0 0 1 14.41 19.63L14.02 22.41A10.6 10.6 0 0 1 9.98 22.41L9.59 19.63" +
    "A8 8 0 0 1 8.31 19.1L6.07 20.79A10.6 10.6 0 0 1 3.21 17.93L4.9 15.69A8 8 0 0 1 4.37 14.41L1.59 14.02" +
    "A10.6 10.6 0 0 1 1.59 9.98L4.37 9.59A8 8 0 0 1 4.9 8.31L3.21 6.07A10.6 10.6 0 0 1 6.07 3.21L8.31 4.9" +
    "A8 8 0 0 1 9.59 4.37ZM15.1 12A3.1 3.1 0 1 0 8.9 12A3.1 3.1 0 1 0 15.1 12Z" +
    '"/></svg>';

  // The pages whose whole job is signing in. There is nothing personal to set
  // there yet, so the gear stays out of the way (the mic pill still shows if the
  // microphone is somehow live).
  function onSignInPage() {
    return /^\/buzzy\/(landing|login)(\.html)?\/?$/.test(location.pathname);
  }

  function settingsDock() {
    var dock = document.getElementById("bzDock");
    if (dock) {
      dock.syncPage();
      return;
    }
    dock = document.createElement("div");
    dock.id = "bzDock";

    var live = document.createElement("div");
    live.id = "bzMicLive";
    live.setAttribute("role", "status");
    live.hidden = true;
    live.innerHTML =
      '<span class="bz-mic-dot" aria-hidden="true"></span>' +
      '<span class="bz-mic-label">Listening</span>' +
      '<button type="button" id="bzMicCut" hidden>Interrupt</button>' +
      '<button type="button" id="bzMicStop">Stop</button>';
    dock.appendChild(live);

    var gear = document.createElement("button");
    gear.type = "button";
    gear.id = "bzGear";
    gear.title = "Settings";
    gear.setAttribute("aria-label", "Settings");
    gear.setAttribute("aria-haspopup", "dialog");
    gear.setAttribute("aria-expanded", "false");
    gear.setAttribute("aria-controls", "bzSettings");
    gear.innerHTML = GEAR_SVG;
    dock.appendChild(gear);

    // Divs and spans, never h2/p/section: pages style those for their own content
    // and none of it may leak in. The few buttons and links name every property
    // they show (the #bzSettings rules), for the same reason.
    var panel = document.createElement("div");
    panel.id = "bzSettings";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "bzSettingsTitle");
    panel.hidden = true;
    panel.innerHTML = [
      '<div class="bzs-head">',
      '<div class="bzs-title" id="bzSettingsTitle" role="heading" aria-level="2">Settings</div>',
      '<button type="button" class="bzs-close" aria-label="Close settings">&times;</button>',
      "</div>",
      '<div class="bzs-sec" data-bzs="out" hidden>',
      '<div class="bzs-muted">You\u2019re not signed in.</div>',
      '<div class="bzs-row" style="margin-top:12px"><a class="bzs-btn primary" href="/buzzy/landing">Sign in</a></div>',
      "</div>",
      '<div class="bzs-sec" data-bzs="account">',
      '<div class="bzs-h" role="heading" aria-level="3">Account</div>',
      '<div class="bzs-name"></div>',
      '<div class="bzs-email"></div>',
      '<div class="bzs-row">',
      '<a class="bzs-link" href="/buzzy/profile">About your business</a>',
      '<button type="button" class="bzs-btn" data-bzs="signout">Log out</button>',
      "</div>",
      // Your own AI key, in the cloud too (it used to sit in Talk's More menu).
      '<div class="bzs-row"><span class="bzs-muted">Your own AI account for BeeZilla\u2019s answers</span>',
      '<button type="button" class="bzs-btn" data-bzs="aikey">Your AI key</button></div>',
      "</div>",
      '<div class="bzs-sec" data-bzs="plan">',
      '<div class="bzs-h" role="heading" aria-level="3">Plan &amp; usage</div>',
      '<div class="bzs-row"><span class="bzs-plan"></span><span class="bzs-renew"></span></div>',
      '<div class="bzs-meter" data-bzs="chats"><div class="bzs-meter-top"><span>Chats</span><b></b></div><div class="bzs-bar"><span></span></div></div>',
      '<div class="bzs-meter" data-bzs="music"><div class="bzs-meter-top"><span>Music</span><b></b></div><div class="bzs-bar"><span></span></div></div>',
      '<div class="bzs-note">Counted over the last 24 hours.</div>',
      "</div>",
      '<div class="bzs-sec" data-bzs="honey">',
      '<div class="bzs-h" role="heading" aria-level="3">Honey Drops</div>',
      '<div class="bzs-row"><span class="bzs-honey"></span><a class="bzs-link" href="/buzzy/wallet">Open wallet</a></div>',
      "</div>",
    ].join("");
    dock.appendChild(panel);
    document.body.appendChild(dock);

    function q(sel) { return panel.querySelector(sel); }
    function sec(name) { return q('[data-bzs="' + name + '"]'); }
    function isOpen() { return !panel.hidden; }

    // After a soft navigation the header is sticky above everything (z-index 800,
    // and several rows tall on a phone). Sized by the window alone, the panel slid
    // its title and close button under it on a short window, so it stops 8px below
    // whatever the header covers.
    function fitPanel() {
      var chromeEl = document.getElementById("bzChrome");
      var header = chromeEl ? chromeEl.closest("header") : null;
      var top = 16;
      if (header) top = Math.max(top, header.getBoundingClientRect().bottom + 8);
      var bottom = parseFloat(window.getComputedStyle(panel).bottom) || 0;
      panel.style.maxHeight = Math.max(160, Math.floor(window.innerHeight - bottom - top)) + "px";
    }
    window.addEventListener("resize", function () { if (isOpen()) fitPanel(); });

    function open() {
      if (isOpen()) return;
      panel.hidden = false;
      fitPanel();
      gear.setAttribute("aria-expanded", "true");
      load();
      q(".bzs-close").focus();
    }
    function close(giveFocusBack) {
      if (!isOpen()) return;
      panel.hidden = true;
      gear.setAttribute("aria-expanded", "false");
      if (giveFocusBack) gear.focus();
    }

    gear.addEventListener("click", function () {
      if (isOpen()) close(false);
      else open();
    });
    q(".bzs-close").addEventListener("click", function () { close(true); });
    sec("signout").addEventListener("click", signOut);
    // The key dialog belongs to the website's header (voice-stage.js). A page without
    // the header yet goes to Talk, where it is, and opens it there.
    sec("aikey").addEventListener("click", function (e) {
      e.stopPropagation();
      close(false);
      if (window.bzOpenKeyDialog) { window.bzOpenKeyDialog(); return; }
      var shell = window.BeeZillaShell;
      if (shell && shell.go) {
        Promise.resolve(shell.go("/buzzy/talk")).then(function () {
          if (window.bzOpenKeyDialog) window.bzOpenKeyDialog();
        });
      } else {
        location.href = "/buzzy/talk";
      }
    });
    // Its links go somewhere (the shell soft-navigates /buzzy/ links), so the panel
    // has done its job and closes instead of hanging over the next page.
    panel.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest("a[href]")) close(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen()) close(true);
    });
    document.addEventListener("click", function (e) {
      if (isOpen() && !dock.contains(e.target)) close(false);
    });
    window.addEventListener("popstate", function () { close(false); });

    // ── What the panel shows ───────────────────────────────────────────
    function showSignedIn(on) {
      sec("out").hidden = on;
      sec("account").hidden = !on;
      sec("plan").hidden = !on;
      sec("honey").hidden = !on;
    }
    function paintAccount(name, email) {
      q(".bzs-name").textContent = name || "";
      q(".bzs-email").textContent = email && email !== name ? email : "";
    }
    function num(n) { return Number(n || 0).toLocaleString(); }
    function meter(name, text, fraction) {
      var m = sec(name);
      m.querySelector("b").textContent = text;
      var bar = m.querySelector(".bzs-bar");
      bar.hidden = fraction === null;
      if (fraction !== null) {
        var f = Math.max(0, Math.min(1, fraction));
        bar.querySelector("span").style.width = (f * 100).toFixed(1) + "%";
        bar.classList.toggle("low", f <= 0.1);
      }
    }
    function paintPlan(d) {
      var name = String(d.plan || "free");
      var badge = q(".bzs-plan");
      badge.hidden = false;
      badge.textContent = name.charAt(0).toUpperCase() + name.slice(1) + " plan";
      badge.className = "bzs-plan " + name;
      var until = d.planUntil ? new Date(d.planUntil) : null;
      q(".bzs-renew").textContent = until && !isNaN(until.getTime())
        ? "Paid through " + until.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
        : "";
      var lim = d.limits || {};
      var left = d.remaining || {};
      var chats = Number(lim.inferencePerDay || 0);
      meter("chats", chats > 0 ? num(left.inference) + " of " + num(chats) + " left" : "Not in your plan",
        chats > 0 ? Number(left.inference || 0) / chats : null);
      var music = Number(lim.musicSecondsPerDay || 0);
      meter("music", music > 0
        ? Math.floor(Number(left.musicSeconds || 0) / 60) + " of " + Math.floor(music / 60) + " min left"
        : "Not in your plan",
        music > 0 ? Number(left.musicSeconds || 0) / music : null);
      sec("chats").hidden = false;
      sec("music").hidden = false;
      q(".bzs-note").textContent = "Counted over the last 24 hours.";
    }
    function planUnavailable() {
      q(".bzs-plan").hidden = true;
      q(".bzs-renew").textContent = "";
      sec("chats").hidden = true;
      sec("music").hidden = true;
      q(".bzs-note").textContent = "Your usage couldn\u2019t be loaded just now. Open this again in a moment.";
    }
    function planLoading() {
      var badge = q(".bzs-plan");
      badge.hidden = false;
      badge.className = "bzs-plan";
      badge.textContent = "\u2026";
      q(".bzs-renew").textContent = "";
      meter("chats", "\u2026", null);
      meter("music", "\u2026", null);
    }

    // One answer per opening: a slow response from an earlier opening must not
    // repaint over a newer one.
    var seq = 0;
    function getJSON(url) {
      return fetch(url, { credentials: "same-origin" })
        .then(function (r) {
          if (r.status === 401) return { signedOut: true };
          return r.ok ? r.json() : undefined;
        })
        .catch(function () { return undefined; });
    }
    function load() {
      var mine = ++seq;
      var cached = readIdentityCache();
      if (cached) {
        showSignedIn(true);
        paintAccount(cached.name, cached.email);
      } else if (cached === null) {
        showSignedIn(false);
      }
      planLoading();
      q(".bzs-honey").textContent = "\u2026";

      // Plan and balance belong to an account: asked for at once when this browser
      // last saw one signed in, otherwise only after the session says there is one.
      var asked = false;
      function loadNumbers() {
        if (asked) return;
        asked = true;
        getJSON("/api/buzzy/entitlement").then(function (d) {
          if (mine !== seq) return;
          if (d && d.signedOut) { showSignedIn(false); return; }
          if (d && d.ok && d.plan) paintPlan(d);
          else planUnavailable();
        });
        getJSON("/api/wallet").then(function (d) {
          if (mine !== seq) return;
          if (d && d.signedOut) { showSignedIn(false); return; }
          q(".bzs-honey").textContent = d && typeof d.balance === "number"
            ? "\u25c8 " + num(d.balance)
            : "Couldn\u2019t load your balance";
        });
      }
      if (cached) loadNumbers();

      getJSON("/api/auth/get-session").then(function (res) {
        if (mine !== seq) return;
        if (res === undefined) { loadNumbers(); return; } // outage: keep the name, try the rest
        var u = res && res.user;
        if (u && (u.name || u.email)) {
          showSignedIn(true);
          paintAccount(u.name || u.email, u.email || "");
          loadNumbers();
        } else {
          showSignedIn(false);
        }
      });
    }

    dock.syncPage = function () {
      var hide = onSignInPage();
      gear.hidden = hide;
      if (hide) close(false);
    };
    dock.syncPage();
    micPill(live);
  }

  /**
   * The microphone, while it is on.
   *
   * Listen used to sit in the header and doubled as the "BeeZilla can hear you"
   * light. The page shell keeps Talk's recogniser running while you move between
   * pages, so with Listen gone something still has to say the mic is live: this
   * pill, beside the gear, on every page. It exists only while a voice session
   * does (idle, the corner holds nothing but the gear):
   *   - Listening              · Stop ends the session in one click
   *   - BeeZilla is talking    · Interrupt cuts the reply short and listens again
   *                              (the one-click barge-in the header chip used to
   *                              offer; Talk's own mic button ends the session)
   *   - Mic paused             · after a reload the session waits, ARMED, for the
   *                              next touch anywhere (talk.html) — said, not hidden
   */
  function micPill(live) {
    var label = live.querySelector(".bz-mic-label");
    var cut = live.querySelector("#bzMicCut");
    var stop = live.querySelector("#bzMicStop");
    cut.setAttribute("aria-label", "Interrupt BeeZilla and speak");
    stop.setAttribute("aria-label", "Stop listening");
    function engine() { return window.BeeZillaVoice || null; }
    function paint(st) {
      st = st || (engine() && engine().state ? engine().state() : null);
      var on = !!(st && st.mic);
      var armed = !on && !!(st && st.armed);
      var speaking = on && !!(st && st.speaking);
      live.hidden = !(on || armed);
      live.classList.toggle("paused", armed);
      label.textContent = speaking ? "BeeZilla is talking" : on ? "Listening" : "Mic paused";
      live.title = speaking
        ? "Your mic is off while BeeZilla talks. Interrupt to speak now, or Stop to end"
        : on
          ? "BeeZilla can hear you on every page until you press Stop"
          : "Touch the page and BeeZilla listens again";
      cut.hidden = !speaking;
      stop.hidden = !on;
      // The mic marker is a property of the TAB, not of the page: this is the
      // one writer for it, so a soft hop and a start/stop both land here.
      bzTitle.apply();
    }
    // Talk publishes its state here (paintVoice); a page with no engine stays idle.
    window.BeeZillaVoiceChip = { update: paint };
    cut.addEventListener("click", function () {
      if (engine() && engine().interrupt) engine().interrupt();
      paint();
    });
    stop.addEventListener("click", function () {
      if (engine() && engine().stop) engine().stop();
      else { var b = document.getElementById("micBtn"); if (b) b.click(); }
      paint();
    });
    // A session started on Talk before this chrome existed still shows up.
    paint();
    setInterval(function () { paint(); }, 1500);
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
  var TALK = "/buzzy/talk";

  // ── The website's header (#bzHead) on every page ─────────────────────────
  // Owner, 2026-11-20: "Bezilla's talk button should always be at the top. There
  // isn't any other place there. Everything lives under there. What you see as a
  // talk area is actually just the header of the entire website… The URL bar and
  // menu of the website lives below the talk area."
  // Talk's header (Talk to BeeZilla, the Idea Board, the search with its QR code and
  // copy button, the row of places) is one element, #bzHead, that this shell keeps for
  // the life of the document above whichever page is showing. A page opened on its own
  // (a link, a reload) fetches Talk once, quietly, for its header; Talk's own page then
  // waits in the cache, as if you had been there and left. The sign-in pages have none.
  function wantsHead(path) {
    var p = String(path || "").replace(/[?#].*$/, "").replace(/\.html$/, "").replace(/\/+$/, "");
    return /^\/buzzy(\/|$)/.test(p) && !/^\/buzzy\/(landing|login|shared|join)$/.test(p);
  }
  function isTalk(key) {
    return /^\/buzzy(\/talk)?$/.test(String(key || "").replace(/[?#].*$/, "").replace(/\.html$/, "").replace(/\/+$/, ""));
  }

  // ── Who lights the places row, and when ──────────────────────────────────
  // #bzPlaces belongs to Talk's header, which this shell paints onto every other
  // page — so its "you are here" state must be painted by the thing that paints
  // it, not left to a page script that may not have run yet (or at all). It was
  // left to the markup: the row shipped with Inspiration pre-lit, so on Sketch
  // the yellow underline sat under Inspiration with the sketch tools on screen.
  // Same path→place rule as the nav row (BeeZillaChrome.section), so there is one
  // mapping and one answer. On Talk the open TAB is Talk's own state (the pane you
  // have open), which browse.js owns; this only clears the row off Talk.
  function paintPlacesRow() {
    var row = document.getElementById("bzPlaces");
    if (!row) return;
    var chrome = window.BeeZillaChrome;
    // The shell's key, not location.pathname: Music studio rewrites its own address
    // to /buzzy/talk after it opens, so the path would say "Talk" while the studio
    // is what is on screen. browse.js reads the same key (pathNow), so both agree.
    var shell = window.BeeZillaShell;
    var key = shell && shell.currentKey ? shell.currentKey : location.pathname;
    var here = chrome && chrome.section ? chrome.section(key) : "";
    Array.prototype.forEach.call(row.querySelectorAll("a[data-place]"), function (a) {
      var on = a.getAttribute("data-place") === here;
      a.classList.toggle("on", on);
      if (on) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    if (here === "talk") return;
    Array.prototype.forEach.call(row.querySelectorAll("[data-tab]"), function (b) {
      var mine = b.getAttribute("data-tab") === here;
      b.classList.remove("on");
      b.classList.toggle("here", mine);
      b.setAttribute("aria-selected", "false");
      if (mine) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
      b.tabIndex = mine ? 0 : -1;
    });
  }
  window.bzPaintPlacesRow = paintPlacesRow;

  // ── Two kinds of stylesheet in one document ──────────────────────────────
  // The header is Talk's, and every page under it brings its own styles. A page's
  // stylesheet must never reach into the header (pages style bare `button`, `h2`,
  // `body`), and Talk's must reach nothing but the header while another page shows.
  // Both are done by rewriting each rule once, at zero added specificity, so every
  // sheet cascades exactly as it did on its own page:
  //  - a page's rules gain :not(:where(<the header>)) on the element they style, and
  //    its `body` layout (Sketch's 100vh flex column, Capabilities' side padding) moves
  //    to its own #bzPage, so the header is never squeezed, clipped or inset;
  //  - Talk's rules are copied once with :where(<the header>) on the element they style,
  //    and its html/body/:root rules give the header Talk's fonts, colours and
  //    variables. The copy (#bz-head-css) stays on for every page, Talk included: the
  //    same rules at the same specificity, later in the document, change nothing there.
  // "The header" is #bzHead and what Talk's scripts open over the page for it
  // (.bz-talk-own: the AI key dialog and the like).
  var HEAD_AREA = "#bzHead, #bzHead *, .bz-talk-own, .bz-talk-own *";
  var HEAD_ROOTS = "#bzHead, .bz-talk-own";
  var INHERITED = /^(--|color$|font|line-height$|letter-spacing$|word-spacing$|text-(align|indent|transform|shadow|rendering|underline|decoration-skip)|white-space$|cursor$|visibility$|direction$|quotes$|list-style|caption-side$|border-collapse$|border-spacing$|empty-cells$|tab-size$|hyphens$|word-break$|overflow-wrap$|word-wrap$|-webkit-font-smoothing$|-moz-osx-font-smoothing$|writing-mode$|accent-color$|caret-color$|color-scheme$|-webkit-text-size-adjust$|text-size-adjust$|font-)/i;
  // On a page's <body>, these lay the page itself out: they move to its #bzPage.
  var BODY_LAYOUT = /^(display$|flex|grid|gap$|row-gap$|column-gap$|align-|justify-|place-|height$|min-height$|max-height$|width$|min-width$|max-width$|overflow|overscroll-behavior|padding|position$|inset|top$|left$|right$|bottom$|z-index$|box-sizing$|contain$|isolation$)/i;

  // A selector list split at its own commas (not those inside :is(), [..] or quotes).
  function splitList(text, sep) {
    var out = [], depth = 0, cur = "", q = null;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (q) {
        cur += ch;
        if (ch === "\\") { cur += text.charAt(i + 1); i++; }
        else if (ch === q) q = null;
        continue;
      }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      if (ch === sep && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map(function (x) { return x.trim(); }).filter(Boolean);
  }
  // Where the last compound of a complex selector starts ("a > b .c:hover" → at ".c").
  function subjectAt(sel) {
    var depth = 0, q = null, start = 0;
    for (var i = 0; i < sel.length; i++) {
      var ch = sel.charAt(i);
      if (q) { if (ch === "\\") i++; else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === "(" || ch === "[") { depth++; continue; }
      if (ch === ")" || ch === "]") { depth--; continue; }
      if (depth === 0 && (ch === " " || ch === ">" || ch === "+" || ch === "~")) start = i + 1;
    }
    return start;
  }
  // Where a trailing pseudo-element starts in that compound (::before, ::placeholder…).
  function pseudoAt(sel, from) {
    var depth = 0, q = null;
    for (var i = from; i < sel.length; i++) {
      var ch = sel.charAt(i);
      if (q) { if (ch === "\\") i++; else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === "(" || ch === "[") { depth++; continue; }
      if (ch === ")" || ch === "]") { depth--; continue; }
      if (depth === 0 && ch === ":") {
        if (sel.charAt(i + 1) === ":") return i;
        if (/^:(before|after|first-line|first-letter)(?![\w-])/i.test(sel.slice(i))) return i;
      }
    }
    return -1;
  }
  function onSubject(sel, extra) {
    var at = subjectAt(sel), pe = pseudoAt(sel, at);
    return pe < 0 ? sel + extra : sel.slice(0, pe) + extra + sel.slice(pe);
  }
  function subjectIs(sel, re) { return re.test(sel.slice(subjectAt(sel))); }
  var ROOTISH = /^(html|body|:root)(?![\w-])/i;
  var BODYISH = /^body(?![\w-])/i;
  function decls(style) {
    return splitList(style.cssText || "", ";").map(function (d) {
      var c = d.indexOf(":");
      return c < 0 ? null : { prop: d.slice(0, c).trim().toLowerCase(), text: d };
    }).filter(Boolean);
  }
  function joinDecls(list) { return list.map(function (d) { return d.text; }).join("; "); }
  // One style rule, rewritten. mode "page": kept out of the header; "head": only the header.
  function styleRule(r, mode) {
    var sels = splitList(r.selectorText || "", ",");
    if (!sels.length) return "";
    var all = decls(r.style);
    var out = "";
    if (mode === "page") {
      var plain = [], bodies = [];
      sels.forEach(function (x) { (subjectIs(x, BODYISH) ? bodies : plain).push(x); });
      var guarded = plain.map(function (x) {
        return subjectIs(x, ROOTISH) ? x : onSubject(x, ":not(:where(" + HEAD_AREA + "))");
      });
      if (guarded.length) out += guarded.join(", ") + " { " + r.style.cssText + " }\n";
      if (bodies.length) {
        var keep = all.filter(function (d) { return !BODY_LAYOUT.test(d.prop); });
        var move = all.filter(function (d) { return BODY_LAYOUT.test(d.prop); });
        if (keep.length) out += bodies.join(", ") + " { " + joinDecls(keep) + " }\n";
        if (move.length) out += bodies.map(function (x) { return x + " > #bzPage"; }).join(", ") + " { " + joinDecls(move) + " }\n";
      }
      return out;
    }
    var mine = [], roots = [];
    sels.forEach(function (x) { (subjectIs(x, ROOTISH) ? roots : mine).push(x); });
    if (mine.length) out += mine.map(function (x) { return onSubject(x, ":where(" + HEAD_AREA + ")"); }).join(", ") + " { " + r.style.cssText + " }\n";
    if (roots.length) {
      var inh = all.filter(function (d) { return INHERITED.test(d.prop); });
      if (inh.length) out += roots.map(function (x) { return x + " :where(" + HEAD_ROOTS + ")"; }).join(", ") + " { " + joinDecls(inh) + " }\n";
    }
    return out;
  }
  function rewriteRules(rules, mode) {
    var out = "";
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      var text = r.cssText || "";
      if (r.selectorText !== undefined && r.style) {
        // A nested rule (CSS nesting) is left as written: no page here uses one.
        out += r.cssRules && r.cssRules.length ? text + "\n" : styleRule(r, mode);
      } else if (r.cssRules && /^@(media|supports|container|layer|document)/i.test(text)) {
        var inner = rewriteRules(r.cssRules, mode);
        if (inner) out += text.slice(0, text.indexOf("{")).trim() + " {\n" + inner + "}\n";
      } else {
        out += text + "\n";   // @keyframes, @font-face, @import, @page …
      }
    }
    return out;
  }
  // Parse CSS text without applying it, then rewrite it.
  function rewriteCss(text, mode) {
    var tmp = document.createElement("style");
    tmp.media = "not all";
    tmp.setAttribute("data-bz-parse", "1");
    tmp.textContent = text || "";
    document.head.appendChild(tmp);
    var out = "";
    try { out = tmp.sheet ? rewriteRules(tmp.sheet.cssRules, mode) : ""; } catch (e) { out = ""; }
    tmp.remove();
    return out;
  }
  function sameOrigin(href) {
    try { return new URL(href, location.href).origin === location.origin; } catch (e) { return false; }
  }
  // The text of a <style>, or of a same-origin <link> (fetched; the browser has it).
  function cssTextOf(el) {
    if (el.tagName === "STYLE") return Promise.resolve(el.textContent || "");
    var href = el.getAttribute("href") || "";
    if (!sameOrigin(href)) return Promise.resolve(null);
    return fetch(new URL(href, location.href).href, { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.text() : null; })
      .catch(function () { return null; });
  }

  // A page under the header: each of its stylesheets becomes a <style> that keeps out
  // of the header (a font sheet from another site, nothing to rewrite, stays as is).
  function guardPageStyles(els, key) {
    return Promise.all(els.map(function (el) {
      return cssTextOf(el).then(function (text) {
        if (text === null) return el;
        var st = document.createElement("style");
        st.setAttribute("data-bz-style", key);
        st.setAttribute("data-bz-guarded", "1");
        st.textContent = rewriteCss(text, "page");
        if (el.parentNode) el.parentNode.insertBefore(st, el.nextSibling);
        else document.head.appendChild(st);
        // The original stays in place, switched off for good (and matched to no
        // screen), so the order of the page's sheets is the order it shipped.
        el.setAttribute("data-bz-replaced", "1");
        el.setAttribute("media", "not all");
        try { el.disabled = true; } catch (e) { /* best effort */ }
        return st;
      });
    }));
  }

  // Talk's sheets, copied for the header (#bz-head-css), in the order Talk ships them.
  // Resolves with each sheet's text (null for one from another site).
  var headCssReady = null;
  function buildHeadCss(els) {
    if (headCssReady) return headCssReady;
    headCssReady = Promise.all(els.map(cssTextOf)).then(function (texts) {
      var css = texts.map(function (t) { return t ? rewriteCss(t, "head") : ""; }).join("\n");
      var st = document.getElementById("bz-head-css");
      if (!st) {
        st = document.createElement("style");
        st.id = "bz-head-css";
        document.head.appendChild(st);
      }
      st.textContent = css;
      return texts;
    });
    return headCssReady;
  }
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
  var firstSheets = [];
  Array.prototype.forEach.call(
    document.querySelectorAll('head style, head link[rel="stylesheet"]'),
    function (el) {
      if (el.id === "bz-chrome-css" || el.id === "bz-head-css" || el.hasAttribute("data-bz-style")) return;
      el.setAttribute("data-bz-style", currentKey);
      firstSheets.push(el);
    }
  );

  function keyOf(url) {
    var u = url instanceof URL ? url : new URL(url, location.href);
    return u.pathname.replace(/\/+$/, "") + u.search;
  }
  // The sign-in pages are not part of the shell: they are loaded for real, so the
  // server can send a reader who is already signed in on to Talk. Fetched by the
  // shell, that redirect would be followed and Talk painted under /buzzy/login.
  function isShellPath(u) {
    return (
      u.origin === location.origin &&
      /^\/buzzy(\/|$)/.test(u.pathname) &&
      !/^\/buzzy\/(landing|login)(\.html)?\/?$/.test(u.pathname)
    );
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
        // The settings dock belongs to the document, not to the first page: wrapped
        // in here it would be stashed with Talk or deleted with any other page.
        if (k.id === "bzDock") return;
        // So do the chrome's header and the website's header (#bzHead): they stay
        // above every page, in that order. The Feedback panel and the tooltip too.
        if (k.id === "bzHead" || k.id === "bzFeedback" || k.id === "bzTip" || k.id === "bzHeadSoon") return;
        // The Zilla agents (agents.js): the strip down the left, its phone tab and its dialog.
        if (k.id === "bzAgents" || k.id === "bzAgentsTab" || k.id === "bzAgentsModal") return;
        if (k.tagName === "HEADER" && k.querySelector("#bzChrome, #bzNav")) return;
        // Scripts stay where they ran; moving them changes nothing but the markup.
        if (k.tagName === "SCRIPT") return;
        page.appendChild(k);
      });
      page.setAttribute("data-bz-path", currentKey);
      var anchor = document.getElementById("bzPageCache");
      document.body.insertBefore(page, anchor && anchor.parentNode === document.body ? anchor : null);
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
          try { el.disabled = el.getAttribute("data-bz-style") !== key || el.hasAttribute("data-bz-replaced"); } catch (e) { /* nothing to do */ }
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
      if (wantsHead(key) && !isTalk(key)) {
        // Under the header: rewritten so nothing here reaches into it. Until the
        // rewrite lands (a moment: the sheets are cached) the originals stand in.
        var originals = holder.slice();
        guardPageStyles(originals, key).then(function (made) {
          made.forEach(function (st) {
            if (originals.indexOf(st) < 0) {
              try { st.disabled = currentKey !== key; } catch (e) { /* best effort */ }
            }
          });
          if (currentKey === key && window.BeeZillaChrome && window.BeeZillaChrome.syncBleed) window.BeeZillaChrome.syncBleed();
        });
      } else if (isTalk(key)) {
        buildHeadCss(holder);
      }
      if (cachedEntry) cachedEntry.styles = holder;
    } else if (cachedEntry && cachedEntry.styles) {
      holder = cachedEntry.styles;
    }
    // Only the active page's stylesheets are enabled. Pages style `body`, `#app`
    // and bare element selectors, so leaving two pages' CSS on at once repaints
    // the current page with the previous one's rules. A sheet that was rewritten
    // for the header (data-bz-replaced) stays off for good.
    Array.prototype.forEach.call(document.querySelectorAll("[data-bz-style]"), function (el) {
      var on = el.getAttribute("data-bz-style") === key && !el.hasAttribute("data-bz-replaced");
      try { el.disabled = !on; } catch (e) { /* link elements on some browsers */ }
    });
    if (holder) {
      holder.forEach(function (el) { if (!el.hasAttribute("data-bz-replaced")) { try { el.disabled = false; } catch (e) { /* nothing to do */ } } });
    }
  }

  function runScripts(root, quiet) {
    var scripts = Array.prototype.slice.call(root.querySelectorAll("script"));
    // Talk fetched only for its header on another page is not a visit to Talk: its
    // analytics snippet (a page view) stays out.
    if (quiet) {
      scripts = scripts.filter(function (s) {
        var drop = /openpanel\.dev/.test(s.getAttribute("src") || "") || /window\.op\s*=|window\.op\(/.test(s.textContent || "");
        if (drop) s.remove();
        return !drop;
      });
    }
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
    "#accountLink", ".account-link", ".account-menu", "#bzDock",
  ].join(",");
  function stripChrome(root) {
    Array.prototype.forEach.call(root.querySelectorAll(CHROME_OWNED), function (n) {
      if (n.closest("#bzChrome")) return; // the live chrome, not the imported copy
      if (n.parentNode) n.parentNode.removeChild(n);
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
    paintPlacesRow();
    try { window.dispatchEvent(new CustomEvent("bz:page", { detail: { key: key } })); } catch (e) { /* old browsers */ }
    // Pages that wait for DOMContentLoaded (memory.html) never see it again in a
    // soft navigation; a synthetic event keeps their boot code honest.
    try { document.dispatchEvent(new Event("DOMContentLoaded")); } catch (e) { /* nothing to do */ }
    try { window.scrollTo(0, scrollY || 0); } catch (e) { /* nothing to do */ }
    busy = false;
  }

  function stashCurrent() {
    var page = document.getElementById("bzPage");
    if (!page) return;
    var key = page.getAttribute("data-bz-path") || currentKey;
    if (keepAlive(key)) {
      // The chrome is rebuilt on restore, so the cached copy must not keep a
      // second #bzNav / #accountLink alive: duplicate ids make
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
      if (page.parentNode) page.parentNode.removeChild(page);
    }
  }

  // What a page's own scripts hang directly on <body> belongs to that page, not to the
  // document: Talk's back-to-top button (browse.js), the Inspiration viewer and its
  // minimised pill, the share sheet, a Recipes backdrop. Left on <body>, those nodes
  // outlived their page AND its stylesheet (a page's CSS is switched off with it), so
  // every later page drew them unstyled. Talk's back-to-top chevron became a black
  // "half a diamond" the width of the window, and as a flex item of Sketch's 100vh
  // body it squeezed the drawing area to 0px: no board, nothing to draw on, only the
  // colour swatch showing above it (owner report, 19 Nov 2026: open Sketch, go to
  // Talk, come back). Leaving a page now takes them along, so a kept-alive page
  // (Talk) gets them back on restore and every other page drops them with its DOM.
  // Left on <body>: the shell's own nodes, the chrome (its header, the settings dock,
  // the Feedback panel), BeeZilla's step-by-step card (pilot.js styles itself and
  // follows its own "go" steps across pages), and tags that draw nothing.
  var DOCUMENT_OWNED = ["bzPage", "bzPageCache", "bzDock", "bzFeedback", "bzHead", "bzTip", "bzAgents", "bzAgentsTab", "bzAgentsModal"];
  function adoptStrays(page) {
    if (!page) return;
    Array.prototype.slice.call(document.body.children).forEach(function (n) {
      if (n === page || DOCUMENT_OWNED.indexOf(n.id) >= 0) return;
      if (/^(HEADER|SCRIPT|STYLE|LINK|TEMPLATE|NOSCRIPT|META)$/.test(n.tagName)) return;
      if (n.classList && (n.classList.contains("bz-pilot") || n.classList.contains("bz-talk-own"))) return;
      page.appendChild(n);
    });
  }

  function restore(key) {
    var entry = cache[key];
    var page = entry.el;
    document.getElementById("bzPageCache").removeChild(page);
    page.id = "bzPage";
    document.body.insertBefore(page, document.getElementById("bzPageCache"));
    finish(key, entry.title, entry.scrollY);
  }

  function handTalk(params) {
    var job = params && params.get ? params.get("job") : null;
    if (job && window.BeeZillaTalk && window.BeeZillaTalk.openJob) window.BeeZillaTalk.openJob(job);
    // /buzzy/talk?agent=<id>: Talk as one of the person's Zilla agents (agents.js).
    var agent = params && params.get ? params.get("agent") : null;
    if (agent && window.BeeZillaAgents && window.BeeZillaAgents.open) window.BeeZillaAgents.open(agent);
  }

  function go(href, opts) {
    opts = opts || {};
    var url;
    try { url = new URL(href, location.href); } catch (e) { return Promise.resolve(); }
    if (!isShellPath(url)) { location.href = url.href; return Promise.resolve(); }
    var key = keyOf(url);
    // Talk is one page, kept for good once it is here (its header is on every page): an
    // address of Talk's with a ?job= goes to the kept Talk and hands it the job, never to
    // a second copy of Talk running its scripts over the same header.
    var talkAsk = null;
    if (isTalk(url.pathname) && key !== TALK && (cache[TALK] || isTalk(currentKey))) {
      talkAsk = url.searchParams;
      url = new URL(TALK, location.href);
      key = TALK;
    }
    // The page already showing. Not location.href: Back and Forward call this after the
    // address has already changed, and comparing with it swapped the address but never
    // the page.
    if (key === currentKey) { handTalk(talkAsk); return Promise.resolve(); }
    if (busy) return Promise.resolve();
    busy = true;

    ensurePageWrapper();
    var target = document.getElementById("bzPage");
    if (target) target.setAttribute("data-bz-path", currentKey);
    adoptStrays(target);
    stashCurrent();
    currentKey = key;
    // Default is to push; only popstate passes push:false (history already moved).
    if (opts.push !== false) history.pushState({ bzShell: key }, "", url.pathname + url.search);

    if (cache[key]) { restore(key); handTalk(talkAsk); return Promise.resolve(); }

    return fetch(url.href, { credentials: "same-origin", headers: { "x-bz-shell": "1" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var page = buildFromDoc(doc, key);
        var head = page.querySelector("#bzHead");
        if (head) {
          var have = document.getElementById("bzHead");
          if (have) head.remove();
          else document.body.insertBefore(head, document.getElementById("bzPage") || document.getElementById("bzPageCache"));
        }
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

  // A page opened on its own gets the header: Talk is fetched once, quietly. Its
  // header goes above the page, its own page into the cache (as if you had been to
  // Talk and left), and its scripts run, so talking works from here. Until it is in,
  // a placeholder holds its place so the page doesn't jump far when it arrives.
  var headLoading = null;
  function placeholder() {
    var ph = document.createElement("div");
    ph.id = "bzHeadSoon";
    ph.setAttribute("aria-hidden", "true");
    ph.style.cssText = "box-sizing:border-box;padding:4px 24px 10px;display:flex;flex-direction:column;gap:18px";
    var bar = "border-radius:999px;background:#141414;border:1px solid #232323";
    ph.innerHTML =
      '<div style="height:66px;' + bar + '"></div>' +
      '<div style="height:56px;margin-right:80px;' + bar + '"></div>' +
      '<div style="height:44px;margin:0 80px 0 10px;border-bottom:1px solid #1e1e1e"></div>';
    return ph;
  }
  function ensureHead() {
    if (document.getElementById("bzHead") || !wantsHead(location.pathname) || isTalk(currentKey)) return Promise.resolve();
    if (headLoading) return headLoading;
    // Above whichever page is showing. Never a new wrapper here: a page may be on its
    // way in (Music studio hops to its own ?job= address as it opens), and a second
    // #bzPage would be mistaken for the page from then on.
    var ph = placeholder();
    var anchor = document.getElementById("bzPage") || document.getElementById("bzPageCache");
    document.body.insertBefore(ph, anchor && anchor.parentNode === document.body ? anchor : null);
    headLoading = fetch(TALK, { credentials: "same-origin", headers: { "x-bz-shell": "1" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var talk = buildFromDoc(doc, TALK);
        var head = talk.querySelector("#bzHead");
        if (!head) throw new Error("no header in Talk");
        // Talk's sheets: in the document but off (its page isn't showing), plus the
        // copy that styles only the header, which is ready before the header shows.
        var found = Array.prototype.slice.call(doc.querySelectorAll('style, link[rel="stylesheet"]'));
        return buildHeadCss(found).then(function (texts) {
          // Talk's own sheets wait, switched off, for the day you open Talk: as <style>
          // text where it was read here, so that day nothing flashes while it loads.
          var sheets = found.map(function (el, i) {
            var mine;
            if (texts && typeof texts[i] === "string") {
              mine = document.createElement("style");
              mine.textContent = texts[i];
            } else {
              mine = el.cloneNode(true);
            }
            mine.setAttribute("data-bz-style", TALK);
            document.head.appendChild(mine);
            try { mine.disabled = true; } catch (e) { /* best effort */ }
            return mine;
          });
          if (document.getElementById("bzHead")) { ph.remove(); return; }
          ph.parentNode.replaceChild(head, ph);
          // The row is in the document now: light the place this address is before
          // a single page script runs, so there is never a frame where Inspiration
          // claims to be the open place on Sketch.
          paintPlacesRow();
          talk.removeAttribute("id");
          document.getElementById("bzPageCache").appendChild(talk);
          cache[TALK] = { el: talk, title: doc.title, scrollY: 0, styles: sheets };
          document.documentElement.classList.add("bz-has-head");
          return runScripts(talk, true).then(function () {
            try { window.dispatchEvent(new CustomEvent("bz:page", { detail: { key: currentKey } })); } catch (e) { /* old browsers */ }
          });
        });
      })
      .catch(function () {
        // No header this time (offline, signed out of a private page): the page itself
        // still works, as it always did.
        if (ph.parentNode) ph.remove();
        headLoading = null;
      });
    return headLoading;
  }

  if (wantsHead(location.pathname)) {
    if (isTalk(currentKey)) {
      // Talk opened directly: its header is in its own markup; copy its sheets for it.
      ensurePageWrapper();
      buildHeadCss(firstSheets);
    } else {
      // Another page opened directly: its sheets keep out of the header, then the
      // header is fetched.
      ensurePageWrapper();
      var settle = function () {
        // The page's own side padding now sits on its #bzPage: the bar re-measures.
        if (window.BeeZillaChrome && window.BeeZillaChrome.syncBleed) window.BeeZillaChrome.syncBleed();
        ensureHead();
      };
      guardPageStyles(firstSheets, currentKey).then(settle, settle);
    }
  }

  window.BeeZillaShell = { go: go, cache: cache, get busy() { return busy; }, get currentKey() { return currentKey; } };
})();

/**
 * Tooltips you can read (owner, 2026-11-20): "my mouse blocks the tooltip. Make the
 * tooltip larger when I hover over it, and move it away from the item itself so that
 * I can see it, rather than my own mouse blocking."
 *
 * Every `title` on the site shows as this tooltip instead of the browser's small one,
 * which sits right under the pointer: 15px type on a dark card, placed beside the thing
 * you point at with a clear gap. Tools down the left edge get theirs on the right;
 * everything else gets it above, or to the right, or (with room for the pointer) below.
 * It shows after a short pause, for keyboard focus too, and goes on leave, a press, a
 * scroll or Escape. While the pointer is on a thing its title waits in data-bz-tip (so
 * the browser's own tooltip can't show), then goes back.
 */
(function () {
  "use strict";
  if (window.BeeZillaTips) return;
  var GAP = 14;
  var tip = null, owner = null, timer = 0;

  function box() {
    if (tip && tip.isConnected) return tip;
    tip = document.createElement("div");
    tip.id = "bzTip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  }
  function text(el) { return (el.getAttribute("data-bz-tip") || el.getAttribute("title") || "").trim(); }
  function holder(t) {
    var el = t && t.nodeType === 1 ? t : t && t.parentElement;
    if (!el || !el.closest) return null;
    var h = el.closest("[title], [data-bz-tip]");
    if (!h || h === document.documentElement || h === document.body || h.tagName === "IFRAME") return null;
    return text(h) ? h : null;
  }
  function take(el) {
    var t = el.getAttribute("title");
    if (!t) return;
    el.setAttribute("data-bz-tip", t);
    el.removeAttribute("title");
    if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-description")) {
      el.setAttribute("aria-description", t);
      el.setAttribute("data-bz-tip-desc", "1");
    }
  }
  function giveBack(el) {
    if (!el) return;
    var t = el.getAttribute("data-bz-tip");
    // A script that set a new title meanwhile wins; otherwise the title comes back.
    if (t && !el.hasAttribute("title")) el.setAttribute("title", t);
    el.removeAttribute("data-bz-tip");
    if (el.getAttribute("data-bz-tip-desc")) { el.removeAttribute("aria-description"); el.removeAttribute("data-bz-tip-desc"); }
  }
  function hide() {
    clearTimeout(timer);
    if (tip) tip.hidden = true;
    giveBack(owner);
    owner = null;
  }
  function place(el) {
    var t = box();
    var words = text(el);
    if (!words || !el.isConnected) { hide(); return; }
    t.textContent = words;
    t.style.visibility = "hidden";
    t.hidden = false;
    var r = el.getBoundingClientRect();
    var vw = document.documentElement.clientWidth || window.innerWidth;
    var vh = window.innerHeight;
    var w = t.offsetWidth, h = t.offsetHeight;
    var x, y;
    var roomRight = r.right + GAP + w <= vw - 8;
    var roomAbove = r.top - GAP - h >= 8;
    if (r.left < 140 && r.width <= 72 && roomRight) {
      // A tool in a column on the left: the tooltip sits to its right.
      x = r.right + GAP; y = r.top + r.height / 2 - h / 2;
    } else if (roomAbove) {
      x = r.left + r.width / 2 - w / 2; y = r.top - GAP - h;
    } else if (roomRight) {
      x = r.right + GAP; y = r.top + r.height / 2 - h / 2;
    } else {
      // Below, far enough down that the pointer's own arrow can't cover it.
      x = r.left + r.width / 2 - w / 2; y = r.bottom + GAP + 18;
    }
    x = Math.max(8, Math.min(x, vw - w - 8));
    y = Math.max(8, Math.min(y, vh - h - 8));
    t.style.left = Math.round(x) + "px";
    t.style.top = Math.round(y) + "px";
    t.style.visibility = "";
  }
  function start(el, wait) {
    if (owner === el) return;
    hide();
    owner = el;
    take(el);
    timer = setTimeout(function () { if (owner === el) place(el); }, wait);
  }

  document.addEventListener("pointerover", function (e) {
    if (e.pointerType && e.pointerType !== "mouse") return;
    var el = holder(e.target);
    if (!el) { if (owner && !owner.contains(e.target)) hide(); return; }
    start(el, 380);
  }, true);
  document.addEventListener("pointerout", function (e) {
    if (!owner) return;
    var to = e.relatedTarget;
    if (to && owner.contains(to)) return;
    hide();
  }, true);
  document.addEventListener("focusin", function (e) {
    var el = holder(e.target);
    if (!el || el !== e.target) return;
    var visible = false;
    try { visible = el.matches(":focus-visible"); } catch (_) { visible = false; }
    if (visible) start(el, 120);
  }, true);
  document.addEventListener("focusout", function (e) { if (owner && e.target === owner) hide(); }, true);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); }, true);
  window.addEventListener("scroll", function () { if (owner) hide(); }, true);
  window.addEventListener("blur", hide);

  window.BeeZillaTips = { hide: hide };
})();

/**
 * The Zilla agents (agents.js + agents.css): a strip of helpers down the left of every
 * page that has the website's header, opened into a sidebar with names and jobs. It is
 * loaded here, once, so the pages that already carry this file get it without a change.
 * It checks for itself that the page wants it and that someone is signed in.
 */
(function () {
  "use strict";
  if (window.BeeZillaAgents || document.getElementById("bzAgentsJs")) return;
  var css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "/buzzy/agents.css";
  css.id = "bzAgentsCss";
  (document.head || document.documentElement).appendChild(css);
  var js = document.createElement("script");
  js.id = "bzAgentsJs";
  js.src = "/buzzy/agents.js";
  js.defer = true;
  (document.head || document.documentElement).appendChild(js);
})();
