/**
 * The Whiteboard (owner's reference zMWSgG0, top right): a dotted board of file
 * cards — a picture shows its picture, a document its type glyph — each with four
 * yellow corner handles; drag from a handle to another card to connect them with a
 * yellow curve. "Search the board" finds cards already on it and the owner's own
 * files and documents to add. Inspiration cards (application/x-beezilla-card) drop
 * onto it. Close (✕) and minimise (–) like every BeeZilla pop-up.
 *
 *   var board = BeeZillaWhiteboard.mount(el, { boardId, onClose, onMinimise });
 *   board.addCard({ kind, title, url, contentType }); board.destroy();
 *
 * Saved per board in this browser (localStorage "bz.board.<id>"), 60 cards at most.
 * Built from DOM nodes and textContent only.
 */
(function () {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";
  var CARD_W = 120, CARD_H = 112, MAX_CARDS = 60;
  var CORNERS = ["nw", "ne", "sw", "se"];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function uid() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function load(key) {
    try { var v = JSON.parse(localStorage.getItem(key) || "null"); return v && Array.isArray(v.cards) ? v : null; } catch (_) { return null; }
  }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { /* best effort */ } }

  // What a card is, from whatever the source called it.
  function kindOf(c) {
    var k = String(c.kind || "").toLowerCase();
    var name = String(c.title || c.url || "").toLowerCase();
    var t = String(c.contentType || "").toLowerCase();
    if (k === "photo" || k === "image" || /^image\//.test(t) || /\.(png|jpe?g|gif|webp|svg)$/.test(name)) return "image";
    if (k === "audio" || k === "track" || /^audio\//.test(t) || /\.(mp3|wav|m4a|ogg)$/.test(name)) return "track";
    if (k === "3d" || k === "model" || /\.(glb|gltf|obj|usdz)$/.test(name)) return "model";
    if (/\.(xlsx?|csv)$/.test(name) || /sheet|csv/.test(t) || k === "sheet") return "sheet";
    if (/\.(pptx?|key)$/.test(name) || /presentation/.test(t) || k === "slides") return "slides";
    if (/\.pdf$/.test(name) || /pdf/.test(t) || k === "pdf") return "pdf";
    if (k === "document" || /\.(docx?|md|txt|rtf)$/.test(name) || /word|text\//.test(t)) return "document";
    if (k === "note") return "note";
    return "file";
  }
  var GLYPH = { document: "W", sheet: "E", slides: "P", pdf: "PDF", track: "♪", model: "◇", file: "📎", note: "✎" };

  function mount(host, opts) {
    opts = opts || {};
    var key = "bz.board." + String(opts.boardId || "default").slice(0, 80);
    var state = load(key) || { cards: [], links: [] };
    var selectedLink = -1;
    var saveTimer = 0;
    function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(function () { save(key, state); }, 300); }

    // ── Shell ──────────────────────────────────────────────────────────
    var root = el("section", "wb-panel");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Whiteboard");
    var head = el("div", "wb-head");
    head.appendChild(el("h3", "wb-title", "Whiteboard"));
    var tools = el("span", "wb-tools");
    var minBtn = el("button", "wb-btn", "–");
    minBtn.type = "button"; minBtn.setAttribute("aria-label", "Minimise whiteboard"); minBtn.title = "Minimise";
    var closeBtn = el("button", "wb-btn", "✕");
    closeBtn.type = "button"; closeBtn.setAttribute("aria-label", "Close whiteboard"); closeBtn.title = "Close";
    tools.appendChild(minBtn); tools.appendChild(closeBtn);
    head.appendChild(tools);
    var canvas = el("div", "wb-canvas");
    canvas.tabIndex = -1;
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "wb-links");
    svg.setAttribute("aria-hidden", "true");
    canvas.appendChild(svg);
    var hint = el("p", "wb-hint", "Drag work here, or search the board to add it.");
    canvas.appendChild(hint);
    var foot = el("div", "wb-foot");
    var search = el("input", "wb-search");
    search.type = "search";
    search.placeholder = "Search the board";
    search.setAttribute("aria-label", "Search the board and your work to add it");
    search.autocomplete = "off";
    var drop = el("div", "wb-results");
    drop.setAttribute("role", "listbox");
    drop.hidden = true;
    foot.appendChild(search);
    foot.appendChild(drop);
    root.appendChild(head);
    root.appendChild(canvas);
    root.appendChild(foot);
    host.appendChild(root);

    var minimised = false;
    minBtn.addEventListener("click", function () {
      minimised = !minimised;
      root.classList.toggle("wb-min", minimised);
      minBtn.textContent = minimised ? "▢" : "–";
      minBtn.setAttribute("aria-label", minimised ? "Restore whiteboard" : "Minimise whiteboard");
      if (opts.onMinimise) opts.onMinimise(minimised);
    });
    closeBtn.addEventListener("click", function () { if (opts.onClose) opts.onClose(); });

    // ── Cards ──────────────────────────────────────────────────────────
    var nodes = {};
    function cardById(id) { for (var i = 0; i < state.cards.length; i++) if (state.cards[i].id === id) return state.cards[i]; return null; }

    function renderCard(c) {
      var n = el("div", "wb-card wb-k-" + kindOf(c));
      n.tabIndex = 0;
      n.setAttribute("role", "group");
      n.setAttribute("aria-label", (c.title || "Card") + " — arrow keys move it, Delete removes it");
      n.style.left = c.x + "px";
      n.style.top = c.y + "px";
      var k = kindOf(c);
      if (k === "image" && c.url) {
        var img = el("img", "wb-img");
        img.src = c.url; img.alt = ""; img.loading = "lazy"; img.draggable = false;
        n.appendChild(img);
      } else {
        var g = el("span", "wb-glyph wb-g-" + k, GLYPH[k] || "📎");
        g.setAttribute("aria-hidden", "true");
        n.appendChild(g);
      }
      n.appendChild(el("span", "wb-name", c.title || "Untitled"));
      var rm = el("button", "wb-rm", "✕");
      rm.type = "button"; rm.setAttribute("aria-label", "Remove " + (c.title || "card")); rm.title = "Remove";
      rm.addEventListener("click", function (e) { e.stopPropagation(); removeCard(c.id); });
      n.appendChild(rm);
      CORNERS.forEach(function (corner) {
        var h = el("span", "wb-handle wb-" + corner);
        h.setAttribute("data-corner", corner);
        h.setAttribute("aria-hidden", "true");
        n.appendChild(h);
      });
      if (c.url && k !== "image") {
        n.addEventListener("dblclick", function () { window.open(c.url, "_blank", "noopener"); });
      }
      wireDrag(n, c);
      n.addEventListener("keydown", function (e) {
        var d = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[e.key];
        if (d) { e.preventDefault(); c.x = Math.max(0, c.x + d[0]); c.y = Math.max(0, c.y + d[1]); place(c); drawLinks(); persist(); return; }
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeCard(c.id); }
      });
      canvas.appendChild(n);
      nodes[c.id] = n;
    }
    function place(c) {
      var n = nodes[c.id];
      if (n) { n.style.left = c.x + "px"; n.style.top = c.y + "px"; }
    }
    function freeSpot() {
      // Fill the visible board left to right, then top to bottom; skip spots taken.
      var gapX = 26, gapY = 26;
      var cols = Math.max(1, Math.floor(((canvas.clientWidth || 520) - 12) / (CARD_W + gapX)));
      for (var i = 0; i < MAX_CARDS; i++) {
        var x = 12 + (i % cols) * (CARD_W + gapX), y = 12 + Math.floor(i / cols) * (CARD_H + gapY);
        var taken = state.cards.some(function (c) { return Math.abs(c.x - x) < CARD_W / 2 && Math.abs(c.y - y) < CARD_H / 2; });
        if (!taken) return { x: x, y: y };
      }
      return { x: 12, y: 12 };
    }
    function addCard(card, at) {
      if (state.cards.length >= MAX_CARDS) return null;
      var spot = at || freeSpot();
      var c = {
        id: uid(),
        kind: kindOf(card),
        title: String(card.title || card.name || "Untitled").slice(0, 120),
        url: card.url ? String(card.url) : "",
        contentType: card.contentType ? String(card.contentType) : "",
        x: Math.max(0, Math.round(spot.x)),
        y: Math.max(0, Math.round(spot.y)),
      };
      state.cards.push(c);
      renderCard(c);
      refreshHint();
      persist();
      return c;
    }
    function removeCard(id) {
      state.cards = state.cards.filter(function (c) { return c.id !== id; });
      state.links = state.links.filter(function (l) { return l.from.id !== id && l.to.id !== id; });
      if (nodes[id]) { nodes[id].remove(); delete nodes[id]; }
      selectedLink = -1;
      drawLinks();
      refreshHint();
      persist();
    }
    function refreshHint() { hint.hidden = state.cards.length > 0; }

    // ── Moving a card, or drawing a link from a corner ───────────────────
    function point(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left + canvas.scrollLeft, y: e.clientY - r.top + canvas.scrollTop };
    }
    function cornerXY(c, corner) {
      var n = nodes[c.id];
      var w = n ? n.offsetWidth : CARD_W, h = n ? n.offsetHeight : CARD_H;
      return { x: c.x + (corner.charAt(1) === "e" ? w : 0), y: c.y + (corner.charAt(0) === "s" ? h : 0) };
    }
    var preview = null;
    function wireDrag(n, c) {
      n.addEventListener("pointerdown", function (e) {
        if (e.button !== 0 || (e.target.closest && e.target.closest(".wb-rm"))) return;
        var handle = e.target.closest ? e.target.closest(".wb-handle") : null;
        e.preventDefault();
        n.setPointerCapture(e.pointerId);
        if (handle) {
          var corner = handle.getAttribute("data-corner");
          var start = cornerXY(c, corner);
          preview = document.createElementNS(SVGNS, "path");
          preview.setAttribute("class", "wb-link wb-preview");
          svg.appendChild(preview);
          var move = function (ev) { var p = point(ev); preview.setAttribute("d", curve(start, p)); };
          var up = function (ev) {
            n.removeEventListener("pointermove", move);
            n.removeEventListener("pointerup", up);
            if (preview) { preview.remove(); preview = null; }
            var target = document.elementFromPoint(ev.clientX, ev.clientY);
            var card = target && target.closest ? target.closest(".wb-card") : null;
            var toId = null;
            Object.keys(nodes).forEach(function (id) { if (nodes[id] === card) toId = id; });
            if (!toId || toId === c.id) return;
            var to = cardById(toId);
            var th = target.closest(".wb-handle");
            var toCorner = th ? th.getAttribute("data-corner") : nearestCorner(to, point(ev));
            link(c.id, corner, toId, toCorner);
          };
          n.addEventListener("pointermove", move);
          n.addEventListener("pointerup", up);
          return;
        }
        var startP = point(e), ox = c.x, oy = c.y;
        n.classList.add("wb-moving");
        var mv = function (ev) {
          var p = point(ev);
          c.x = Math.max(0, Math.round(ox + p.x - startP.x));
          c.y = Math.max(0, Math.round(oy + p.y - startP.y));
          place(c);
          drawLinks();
        };
        var upm = function () {
          n.classList.remove("wb-moving");
          n.removeEventListener("pointermove", mv);
          n.removeEventListener("pointerup", upm);
          persist();
        };
        n.addEventListener("pointermove", mv);
        n.addEventListener("pointerup", upm);
      });
    }
    function nearestCorner(c, p) {
      var best = "nw", bd = Infinity;
      CORNERS.forEach(function (k) {
        var q = cornerXY(c, k), d = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y);
        if (d < bd) { bd = d; best = k; }
      });
      return best;
    }
    function link(fromId, fromCorner, toId, toCorner) {
      var dup = state.links.some(function (l) {
        return (l.from.id === fromId && l.from.corner === fromCorner && l.to.id === toId && l.to.corner === toCorner) ||
               (l.from.id === toId && l.from.corner === toCorner && l.to.id === fromId && l.to.corner === fromCorner);
      });
      if (dup) return;
      state.links.push({ from: { id: fromId, corner: fromCorner }, to: { id: toId, corner: toCorner } });
      drawLinks();
      persist();
    }
    function curve(a, b) {
      var dx = Math.max(60, Math.abs(b.x - a.x) * 0.4);
      var dir = b.x >= a.x ? 1 : -1;
      return "M" + a.x + "," + a.y + " C" + (a.x + dx * dir) + "," + a.y + " " + (b.x - dx * dir) + "," + b.y + " " + b.x + "," + b.y;
    }
    function drawLinks() {
      Array.prototype.slice.call(svg.querySelectorAll(".wb-link:not(.wb-preview)")).forEach(function (p) { p.remove(); });
      var w = 0, h = 0;
      state.cards.forEach(function (c) { var n = nodes[c.id]; if (n) { w = Math.max(w, c.x + n.offsetWidth + 40); h = Math.max(h, c.y + n.offsetHeight + 40); } });
      svg.setAttribute("width", String(Math.max(w, canvas.scrollWidth)));
      svg.setAttribute("height", String(Math.max(h, canvas.scrollHeight)));
      state.links.forEach(function (l, i) {
        var a = cardById(l.from.id), b = cardById(l.to.id);
        if (!a || !b) return;
        var p = document.createElementNS(SVGNS, "path");
        p.setAttribute("class", "wb-link" + (i === selectedLink ? " wb-sel" : ""));
        p.setAttribute("d", curve(cornerXY(a, l.from.corner), cornerXY(b, l.to.corner)));
        p.addEventListener("click", function () { selectedLink = selectedLink === i ? -1 : i; drawLinks(); canvas.focus(); });
        svg.appendChild(p);
      });
    }
    canvas.addEventListener("keydown", function (e) {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedLink >= 0) {
        e.preventDefault();
        state.links.splice(selectedLink, 1);
        selectedLink = -1;
        drawLinks();
        persist();
      }
    });

    // ── Drops from the Inspiration wall (and plain links) ────────────────
    var TYPE = "application/x-beezilla-card";
    function acceptable(e) {
      var t = e.dataTransfer && e.dataTransfer.types ? Array.prototype.slice.call(e.dataTransfer.types) : [];
      return t.indexOf(TYPE) >= 0 || t.indexOf("text/uri-list") >= 0;
    }
    canvas.addEventListener("dragover", function (e) {
      if (!acceptable(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      root.classList.add("wb-over");
    });
    canvas.addEventListener("dragleave", function (e) {
      if (!canvas.contains(e.relatedTarget)) root.classList.remove("wb-over");
    });
    canvas.addEventListener("drop", function (e) {
      root.classList.remove("wb-over");
      if (!acceptable(e)) return;
      e.preventDefault();
      var p = point(e);
      var at = { x: p.x - CARD_W / 2, y: p.y - 30 };
      var raw = e.dataTransfer.getData(TYPE);
      if (raw) {
        try { var c = JSON.parse(raw); addCard({ kind: c.kind, title: c.title, url: c.url, contentType: c.contentType }, at); } catch (_) { /* best effort */ }
        return;
      }
      var uri = (e.dataTransfer.getData("text/uri-list") || "").split("\n")[0].trim();
      if (/^https?:\/\//i.test(uri)) {
        var u = new URL(uri);
        addCard({ kind: "file", title: u.host + u.pathname.replace(/\/$/, ""), url: uri }, at);
      }
    });

    // While a card is being dragged anywhere on the page, show where it can go
    // (roadmap: "highlight board drop targets"), not only once it is over the board.
    function dragStarted(e) { if (acceptable(e)) root.classList.add("wb-target"); }
    function dragFinished() { root.classList.remove("wb-target"); root.classList.remove("wb-over"); }
    document.addEventListener("dragstart", dragStarted);
    document.addEventListener("dragend", dragFinished);
    document.addEventListener("drop", dragFinished);

    // ── Search the board ─────────────────────────────────────────────────
    var library = null;
    function getLibrary() {
      if (library) return Promise.resolve(library);
      function get(u) {
        return fetch(u, { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      }
      return Promise.all([get("/api/buzzy/assets?limit=300"), get("/api/buzzy/documents")]).then(function (r) {
        var files = r[0] && [r[0].items, r[0].assets, r[0].rows, r[0].files].filter(Array.isArray)[0] || [];
        var docs = (r[1] && Array.isArray(r[1].documents)) ? r[1].documents : [];
        library = files.map(function (f) {
          return { kind: kindOf({ title: f.filename, contentType: f.content_type }), title: f.filename || f.rel_path || "File",
            url: "/api/buzzy/assets/" + encodeURIComponent(f.id), contentType: f.content_type || "" };
        }).concat(docs.map(function (d) {
          return { kind: "document", title: d.title || "Untitled document", url: "/buzzy/library?job=" + encodeURIComponent(d.job_id || d.id) };
        }));
        return library;
      });
    }
    var searchTimer = 0;
    function closeDrop() { drop.hidden = true; drop.textContent = ""; }
    function option(label, sub, onPick) {
      var b = el("button", "wb-opt");
      b.type = "button";
      b.setAttribute("role", "option");
      b.appendChild(el("span", "wb-opt-name", label));
      b.appendChild(el("span", "wb-opt-sub", sub));
      b.addEventListener("click", function () { onPick(); search.value = ""; closeDrop(); });
      drop.appendChild(b);
    }
    search.addEventListener("input", function () {
      clearTimeout(searchTimer);
      var q = search.value.trim().toLowerCase();
      if (q.length < 2) { closeDrop(); return; }
      searchTimer = setTimeout(function () {
        getLibrary().then(function (lib) {
          drop.textContent = "";
          var onBoard = state.cards.filter(function (c) { return c.title.toLowerCase().indexOf(q) >= 0; }).slice(0, 5);
          onBoard.forEach(function (c) {
            option(c.title, "On the board", function () {
              var n = nodes[c.id];
              if (n) { n.focus(); n.classList.add("wb-flash"); setTimeout(function () { n.classList.remove("wb-flash"); }, 900); }
            });
          });
          lib.filter(function (x) { return x.title.toLowerCase().indexOf(q) >= 0; }).slice(0, 8).forEach(function (x) {
            option(x.title, "Add to the board", function () { addCard(x); });
          });
          if (!drop.childNodes.length) drop.appendChild(el("p", "wb-none", "Nothing of yours matches."));
          drop.hidden = false;
        });
      }, 250);
    });
    search.addEventListener("keydown", function (e) { if (e.key === "Escape") { search.value = ""; closeDrop(); } });
    var outside = function (e) { if (!foot.contains(e.target)) closeDrop(); };
    document.addEventListener("click", outside);

    // ── Start ────────────────────────────────────────────────────────────
    state.cards = state.cards.slice(0, MAX_CARDS);
    state.cards.forEach(renderCard);
    refreshHint();
    requestAnimationFrame(drawLinks);

    return {
      addCard: function (c) { return addCard(c); },
      clear: function () { state = { cards: [], links: [] }; Object.keys(nodes).forEach(function (id) { nodes[id].remove(); }); nodes = {}; drawLinks(); refreshHint(); persist(); },
      minimise: function () { if (!minimised) minBtn.click(); },
      restore: function () { if (minimised) minBtn.click(); },
      isOpen: function () { return !!root.isConnected; },
      destroy: function () {
        clearTimeout(saveTimer); clearTimeout(searchTimer);
        document.removeEventListener("click", outside);
        document.removeEventListener("dragstart", dragStarted);
        document.removeEventListener("dragend", dragFinished);
        document.removeEventListener("drop", dragFinished);
        save(key, state);
        root.remove();
      },
    };
  }

  window.BeeZillaWhiteboard = { mount: mount };
})();
