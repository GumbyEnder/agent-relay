/* page-share.js — the window that asks before a page is shared.
 *
 *   BeeZillaPageShare.open("copy" | "qr")   opens it (the header's Copy page link and QR code)
 *   BeeZillaPageShare.close()               closes it; does nothing when closed
 *   BeeZillaPageShare.isOpen()
 *
 * Owner, 2026-11-21: "When you use a QR code or copy a page link, you have to be given a
 * prompt to say, first you have to know that you're going to open this up, everything on this
 * page… becomes available. Make sure that's clear. Give people a little pop-up to say yes and
 * confirm before they do that. And it should say, to anyone with a link or searching it via the
 * internet. A sub option that's small that says block searches by default. Should be a tickable
 * option."
 *
 * Nothing is shared until "Yes, share this page". What the window lists comes from the server
 * (GET /api/buzzy/page-shares/preview): the cards and the conversation a link would show, and
 * what it leaves out. "Block searches" is ticked until the person unticks it. The server makes
 * the link (POST, confirm: true) and the public page carries the noindex headers.
 *
 * Plain IIFE, no dependencies. Text from the server only goes in through textContent; the QR
 * code is the one piece of markup, parsed from our own encoder's output (qr.js, loaded first).
 * Design rules (owner): nothing closes on a click outside it, only Esc or the X; the box can be
 * resized by a side or a corner.
 */
