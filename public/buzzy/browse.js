/**
 * The bottom half of Talk: find and browse (owner's references zMWSgG0 + qVxl1TJ).
 *
 *   [ 🔍 Search or enter a URL                         ⧉ ]
 *   Inspiration · Library · Memory · Experts
 *   <the chosen tab, or the search results while a search is open>
 *
 * Building happens above (the Talk bar and the conversation); browsing happens here.
 * A search replaces the tab content and ✕ / Escape returns to it. Search reads only
 * the owner's own data: /api/buzzy/search (work, chats, documents), their files
 * (/api/buzzy/assets), recipes (/api/buzzy/recipes) and the experts' skills
 * (experts-data.js). A web address opens in a new tab — this page does not pretend
 * to be a browser.
 *
 * Mounted by talk.html into #bzBrowse; needs nothing from the page except two
 * optional hooks: window.bzPrompt(text) and window.bzOpenSession(session).
 */
(function () {
  "use strict";

  var root = document.getElementById("bzBrowse");
  if (!root) return;

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function getJSON(url) {
    return fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  function store(key, val) {
    try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (_) {}
    return null;
  }

  var input = $("bzSearch");
  var results = $("bzResults");
  var grid = $("bzResultsGrid");
  var note = $("bzSearchNote");
  var tabs = $("bzTabs");
  var pane = $("bzPane");
  var recent = $("recentBelow");

  // ── Icons: one glyph per kind, in the reference's colours ─────────────
  var ICON = {
    word: '<span class="bz-ico bz-ico-word" aria-hidden="true">W</span>',
    sheet: '<span class="bz-ico bz-ico-sheet" aria-hidden="true">E</span>',
    slides: '<span class="bz-ico bz-ico-slides" aria-hidden="true">P</span>',
    pdf: '<span class="bz-ico bz-ico-pdf" aria-hidden="true">PDF</span>',
    image: '<span class="bz-ico bz-ico-image" aria-hidden="true">&#9638;</span>',
    track: '<span class="bz-ico bz-ico-track" aria-hidden="true">&#9835;</span>',
    model: '<span class="bz-ico bz-ico-model" aria-hidden="true">&#9671;</span>',
    file: '<span class="bz-ico bz-ico-file" aria-hidden="true">&#128206;</span>',
    work: '<span class="bz-ico bz-ico-work" aria-hidden="true">&#9673;</span>',
    chat: '<span class="bz-ico bz-ico-chat" aria-hidden="true">&#8230;</span>',
    skill: '<svg class="bz-ico bz-ico-skill" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2l1.8 5.2L16 9l-5.2 1.8L9 16l-1.8-5.2L2 9l5.2-1.8zM18 12l1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/></svg>',
    recipe: '<span class="bz-ico bz-ico-recipe" aria-hidden="true"><i></i><i></i><i></i></span>',
    web: '<span class="bz-ico bz-ico-web" aria-hidden="true">&#8599;</span>',
  };

  function fileKind(name, type) {
    var n = String(name || "").toLowerCase(), t = String(type || "").toLowerCase();
    if (/^image\//.test(t) || /\.(png|jpe?g|gif|webp|svg)$/.test(n)) return { icon: "image", label: "Image" };
    if (/^audio\//.test(t) || /\.(mp3|wav|m4a|ogg)$/.test(n)) return { icon: "track", label: "Track" };
    if (/\.(glb|gltf|obj|usdz)$/.test(n) || /model\//.test(t)) return { icon: "model", label: "3D model" };
    if (/\.(xlsx?|csv)$/.test(n) || /sheet|csv/.test(t)) return { icon: "sheet", label: "Spreadsheet" };
    if (/\.(pptx?|key)$/.test(n) || /presentation/.test(t)) return { icon: "slides", label: "Presentation" };
    if (/\.pdf$/.test(n) || /pdf/.test(t)) return { icon: "pdf", label: "PDF" };
    if (/\.(docx?|md|txt|rtf)$/.test(n) || /word|text\//.test(t)) return { icon: "word", label: "Document" };
    return { icon: "file", label: "File" };
  }
  function docKind(type) {
    var t = String(type || "").toLowerCase();
    if (/sheet|csv|budget|spreadsheet/.test(t)) return { icon: "sheet", label: "Spreadsheet" };
    if (/presentation|slides|deck/.test(t)) return { icon: "slides", label: "Presentation" };
    return { icon: "word", label: "Document" };
  }

  // ── A web address is opened, not searched ──────────────────────────────
  function asUrl(q) {
    var s = String(q || "").trim();
    if (!s || /\s/.test(s)) return null;
    if (/^https?:\/\//i.test(s)) { try { return new URL(s).href; } catch (_) { return null; } }
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(s) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(s)) {
      try { return new URL("https://" + s).href; } catch (_) { return null; }
    }
    return null;
  }

  function say(msg) {
    if (!note) return;
    note.textContent = msg || "";
    clearTimeout(say.t);
    if (msg) say.t = setTimeout(function () { note.textContent = ""; }, 6000);
  }

  // ── Copy this page's link, and say truthfully whether it worked ────────
  function copyLink() {
    var href = window.location.href;
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = href;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
      document.body.removeChild(ta);
      say(ok ? "Link copied." : "Couldn't copy here — the link is " + href);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(href).then(function () { say("Link copied."); }, fallback);
    } else fallback();
  }

  // ── Sources (cached per page view; search queries the server each time) ─
  var cache = { recipes: null, files: null };
  function recipes() {
    if (cache.recipes) return Promise.resolve(cache.recipes);
    return getJSON("/api/buzzy/recipes").then(function (j) {
      cache.recipes = (j && Array.isArray(j.recipes)) ? j.recipes : [];
      return cache.recipes;
    });
  }
  function files() {
    if (cache.files) return Promise.resolve(cache.files);
    return getJSON("/api/buzzy/assets?limit=300").then(function (j) {
      // The rows are under `items`; `files` is a count. Take the first array found.
      var list = j && [j.items, j.assets, j.rows, j.files].filter(Array.isArray)[0];
      cache.files = list || [];
      return cache.files;
    });
  }
  function skills() {
    var out = [];
    (window.BZ_EXPERTS || []).forEach(function (e) {
      (e.skills || []).forEach(function (s) { out.push({ skill: s, expert: e }); });
    });
    return out;
  }

  // ── Search ─────────────────────────────────────────────────────────────
  var items = [];
  var filter = store("bz.search.filter") || "all";
  var seq = 0;

  function contains(hay, q) { return String(hay || "").toLowerCase().indexOf(q) >= 0; }

  function run(q) {
    var my = ++seq;
    var url = asUrl(q);
    var ql = q.toLowerCase();
    var webItem = url ? [{ group: "all", icon: "web", title: "Open " + url.replace(/^https?:\/\//, "").replace(/\/$/, ""), type: "Web page · read it here", reader: url }] : [];
    if (q.length < 2) { show(webItem, q); return; }
    Promise.all([
      getJSON("/api/buzzy/search?q=" + encodeURIComponent(q)),
      files(),
      recipes(),
    ]).then(function (r) {
      if (my !== seq) return; // a newer keystroke won
      var s = r[0] || {};
      var list = webItem.slice();
      (s.documents || []).forEach(function (d) {
        var k = docKind(d.type);
        list.push({ group: "documents", icon: k.icon, title: d.title || "Untitled document", type: k.label,
          sub: d.snippet || "", href: "/buzzy/library?job=" + encodeURIComponent(d.job_id || d.jobId || d.id) });
      });
      (r[1] || []).filter(function (f) { return contains(f.filename || f.rel_path, ql); }).slice(0, 12).forEach(function (f) {
        var k = fileKind(f.filename || f.rel_path, f.content_type);
        list.push({ group: "documents", icon: k.icon, title: f.filename || f.rel_path || "File", type: k.label,
          sub: f.job_title ? "In " + f.job_title : "", href: "/api/buzzy/assets/" + encodeURIComponent(f.id), external: true });
      });
      (s.jobs || []).forEach(function (j) {
        list.push({ group: "documents", icon: "work", title: j.title || "Untitled work", type: "Work",
          sub: [j.companyName, j.status].filter(Boolean).join(" · "), href: "/buzzy/project?job=" + encodeURIComponent(j.id) });
      });
      (s.sessions || []).forEach(function (c) {
        list.push({ group: "documents", icon: "chat", title: c.title || "Untitled chat", type: "Chat",
          sub: c.companyName || "", session: c });
      });
      skills().filter(function (x) { return contains(x.skill, ql) || contains(x.expert.name, ql); }).slice(0, 12).forEach(function (x) {
        list.push({ group: "skills", icon: "skill", title: x.skill, type: "Skill · " + x.expert.name,
          prompt: "I need help with " + x.skill.charAt(0).toLowerCase() + x.skill.slice(1) });
      });
      (r[2] || []).filter(function (rc) { return contains(rc.name, ql) || contains(rc.outcome, ql); }).slice(0, 12).forEach(function (rc) {
        list.push({ group: "recipes", icon: "recipe", title: rc.name || rc.id, type: "Recipe",
          sub: rc.outcome || "", href: "/buzzy/recipes#" + encodeURIComponent(rc.id) });
      });
      show(list, q);
    });
  }

  function show(list, q) {
    items = list;
    results.classList.remove("hidden");
    tabs.classList.add("hidden");
    pane.classList.add("hidden");
    paintChips();
    var visible = list.filter(function (it) { return filter === "all" || it.group === filter || it.group === "all"; });
    if (!visible.length) {
      grid.innerHTML = '<p class="bz-results-empty">' + (q.length < 2
        ? "Keep typing — two letters or more."
        : "Nothing of yours matches “" + esc(q) + "”" + (filter === "all" ? "." : " in " + filter + ".")) + "</p>";
      return;
    }
    grid.innerHTML = visible.map(function (it) {
      var i = list.indexOf(it);
      var tag = it.href ? "a" : "button";
      var attrs = it.href
        ? ' href="' + esc(it.href) + '"' + (it.external ? ' target="_blank" rel="noopener noreferrer"' : "")
        : ' type="button"';
      return "<" + tag + ' class="bz-result" data-i="' + i + '"' + attrs + ">" +
        (ICON[it.icon] || ICON.file) +
        '<span class="bz-result-text"><span class="bz-result-title">' + esc(it.title) + "</span>" +
        '<span class="bz-result-type">' + esc(it.type) + (it.sub ? " · " + esc(it.sub) : "") + "</span></span></" + tag + ">";
    }).join("");
  }

  function paintChips() {
    var counts = { all: items.length, documents: 0, skills: 0, recipes: 0 };
    items.forEach(function (it) { if (counts[it.group] != null && it.group !== "all") counts[it.group]++; });
    results.querySelectorAll(".bz-chips [data-f]").forEach(function (b) {
      var f = b.getAttribute("data-f");
      var on = f === filter;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      var c = b.querySelector(".bz-chip-n");
      if (c) c.textContent = counts[f] ? String(counts[f]) : "";
    });
  }

  function closeSearch() {
    seq++;
    input.value = "";
    results.classList.add("hidden");
    var rd = document.getElementById("bzReader");
    if (rd) { rd.classList.add("hidden"); }
    tabs.classList.remove("hidden");
    pane.classList.remove("hidden");
    say("");
  }

  var timer = 0;
  input.addEventListener("input", function () {
    clearTimeout(timer);
    var q = input.value.trim();
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
  $("bzResultsClose").addEventListener("click", function () { closeSearch(); input.focus(); });
  results.querySelectorAll(".bz-chips [data-f]").forEach(function (b) {
    b.addEventListener("click", function () {
      filter = b.getAttribute("data-f");
      store("bz.search.filter", filter);
      show(items, input.value.trim());
    });
  });
  grid.addEventListener("click", function (e) {
    var el = e.target.closest ? e.target.closest(".bz-result") : null;
    if (!el) return;
    var it = items[Number(el.getAttribute("data-i"))];
    if (!it) return;
    if (it.reader) { e.preventDefault(); openReader(it.reader); return; }
    if (it.session && window.bzOpenSession) { e.preventDefault(); closeSearch(); window.bzOpenSession(it.session); return; }
    if (it.prompt && window.bzPrompt) { e.preventDefault(); closeSearch(); window.bzPrompt(it.prompt); return; }
    if (it.href && window.BeeZillaShell && !it.external && /^\/buzzy\//.test(it.href)) {
      e.preventDefault(); window.BeeZillaShell.go(it.href);
    }
  });
  var copyBtn = $("bzCopy");
  if (copyBtn) copyBtn.addEventListener("click", copyLink);

  // ── Reader: the built-in browser for a typed web address ──────────────
  // Home · Back · breadcrumbs · the page as text with its links. Fetched by the
  // server's public-page reader (/api/buzzy/read); the real page is one click
  // away in a new tab. Home (or Escape) returns to the tabs.
  var reader = document.createElement("div");
  reader.className = "bz-reader hidden";
  reader.id = "bzReader";
  reader.setAttribute("role", "region");
  reader.setAttribute("aria-label", "Web page");
  reader.innerHTML =
    '<div class="bz-reader-bar">' +
      '<button type="button" class="bz-icon-btn" data-r="home" aria-label="Home — back to Inspiration" title="Home">&#8962;</button>' +
      '<button type="button" class="bz-icon-btn" data-r="back" aria-label="Back" title="Back">&#8592;</button>' +
      '<nav class="bz-crumbs" aria-label="Pages you opened"></nav>' +
      '<a class="bz-reader-out" target="_blank" rel="noopener noreferrer">Open the real page &#8599;</a>' +
    "</div>" +
    '<div class="bz-reader-body" aria-live="polite"></div>';
  root.insertBefore(reader, tabs);
  var trail = [];   // pages opened, oldest first
  var at = -1;      // index in trail being shown
  var readSeq = 0;

  function showReader(on) {
    reader.classList.toggle("hidden", !on);
    results.classList.add("hidden");
    tabs.classList.toggle("hidden", on);
    pane.classList.toggle("hidden", on);
  }
  function crumbs() {
    var nav = reader.querySelector(".bz-crumbs");
    nav.innerHTML = trail.map(function (p, i) {
      var label = p.title || p.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
      return '<button type="button" class="bz-crumb' + (i === at ? " on" : "") + '" data-i="' + i + '"' +
        (i === at ? ' aria-current="page"' : "") + ">" + esc(label.slice(0, 40)) + "</button>";
    }).join('<span class="bz-crumb-sep" aria-hidden="true">›</span>');
  }
  function paint(p) {
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
            return '<li><button type="button" data-link="' + i + '">' + esc(l.text) + '</button> <span>' +
              esc(l.href.replace(/^https?:\/\//, "").slice(0, 70)) + "</span></li>";
          }).join("") + "</ul>"
        : "");
    body.scrollTop = 0;
  }
  function openReader(url, opts) {
    opts = opts || {};
    var my = ++readSeq;
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
        paint(page);
      })
      .catch(function () { if (my === readSeq) paint({ url: url, error: "Couldn't reach BeeZilla to read that page — check the connection." }); });
  }
  function goTrail(i) {
    if (!trail[i]) return;
    at = i;
    crumbs();
    if (trail[i].page) { showReader(true); paint(trail[i].page); }
    else openReader(trail[i].url, { fromTrail: true });
  }
  function home() {
    readSeq++;
    showReader(false);
    input.value = "";
  }
  reader.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("button") : null;
    if (!b) return;
    var r = b.getAttribute("data-r");
    if (r === "home") { home(); return; }
    if (r === "back") { if (at > 0) goTrail(at - 1); else home(); return; }
    if (b.hasAttribute("data-i")) { goTrail(Number(b.getAttribute("data-i"))); return; }
    if (b.hasAttribute("data-link")) {
      var cur = trail[at] && trail[at].page;
      var l = cur && cur.links && cur.links[Number(b.getAttribute("data-link"))];
      if (l) openReader(l.href);
    }
  });
  reader.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); home(); input.focus(); }
  });

  // ── Tabs: Inspiration · Library · Memory · Experts ─────────────────────
  var current = null;
  var mounted = null;

  function parkRecent() {
    // Recent work belongs to Library; elsewhere it waits, hidden, so talk.html's
    // own code (which repaints it) keeps working.
    if (recent && recent.parentNode !== root) { root.appendChild(recent); }
    if (recent) recent.classList.add("bz-parked");
  }

  function link(href, label) {
    return '<a class="bz-pane-link" href="' + esc(href) + '">' + esc(label) + " &rarr;</a>";
  }

  var TABS = {
    inspiration: function () {
      // Lockdown hides inspiration (roadmap: Private/Lockdown disables it).
      if (window.bzPrivacy && window.bzPrivacy() === "lockdown") {
        pane.innerHTML = '<p class="bz-pane-text">Inspiration is off while privacy is set to Lockdown. ' +
          "Your own work is still under Library.</p>";
        return;
      }
      if (window.BeeZillaInspiration && window.BeeZillaInspiration.mount) {
        // Tailored by an explicit choice (roadmap phase 5): which kinds of finished
        // work the owner wants to see. Remembered in this browser; never inferred.
        var KINDS = [["all", "All"], ["photo", "Pictures"], ["audio", "Music"], ["3d", "3D"], ["document", "Documents"]];
        var want = store("bz.insp.kind") || "all";
        if (!KINDS.some(function (k) { return k[0] === want; })) want = "all";
        pane.innerHTML = '<div class="bz-insp-kinds" role="radiogroup" aria-label="Show in Inspiration">' +
          KINDS.map(function (k) {
            return '<button type="button" role="radio" data-kind="' + k[0] + '" aria-checked="' + (k[0] === want) + '">' + k[1] + "</button>";
          }).join("") + '</div><div class="bz-insp-wall"></div>';
        mounted = window.BeeZillaInspiration.mount(pane.querySelector(".bz-insp-wall"), {
          onPrompt: function (t) { if (window.bzPrompt) window.bzPrompt(t); },
        });
        var applyKind = function (k) {
          want = k;
          store("bz.insp.kind", k);
          pane.querySelectorAll(".bz-insp-kinds [data-kind]").forEach(function (b) {
            b.setAttribute("aria-checked", b.getAttribute("data-kind") === k ? "true" : "false");
          });
          if (mounted && mounted.filter) mounted.filter(k === "all" ? null : k);
        };
        pane.querySelector(".bz-insp-kinds").addEventListener("click", function (e) {
          var b = e.target.closest ? e.target.closest("[data-kind]") : null;
          if (b) applyKind(b.getAttribute("data-kind"));
        });
        if (want !== "all") applyKind(want);
        return;
      }
      // Without the wall, finished work still has a home: show recent work.
      if (recent) { recent.classList.remove("bz-parked"); pane.appendChild(recent); }
    },
    library: function () {
      pane.innerHTML = '<div class="bz-pane-head"><h2>Library</h2>' + link("/buzzy/library", "Open the full Library") + "</div>";
      if (recent) { recent.classList.remove("bz-parked"); pane.appendChild(recent); }
    },
    memory: function () {
      pane.innerHTML = '<div class="bz-pane-head"><h2>Memory</h2>' + link("/buzzy/memory", "Open Memory") + "</div>" +
        '<p class="bz-pane-text">What BeeZilla has learned about you and your work — facts you confirmed, decisions per job — and what you asked it to remember. You can correct or delete any of it there.</p>';
    },
    experts: function () {
      var ex = window.BZ_EXPERTS || [];
      var icons = window.BZ_EXPERT_ICONS || {};
      pane.innerHTML = '<div class="bz-pane-head"><h2>Experts</h2>' + link("/buzzy/experts", "All experts") + "</div>" +
        '<div class="bz-experts">' + ex.map(function (e) {
          return '<a class="bz-expert" href="/buzzy/experts#' + esc(e.id) + '">' +
            '<span class="bz-expert-ico" aria-hidden="true">' + esc(icons[e.id] || "★") + "</span>" +
            '<span class="bz-expert-name">' + esc(e.name) + "</span>" +
            '<span class="bz-expert-blurb">' + esc(e.blurb || "") + "</span></a>";
        }).join("") + "</div>";
    },
  };

  function select(name) {
    if (!TABS[name]) name = "inspiration";
    if (mounted && mounted.destroy) { try { mounted.destroy(); } catch (_) {} }
    mounted = null;
    parkRecent();
    pane.innerHTML = "";
    current = name;
    store("bz.browse.tab", name);
    tabs.querySelectorAll("[data-tab]").forEach(function (b) {
      var on = b.getAttribute("data-tab") === name;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    TABS[name]();
  }

  tabs.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("[data-tab]") : null;
    if (b) select(b.getAttribute("data-tab"));
  });
  tabs.addEventListener("keydown", function (e) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    var all = Array.prototype.slice.call(tabs.querySelectorAll("[data-tab]"));
    var at = all.findIndex(function (b) { return b.getAttribute("data-tab") === current; });
    var next = all[(at + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
    if (next) { select(next.getAttribute("data-tab")); next.focus(); }
  });

  // A privacy change can hide or show the wall.
  window.addEventListener("bz:privacy", function () { if (current === "inspiration") select("inspiration"); });

  // The wall script may arrive after this one.
  select(store("bz.browse.tab") || "inspiration");
  window.addEventListener("load", function () {
    if (current === "inspiration" && !mounted && window.BeeZillaInspiration) select("inspiration");
  });

  // ── Back to top ────────────────────────────────────────────────────────
  var top = document.createElement("button");
  top.type = "button";
  top.className = "bz-totop";
  top.setAttribute("aria-label", "Back to top");
  top.title = "Back to top";
  top.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7.6l-7.1 7.1 1.4 1.4L12 10.4l5.7 5.7 1.4-1.4z"/></svg>';
  top.addEventListener("click", function () {
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  });
  document.body.appendChild(top);
  function toggleTop() { top.classList.toggle("on", window.scrollY > 600); }
  window.addEventListener("scroll", toggleTop, { passive: true });
  toggleTop();
})();
