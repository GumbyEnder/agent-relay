/* Talk's search, ported from web's browse.js — the search half only.
 *
 * Web's browse.js is 835 lines because it also owns the pane framework: the
 * Inspiration/History/Library/Memory/Experts/Recipes tabs live INSIDE Talk's
 * header there. This line deliberately serves those as their own pages
 * (public/buzzy/library.html, memory.html, ...), so there are no inline panes to
 * mount and no #bzPane to paint. What is left is what the owner asked for:
 *
 *   - typing in #bzSearch searches YOUR work through /api/buzzy/search
 *     (jobs, chats, documents) — the route that already answers here;
 *   - a web address is not a search: it opens in the reader through
 *     /api/buzzy/read, exactly as it does on the website;
 *   - /api/buzzy/search-status is asked once so "your session lapsed" never reads
 *     as "search is off" (the browser half of that promise).
 *
 * The three chips are All / Work / Chats / Documents because those are the three
 * kinds /api/buzzy/search returns here. Pictures, music and 3D come from the
 * assets route and the Library's own grid; offering seven chips and filling four
 * of them would be the search-box-that-cannot-search in another costume.
 */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }
  var input = $("bzSearch");
  if (!input) return; // the header is not on this page (sign-in, landing)
  var results = $("bzResults");
  var grid = $("bzResultsGrid");
  var note = $("bzSearchNote");
  var places = $("bzPlaces");
  var reader = $("bzReader");
  if (!results || !grid) return;

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function say(msg, ms) {
    if (!note) return;
    note.textContent = msg || "";
    clearTimeout(say.t);
    if (msg) say.t = setTimeout(function () { note.textContent = ""; }, ms || 6000);
  }

  // ── The placeholder has to FIT ─────────────────────────────────────────
  // Same rule as web's browse.js: the markup carries a short word and the full
  // sentence in data-placeholder-full, so first paint is never a cut-off
  // sentence while this file is still loading. Then the longest that fits is
  // chosen, and re-chosen on resize.
  var SHRINKS = ["Search your work or a web address", "Search your work or a link", "Search your work", "Search"];
  (function fitPlaceholder() {
    var long = input.getAttribute("data-placeholder-full") || input.getAttribute("placeholder") || SHRINKS[0];
    var all = [long].concat(SHRINKS.filter(function (s) { return s !== long; }));
    var canvas = null;
    var tries = 0;
    function pick() {
      var cs = window.getComputedStyle(input);
      var room = input.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      if (!(room > 0)) {
        if (tries++ < 60) requestAnimationFrame(pick);
        return;
      }
      canvas = canvas || document.createElement("canvas");
      var ctx = canvas.getContext && canvas.getContext("2d");
      if (!ctx) return;
      ctx.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
      var chosen = all[all.length - 1];
      for (var i = 0; i < all.length; i++) {
        if (ctx.measureText(all[i]).width <= room) { chosen = all[i]; break; }
      }
      if (input.placeholder !== chosen) input.placeholder = chosen;
    }
    var t = null;
    function soon() { clearTimeout(t); t = setTimeout(pick, 60); }
    window.addEventListener("resize", soon);
    if (window.ResizeObserver) new window.ResizeObserver(soon).observe(input);
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(soon);
    pick();
  })();

  // ── A web address is opened, not searched ──────────────────────────────
  function asUrl(q) {
    var s = String(q || "").trim();
    if (!s || /\s/.test(s)) return null;
    if (/^https?:\/\//i.test(s)) { try { return new URL(s).href; } catch (_) { return null; } }
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+((:\d+)?)(\/\S*)?$/i.test(s) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(s)) {
      try { return new URL("https://" + s).href; } catch (_) { return null; }
    }
    return null;
  }

  function shortUrl(url) {
    return String(url || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  // ── Icons: one glyph per kind, in the website's colours ────────────────
  var ICON = {
    work: '<span class="bz-ico bz-ico-work" aria-hidden="true">&#9673;</span>',
    chat: '<span class="bz-ico bz-ico-chat" aria-hidden="true">&#8230;</span>',
    word: '<span class="bz-ico bz-ico-word" aria-hidden="true">W</span>',
    pdf: '<span class="bz-ico bz-ico-pdf" aria-hidden="true">PDF</span>',
    sheet: '<span class="bz-ico bz-ico-sheet" aria-hidden="true">E</span>',
    web: '<span class="bz-ico bz-ico-web" aria-hidden="true">&#8599;</span>'
  };

  function docIcon(type) {
    var t = String(type || "").toLowerCase();
    if (/sheet|csv|budget|spreadsheet/.test(t)) return "sheet";
    if (/pdf/.test(t)) return "pdf";
    return "word";
  }

  // ── Search ─────────────────────────────────────────────────────────────
  var seq = 0;
  var items = [];
  var filter = "all";
  try { filter = localStorage.getItem("bz.search.filter") || "all"; } catch (_) {}

  function paintChips() {
    var counts = { work: 0, chats: 0, documents: 0 };
    items.forEach(function (it) {
      if (counts[it.group] != null) counts[it.group]++;
    });
    Array.prototype.forEach.call(results.querySelectorAll(".bz-chips [data-f]"), function (b) {
      var f = b.getAttribute("data-f");
      var on = f === filter;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      var n = b.querySelector(".bz-chip-n");
      if (n) n.textContent = counts[f] ? String(counts[f]) : "";
    });
  }

  function show(list, q) {
    items = list;
    results.classList.remove("hidden");
    if (places) places.classList.add("hidden");
    if (reader) reader.classList.add("hidden");
    paintChips();
    var label = { pictures: "pictures", music: "music", models: "3D", documents: "documents", work: "work", chats: "chats" };
    var visible = list.filter(function (it) {
      return filter === "all" || it.group === filter || it.group === "web";
    });
    if (!visible.length) {
      var empty = q.length < 2
        ? "Keep typing — two letters or more."
        : "Nothing of yours matches \u201c" + esc(q) + "\u201d" + (filter === "all" ? "." : " in " + (label[filter] || filter) + ".");
      // This box does not search the web (no provider-backed half was ported), so
      // say that when a query finds nothing of yours — otherwise "no results"
      // reads as "there is nothing anywhere".
      if (q.length >= 2 && webSearch && !webSearch.available) {
        empty += webSearch.needsReconnect
          ? " Web results need a reconnect in Settings."
          : " Web results are not available on this install.";
      }
      grid.innerHTML = '<p class="bz-results-empty">' + empty + "</p>";
      return;
    }
    grid.innerHTML = visible.map(function (it) {
      var i = list.indexOf(it);
      var icon = ICON[it.icon] || ICON.word;
      var tag = it.href ? "a" : "button";
      var attrs = it.href
        ? ' href="' + esc(it.href) + '"' + (it.external ? ' target="_blank" rel="noopener noreferrer"' : "")
        : ' type="button"';
      return "<" + tag + ' class="bz-result" data-i="' + i + '"' + attrs + ">" + icon +
        '<span class="bz-result-text"><span class="bz-result-title">' + esc(it.title) + "</span>" +
        '<span class="bz-result-type">' + esc(it.type) + (it.sub ? " · " + esc(it.sub) : "") + "</span></span></" + tag + ">";
    }).join("");
  }

  function run(q) {
    var my = ++seq;
    var url = asUrl(q);
    var web = url
      ? [{ group: "web", icon: "web", title: "Open " + shortUrl(url), type: "Web page · read it here", reader: url }]
      : [];
    if (q.length < 2) { show(web, q); return; }
    fetch("/api/buzzy/search?q=" + encodeURIComponent(q), { credentials: "same-origin" })
      .then(function (r) {
        if (r.status === 401) return null;
        return r.ok ? r.json() : null;
      })
      .then(function (s) {
        if (my !== seq) return; // a newer keystroke won
        var list = web.slice();
        ((s && s.documents) || []).forEach(function (d) {
          var icon = docIcon(d.type || d.contentType);
          list.push({
            group: "documents", icon: icon, title: d.title || "Untitled document",
            type: icon === "sheet" ? "Spreadsheet" : icon === "pdf" ? "PDF" : "Document",
            sub: d.snippet || (d.company_name || ""),
            href: "/buzzy/library?job=" + encodeURIComponent(d.job_id || d.jobId || d.id)
          });
        });
        ((s && s.jobs) || []).forEach(function (j) {
          list.push({
            group: "work", icon: "work", title: j.title || "Untitled work", type: "Work",
            sub: [j.company_name, j.status].filter(Boolean).join(" · "),
            href: "/buzzy/talk?job=" + encodeURIComponent(j.id)
          });
        });
        ((s && s.sessions) || []).forEach(function (c) {
          list.push({
            group: "chats", icon: "chat", title: c.title || "Untitled chat", type: "Chat",
            sub: [c.company_name, c.message_count != null ? c.message_count + " message" + (c.message_count === 1 ? "" : "s") : ""].filter(Boolean).join(" · "),
            session: c
          });
        });
        show(list, q);
      })
      .catch(function () {
        if (my !== seq) return;
        show(web, q);
        say("Couldn't search right now — check the connection and try again.");
      });
  }

  // ── The reader: a typed web address opened as text ────────────────────
  var trail = [];
  var at = -1;
  var readSeq = 0;

  function mountReader() {
    if (!reader || reader.getAttribute("data-ready")) return;
    reader.setAttribute("data-ready", "1");
    reader.innerHTML =
      '<div class="bz-reader-bar">' +
        '<button type="button" class="bz-icon-btn" data-r="home" aria-label="Home — back to the places" title="Home">&#8962;</button>' +
        '<button type="button" class="bz-icon-btn" data-r="back" aria-label="Back" title="Back">&#8592;</button>' +
        '<nav class="bz-crumbs" aria-label="Pages you opened"></nav>' +
        '<a class="bz-reader-out" target="_blank" rel="noopener noreferrer">Open the real page &#8599;</a>' +
      "</div>" +
      '<div class="bz-reader-body" aria-live="polite"></div>';
  }

  function crumbs() {
    if (!reader) return;
    var nav = reader.querySelector(".bz-crumbs");
    nav.innerHTML = trail.map(function (p, i) {
      var label = p.title || shortUrl(p.url);
      return '<button type="button" class="bz-crumb' + (i === at ? " on" : "") + '" data-i="' + i + '"' +
        (i === at ? ' aria-current="page"' : "") + ">" + esc(label.slice(0, 40)) + "</button>";
    }).join('<span class="bz-crumb-sep" aria-hidden="true">›</span>');
  }

  function paintReader(p) {
    var body = reader.querySelector(".bz-reader-body");
    var out = reader.querySelector(".bz-reader-out");
    out.href = p.url;
    if (p.error) {
      body.innerHTML = '<p class="bz-reader-msg">' + esc(p.error) + "</p>";
      return;
    }
    var paras = String(p.text || "").split(/\n+/).slice(0, 400);
    body.innerHTML =
      "<h2>" + esc(p.title || p.url) + "</h2>" +
      '<p class="bz-reader-url">' + esc(p.url) + "</p>" +
      '<div class="bz-reader-text">' + paras.map(function (t) { return "<p>" + esc(t) + "</p>"; }).join("") + "</div>" +
      (p.truncated ? '<p class="bz-reader-msg">This page is long — the rest is on the real page.</p>' : "") +
      ((p.links && p.links.length)
        ? '<h3>Links on this page</h3><ul class="bz-reader-links">' + p.links.map(function (l, i) {
          return '<li><button type="button" data-link="' + i + '">' + esc(l.text) + "</button> <span>" +
            esc(shortUrl(l.href).slice(0, 70)) + "</span></li>";
        }).join("") + "</ul>"
        : "");
    body.scrollTop = 0;
  }

  function showReader(on) {
    if (!reader) return;
    mountReader();
    reader.classList.toggle("hidden", !on);
    results.classList.add("hidden");
    if (places) places.classList.toggle("hidden", on);
  }

  function openReader(url, opts) {
    if (!reader) return;
    opts = opts || {};
    var my = ++readSeq;
    mountReader();
    showReader(true);
    if (!opts.fromTrail) {
      trail = trail.slice(0, at + 1);
      trail.push({ url: url, title: "" });
      if (trail.length > 12) trail.shift();
      at = trail.length - 1;
    }
    crumbs();
    var body = reader.querySelector(".bz-reader-body");
    body.innerHTML = '<p class="bz-reader-msg">Reading ' + esc(url) + "…</p>";
    reader.querySelector(".bz-reader-out").href = url;
    fetch("/api/buzzy/read?url=" + encodeURIComponent(url), { credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "That page could not be read." }; }); })
      .then(function (j) {
        if (my !== readSeq) return;
        var page = j && j.ok
          ? { url: j.url || url, title: j.title || "", text: j.text || "", truncated: !!j.truncated, links: j.links || [] }
          : { url: url, error: (j && j.error) || "That page could not be read." };
        if (trail[at]) { trail[at].title = page.title || trail[at].title; trail[at].page = page; trail[at].url = page.url; }
        crumbs();
        paintReader(page);
      })
      .catch(function () {
        if (my === readSeq) paintReader({ url: url, error: "Couldn't reach BeeZilla to read that page — check the connection." });
      });
  }

  function goTrail(i) {
    if (!trail[i]) return;
    at = i;
    crumbs();
    if (trail[i].page) { showReader(true); paintReader(trail[i].page); }
    else openReader(trail[i].url, { fromTrail: true });
  }

  // ── Opening a result ───────────────────────────────────────────────────
  function openChat(s) {
    closeSearch();
    var open = function () { if (window.bzOpenSessionById) window.bzOpenSessionById(s.id); };
    // The Talk page's script ran when its header was fetched (or earlier), so
    // the opener is on window; if the shell is on another page, bring Talk up
    // first and wait for the cached page to be showing.
    if (window.BeeZillaShell) {
      window.BeeZillaShell.go("/buzzy/talk");
      var tries = 0;
      (function wait() {
        if (window.bzOpenSessionById) return open();
        if (tries++ < 60) setTimeout(wait, 50);
      })();
      return;
    }
    // No shell (a page loaded outside nav.js): a real navigation still gets you to
    // the conversation; the History drawer is one click from there.
    location.href = "/buzzy/talk";
  }

  // ── Close, chips, keys ─────────────────────────────────────────────────
  function closeSearch() {
    seq++;
    readSeq++;
    input.value = "";
    results.classList.add("hidden");
    if (places) places.classList.remove("hidden");
    if (reader) reader.classList.add("hidden");
    trail = [];
    at = -1;
    say("");
  }

  var timer = 0;
  input.addEventListener("input", function () {
    clearTimeout(timer);
    var q = input.value.trim();
    var bar = $("talkBar");
    if (bar) bar.classList.toggle("has-text", !!q);
    if (!q) { closeSearch(); return; }
    timer = setTimeout(function () { run(q); }, 220);
  });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); closeSearch(); input.blur(); return; }
    if (e.key === "Enter") {
      var url = asUrl(input.value);
      if (url) { e.preventDefault(); openReader(url); }
    }
  });

  var closeBtn = $("bzResultsClose");
  if (closeBtn) closeBtn.addEventListener("click", function () { closeSearch(); input.focus(); });

  if (results) {
    Array.prototype.forEach.call(results.querySelectorAll(".bz-chips [data-f]"), function (b) {
      if (b.getAttribute("data-f") === filter) { b.classList.add("on"); b.setAttribute("aria-selected", "true"); }
      b.addEventListener("click", function () {
        filter = b.getAttribute("data-f");
        try { localStorage.setItem("bz.search.filter", filter); } catch (_) {}
        show(items, input.value.trim());
      });
    });
  }

  if (grid) {
    grid.addEventListener("click", function (e) {
      var el = e.target.closest ? e.target.closest(".bz-result") : null;
      if (!el) return;
      var it = items[Number(el.getAttribute("data-i"))];
      if (!it) return;
      if (it.reader) { e.preventDefault(); openReader(it.reader); return; }
      if (it.session) { e.preventDefault(); openChat(it.session); return; }
      if (it.href && window.BeeZillaShell && !it.external && /^\/buzzy\//.test(it.href)) {
        e.preventDefault();
        closeSearch();
        window.BeeZillaShell.go(it.href);
      }
    });
  }

  if (reader) {
    reader.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button") : null;
      if (!b) return;
      var r = b.getAttribute("data-r");
      if (r === "home") { readSeq++; showReader(false); input.value = ""; return; }
      if (r === "back") { if (at > 0) goTrail(at - 1); else { readSeq++; showReader(false); } return; }
      if (b.hasAttribute("data-i")) { goTrail(Number(b.getAttribute("data-i"))); return; }
      if (b.hasAttribute("data-link")) {
        var cur = trail[at] && trail[at].page;
        var l = cur && cur.links && cur.links[Number(b.getAttribute("data-link"))];
        if (l) openReader(l.href);
      }
    });
    reader.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); readSeq++; showReader(false); input.focus(); }
    });
  }

  // ── Copy this page's link, and say truthfully whether it worked ────────
  var copyBtn = $("bzCopy");
  if (copyBtn) copyBtn.addEventListener("click", function () {
    var href = window.location.href;
    function fallback() {
      try {
        var t = document.createElement("textarea");
        t.value = href;
        t.style.position = "fixed";
        t.style.opacity = "0";
        document.body.appendChild(t);
        t.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(t);
        say(ok ? "Page link copied." : "Couldn't copy — select the address bar to copy the link.");
      } catch (_) { say("Couldn't copy — select the address bar to copy the link."); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(href).then(function () { say("Page link copied."); }, fallback);
    } else fallback();
  });

  // ── Is web search on, and is the session stale? ────────────────────────
  // This box searches YOUR work and reads typed web addresses; it does not send
  // queries to a search provider (that half of browse.js was not ported). So a
  // status note on every page load would be noise about a feature this box does
  // not use. Asked once, and only surfaced when a query comes back empty — the
  // moment "nothing found" needs the truth that web results are not in scope.
  var webSearch = null;
  fetch("/api/buzzy/search-status", { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (s) { if (s && s.ok) webSearch = s; })
    .catch(function () { /* a status probe must never surface an error */ });

})();