(function () {
  "use strict";
  if (window.BeeZillaPageShare) return;

  var FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])";
  var DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
  var MIN_W = 300;
  var MIN_H = 220;
  var session = null;

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function boardId() {
    if (typeof window.bzTabSession === "function") return window.bzTabSession() || "talk";   // Talk: this tab's
    try { return localStorage.getItem("bz_session_id") || "talk"; } catch (_) { return "talk"; }
  }
  function absolute(path) {
    return /^https?:\/\//i.test(path) ? path : location.origin + (path.charAt(0) === "/" ? "" : "/") + path;
  }
  function dateOf(v) {
    var d = v ? new Date(v) : null;
    if (!d || isNaN(d.getTime())) return "";
    try { return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }); } catch (_) { return ""; }
  }

  // One request. Always resolves to { ok, status, data }; a network failure has status 0.
  function api(method, path, body) {
    var init = { method: method, credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(path, init)
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          if (text) { try { data = JSON.parse(text); } catch (_) { data = null; } }
          return { ok: res.ok, status: res.status, data: data };
        });
      })
      .catch(function () { return { ok: false, status: 0, data: null }; });
  }
  function failure(res) {
    if (res.status === 0) return "BeeZilla could not be reached. Check your connection and try again.";
    if (res.status === 401) return "Sign in first, then share this page.";
    var d = res.data || {};
    return typeof d.error === "string" && d.error ? d.error : "Something went wrong on BeeZilla's side. Try again in a moment.";
  }

  function copyText(text) {
    return new Promise(function (resolve) {
      function fallback() {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var done = false;
        try { done = document.execCommand("copy"); } catch (_) { done = false; }
        document.body.removeChild(ta);
        resolve(done);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { resolve(true); }, fallback);
      else fallback();
    });
  }

  // The QR code of a link, as inline svg. Only our own encoder's markup is parsed here.
  function qrNode(text) {
    try {
      var QR = window.BeeZillaQR;
      if (!QR || typeof QR.svg !== "function") throw new Error("qr.js is not loaded");
      var modules = QR.encode(text).size + 8;
      var px = modules * Math.max(2, Math.floor(200 / modules));
      var doc = new DOMParser().parseFromString(QR.svg(text, { label: "QR code for the shared page", size: px }), "image/svg+xml");
      if (!doc.documentElement || doc.getElementsByTagName("parsererror").length) throw new Error("bad svg");
      return document.importNode(doc.documentElement, true);
    } catch (_) {
      return make("p", "pshare-small", "The QR code could not be drawn. Copy the link instead.");
    }
  }

  // ── The window ───────────────────────────────────────────────────────
  function build(kind) {
    var opener = document.activeElement;
    var back = make("div", "pshare-back bz-talk-own");
    var box = make("div", "pshare-box");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "pshareTitle");
    box.tabIndex = -1;
    var head = make("div", "pshare-head");
    var title = make("h2", "pshare-title", "Share this page?");
    title.id = "pshareTitle";
    var x = make("button", "pshare-x", "✕");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    head.appendChild(title);
    head.appendChild(x);
    var body = make("div", "pshare-body");
    var status = make("p", "pshare-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    box.appendChild(head);
    box.appendChild(body);
    box.appendChild(status);
    back.appendChild(box);

    // Nothing closes on a click outside it: only Esc or the X (owner's design rule).
    back.addEventListener("mousedown", function (e) { if (e.target === back) { e.preventDefault(); box.focus(); } });

    // Resize by a side or a corner.
    DIRS.forEach(function (d) {
      var g = make("div", "pshare-grip pshare-grip-" + d);
      g.setAttribute("aria-hidden", "true");
      g.addEventListener("pointerdown", function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        var start = box.getBoundingClientRect();
        var sx = e.clientX;
        var sy = e.clientY;
        try { g.setPointerCapture(e.pointerId); } catch (_) { /* best effort */ }
        function move(ev) {
          var dx = ev.clientX - sx;
          var dy = ev.clientY - sy;
          var l = start.left;
          var t = start.top;
          var w = start.width;
          var h = start.height;
          var vw = window.innerWidth;
          var vh = window.innerHeight;
          if (d.indexOf("e") >= 0) w = Math.min(vw - l - 4, Math.max(MIN_W, start.width + dx));
          if (d.indexOf("s") >= 0) h = Math.min(vh - t - 4, Math.max(MIN_H, start.height + dy));
          if (d.indexOf("w") >= 0) {
            var nw = Math.max(MIN_W, start.width - dx);
            l = Math.max(4, start.left + start.width - nw);
            w = start.left + start.width - l;
          }
          if (d.indexOf("n") >= 0) {
            var nh = Math.max(MIN_H, start.height - dy);
            t = Math.max(4, start.top + start.height - nh);
            h = start.top + start.height - t;
          }
          box.style.left = l + "px";
          box.style.top = t + "px";
          box.style.width = w + "px";
          box.style.height = h + "px";
        }
        function up() {
          g.removeEventListener("pointermove", move);
          g.removeEventListener("pointerup", up);
          g.removeEventListener("pointercancel", up);
        }
        g.addEventListener("pointermove", move);
        g.addEventListener("pointerup", up);
        g.addEventListener("pointercancel", up);
      });
      box.appendChild(g);
    });

    document.body.appendChild(back);
    // Where it opens: near the top, centred; resizing grows it from the side you hold.
    var w0 = Math.min(480, window.innerWidth - 16);
    box.style.width = w0 + "px";
    box.style.left = Math.max(8, Math.round((window.innerWidth - w0) / 2)) + "px";
    box.style.top = Math.max(8, Math.min(96, Math.round(window.innerHeight * 0.1))) + "px";

    function clamp() {
      var r = box.getBoundingClientRect();
      var maxL = Math.max(4, window.innerWidth - Math.min(r.width, window.innerWidth - 8) - 4);
      var maxT = Math.max(4, window.innerHeight - 60);
      if (r.left > maxL) box.style.left = maxL + "px";
      if (r.top > maxT) box.style.top = maxT + "px";
      if (r.width > window.innerWidth - 8) box.style.width = window.innerWidth - 8 + "px";
    }
    window.addEventListener("resize", clamp);

    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!s.working) s.close(); return; }
      if (e.key !== "Tab") return;
      var items = Array.prototype.filter.call(box.querySelectorAll(FOCUSABLE), function (n) { return n.getClientRects().length > 0; });
      if (!items.length) { e.preventDefault(); box.focus(); return; }
      var first = items[0];
      var last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    box.addEventListener("keydown", onKey);
    x.addEventListener("click", function () { if (!s.working) s.close(); });
    // A different page under the header means this question is about something else.
    function onPage() { s.close(); }
    window.addEventListener("bz:page", onPage);
    window.addEventListener("popstate", onPage);

    var s = {
      kind: kind,
      box: box,
      body: body,
      title: title,
      x: x,
      working: false,
      say: function (t) { status.textContent = t || ""; },
      close: function () {
        if (session !== s) return;
        session = null;
        window.removeEventListener("resize", clamp);
        window.removeEventListener("bz:page", onPage);
        window.removeEventListener("popstate", onPage);
        if (back.parentNode) back.parentNode.removeChild(back);
        if (opener && opener.focus && document.contains(opener)) { try { opener.focus(); } catch (_) { /* best effort */ } }
      },
    };
    return s;
  }

  function button(label, className, onClick) {
    var b = make("button", "pshare-btn" + (className ? " " + className : ""), label);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  function actions(items) {
    var row = make("div", "pshare-actions");
    items.forEach(function (b) { if (b) row.appendChild(b); });
    return row;
  }
  function blockTick(checked, onChange) {
    var label = make("label", "pshare-block");
    var box = make("input", "pshare-tick");
    box.type = "checkbox";
    box.checked = checked !== false;
    var words = make("span", "pshare-block-words");
    words.appendChild(make("span", "pshare-block-name", "Block searches"));
    words.appendChild(make("span", "pshare-block-desc", "Asks Google and other search engines not to list this page. Anyone with the link can still open it."));
    label.appendChild(box);
    label.appendChild(words);
    if (onChange) box.addEventListener("change", onChange);
    return { label: label, input: box };
  }
  function listOf(lines) {
    var ul = make("ul", "pshare-list");
    (lines || []).forEach(function (l) {
      var li = make("li");
      li.appendChild(make("strong", "", l.label));
      li.appendChild(make("span", "", " — " + l.detail));
      ul.appendChild(li);
    });
    return ul;
  }
  function leftOut(items) {
    var list = (items || []).slice();
    var text = "";
    if (list.length === 1) text = list[0];
    else if (list.length > 1) text = list.slice(0, -1).join(", ") + ", and " + list[list.length - 1];
    return make("p", "pshare-left", "Left out: " + text + ".");
  }

  // ── The states ───────────────────────────────────────────────────────
  function showAsk(s, pre) {
    idle(s);
    clear(s.body);
    s.title.textContent = "Share this page?";
    s.box.setAttribute("aria-describedby", "pshareLead");
    var lead = make("p", "pshare-lead", "Once you say yes, everything on this page can be read by anyone who has the link, and by anyone who finds it by searching the internet. There is no sign-in and no password.");
    lead.id = "pshareLead";
    s.body.appendChild(lead);
    s.body.appendChild(make("p", "pshare-sub", "A copy of this goes public:"));
    s.body.appendChild(listOf(pre.includes));
    s.body.appendChild(leftOut(pre.notIncluded));
    var tick = blockTick(true);
    s.body.appendChild(tick.label);
    var go = button("Yes, share this page", "pshare-primary", function () { share(s, tick.input.checked); });
    var cancel = button("Cancel", "pshare-quiet", function () { s.close(); });
    s.body.appendChild(actions([cancel, go]));
    s.say("");
    cancel.focus();
  }

  function showBlocked(s, pre) {
    idle(s);
    clear(s.body);
    s.title.textContent = pre.active ? "This page is still shared" : "This page can't be shared right now";
    s.body.appendChild(make("p", "pshare-lead", pre.message || "This page can't be shared right now."));
    var row = [];
    if (pre.active) {
      s.body.appendChild(make("p", "pshare-small", "Anyone with its link can still read the copy made on " + (dateOf(pre.active.sharedAt) || "an earlier day") + "."));
      row.push(button("Stop sharing", "pshare-danger", function () { stop(s, pre.active); }));
    }
    var close = button("Close", pre.active ? "pshare-quiet" : "pshare-primary", function () { s.close(); });
    row.push(close);
    s.body.appendChild(actions(row));
    s.say("");
    close.focus();
  }

  function showShared(s, share, info) {
    idle(s);
    clear(s.body);
    var url = absolute(share.url);
    s.title.textContent = "This page is shared";
    s.body.appendChild(make("p", "pshare-lead", "Anyone with this link can read the copy made on " + (dateOf(share.updatedAt || share.sharedAt) || "today") + ". Changes you make later stay private until you update it."));
    var row = make("div", "pshare-linkrow");
    var field = make("input", "pshare-link");
    field.type = "text";
    field.readOnly = true;
    field.value = url;
    field.setAttribute("aria-label", "The shared link");
    field.addEventListener("focus", function () { field.select(); });
    var copy = button("Copy link", "pshare-primary", function () {
      copyText(url).then(function (done) { s.say(done ? "Link copied. Anyone who has it can read this page." : "Couldn't copy here. Select the link and copy it yourself."); });
    });
    row.appendChild(field);
    row.appendChild(copy);
    s.body.appendChild(row);
    if (info && info.includes && info.includes.length) {
      var put = make("p", "pshare-small", "In the copy: " + info.includes.map(function (l) { return l.label.toLowerCase() + " (" + l.detail + ")"; }).join("; ") + ".");
      s.body.appendChild(put);
    }
    var qrBox = make("div", "pshare-qr");
    qrBox.hidden = true;
    s.body.appendChild(qrBox);
    function showQr() {
      clear(qrBox);
      qrBox.appendChild(qrNode(url));
      qrBox.appendChild(make("p", "pshare-small", "Point a phone's camera at this. Whoever scans it can read the page."));
      qrBox.hidden = false;
      qrBtn.hidden = true;
    }
    var qrBtn = button("Show QR code", "pshare-quiet", showQr);
    var tick = blockTick(share.searchBlocked, function () { s.say("Press Update to apply this."); });
    s.body.appendChild(tick.label);
    var update = button("Update the copy", "pshare-quiet", function () { reshare(s, tick.input.checked); });
    var off = button("Stop sharing", "pshare-danger", function () { stop(s, share); });
    var done = button("Close", "pshare-quiet", function () { s.close(); });
    s.body.appendChild(actions([qrBtn, update, off, done]));
    var line = share.searchBlocked
      ? "Searches are blocked: search engines are asked not to list it."
      : "Search engines may list this page.";
    s.body.appendChild(make("p", "pshare-small pshare-search-line", line));
    if (info && info.copied === true) s.say("Link copied. Anyone who has it can read this page.");
    else if (info && info.copied === false) s.say("Shared. Couldn't copy here, so select the link and copy it yourself.");
    else s.say(info && info.updated ? "Updated. The shared copy now matches this page." : "");
    if (s.kind === "qr") showQr();
    copy.focus();
  }

  function showStopped(s) {
    idle(s);
    clear(s.body);
    s.title.textContent = "No longer shared";
    s.body.appendChild(make("p", "pshare-lead", "The link is off and the copy is deleted. Anyone who opens it now is told it was turned off."));
    var close = button("Close", "pshare-primary", function () { s.close(); });
    s.body.appendChild(actions([close]));
    s.say("");
    close.focus();
  }

  function showError(s, message, retry) {
    idle(s);
    clear(s.body);
    s.title.textContent = "That didn't work";
    s.body.appendChild(make("p", "pshare-lead", message));
    var row = [];
    if (retry) row.push(button("Try again", "pshare-primary", retry));
    var close = button("Close", retry ? "pshare-quiet" : "pshare-primary", function () { s.close(); });
    row.push(close);
    s.body.appendChild(actions(row));
    s.say("");
    (row[0] || close).focus();
  }

  // While a request is out, nothing can be pressed twice and the window can't be closed
  // from under it (a link made after the window is gone would be a link nobody saw).
  function busy(s, text) {
    s.working = true;
    s.x.disabled = true;
    Array.prototype.forEach.call(s.body.querySelectorAll("button, input"), function (n) { n.disabled = true; });
    s.say(text);
  }
  function idle(s) {
    s.working = false;
    s.x.disabled = false;
  }

  // ── What the buttons do ──────────────────────────────────────────────
  function share(s, searchBlocked) {
    busy(s, "Sharing…");
    // The board that was previewed, never whatever the page shows by now.
    api("POST", "/api/buzzy/page-shares", { board: s.board, searchBlocked: searchBlocked !== false, confirm: true }).then(function (res) {
      if (session !== s) return;
      var d = res.data || {};
      if (!res.ok || !d.ok || !d.share) { showError(s, failure(res), function () { open(s.kind, true); }); return; }
      if (s.kind === "copy") {
        copyText(absolute(d.share.url)).then(function (done) {
          if (session === s) showShared(s, d.share, { fresh: true, copied: done, includes: d.includes });
        });
      } else {
        showShared(s, d.share, { fresh: true, includes: d.includes });
      }
    });
  }
  function reshare(s, searchBlocked) {
    busy(s, "Updating…");
    api("POST", "/api/buzzy/page-shares", { board: s.board, searchBlocked: searchBlocked !== false, confirm: true }).then(function (res) {
      if (session !== s) return;
      var d = res.data || {};
      if (!res.ok || !d.ok || !d.share) { showError(s, failure(res), function () { open(s.kind, true); }); return; }
      showShared(s, d.share, { updated: true, includes: d.includes });
    });
  }
  function stop(s, share) {
    busy(s, "Turning it off…");
    api("DELETE", "/api/buzzy/page-shares/" + encodeURIComponent(share.id)).then(function (res) {
      if (session !== s) return;
      if (!res.ok || !(res.data && res.data.ok)) { showError(s, failure(res), function () { stop(s, share); }); return; }
      showStopped(s);
    });
  }

  function open(kind, again) {
    if (session && !again) return;
    if (session && again) { session.close(); }
    kind = kind === "qr" ? "qr" : "copy";
    var s = build(kind);
    session = s;
    s.body.appendChild(make("p", "pshare-lead", "Checking what is on this page…"));
    s.box.focus();
    // Which board this Share is about is decided once, here: what is confirmed is what was previewed.
    s.board = boardId();
    api("GET", "/api/buzzy/page-shares/preview?board=" + encodeURIComponent(s.board)).then(function (res) {
      if (session !== s) return;
      var d = res.data || {};
      if (!res.ok || !d.ok) { showError(s, failure(res), function () { open(kind, true); }); return; }
      if (d.active && d.canShare) { showShared(s, d.active, null); return; }
      if (!d.canShare) { showBlocked(s, d); return; }
      showAsk(s, d);
    });
  }

  window.BeeZillaPageShare = {
    open: open,
    close: function () { if (session) session.close(); },
    isOpen: function () { return !!session; },
  };
})();
