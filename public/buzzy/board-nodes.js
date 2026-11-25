/**
 * The windows behind the Idea Board's "More" nodes: API use and Browser use.
 *
 * Owner, 2026-11-21: "you should be able to add a node and connect nodes. But add a node
 * under more for API use and add another one for browser use. And you should be able to
 * record yourself using the browser in order to accomplish the task at hand. But the
 * browser it pulls up should be via a non-residential IP, so you can see it as the AI
 * would see it."
 *
 *   API use     — an address to call: method, headers, keys, body. "Try it" makes the call
 *                 from BeeZilla's server (the answer BeeZilla itself would get) and keeps
 *                 what came back on the card. Keys are used for that try and forgotten: the
 *                 board is saved to the account and can be shared, so it keeps only a key's
 *                 NAME.
 *   Browser use — the globe (owner, 2026-11-23). BeeZilla's own browser: a real browser on a
 *                 server (not this computer: its address is a data centre's, the same as the
 *                 AI's) shown here as pictures you can click and type into. A node does one of
 *                 two things: "Do this" — a job in words, which BeeZilla does itself, clicking
 *                 and typing while you watch — or "Follow a recording" — Record once, and every
 *                 click, line typed, key and scroll becomes a step in plain words, followed
 *                 exactly (a typed step can be "filled in each time"). Joined to a step on the
 *                 board, BeeZilla runs it when the work gets there (use_browser). Downloads go to
 *                 the Library; sign-ins made here are remembered until "Forget sign-ins".
 *
 * whiteboard.js owns the cards (what they look like, what BeeZilla is told about them) and
 * hands this file a small `ctx` to save through. Everything on a card is text: nothing here
 * is ever put on the page as HTML. Rules from the owner kept here: nothing closes on a click
 * outside it (only Esc or Close), and the window can be resized by its left edge, top edge
 * or top-left corner.
 */
(function () {
  "use strict";
  if (window.BeeZillaBoardNodes) return;

  var SVGNS = "http://www.w3.org/2000/svg";
  var ICONS = {
    api: "M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4",
    browser: "M12 3a9 9 0 100 18 9 9 0 000-18zM3.6 9h16.8M3.6 15h16.8M12 3c2.3 2.5 3.5 5.5 3.5 9s-1.2 6.5-3.5 9c-2.3-2.5-3.5-5.5-3.5-9s1.2-6.5 3.5-9z",
    close: "M6 6l12 12M18 6L6 18",
    back: "M15 5l-7 7 7 7",
    forward: "M9 5l7 7-7 7",
    reload: "M20 11a8 8 0 10-2.3 5.7M20 4v7h-7",
    stop: "M7 7h10v10H7z",
    play: "M7 4.5v15l13-7.5z",
    trash: "M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13",
    plus: "M12 5v14M5 12h14",
    server: "M4 5h16v6H4zM4 13h16v6H4zM7.5 8h.01M7.5 16h.01",
    eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z"
  };
  function icon(name, cls) {
    var s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", "wb-ico" + (cls ? " " + cls : ""));
    var p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", ICONS[name] || ICONS.api);
    s.appendChild(p);
    return s;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(cls, label, iconName, onClick) {
    var b = el("button", cls);
    b.type = "button";
    if (iconName) b.appendChild(icon(iconName));
    if (label) b.appendChild(el("span", null, label));
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function nodeApi() { return window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.node; }
  function parse(c) { var N = nodeApi(); return (N && N.parse(c)) || {}; }
  function debounce(fn, ms) {
    var t = 0;
    var d = function () { clearTimeout(t); t = setTimeout(fn, ms); };
    d.now = function () { clearTimeout(t); t = 0; fn(); };
    d.flush = function () { if (t) { clearTimeout(t); t = 0; fn(); } };
    d.cancel = function () { clearTimeout(t); t = 0; };
    return d;
  }
  function ago(iso) {
    var t = Date.parse(iso);
    if (!t) return "";
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }
  function sizeText(n) { return n < 1024 ? n + " bytes" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
  function post(url, body, keepalive) {
    return fetch(url, {
      method: "POST", credentials: "same-origin", keepalive: !!keepalive,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: "That didn't come back right." }; }).then(function (j) { j.httpStatus = r.status; return j; }); });
  }

  // Names that carry a secret (the same words boardNodes.ts keeps out of the account; a camelCase
  // name is split into words first, so accessToken and clientSecret count).
  var SECRET = /(^|[-_. ])(authorization|authentication|auth|cookie|set-cookie|token|secret|password|passwd|pwd|passcode|pass|pin|api[-_ ]?key|apikey|hapikey|access[-_ ]?key|key|sig|signature|bearer|credentials?|session|session[-_ ]?id|sessionid|csrf|xsrf|private|jwt|otp|refresh|client[-_ ]?secret)([-_. ]|$)/i;
  // For the value of a word in an address or a body only the plain ones ("key", "private", "refresh",
  // "pin" and "pass" are also what a body calls a project key, a flag or a page number).
  var SECRET_VALUE = /(^|[-_. ])(authorization|authentication|auth|cookie|token|secret|password|passwd|pwd|passcode|api[-_ ]?key|apikey|hapikey|access[-_ ]?key|sig|signature|bearer|credentials?|session[-_ ]?id|sessionid|csrf|xsrf|jwt|client[-_ ]?secret)([-_. ]|$)/i;
  var NOT_SECRET = /(page|next|prev|previous|cursor|continuation|sync|idempotency)[-_. ]?(token|key)/i;
  function wordsOf(n) { return String(n || "").replace(/([a-z0-9])([A-Z])/g, "$1-$2"); }
  function isSecretName(n) { var w = wordsOf(n); return !NOT_SECRET.test(w) && SECRET.test(w); }
  function isSecretValueName(n) { var w = wordsOf(n); return !NOT_SECRET.test(w) && SECRET_VALUE.test(w); }
  // In an address "key" on its own counts too (?key=… is how many services take theirs); in a body it does not.
  function isSecretQueryName(n) { return isSecretValueName(n) || /^key$/i.test(String(n || "").trim()); }
  // A request body with every secret-named value emptied (the same rule as scrubBody in boardNodes.ts).
  function scrubBody(text) {
    var t = String(text || "").trim();
    if (t.charAt(0) === "{" || t.charAt(0) === "[") {
      try {
        var changed = false;
        var walk = function (v, depth) {
          if (depth > 12) return v;
          if (Array.isArray(v)) return v.map(function (x) { return walk(x, depth + 1); });
          if (v && typeof v === "object") {
            var o = {};
            Object.keys(v).forEach(function (k) {
              var x = v[k];
              if (isSecretValueName(k) && x !== "" && x !== null && typeof x !== "object") { o[k] = ""; changed = true; } else o[k] = walk(x, depth + 1);
            });
            return o;
          }
          return v;
        };
        var out = walk(JSON.parse(t), 0);
        return changed ? JSON.stringify(out, null, 2) : text;
      } catch (_) { /* not JSON: look at it as a form */ }
    }
    if (/^[^\s=&]+=/.test(t)) {
      var did = false;
      var parts = t.split("&").map(function (pair) {
        var eq = pair.indexOf("=");
        if (eq < 0) return pair;
        var name = pair.slice(0, eq);
        try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch (_) { /* as written */ }
        if (!isSecretValueName(name) || pair.slice(eq + 1) === "") return pair;
        did = true;
        return pair.slice(0, eq + 1);
      });
      return did ? parts.join("&") : text;
    }
    return text;
  }

  // Where a played job ended up, with the value of every secret query word emptied
  // (?token=abc → ?token=). The server scrubs the same value at the source; this is
  // the second half, for whatever a card already saved, and for a server that is older
  // than this page.
  function scrubUrl(u) {
    var text = String(u || "");
    return scrubBody(text.replace(/^[^?]*\?/, "")) === text.replace(/^[^?]*\?/, "")
      ? text
      : text.replace(/\?.*$/, "?" + scrubBody(text.replace(/^[^?]*\?/, "")));
  }
  // A sentence from a page, with `name=value` pairs whose name is a secret word emptied.
  // The words around it are left alone: this is prose, not a body.
  function scrubLine(t) {
    var text = String(t || "");
    return text.replace(/([A-Za-z0-9_.-]{1,40})=(?!\s)([^\s&"',;)]+)/g, function (m, name) {
      return isSecretQueryName(name) ? name + "=" : m;
    });
  }

  // ── The window ───────────────────────────────────────────────────────────
  // Docked in the corner History uses (bottom right, above the zoom controls), so it never
  // covers the tools. Resized by its left edge, top edge or top-left corner; the size is
  // remembered on this computer.
  var current = null;     // the window that is open: { close(), root, card }
  var SIZES = { api: { w: 460, h: 560, minW: 360, minH: 340 }, browser: { w: 760, h: 720, minW: 520, minH: 500 } };

  function savedSize(kind) {
    try { var v = JSON.parse(localStorage.getItem("bz.nodewin." + kind) || "null"); if (v && v.w > 0 && v.h > 0) return v; } catch (_) { /* none */ }
    return null;
  }
  function rememberSize(kind, w, h) { try { localStorage.setItem("bz.nodewin." + kind, JSON.stringify({ w: Math.round(w), h: Math.round(h) })); } catch (_) { /* fine */ } }

  // The browser window needs room to show a page at a readable size, and the board is only
  // as tall as the screen leaves it, so that one window is fixed to the screen's bottom-right
  // and runs down from where the board's work area starts. The API window stays in the board.
  function limits(ctx, kind) {
    var d = SIZES[kind];
    if (kind === "browser") {
      var top = Math.max(12, ctx.host.getBoundingClientRect().top);
      return { maxW: Math.max(d.minW, window.innerWidth - 24 - 64), maxH: Math.max(d.minH, window.innerHeight - top - 12) };
    }
    return { maxW: Math.max(d.minW, ctx.host.clientWidth - 90), maxH: Math.max(d.minH, ctx.host.clientHeight - 72) };
  }
  function shell(ctx, kind, label, titleText) {
    var root = el("section", "wb-nwin wb-node-pop wb-nwin-" + kind);
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", label);
    var head = el("div", "wb-nwin-head");
    head.appendChild(icon(kind, "wb-nwin-ico"));
    var title = el("strong", "wb-nwin-title", titleText);
    head.appendChild(title);
    var x = button("wb-btn wb-nwin-x", "Close", "close");
    x.setAttribute("aria-label", "Close " + label);
    head.appendChild(x);
    root.appendChild(head);
    var body = el("div", "wb-nwin-body");
    root.appendChild(body);
    var d = SIZES[kind];
    ["l", "t", "tl"].forEach(function (edge) {
      var h = el("div", "wb-rs wb-rs-" + edge);
      h.setAttribute("aria-hidden", "true");
      h.title = "Drag to resize";
      root.appendChild(h);
      h.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        h.setPointerCapture(e.pointerId);
        var w0 = root.offsetWidth, h0 = root.offsetHeight, x0 = e.clientX, y0 = e.clientY;
        var lim = limits(ctx, kind);
        function move(ev) {
          if (edge.indexOf("l") >= 0) root.style.width = clamp(w0 + (x0 - ev.clientX), d.minW, lim.maxW) + "px";
          if (edge.indexOf("t") >= 0) root.style.height = clamp(h0 + (y0 - ev.clientY), d.minH, lim.maxH) + "px";
          if (root.onresized) root.onresized();
        }
        function up() {
          h.removeEventListener("pointermove", move);
          h.removeEventListener("pointerup", up);
          h.removeEventListener("pointercancel", up);
          rememberSize(kind, root.offsetWidth, root.offsetHeight);
        }
        h.addEventListener("pointermove", move);
        h.addEventListener("pointerup", up);
        h.addEventListener("pointercancel", up);
      });
    });
    function fit() {
      var lim = limits(ctx, kind);
      var s = savedSize(kind);
      root.style.width = clamp(s ? s.w : (kind === "browser" ? Math.min(1180, lim.maxW) : d.w), d.minW, lim.maxW) + "px";
      root.style.height = clamp(s ? s.h : (kind === "browser" ? lim.maxH : d.h), d.minH, lim.maxH) + "px";
      if (root.onresized) root.onresized();
    }
    ctx.host.appendChild(root);
    fit();
    // The screen changed size: keep the window on it.
    window.addEventListener("resize", fit);
    root.dispose = function () { window.removeEventListener("resize", fit); };
    return { root: root, head: head, title: title, body: body, closeBtn: x };
  }

  function closeAll() { if (current) current.close(); }

  // ── API use ──────────────────────────────────────────────────────────────
  function openApi(c, ctx) {
    var spec = parse(c);
    var state = {
      title: c.title || "API call",
      purpose: spec.purpose || "",
      method: spec.method || "GET",
      url: spec.url || "",
      headers: (spec.headers || []).map(function (h) { return { name: h.name, value: h.value }; }),
      keys: (spec.keys || []).map(function (k) { return { name: k.name, where: k.in === "query" ? "query" : "header", value: "" }; }),
      body: spec.body || "",
      last: spec.last || null
    };
    var snapped = false;
    var win = shell(ctx, "api", "API use", "API use");
    var root = win.root, body = win.body;
    var saveSoon = debounce(commit, 450);

    function field(labelText, input, hint) {
      var wrap = el("label", "wb-nf");
      wrap.appendChild(el("span", "wb-nf-label", labelText));
      wrap.appendChild(input);
      if (hint) wrap.appendChild(el("span", "wb-nf-hint", hint));
      return wrap;
    }
    function text(value, ph, max, on) {
      var i = el("input", "wb-nf-input");
      i.type = "text";
      i.value = value || "";
      i.placeholder = ph || "";
      i.maxLength = max || 300;
      i.autocomplete = "off";
      i.spellcheck = false;
      i.addEventListener("input", function () { on(i.value); });
      return i;
    }

    var nameIn = text(state.title, "API call", 140, function (v) { state.title = v; saveSoon(); });
    nameIn.setAttribute("aria-label", "Name");
    body.appendChild(field("Name", nameIn));
    var purposeIn = text(state.purpose, "What do you want from it?", 300, function (v) { state.purpose = v; saveSoon(); });
    body.appendChild(field("What it's for", purposeIn, "In your words. BeeZilla reads this."));

    // Method + address on one row.
    var callRow = el("div", "wb-nf wb-nf-call");
    callRow.appendChild(el("span", "wb-nf-label", "Address to call"));
    var line = el("div", "wb-nf-line");
    var method = el("select", "wb-nf-input wb-nf-method");
    method.setAttribute("aria-label", "Method");
    ["GET", "POST", "PUT", "PATCH", "DELETE"].forEach(function (m) {
      var o = el("option", null, m);
      o.value = m;
      method.appendChild(o);
    });
    method.value = state.method;
    var urlIn = el("input", "wb-nf-input wb-nf-url");
    urlIn.type = "text";
    urlIn.value = state.url;
    urlIn.placeholder = "https://api.example.com/v1/things";
    urlIn.maxLength = 2000;
    urlIn.autocomplete = "off";
    urlIn.spellcheck = false;
    urlIn.setAttribute("aria-label", "Address");
    var tryBtn = button("wb-selbtn wb-primary wb-nf-try", "Try it", "play", function () { tryIt(); });
    line.appendChild(method);
    line.appendChild(urlIn);
    line.appendChild(tryBtn);
    callRow.appendChild(line);
    callRow.appendChild(el("span", "wb-nf-hint", "Try it makes the call from BeeZilla's own server, so you see the answer BeeZilla would get. Keys go in Keys below, never in the address."));
    body.appendChild(callRow);
    var result = el("div", "wb-nres");
    result.setAttribute("role", "status");
    result.setAttribute("aria-live", "polite");
    body.appendChild(result);

    // Headers (not secret) and keys (secret: used for a try, never kept).
    var headersBox = el("div", "wb-nf wb-nf-list");
    var keysBox = el("div", "wb-nf wb-nf-list");
    body.appendChild(headersBox);
    body.appendChild(keysBox);
    function rowInput(value, ph, onChange, type) {
      var i = el("input", "wb-nf-input");
      i.type = type || "text";
      i.value = value || "";
      i.placeholder = ph;
      i.maxLength = 400;
      i.autocomplete = "off";
      i.spellcheck = false;
      i.addEventListener("input", function () { onChange(i.value); });
      return i;
    }
    function paintLists() {
      headersBox.textContent = "";
      var hh = el("div", "wb-nf-listhead");
      hh.appendChild(el("span", "wb-nf-label", "Headers"));
      hh.appendChild(button("wb-nf-add", "Add a header", "plus", function () { state.headers.push({ name: "", value: "" }); paintLists(); var last = headersBox.querySelector(".wb-nf-row:last-of-type input"); if (last) last.focus(); }));
      headersBox.appendChild(hh);
      if (!state.headers.length) headersBox.appendChild(el("span", "wb-nf-hint", "Optional. Not for keys or passwords — those go below."));
      state.headers.forEach(function (h, i) {
        var r = el("div", "wb-nf-row");
        var n = rowInput(h.name, "Name, like Accept", function (v) { h.name = v; saveSoon(); });
        // A header named like a key moves down to the keys, with its value masked, as soon
        // as it is typed: the value is never part of the board.
        n.addEventListener("change", function () {
          if (isSecretName(h.name)) {
            state.keys.push({ name: h.name.trim(), where: "header", value: h.value || "" });
            state.headers.splice(i, 1);
            paintLists();
            saveSoon();
            ctx.say("That one carries a key, so it moved to Keys. Its value is used for a try and never kept.", 4200);
          }
        });
        n.setAttribute("aria-label", "Header name");
        var v = rowInput(h.value, "Value", function (x) { h.value = x; saveSoon(); });
        v.setAttribute("aria-label", "Header value");
        r.appendChild(n); r.appendChild(v);
        var rm = button("wb-nf-rm", "", "trash", function () { state.headers.splice(i, 1); paintLists(); saveSoon(); });
        rm.setAttribute("aria-label", "Remove this header");
        r.appendChild(rm);
        headersBox.appendChild(r);
      });

      keysBox.textContent = "";
      var kh = el("div", "wb-nf-listhead");
      kh.appendChild(el("span", "wb-nf-label", "Keys"));
      kh.appendChild(button("wb-nf-add", "Add a key", "plus", function () { state.keys.push({ name: "", where: "header", value: "" }); paintLists(); var last = keysBox.querySelector(".wb-nf-row:last-of-type input"); if (last) last.focus(); }));
      keysBox.appendChild(kh);
      keysBox.appendChild(el("span", "wb-nf-hint", "A key, token or password is used for your try, then forgotten. The board keeps only its name."));
      state.keys.forEach(function (k, i) {
        var r = el("div", "wb-nf-row wb-nf-keyrow");
        var n = rowInput(k.name, "Name, like Authorization", function (v) { k.name = v; saveSoon(); });
        n.setAttribute("aria-label", "Key name");
        var v = rowInput(k.value, "Paste the key", function (x) { k.value = x; }, "password");
        v.setAttribute("aria-label", "Key value (not saved)");
        v.autocomplete = "new-password";
        var where = el("select", "wb-nf-input wb-nf-where");
        where.setAttribute("aria-label", "Where the key goes");
        [["header", "In header"], ["query", "In address"]].forEach(function (o) { var op = el("option", null, o[1]); op.value = o[0]; where.appendChild(op); });
        where.value = k.where;
        where.addEventListener("change", function () { k.where = where.value; saveSoon(); });
        r.appendChild(n); r.appendChild(v); r.appendChild(where);
        var rm = button("wb-nf-rm", "", "trash", function () { state.keys.splice(i, 1); paintLists(); saveSoon(); });
        rm.setAttribute("aria-label", "Remove this key");
        r.appendChild(rm);
        keysBox.appendChild(r);
      });
    }
    paintLists();

    // A key typed straight into the address (?api_key=…) moves down to Keys, with its value masked,
    // when you leave the address; and what is saved never has it, however fast you type.
    function splitKeysFromUrl(url) {
      var u;
      try { u = new URL(String(url).trim()); } catch (_) { return { url: url, found: [] }; }
      if (u.search.length < 2) return { url: url, found: [] };
      var found = [];
      var pairs = u.search.slice(1).split("&").map(function (pair) {
        var eq = pair.indexOf("=");
        var rawName = eq < 0 ? pair : pair.slice(0, eq);
        var rawValue = eq < 0 ? "" : pair.slice(eq + 1);
        var nm = rawName;
        try { nm = decodeURIComponent(rawName.replace(/\+/g, " ")); } catch (_) { /* as written */ }
        if (!isSecretQueryName(nm) || rawValue === "") return pair;
        var val = rawValue;
        try { val = decodeURIComponent(rawValue.replace(/\+/g, " ")); } catch (_) { /* as written */ }
        found.push({ name: nm, value: val });
        return rawName + "=";
      });
      if (!found.length) return { url: url, found: [] };
      u.search = "?" + pairs.join("&");
      return { url: u.toString(), found: found };
    }
    function pullKeysFromUrl() {
      var r = splitKeysFromUrl(state.url);
      if (!r.found.length) return false;
      r.found.forEach(function (f) {
        var have = state.keys.filter(function (k) { return k.name.toLowerCase() === f.name.toLowerCase(); })[0];
        if (have) { have.value = f.value; have.where = "query"; } else state.keys.push({ name: f.name, where: "query", value: f.value });
      });
      state.url = r.url;
      return true;
    }
    urlIn.addEventListener("input", function () { state.url = urlIn.value; saveSoon(); });
    urlIn.addEventListener("change", function () {
      state.url = urlIn.value;
      if (!pullKeysFromUrl()) return;
      urlIn.value = state.url;
      paintLists();
      saveSoon();
      ctx.say("The key in that address moved to Keys. It's used for your try and never kept.", 4200);
    });

    // Body, for the methods that send one.
    var bodyIn = el("textarea", "wb-nf-input wb-nf-body");
    bodyIn.value = state.body;
    bodyIn.rows = 5;
    bodyIn.maxLength = 6000;
    bodyIn.spellcheck = false;
    bodyIn.placeholder = '{ "name": "value" }';
    bodyIn.addEventListener("input", function () { state.body = bodyIn.value; saveSoon(); });
    var bodyField = field("What to send (the body)", bodyIn, "A password or key in the body isn't saved with the board. Put keys in Keys.");
    body.appendChild(bodyField);
    function paintMethod() { bodyField.hidden = state.method === "GET"; }
    method.addEventListener("change", function () { state.method = method.value; paintMethod(); saveSoon(); });
    paintMethod();

    function paintResult(last, preview, extra) {
      result.textContent = "";
      result.hidden = false;
      if (extra && extra.error) {
        result.appendChild(el("div", "wb-nres-head wb-nres-bad", extra.error));
        return;
      }
      if (!last) { result.hidden = true; return; }
      var head = el("div", "wb-nres-head");
      if (!last.reached) {
        head.className += " wb-nres-bad";
        head.textContent = "Couldn't reach it. " + (last.error || "");
        result.appendChild(head);
        return;
      }
      head.className += last.status < 300 ? " wb-nres-ok" : last.status < 500 ? " wb-nres-warn" : " wb-nres-bad";
      head.appendChild(el("strong", null, "Answered " + last.status + (last.statusText ? " " + last.statusText : "")));
      var bits = [];
      if (last.ms != null) bits.push(last.ms < 1000 ? last.ms + " ms" : (last.ms / 1000).toFixed(1) + " s");
      if (last.type) bits.push(last.type);
      if (last.bytes != null) bits.push(sizeText(last.bytes));
      if (last.at) bits.push(ago(last.at));
      head.appendChild(el("span", "wb-nres-meta", bits.join(" · ")));
      result.appendChild(head);
      var pre = el("pre", "wb-nres-pre", preview != null ? preview : (last.preview || ""));
      pre.tabIndex = 0;
      pre.setAttribute("aria-label", "What came back");
      result.appendChild(pre);
      if (extra && extra.headers && extra.headers.length) {
        var det = el("details", "wb-nres-det");
        det.appendChild(el("summary", null, "Some of what it said about itself"));
        extra.headers.forEach(function (h) { det.appendChild(el("div", "wb-nres-h", h[0] + ": " + h[1])); });
        result.appendChild(det);
      }
      if (extra && extra.truncated) result.appendChild(el("div", "wb-nf-hint", "Only the start of the answer is shown."));
    }
    paintResult(state.last, null, null);

    function tryIt() {
      if (!state.url.trim()) { paintResult(null, null, { error: "Type the address to call first." }); return; }
      saveSoon.now();
      tryBtn.disabled = true;
      tryBtn.querySelector("span").textContent = "Trying…";
      result.textContent = "";
      result.hidden = false;
      result.appendChild(el("div", "wb-nres-head", "Calling it…"));
      post("/api/buzzy/nodes/api-call", {
        method: state.method,
        url: state.url.trim(),
        headers: state.headers.filter(function (h) { return h.name.trim(); }),
        keys: state.keys.filter(function (k) { return k.name.trim() && k.value; }).map(function (k) { return { name: k.name.trim(), in: k.where, value: k.value }; }),
        body: state.method === "GET" ? "" : state.body
      }).then(function (j) {
        tryBtn.disabled = false;
        tryBtn.querySelector("span").textContent = "Try it";
        if (!ctx.alive(c)) return;
        if (j && j.reached === true) {
          state.last = { at: j.at, reached: true, status: j.status, statusText: j.statusText, ms: j.ms, type: j.type, bytes: j.bytes, preview: String(j.preview || "").slice(0, 1500) };
          paintResult(state.last, j.preview, { headers: j.headers, truncated: j.truncated });
          saveSoon.now();
        } else if (j && j.reached === false) {
          state.last = { at: j.at, reached: false, error: String(j.error || "").slice(0, 200) };
          paintResult(state.last, null, null);
          saveSoon.now();
        } else {
          // Not an attempt at all (signed out, Lockdown, too many tries): say so, keep what was there.
          paintResult(null, null, { error: (j && j.error) || "That didn't work. Try again." });
        }
      }).catch(function () {
        tryBtn.disabled = false;
        tryBtn.querySelector("span").textContent = "Try it";
        paintResult(null, null, { error: "BeeZilla couldn't be reached. Check the connection and try again." });
      });
    }

    function commit() {
      if (!ctx.alive(c)) return;
      if (!snapped) { ctx.snapshot(); snapped = true; }
      // Never saved with a key in it, however fast the person types: a clean copy is saved, with the
      // key's name added to Keys. The field itself is only changed when they leave it.
      var split = splitKeysFromUrl(state.url.trim());
      var keysSaved = state.keys.filter(function (k) { return k.name.trim(); }).map(function (k) { return { name: k.name.trim(), in: k.where }; });
      split.found.forEach(function (f) {
        if (!keysSaved.some(function (k) { return k.name.toLowerCase() === f.name.toLowerCase(); })) keysSaved.push({ name: f.name, in: "query" });
      });
      var s = {
        v: 1,
        purpose: state.purpose.trim(),
        method: state.method,
        url: split.url,
        headers: state.headers.filter(function (h) { return h.name.trim(); }).map(function (h) { return { name: h.name.trim(), value: h.value }; }),
        keys: keysSaved,
        body: state.method === "GET" ? "" : scrubBody(state.body),
        last: state.last || undefined
      };
      c.title = state.title.trim() || "API call";
      c.node = JSON.stringify(s);
      ctx.changed(c);
    }

    var alive = setInterval(function () { if (!ctx.alive(c)) win.close(); }, 2000);
    win.close = function () {
      clearInterval(alive);
      saveSoon.flush();
      root.dispose();
      root.remove();
      if (current === win) current = null;
    };
    win.closeBtn.addEventListener("click", function () { win.close(); focusCard(ctx, c); });
    root.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Escape") { win.close(); focusCard(ctx, c); }
    });
    win.card = c;
    current = win;
    (state.url ? tryBtn : urlIn).focus({ preventScroll: true });
  }

  function focusCard(ctx, c) {
    try {
      var n = ctx.host.querySelector('.wb-card[aria-label$=": ' + (c.title || "").replace(/"/g, "") + '"]');
      if (n) n.focus({ preventScroll: true });
    } catch (_) { /* focus is a courtesy */ }
  }

  // ── Browser use ──────────────────────────────────────────────────────────
  var VIEW_W = 1280, VIEW_H = 800;
  var ENDED = {
    idle: "It closed after a few minutes with nothing happening, to save your browser time.",
    time: "It reached the time limit for one browser.",
    replaced: "A browser opened somewhere else, so this one closed.",
    closed: "The browser closed.",
    shutdown: "BeeZilla restarted, so the browser closed."
  };
  function seeText(w) { return w && w.line ? w.line : "A browser on a server."; }

  function openBrowser(c, ctx) {
    var N = nodeApi();
    var spec = parse(c);
    var startMode = spec.mode === "task" || spec.mode === "recording" ? spec.mode : (spec.steps && spec.steps.length ? "recording" : "task");
    var st = {
      phase: "idle",          // idle · starting · live · ended · error
      mode: startMode,        // task: BeeZilla does it from words · recording: it follows the steps exactly
      steps: (spec.steps || []).slice(),
      recording: false,
      replaying: false,
      marks: {},              // step index → running | ok | skipped | failed
      notes: {},              // step index → words
      where: spec.where || null,
      url: "", title: "", canBack: false, canForward: false,
      msg: "",
      id: "", es: null,
      info: null,             // is the server browser set up here, and how much time is left today
      pendingAfterReplay: false,
      running: null,          // the kind of job going on now ("task" | "recording"), or null
      acts: [],               // what BeeZilla is doing, step by step (a task)
      result: null,           // how the last job in this window ended
      files: [],              // what this browser downloaded (saved to the Library)
      signIns: false,
      fill: {}                // the words for this run's blanks ("Filled in each time" steps)
    };
    var win = shell(ctx, "browser", "Browser use", "Browser use");
    var root = win.root;
    var snapped = false;
    var lastRun = spec.lastRun || null;

    // The title is the node's name, editable in place; the controls sit beside it.
    var nameIn = el("input", "wb-nf-input wb-nwin-name");
    nameIn.type = "text";
    nameIn.value = c.title || "Browser job";
    nameIn.maxLength = 140;
    nameIn.setAttribute("aria-label", "Name of this browser job");
    win.head.replaceChild(nameIn, win.title);
    var saveName = debounce(function () { if (!ctx.alive(c)) return; if (!snapped) { ctx.snapshot(); snapped = true; } c.title = nameIn.value.trim() || "Browser job"; ctx.changed(c); }, 450);
    nameIn.addEventListener("input", saveName);

    var wrap = win.body;
    // Where it runs: said first, because it is the point.
    var where = el("div", "wb-nw-where");
    where.setAttribute("role", "status");
    wrap.appendChild(where);

    // ── The two kinds of job (owner, 2026-11-23: "say, do this specifically, or follow this
    // recording specifically") ──
    var tabs = el("div", "wb-nw-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "What this node does");
    var tabTask = button("wb-nw-tab", "Do this", null, function () { setMode("task"); });
    var tabRec = button("wb-nw-tab", "Follow a recording", null, function () { setMode("recording"); });
    [tabTask, tabRec].forEach(function (t) { t.setAttribute("role", "tab"); tabs.appendChild(t); });
    wrap.appendChild(tabs);

    // "Do this": the job in words.
    var taskBox = el("div", "wb-nw-task");
    var taskLabel = el("label", "wb-nf-label", "What should BeeZilla do in its browser?");
    var taskIn = el("textarea", "wb-nf-input wb-nw-taskin");
    taskIn.id = "bzNwTask" + Math.random().toString(36).slice(2, 7);
    taskLabel.htmlFor = taskIn.id;
    taskIn.rows = 3;
    taskIn.maxLength = 2000;
    taskIn.placeholder = "Go to mureka.ai/create, type the song idea into the box, press Create, wait for the song, then download it.";
    taskIn.value = spec.task || "";
    var startRow = el("div", "wb-nf-row wb-nw-startrow");
    var startIn = el("input", "wb-nf-input");
    startIn.type = "text";
    startIn.placeholder = "Start at (optional): mureka.ai/create";
    startIn.setAttribute("aria-label", "Web address to start at (optional)");
    startIn.autocomplete = "off";
    startIn.spellcheck = false;
    startIn.value = spec.startUrl || "";
    startRow.appendChild(startIn);
    taskBox.appendChild(taskLabel);
    taskBox.appendChild(taskIn);
    taskBox.appendChild(startRow);
    taskBox.appendChild(el("p", "wb-nf-hint", "Say it step by step, in your own words. BeeZilla clicks and types for you, and you can watch it here. It never types a password or pays: when a site needs you, it stops and says so."));
    wrap.appendChild(taskBox);
    var saveTask = debounce(function () {
      if (!ctx.alive(c)) return;
      if (!snapped) { ctx.snapshot(); snapped = true; }
      writeBack();
    }, 500);
    taskIn.addEventListener("input", function () { saveTask(); paintAll(); });
    startIn.addEventListener("input", saveTask);

    // The controls for either kind.
    var ctl = el("div", "wb-nw-ctl");
    var bRun = button("wb-selbtn wb-primary wb-nw-runbtn", "Run it now", "play", function () { onRun(); });
    bRun.title = "BeeZilla does the job now, in its own browser, where you can watch";
    var bStop = button("wb-selbtn wb-nw-stop", "Stop", "stop", function () { onStop(); });
    bStop.title = "Stop BeeZilla and take over the browser yourself";
    var bRec = button("wb-selbtn wb-nw-rec", "Record", null, function () { onRecord(); });
    var recDot = el("span", "wb-nw-recdot");
    recDot.setAttribute("aria-hidden", "true");
    bRec.insertBefore(recDot, bRec.firstChild);
    var bLook = button("wb-selbtn wb-nw-look", "Just look", "eye", function () { startBrowser({ startUrl: firstUrl(), record: false }); });
    bLook.title = "Open BeeZilla's browser without recording: to see a page the way the AI would, or to sign in to a site once";
    [bRun, bStop, bRec, bLook].forEach(function (b) { ctl.appendChild(b); });
    wrap.appendChild(ctl);

    var grid = el("div", "wb-nw-grid");
    var left = el("div", "wb-nw-left");
    var right = el("div", "wb-nw-right");
    grid.appendChild(left); grid.appendChild(right);
    wrap.appendChild(grid);

    // Address bar.
    var barRow = el("form", "wb-nw-bar");
    var bBack = button("wb-nw-nav", "", "back", function () { nav("history", { action: "back" }); });
    bBack.setAttribute("aria-label", "Back");
    var bFwd = button("wb-nw-nav", "", "forward", function () { nav("history", { action: "forward" }); });
    bFwd.setAttribute("aria-label", "Forward");
    var bReload = button("wb-nw-nav", "", "reload", function () { nav("history", { action: "reload" }); });
    bReload.setAttribute("aria-label", "Reload");
    var addr = el("input", "wb-nf-input wb-nw-addr");
    addr.type = "text";
    addr.placeholder = "Type a web address, like example.com";
    addr.setAttribute("aria-label", "Web address");
    addr.autocomplete = "off";
    addr.spellcheck = false;
    var bGo = el("button", "wb-nw-go", "Go");
    bGo.type = "submit";
    barRow.appendChild(bBack); barRow.appendChild(bFwd); barRow.appendChild(bReload); barRow.appendChild(addr); barRow.appendChild(bGo);
    left.appendChild(barRow);
    barRow.addEventListener("submit", function (e) {
      e.preventDefault();
      if (st.phase !== "live") { startBrowser({ startUrl: addr.value.trim(), record: false }); return; }
      nav("goto", { url: addr.value });
    });

    // The picture of the page.
    var stage = el("div", "wb-nw-stage");
    var canvas = el("canvas", "wb-nw-canvas");
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "BeeZilla's browser. Click in it, then type.");
    var g = canvas.getContext("2d");
    var veil = el("div", "wb-nw-veil");
    veil.setAttribute("role", "status");
    // While BeeZilla works, the page is its: a strip over the picture says so (Stop hands it back).
    var busyStrip = el("div", "wb-nw-busy");
    busyStrip.setAttribute("role", "status");
    busyStrip.hidden = true;
    var pickMenu = el("div", "wb-nw-pick wb-node-pop");
    pickMenu.hidden = true;
    stage.appendChild(canvas);
    stage.appendChild(veil);
    stage.appendChild(busyStrip);
    stage.appendChild(pickMenu);
    left.appendChild(stage);
    var foot = el("p", "wb-nf-hint wb-nw-foot", "Click inside the page, then type. Keys go to the page while you are in it: click the title bar, then press Esc to close. Passwords you type are passed on but never written down.");
    left.appendChild(foot);

    // Beside the picture (under it in a narrow window): what it is doing, the steps, the files.
    var stepsHead = el("div", "wb-nw-stepshead");
    right.appendChild(stepsHead);
    var actList = el("ol", "wb-nw-steps wb-nw-acts");
    actList.setAttribute("aria-label", "What BeeZilla is doing");
    actList.setAttribute("aria-live", "polite");
    right.appendChild(actList);
    // A recording's blanks: the words for this run (BeeZilla fills them itself when it runs it).
    var blanksBox = el("div", "wb-nw-blanks");
    blanksBox.hidden = true;
    right.appendChild(blanksBox);
    var list = el("ol", "wb-nw-steps");
    list.setAttribute("aria-label", "Recorded steps");
    right.appendChild(list);
    // Record again: what to do with the steps already there (no pop-up: it's in place).
    var again = el("div", "wb-nw-again");
    again.hidden = true;
    right.appendChild(again);
    var runBox = el("div", "wb-nw-run");
    runBox.setAttribute("role", "status");
    runBox.setAttribute("aria-live", "polite");
    runBox.hidden = true;
    right.appendChild(runBox);
    var filesBox = el("div", "wb-nw-files");
    filesBox.hidden = true;
    right.appendChild(filesBox);
    // Staying signed in: said plainly, with the way to undo it.
    var signBox = el("div", "wb-nw-signins");
    right.appendChild(signBox);

    function firstUrl() {
      if (st.mode === "task") {
        var s0 = startIn.value.trim();
        if (s0) return /^[a-z][a-z0-9+.-]*:/i.test(s0) ? s0 : "https://" + s0;
      }
      for (var i = 0; i < st.steps.length; i++) if (st.steps[i].t === "goto" && st.steps[i].url) return st.steps[i].url;
      return spec.startUrl || "";
    }

    // ---- saving onto the card ----
    function specNow() {
      var s = parse(c);
      s.v = 1;
      s.mode = st.mode;
      s.task = taskIn.value.slice(0, 2000);
      s.steps = st.steps.slice();
      var start = startIn.value.trim();
      s.startUrl = st.mode === "task" ? (start ? (/^[a-z][a-z0-9+.-]*:/i.test(start) ? start : "https://" + start) : "") : firstUrl();
      if (st.where) s.where = { label: st.where.label, ip: st.where.ip, org: st.where.org, kind: st.where.kind };
      if (lastRun) s.lastRun = lastRun;
      return s;
    }
    function writeBack() {
      var s = specNow();
      if (st.steps.length && !s.recordedAt) s.recordedAt = new Date().toISOString();
      c.node = JSON.stringify(s);
      ctx.changed(c);
    }
    var saveSteps = debounce(function () {
      if (!ctx.alive(c)) return;
      if (!snapped) { ctx.snapshot(); snapped = true; }
      var s = parse(c);
      s.recordedAt = new Date().toISOString();
      c.node = JSON.stringify(s);
      writeBack();
    }, 500);
    function setMode(m) {
      if (st.mode === m) return;
      if (st.running || st.recording) { say("Wait for it to finish (or press Stop) before switching."); return; }
      st.mode = m;
      if (!snapped) { ctx.snapshot(); snapped = true; }
      writeBack();
      paintAll();
    }

    // ---- painting ----
    function whereText() {
      var w = st.where;
      if (!w) return st.phase === "idle" ? "BeeZilla's own browser: a real browser on a server, not on this computer. Its address is a data centre's, the same kind the AI's browser has." : "BeeZilla's browser. Checking the address it goes out from…";
      var org = w.org ? " (" + w.org + ")" : "";
      if (!w.ip) return "BeeZilla's browser. Its address could not be checked.";
      if (w.kind === "datacenter") return "BeeZilla's browser, seen from " + w.ip + org + ": a data-centre address, the view BeeZilla's AI gets, not your home connection.";
      if (w.kind === "home") return "Heads up: this browser goes out from " + w.ip + org + ", which looks like a home or office connection, not a server. The AI may see pages differently.";
      return "BeeZilla's browser, seen from " + w.ip + org + ".";
    }
    function paintWhere() {
      where.textContent = "";
      var kind = st.where && st.where.kind;
      where.className = "wb-nw-where " + (kind === "datacenter" ? "wb-nw-good" : kind === "home" ? "wb-nw-warn" : "");
      where.appendChild(icon("server", "wb-nw-ico"));
      where.appendChild(el("span", null, whereText()));
    }
    function paintVeil() {
      var live = st.phase === "live";
      veil.hidden = live;
      canvas.style.visibility = live ? "visible" : "hidden";
      busyStrip.hidden = !(live && (st.running || st.replaying));
      busyStrip.textContent = st.running === "task" ? "BeeZilla is doing the job in its browser. Press Stop to take over." : "BeeZilla is following the recording. Press Stop to take over.";
      if (live) return;
      veil.textContent = "";
      var m = el("div", "wb-nw-veilbox");
      if (st.phase === "starting") { m.appendChild(el("div", "wb-nw-spin")); m.appendChild(el("p", null, "Starting BeeZilla's browser on a server… this takes a few seconds.")); }
      else if (st.phase === "ended") {
        m.appendChild(el("p", null, st.msg || ENDED.closed));
        m.appendChild(el("p", "wb-nf-hint", "What it did is saved on the card."));
        m.appendChild(button("wb-selbtn wb-primary", "Open the browser again", null, function () { startBrowser({ startUrl: firstUrl(), record: false }); }));
      } else if (st.phase === "error") {
        m.appendChild(el("p", "wb-nw-err", st.msg || "The browser could not be opened."));
        m.appendChild(button("wb-selbtn", "Try again", null, function () { st.phase = "idle"; st.msg = ""; paintAll(); }));
      } else {
        var off = st.info && st.info.configured === false;
        if (st.mode === "task") {
          m.appendChild(el("p", "wb-nw-introhead", "Tell BeeZilla the job. It does it in its own browser."));
          m.appendChild(el("p", null, off
            ? "The server browser isn't set up on this BeeZilla yet, so it can't be opened."
            : "Write what to do above, then press Run it now to watch it work. Join this globe to a step on the board, and BeeZilla does it when the work gets there."));
        } else {
          m.appendChild(el("p", "wb-nw-introhead", st.steps.length ? "A job you recorded is saved here." : "Show BeeZilla a job, once."));
          m.appendChild(el("p", null, off
            ? "The server browser isn't set up on this BeeZilla yet, so it can't be opened."
            : "Press Record. BeeZilla's browser opens here. Do the job in it, and every step is written down. BeeZilla follows it exactly every time."));
        }
        if (!off && st.info && st.info.secondsPerDay) {
          var mins = Math.floor(st.info.secondsLeft / 60);
          m.appendChild(el("p", "wb-nf-hint", mins > 0 ? "About " + mins + (mins === 1 ? " minute" : " minutes") + " of BeeZilla's browser left today." : "Today's browser time is used up. It comes back on a rolling 24 hours."));
        }
      }
      veil.appendChild(m);
    }
    function paintAll() {
      paintWhere();
      paintVeil();
      var live = st.phase === "live";
      var starting = st.phase === "starting";
      var off = st.phase !== "live" && st.info && st.info.configured === false;
      var out = st.phase !== "live" && st.info && st.info.secondsPerDay && st.info.secondsLeft <= 0;
      var working = !!(st.running || st.replaying);
      var task = st.mode === "task";
      tabTask.setAttribute("aria-selected", task ? "true" : "false");
      tabRec.setAttribute("aria-selected", task ? "false" : "true");
      tabTask.classList.toggle("on", task);
      tabRec.classList.toggle("on", !task);
      tabTask.disabled = tabRec.disabled = working || st.recording;
      taskBox.hidden = !task;
      taskIn.readOnly = working;
      barRow.style.visibility = live ? "visible" : "hidden";
      bBack.disabled = !st.canBack || working;
      bFwd.disabled = !st.canForward || working;
      bReload.disabled = working;
      bGo.disabled = working;
      addr.disabled = working;
      // Run it now: the task in words, or the recording.
      bRun.hidden = working || st.recording || (!task && !st.steps.length);
      bRun.disabled = starting || !!off || !!out || (task && !taskIn.value.trim());
      bRun.querySelector("span").textContent = task ? "Run it now" : "Run the recording";
      bStop.hidden = !working;
      // Record is a switch while a browser is open, and opens one when it is not.
      bRec.hidden = task || working;
      bRec.disabled = starting || !!off || !!out;
      bRec.classList.toggle("wb-nw-on", st.recording);
      bRec.querySelector("span:not(.wb-nw-recdot)").textContent = st.recording ? "Stop recording" : (st.steps.length ? "Record again" : "Record");
      bLook.hidden = live || starting;
      bLook.disabled = !!off || !!out;
      // The list beside the picture.
      stepsHead.textContent = "";
      if (task) {
        stepsHead.appendChild(el("strong", null, st.running === "task" ? (st.foreign ? "BeeZilla is working on another job…" : "BeeZilla is working…") : st.acts.length ? "What BeeZilla did" : "What BeeZilla does shows here"));
        if (st.acts.length) stepsHead.appendChild(el("span", "wb-nf-hint", st.acts.length + (st.acts.length === 1 ? " step" : " steps")));
      } else {
        stepsHead.appendChild(el("strong", null, st.recording ? "Recording…" : st.steps.length ? "What you recorded" : "Nothing recorded yet"));
        var when = lastRecorded();
        if (st.steps.length) stepsHead.appendChild(el("span", "wb-nf-hint", st.steps.length + (st.steps.length === 1 ? " step" : " steps") + (when ? " · " + ago(when) : "")));
      }
      actList.hidden = !task || !st.acts.length;
      paintActs();
      list.hidden = task || !st.steps.length;
      paintSteps();
      paintBlanks(task);
      paintFiles();
      paintSignIns();
      foot.hidden = !live || working;
    }
    function lastRecorded() { var s = parse(c); return s.recordedAt || ""; }
    function paintActs() {
      actList.textContent = "";
      st.acts.forEach(function (a) {
        var li = el("li", "wb-nw-step" + (a.state ? " wb-nw-m-" + (a.state === "failed" ? "failed" : a.state === "ok" ? "ok" : "running") : ""));
        li.appendChild(el("span", "wb-nw-stepno", String(a.i + 1)));
        var words = el("span", "wb-nw-stepsay");
        words.appendChild(el("span", null, a.say));
        if (a.note) words.appendChild(el("span", "wb-nw-stepnote", a.note));
        li.appendChild(words);
        actList.appendChild(li);
      });
      if (st.acts.length) actList.scrollTop = actList.scrollHeight;
    }
    function paintSteps() {
      list.textContent = "";
      var working = !!(st.running || st.replaying);
      st.steps.forEach(function (step, i) {
        var li = el("li", "wb-nw-step" + (st.marks[i] ? " wb-nw-m-" + st.marks[i] : ""));
        li.appendChild(el("span", "wb-nw-stepno", String(i + 1)));
        var words = el("span", "wb-nw-stepsay");
        words.appendChild(el("span", null, step.say));
        if (step.t === "type" && !step.secret && step.v) words.appendChild(el("span", "wb-nw-chip", "“" + N.squash(step.v, 40) + "”"));
        if (step.t === "select" && step.v) words.appendChild(el("span", "wb-nw-chip", N.squash(step.v, 40)));
        // A typed step can be filled in each time (the song idea of the day) or stay as recorded.
        if (step.t === "type" && !step.secret) {
          var fillBtn = button("wb-nw-fill" + (step.blank ? " on" : ""), step.blank ? "Filled in each time" : "Same each time", null, function () { toggleBlank(i); });
          fillBtn.title = step.blank ? "BeeZilla types the words of the moment here (" + step.blank + "). Press to always type what you recorded." : "BeeZilla types exactly what you recorded. Press to have it filled in each time instead.";
          fillBtn.disabled = working;
          fillBtn.setAttribute("aria-pressed", step.blank ? "true" : "false");
          words.appendChild(fillBtn);
        }
        if (st.notes[i]) words.appendChild(el("span", "wb-nw-stepnote", st.notes[i]));
        li.appendChild(words);
        var rm = button("wb-nw-steprm", "", "trash", function () { removeStep(i); });
        rm.setAttribute("aria-label", "Remove step " + (i + 1));
        rm.title = "Remove this step";
        rm.disabled = working;
        li.appendChild(rm);
        list.appendChild(li);
      });
    }
    function paintBlanks(task) {
      var names = [];
      st.steps.forEach(function (x) { if (x.t === "type" && x.blank && names.indexOf(x.blank) < 0) names.push(x.blank); });
      blanksBox.hidden = task || !names.length;
      if (blanksBox.hidden) return;
      // Kept while typing: only redrawn when the blanks themselves change.
      var key = names.join("\u0001");
      if (blanksBox.getAttribute("data-key") === key) return;
      blanksBox.setAttribute("data-key", key);
      blanksBox.textContent = "";
      blanksBox.appendChild(el("strong", null, "Words for this run"));
      names.forEach(function (name) {
        var row = el("label", "wb-nw-blank");
        row.appendChild(el("span", null, name));
        var inp = el("input", "wb-nf-input");
        inp.type = "text";
        inp.maxLength = 4000;
        var was = "";
        st.steps.forEach(function (x) { if (x.blank === name && x.v && !was) was = x.v; });
        inp.placeholder = was ? "As recorded: " + N.squash(was, 50) : "As recorded";
        inp.value = st.fill[name] || "";
        inp.addEventListener("input", function () { st.fill[name] = inp.value; });
        row.appendChild(inp);
        blanksBox.appendChild(row);
      });
      blanksBox.appendChild(el("p", "wb-nf-hint", "Left empty, a box gets what you recorded. BeeZilla fills these in itself when it runs the recording."));
    }
    function toggleBlank(i) {
      var step = st.steps[i];
      if (!step || step.t !== "type" || step.secret) return;
      if (step.blank) delete step.blank;
      else step.blank = N.squash((step.on && (step.on.name || step.on.placeholder)) || "The words", 40);
      if (st.phase === "live") post(base() + "/steps", { steps: st.steps });
      paintSteps();
      saveSteps();
    }
    function paintFiles() {
      filesBox.textContent = "";
      var files = st.files.length ? st.files : (lastRun && lastRun.files) || [];
      filesBox.hidden = !files.length;
      if (!files.length) return;
      filesBox.appendChild(el("strong", null, st.files.length ? "Downloaded, saved to your Library" : "Downloaded last time"));
      var ul = el("ul");
      files.slice(-8).forEach(function (f) {
        if (!/^\/api\/buzzy\/assets\/\d+$/.test(String(f.url || ""))) return;
        var li = el("li");
        var a = el("a", null, N.squash(f.name, 60));
        a.href = f.url;
        a.target = "_blank";
        a.rel = "noopener";
        li.appendChild(a);
        if (f.bytes) li.appendChild(el("span", "wb-nf-hint", " " + sizeText(f.bytes)));
        if (/^audio\//.test(String(f.type || ""))) {
          var au = el("audio");
          au.controls = true;
          au.preload = "none";
          au.src = f.url;
          li.appendChild(au);
        }
        ul.appendChild(li);
      });
      filesBox.appendChild(ul);
    }
    function paintSignIns() {
      signBox.textContent = "";
      var on = st.signIns || (st.info && st.info.signIns);
      signBox.appendChild(el("span", "wb-nf-hint", on
        ? "BeeZilla's browser remembers the sites you signed in to here, so it can use them for you. Passwords are never written down."
        : "Does a site need you signed in? Open the browser (Just look), sign in once in the picture, and BeeZilla's browser remembers it."));
      if (on) {
        var f = button("wb-btn wb-nw-forget", "Forget sign-ins", null, function () { forget(); });
        f.title = "Sign BeeZilla's browser out of every site";
        signBox.appendChild(f);
      }
    }
    function removeStep(i) {
      if (st.phase === "live") { post(base() + "/steps", { delete: i }); }
      st.steps.splice(i, 1);
      st.marks = {}; st.notes = {};
      paintAll();
      saveSteps();
    }

    // ---- talking to the server ----
    function base() { return "/api/buzzy/nodes/browser/" + st.id; }
    function nav(what, payload) {
      if (st.phase !== "live") return;
      post(base() + "/" + what, payload).then(function (j) {
        if (j && j.ok === false && j.error) say(j.error);
      });
    }
    function say(t) { runBox.textContent = t; runBox.hidden = !t; }
    function forget() {
      post("/api/buzzy/nodes/browser/forget", {}).then(function (j) {
        if (j && j.ok) { st.signIns = false; if (st.info) st.info.signIns = false; say("Done: BeeZilla's browser is signed out of every site. A browser that is open now forgets them when it closes."); }
        else say((j && j.error) || "That didn't work. Try again in a moment.");
        paintSignIns();
      });
    }

    function startBrowser(o) {
      if (st.phase === "starting") return;
      st.phase = "starting";
      st.msg = "";
      st.recording = false;
      st.marks = {}; st.notes = {};
      again.hidden = true;
      say("");
      paintAll();
      var steps = o.fresh ? [] : st.steps;
      post("/api/buzzy/nodes/browser", { startUrl: o.startUrl || "", steps: steps, join: !!o.join }).then(function (j) {
        if (!ctx.alive(c) || current !== win) { if (j && j.id && !j.joined) fetch("/api/buzzy/nodes/browser/" + j.id, { method: "DELETE", credentials: "same-origin", keepalive: true }); return; }
        if (!j || j.ok !== true) {
          st.phase = "error";
          st.msg = (j && j.error) || "The browser could not be opened.";
          paintAll();
          return;
        }
        st.id = j.id;
        st.joined = !!j.joined;
        if (o.fresh) st.steps = [];
        connect(o);
      }).catch(function () {
        st.phase = "error";
        st.msg = "BeeZilla couldn't be reached. Check the connection and try again.";
        paintAll();
      });
    }

    function connect(o) {
      var es = new EventSource(base() + "/stream");
      st.es = es;
      var first = true;
      function on(name, fn) { es.addEventListener(name, function (e) { var d; try { d = JSON.parse(e.data); } catch (_) { return; } fn(d); }); }
      on("hello", function (d) {
        st.phase = "live";
        // A browser BeeZilla is already working in (joined to watch it) keeps this node's own steps.
        if (!st.joined) st.steps = d.steps || [];
        st.recording = !!d.recording;
        st.replaying = !!d.replaying;
        st.running = d.run ? d.run.kind : null;
        st.foreign = !!(d.run && d.run.nodeId && d.run.nodeId !== c.id);
        if (d.run && d.run.acts) st.acts = d.run.acts.slice();
        st.files = d.files || st.files;
        st.signIns = !!d.signIns;
        st.where = d.where || st.where;
        st.url = d.url || ""; st.title = d.title || "";
        st.canBack = !!d.canBack; st.canForward = !!d.canForward;
        addr.value = /^https?:/i.test(st.url) ? st.url : "";
        paintAll();
        fitStage();
        canvas.focus({ preventScroll: true });
        if (first) {
          first = false;
          if (o.run) runHere();
          else if (o.play && st.steps.length) onPlay();
          else if (o.record) {
            if (o.playFirst && st.steps.length) { st.pendingAfterReplay = true; onPlay(); }
            else post(base() + "/record", { on: true, keep: !!o.keep });
          }
        }
      });
      on("frame", function (d) { draw(d.b64); });
      on("nav", function (d) {
        st.url = d.url; st.title = d.title; st.canBack = d.canBack; st.canForward = d.canForward;
        if (document.activeElement !== addr) addr.value = /^https?:/i.test(d.url) ? d.url : "";
        bBack.disabled = !st.canBack || !!st.running; bFwd.disabled = !st.canForward || !!st.running;
      });
      on("step", function (d) { st.steps.push(d.step); paintAll(); list.scrollTop = list.scrollHeight; saveSteps(); });
      on("steps", function (d) { if (st.joined && st.running) return; st.steps = d.steps || []; st.marks = {}; st.notes = {}; paintAll(); saveSteps(); });
      on("rec", function (d) { st.recording = !!d.on; paintAll(); if (!d.on) saveSteps.now(); });
      on("where", function (d) { st.where = d.where; paintWhere(); writeBack(); });
      on("notice", function (d) { say(d.text); });
      on("pick", function (d) { showPick(d); });
      on("replay", function (d) {
        st.replaying = true;
        st.marks[d.i] = d.state;
        if (d.note) st.notes[d.i] = d.note;
        paintAll();
        var li = list.children[d.i];
        if (li && li.scrollIntoView) li.scrollIntoView({ block: "nearest" });
      });
      on("replay-done", function (d) {
        st.replaying = false;
        // (How it ended is written by the "run" handler below, for a recording and a task alike.)
        if (st.pendingAfterReplay) { st.pendingAfterReplay = false; if (d.ok) post(base() + "/record", { on: true, keep: true }); }
        paintAll();
      });
      on("run", function (d) {
        // Another node's job in the same browser (BeeZilla working on another globe): watched, not
        // taken as this card's own.
        var mine = function (nodeId) { return !nodeId || nodeId === c.id; };
        if (d.state === "start") {
          st.foreign = !mine(d.nodeId);
          st.running = d.kind;
          st.result = null;
          if (d.kind === "task") st.acts = [];
          if (d.kind === "recording") { st.marks = {}; st.notes = {}; }
          say("");
          paintAll();
          return;
        }
        var r = d.result || {};
        st.running = null;
        st.replaying = false;
        st.result = r;
        if (!mine(r.nodeId)) {
          st.foreign = false;
          say("BeeZilla finished another job in this browser" + (r.note ? ": " + N.squash(r.note, 160) : "."));
          paintAll();
          return;
        }
        st.foreign = false;
        // Where it ended, without a secret word's value or a key the page showed (review item 4).
        lastRun = { at: new Date().toISOString(), ok: !!r.ok, steps: r.ran || 0, failedAt: r.failedAt, note: r.note, finalUrl: scrubUrl(r.finalUrl), title: r.title, text: scrubLine(r.text), by: r.by, kind: r.kind, files: (r.files || []).slice(0, 8), needs: r.needs };
        showResult(r);
        paintAll();
        if (ctx.alive(c)) { if (!snapped) { ctx.snapshot(); snapped = true; } writeBack(); }
      });
      on("act", function (d) {
        var at = -1;
        for (var k = 0; k < st.acts.length; k++) if (st.acts[k].i === d.i) at = k;
        var row = { i: d.i, say: d.say, state: d.state, note: d.note };
        if (at >= 0) st.acts[at] = row; else st.acts.push(row);
        if (st.mode === "task") { actList.hidden = false; paintActs(); }
      });
      on("file", function (d) {
        if (d.state === "saved" && d.url) {
          st.files = st.files.filter(function (f) { return f.url !== d.url; }).concat([{ name: d.name, url: d.url, type: d.fileType, bytes: d.bytes }]);
          paintFiles();
        } else if (d.state === "failed") say("A download didn't make it: " + (d.note || "BeeZilla couldn't read it."));
        else if (d.state === "started") say("Downloading “" + N.squash(d.name, 60) + "”…");
      });
      on("ended", function (d) {
        st.phase = "ended";
        st.recording = false; st.replaying = false; st.running = null;
        st.msg = ENDED[d.reason] || ENDED.closed;
        if (es) es.close();
        st.es = null;
        paintAll();
        if (st.mode === "recording") saveSteps.now();
      });
      es.onerror = function () {
        if (st.phase !== "live") return;
        if (es.readyState === 2) {
          // The server says there is no such browser any more (it closed, or restarted).
          st.phase = "ended"; st.recording = false; st.replaying = false; st.running = null;
          st.msg = ENDED.closed;
          st.es = null;
          paintAll();
          return;
        }
        say("The connection to the browser dropped. Trying again…");
      };
      es.onopen = function () { if (st.phase === "live") say(""); };
    }

    // How a job ended, in words, with what to do next.
    function showResult(r) {
      runBox.textContent = "";
      runBox.hidden = false;
      var head = r.ok ? "It worked." : r.needs ? "It needs you." : r.stopped ? "Stopped." : "It stopped.";
      runBox.appendChild(el("strong", r.ok ? "wb-nw-runok" : "wb-nw-runbad", head));
      if (r.note) runBox.appendChild(el("span", null, " " + r.note));
      if (r.text) runBox.appendChild(el("div", "wb-nw-runtext", "The page then said: " + N.squash(r.text, 240)));
      // A job done from words that worked: keep it as the recording, followed exactly next time.
      if (r.kind === "task" && r.ok && r.steps && r.steps.length) {
        var keep = button("wb-selbtn wb-nw-keep", "Keep this as the recording", null, function () {
          if (!ctx.alive(c)) return;
          if (!snapped) { ctx.snapshot(); snapped = true; }
          st.steps = r.steps.slice();
          st.mode = "recording";
          var s = parse(c);
          s.recordedAt = new Date().toISOString();
          c.node = JSON.stringify(s);
          writeBack();
          if (st.phase === "live") post(base() + "/steps", { steps: st.steps });
          say("Kept: from now on BeeZilla follows these " + st.steps.length + " steps exactly. Typed words marked “Filled in each time” change with each run. Switch back to Do this any time.");
          paintAll();
        });
        keep.title = "BeeZilla follows exactly these steps next time (faster, and the same every time)";
        runBox.appendChild(keep);
      }
      if (r.needs && st.phase === "live") runBox.appendChild(el("div", "wb-nw-runtext", "Do it yourself in the picture (for example, sign in), then press Run it now again."));
    }

    // ---- running, recording and playing ----
    function onRun() {
      if (st.mode === "recording") { onPlay(); return; }
      if (!taskIn.value.trim()) { taskIn.focus(); return; }
      saveTask.flush();
      if (st.phase !== "live") { startBrowser({ startUrl: "", record: false, run: true }); return; }
      runHere();
    }
    function runHere() {
      if (st.mode === "recording") { onPlay(); return; }
      st.acts = [];
      st.result = null;
      say("");
      post(base() + "/run", { node: specNow(), nodeId: c.id }).then(function (j) {
        if (j && j.ok === false) { say(j.error || "It couldn't start."); paintAll(); }
      });
    }
    function onStop() {
      if (st.phase !== "live") return;
      post(base() + "/stop", {}).then(function () { say("Stopping… The browser is yours when it does."); });
    }
    function onRecord() {
      if (st.phase === "live") {
        if (st.recording) { post(base() + "/record", { on: false }); return; }
        if (st.steps.length) { askAgain(); return; }
        post(base() + "/record", { on: true, keep: false });
        return;
      }
      if (st.steps.length) { askAgain(); return; }
      startBrowser({ startUrl: "", record: true, keep: false });
    }
    function askAgain() {
      again.hidden = false;
      again.textContent = "";
      again.appendChild(el("p", null, "You already recorded " + st.steps.length + (st.steps.length === 1 ? " step. What now?" : " steps. What now?")));
      var row = el("div", "wb-nw-againrow");
      row.appendChild(button("wb-selbtn wb-primary", "Start over", null, function () {
        again.hidden = true;
        if (st.phase === "live") post(base() + "/record", { on: true, keep: false });
        else startBrowser({ startUrl: "", record: true, keep: false, fresh: true });
      }));
      row.appendChild(button("wb-selbtn", "Play it, then add more", null, function () {
        again.hidden = true;
        if (st.phase === "live") { st.pendingAfterReplay = true; onPlay(); }
        else startBrowser({ startUrl: "", record: true, keep: true, playFirst: true });
      }));
      row.appendChild(button("wb-selbtn", "Cancel", null, function () { again.hidden = true; }));
      again.appendChild(row);
    }
    function onPlay() {
      if (!st.steps.length) return;
      // Not open yet: open a browser, and play as soon as it is there.
      if (st.phase !== "live") { startBrowser({ startUrl: "", record: false, play: true }); return; }
      st.marks = {}; st.notes = {};
      say("");
      st.replaying = true;
      paintAll();
      var fill = {};
      Object.keys(st.fill).forEach(function (k) { if (String(st.fill[k] || "").trim()) fill[k] = st.fill[k]; });
      post(base() + "/replay", { steps: st.steps, nodeId: c.id, fill: fill }).then(function (j) { if (j && j.ok === false) { st.replaying = false; paintAll(); say(j.error || "It couldn't play."); } });
    }

    // ---- the picture, and what is done to it ----
    var drawing = false, pending = null;
    var img = new Image();
    img.onload = function () {
      g.drawImage(img, 0, 0, VIEW_W, VIEW_H);
      drawing = false;
      if (pending) { var p = pending; pending = null; draw(p); }
    };
    img.onerror = function () { drawing = false; };
    function draw(b64) {
      if (drawing) { pending = b64; return; }
      drawing = true;
      img.src = "data:image/jpeg;base64," + b64;
    }
    // Keep the page's shape: the biggest 16:10 picture that fits. A wide window puts the
    // steps beside the picture; a narrow one puts them under it.
    function fitStage() {
      root.classList.toggle("wb-nw-wide", root.offsetWidth >= 800);
      var w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      var sc = Math.min(w / VIEW_W, h / VIEW_H);
      canvas.style.width = Math.floor(VIEW_W * sc) + "px";
      canvas.style.height = Math.floor(VIEW_H * sc) + "px";
    }
    var ro = window.ResizeObserver ? new ResizeObserver(fitStage) : null;
    if (ro) ro.observe(stage);
    root.onresized = fitStage;

    // Input goes to the server in order, a few at a time. While BeeZilla works, the page is its.
    var queue = [], sending = false, moveAt = 0;
    function pushEv(ev) {
      if (st.phase !== "live" || st.replaying || st.running) return;
      queue.push(ev);
      flush();
    }
    function flush() {
      if (sending || !queue.length) return;
      sending = true;
      var batch = queue.splice(0, 40);
      post(base() + "/input", { events: batch }).then(function (j) {
        if (j && j.ok === false && j.code === "slow_down") {
          // The browser is behind: the same events go again a moment later, in the same order.
          queue.unshift.apply(queue, batch);
          setTimeout(function () { sending = false; flush(); }, 250);
          return;
        }
        sending = false;
        if (j && j.ok === false && j.code === "gone") return;
        flush();
      }).catch(function () { sending = false; });
    }
    function point(e) {
      var r = canvas.getBoundingClientRect();
      return { x: clamp(Math.round((e.clientX - r.left) * VIEW_W / r.width), 0, VIEW_W - 1), y: clamp(Math.round((e.clientY - r.top) * VIEW_H / r.height), 0, VIEW_H - 1) };
    }
    // AltGr (how a German or French keyboard types @ or €) is reported as Ctrl+Alt: it is not.
    function mods(e) {
      var altGr = !!(e.getModifierState && e.getModifierState("AltGraph"));
      return (e.altKey && !altGr ? 1 : 0) | (e.ctrlKey && !altGr ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
    }
    var BUTTONS = ["left", "middle", "right"];
    canvas.addEventListener("pointerdown", function (e) {
      if (st.phase !== "live") return;
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(e.pointerId);
      hidePick();
      var p = point(e);
      pushEv({ type: "mouse", action: "down", x: p.x, y: p.y, button: BUTTONS[e.button] || "left", clickCount: Math.max(1, e.detail || 1), mods: mods(e) });
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", function (e) {
      if (st.phase !== "live") return;
      var now = Date.now();
      if (now - moveAt < 45) return;
      moveAt = now;
      var p = point(e);
      pushEv({ type: "mouse", action: "move", x: p.x, y: p.y, buttons: e.buttons ? 1 : 0, mods: mods(e) });
    });
    canvas.addEventListener("pointerup", function (e) {
      if (st.phase !== "live") return;
      var p = point(e);
      pushEv({ type: "mouse", action: "up", x: p.x, y: p.y, button: BUTTONS[e.button] || "left", clickCount: Math.max(1, e.detail || 1), mods: mods(e) });
    });
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    canvas.addEventListener("wheel", function (e) {
      if (st.phase !== "live") return;
      e.preventDefault();
      var p = point(e);
      var k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      pushEv({ type: "wheel", x: p.x, y: p.y, dx: e.deltaX * k, dy: e.deltaY * k, mods: mods(e) });
    }, { passive: false });
    var EDIT = { a: "selectAll", z: "undo", y: "redo" };
    canvas.addEventListener("keydown", function (e) {
      if (st.phase !== "live" || e.isComposing) return;
      var cmdKey = e.metaKey || e.ctrlKey;
      // Escape belongs to the page while you are in it; so does everything else, except the
      // paste shortcut, which has to reach the browser's own paste event (below).
      if (cmdKey && (e.key === "v" || e.key === "V")) return;
      e.preventDefault();
      // Copy and cut would use the server browser's clipboard, shared by everyone on it: not passed on.
      if (cmdKey && (e.key === "c" || e.key === "C" || e.key === "x" || e.key === "X")) return;
      var commands;
      if (cmdKey) {
        var k = String(e.key).toLowerCase();
        if (EDIT[k]) commands = [k === "z" && e.shiftKey ? "redo" : EDIT[k]];
      }
      pushEv({ type: "key", action: "down", key: e.key, code: e.code, mods: mods(e), commands: commands });
    });
    canvas.addEventListener("keyup", function (e) {
      if (st.phase !== "live" || e.isComposing) return;
      var cmdKey = e.metaKey || e.ctrlKey;
      if (cmdKey && (e.key === "v" || e.key === "V")) return;
      e.preventDefault();
      pushEv({ type: "key", action: "up", key: e.key, code: e.code, mods: mods(e) });
    });
    root.addEventListener("paste", function (e) {
      if (st.phase !== "live" || document.activeElement !== canvas) return;
      var t = e.clipboardData && e.clipboardData.getData("text/plain");
      if (t) { e.preventDefault(); pushEv({ type: "text", text: t.slice(0, 4000) }); }
    });
    canvas.addEventListener("compositionend", function (e) { if (e.data) pushEv({ type: "text", text: e.data }); });

    // A list on the page: its choices, in a small menu (the page's own can't be shown).
    function hidePick() { pickMenu.hidden = true; pickMenu.textContent = ""; }
    function showPick(d) {
      pickMenu.textContent = "";
      var head = el("div", "wb-nw-pickhead");
      head.appendChild(el("strong", null, d.name ? "Choose: " + N.squash(d.name, 40) : "Choose one"));
      var x = button("wb-nf-rm", "", "close", function () { hidePick(); canvas.focus({ preventScroll: true }); });
      x.setAttribute("aria-label", "Close this list");
      head.appendChild(x);
      pickMenu.appendChild(head);
      d.options.forEach(function (o) {
        var b = button("wb-nw-pickopt" + (o.selected ? " wb-nw-picked" : ""), o.text || "(blank)", null, function () {
          hidePick();
          pushEv({ type: "choose", x: d.x, y: d.y, index: o.i });
          canvas.focus({ preventScroll: true });
        });
        pickMenu.appendChild(b);
      });
      pickMenu.hidden = false;
      var first = pickMenu.querySelector(".wb-nw-pickopt");
      if (first) first.focus({ preventScroll: true });
    }
    pickMenu.addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Escape") { hidePick(); canvas.focus({ preventScroll: true }); } });

    // ---- leaving ----
    var alive = setInterval(function () { if (!ctx.alive(c)) win.close(); }, 2000);
    function release() {
      // A browser BeeZilla is working in keeps going when the window closes: the job finishes, and
      // the browser closes itself when it is done (and idle). One the person opened here closes now.
      if (st.id && st.phase !== "ended" && !st.running && !st.replaying) {
        // Closes the browser on the server: it costs money while it is open.
        try { fetch("/api/buzzy/nodes/browser/" + st.id, { method: "DELETE", credentials: "same-origin", keepalive: true }); } catch (_) { /* it closes itself when idle */ }
      }
      if (st.es) { st.es.close(); st.es = null; }
    }
    function onHide() { release(); }
    window.addEventListener("pagehide", onHide);
    win.close = function () {
      clearInterval(alive);
      window.removeEventListener("pagehide", onHide);
      if (ro) ro.disconnect();
      saveSteps.cancel();
      saveTask.flush();
      saveName.flush();
      // What was recorded is on the card already (it saves as it goes); this makes sure.
      if (ctx.alive(c) && (st.steps.length || snapped)) {
        writeBack();
        if (nameIn.value.trim()) c.title = nameIn.value.trim();
        ctx.changed(c);
      }
      release();
      root.dispose();
      root.remove();
      if (current === win) current = null;
    };
    win.closeBtn.addEventListener("click", function () { win.close(); focusCard(ctx, c); });
    root.addEventListener("keydown", function (e) {
      e.stopPropagation();
      // Esc inside the page goes to the page; anywhere else in the window it closes it.
      if (e.key === "Escape" && document.activeElement !== canvas) { win.close(); focusCard(ctx, c); }
    });
    win.card = c;
    current = win;
    paintAll();
    fitStage();
    // The saved job shows at once; the browser itself opens on Run, Record or Just look (it costs
    // money) — unless BeeZilla is already working in it, when the window joins it to watch.
    (st.mode === "task" ? (taskIn.value ? bRun : taskIn) : bRec).focus({ preventScroll: true });
    browserInfo().then(function (info) {
      if (!info || current !== win) return;
      st.info = info;
      st.signIns = !!info.signIns;
      paintAll();
      if (info.open && info.open.busy && st.phase === "idle") startBrowser({ join: true });
    });
  }

  // What the window needs to know before it opens a browser: is one set up here?
  function browserInfo() {
    return fetch("/api/buzzy/nodes/browser", { credentials: "same-origin" }).then(function (r) { return r.json(); }).catch(function () { return null; });
  }

  function open(c, ctx) {
    // Its window is already open: bring the person back to it (closing it would end a
    // browser that is running and cost them what they were in the middle of).
    if (current && current.card && current.card.id === c.id && current.root.isConnected) {
      var first = current.root.querySelector("input, button, canvas");
      if (first) first.focus({ preventScroll: true });
      return;
    }
    closeAll();
    if (c.kind === "api") openApi(c, ctx);
    else if (c.kind === "browser") openBrowser(c, ctx);
  }

  // Esc closes a node's window wherever focus is, as it does for every pop-up (owner, 2026-11-21:
  // "Escape key or an X closes anything that opens up"). Inside the window its own handler has
  // already dealt with it; inside the server browser's picture Esc belongs to the page.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || e.defaultPrevented || !current) return;
    var a = document.activeElement;
    if (a && current.root.contains(a)) return;
    current.close();
  });

  window.BeeZillaBoardNodes = {
    open: open,
    closeAll: closeAll,
    isOpen: function () { return !!current; },
    info: browserInfo,
    // whiteboard.js uses these when it writes what a played job did into the words
    // BeeZilla is told; both are no-ops on text with nothing secret in it.
    scrubUrl: scrubUrl,
    scrubLine: scrubLine
  };
})();
