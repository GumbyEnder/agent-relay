/*
 * Boxes and panels you can make bigger or smaller (owner, 2026-11-22):
 *   "If I have a box like the conversation history, I could just grab the side or the
 *    corner and grow the size of that so I can see it bigger if I want to. Make it so."
 * A BeeZilla design rule from now on (docs/BEEZILLA-SCREEN-RULES.md): a box or panel that
 * holds something worth reading can be dragged by any side or corner.
 *
 * What this file does. It puts thin grab strips along a box's sides and a grab square in its
 * corners (inside the box, so a box that clips its children still shows them), with the right
 * pointer for each. A drag changes the box's width and height; a box held by its left or top
 * edge moves that edge, a box held by its right or bottom edge grows toward the other side, and
 * a box centred on the screen grows both ways. It works at any board zoom (the pointer's
 * movement is divided by the box's own scale), it never lets a box grow out of the window (or
 * out of the panel it sits in), and nothing ever closes or moves because of a drag.
 *
 *   - Esc, while dragging, puts the box back as it was (and does nothing else).
 *   - Double-click a strip or the corner: back to the size it opens at.
 *   - The corner is also a button you can Tab to: the arrow keys change the size (Shift: by
 *     more), Home puts it back. Dragging is never the only way.
 *   - A size is remembered per box (this browser), so a box you made bigger opens bigger. A
 *     box that lives in the board's own data (the conversation card) says so ("save: none")
 *     and is told about each finished drag instead (bz:resized).
 *   - A small grip in the corner says "this one resizes"; a line lights along the edge you are
 *     about to grab.
 *
 * Who is resizable, and how. The list below covers the boxes that already exist, so their own
 * files need no change. A new box says so itself, with attributes:
 *     <div data-bz-resize="e s se" data-bz-resize-anchor="start" data-bz-resize-key="agents">
 *   data-bz-resize           the strips to show: "all", or any of n s e w ne nw se sw
 *   data-bz-resize-anchor    how it sits: "start" (by its left/top; the default), "end" (by its
 *                            right/bottom) or "center"; two words for across then down: "end start"
 *   data-bz-resize-key       remember its size under this name
 *   data-bz-resize-min / -max  "width height" in pixels
 *   data-bz-resize-bound     "window" (the default), "parent" or "none"
 *   data-bz-resize-name      what to call it for a screen reader ("the conversation")
 * Events on the box (they bubble): bz:resizestart when a drag begins, bz:resize while it moves,
 * bz:resized when a drag is kept or the size is put back ({ w, h, x, y, reset }), and
 * bz:resizeend whenever a drag is over, kept or taken back (a board waiting for the pointer
 * to be free, to put an update on itself, listens to the first and the last).
 *
 * The sums are plain functions (dragBox, sizeBy), exported for scripts/test-resizable-boxes.mjs.
 */
(function (root) {
  "use strict";

  // ── The sums (no page needed) ──────────────────────────────────────────────────────────
  function clamp(v, lo, hi) {
    if (!(hi >= lo)) hi = lo;
    return v < lo ? lo : v > hi ? hi : v;
  }
  /**
   * The box a drag makes.
   *   start  { w, h, x, y }       the box when the drag began
   *   edge   "e", "sw", …         which strip or corner is held
   *   d      { x, y }             how far the pointer has moved, in the box's own pixels
   *   o      { ax, ay, minW, minH, maxW, maxH }
   *            ax / ay: "start" (held by its left / top), "end" (held by its right / bottom),
   *            "center" (the page keeps it centred, so it grows both ways: the pointer moves
   *            twice as far as the edge it holds)
   * A box held by its start edge moves x or y when that edge is dragged; a box held by its end
   * edge has no strip on the side it is held by.
   */
  function dragBox(start, edge, d, o) {
    var out = { w: start.w, h: start.h, x: start.x, y: start.y };
    var kx = o.ax === "center" ? 2 : 1;
    var ky = o.ay === "center" ? 2 : 1;
    if (edge.indexOf("e") >= 0 && o.ax !== "end") out.w = clamp(start.w + d.x * kx, o.minW, o.maxW);
    if (edge.indexOf("w") >= 0) {
      out.w = clamp(start.w - d.x * kx, o.minW, o.maxW);
      if (o.ax === "start") out.x = start.x + (start.w - out.w);
    }
    if (edge.indexOf("s") >= 0 && o.ay !== "end") out.h = clamp(start.h + d.y * ky, o.minH, o.maxH);
    if (edge.indexOf("n") >= 0) {
      out.h = clamp(start.h - d.y * ky, o.minH, o.maxH);
      if (o.ay === "start") out.y = start.y + (start.h - out.h);
    }
    return out;
  }
  /** The keyboard's version: bigger or smaller by dw, dh (the position never changes). */
  function sizeBy(start, dw, dh, o) {
    return { w: clamp(start.w + dw, o.minW, o.maxW), h: clamp(start.h + dh, o.minH, o.maxH), x: start.x, y: start.y };
  }
  var pure = { dragBox: dragBox, sizeBy: sizeBy, clamp: clamp };
  if (typeof module !== "undefined" && module.exports) module.exports = pure;
  if (typeof document === "undefined" || root.BeeZillaResize) return;

  // ── The boxes that exist today ─────────────────────────────────────────────────────────
  // sel: what to look for. edges: the strips. ax / ay: how it sits (see dragBox). min / max:
  // [width, height] in the box's own pixels. bound: "window", "parent" or "none" (a card on a
  // board has no edge but the board's own). key: remember the size. media: only while this
  // holds. off: not while the box matches this (its own folded-up look). save: "none" when
  // someone else keeps the size. name: for a screen reader.
  var BOXES = [
    // The conversation, a card on the Idea Board. whiteboard.js keeps its size in the card.
    { sel: ".wb-card.wb-k-chat", edges: "all", ax: "start", ay: "start", min: [260, 220], max: [3000, 4000], bound: "none", save: "none", name: "the conversation" },
    // The Idea Board itself, taller or shorter by its bottom edge. (A phone's board is already
    // as tall as its page needs.)
    { sel: "#obBoard", edges: "s", ay: "start", min: [0, 360], max: [0, 3000], bound: "none", key: "board", media: "(min-width: 761px)", name: "the Idea Board" },
    // The board's earlier versions: held by the corner it opens in, so it grows left and up.
    { sel: ".wb-history", edges: "w n nw", ax: "end", ay: "end", min: [260, 200], bound: "parent", key: "board-history", name: "History" },
    // The step editor: opens beside its card, so it grows right and down.
    { sel: ".wb-editor", edges: "e s se", ax: "start", ay: "start", min: [280, 240], bound: "parent", key: "board-editor", name: "the step editor" },
    // Feedback hangs from the top right corner; folded up it is a small pill again.
    { sel: "#bzFeedback", edges: "w s sw", ax: "end", ay: "start", min: [320, 260], bound: "window", key: "feedback", off: ".min", name: "Feedback" },
  ];
  var ALL = ["ne", "nw", "se", "sw", "n", "s", "e", "w"];
  var MAIN = ["se", "sw", "ne", "nw", "s", "e", "w", "n"];   // the one you can Tab to
  var KEY = "bz.size.";
  var MARGIN = 12;     // never closer than this to the window's edge
  var STEP = 16, BIG = 64;
  var MIN_W = 200, MIN_H = 120;
  var tracked = [];

  // ── Remembering ────────────────────────────────────────────────────────────────────────
  function load(key) {
    try {
      var j = JSON.parse(localStorage.getItem(KEY + key) || "null");
      if (!j || typeof j !== "object") return null;
      var out = {};
      if (isFinite(j.w) && j.w > 0) out.w = Math.round(j.w);
      if (isFinite(j.h) && j.h > 0) out.h = Math.round(j.h);
      return out.w || out.h ? out : null;
    } catch (_) { return null; }
  }
  function save(key, size) {
    try {
      if (size) localStorage.setItem(KEY + key, JSON.stringify(size));
      else localStorage.removeItem(KEY + key);
    } catch (_) { /* a private window: the size just isn't remembered */ }
  }

  // ── What a box is ──────────────────────────────────────────────────────────────────────
  function words(v) { return String(v || "").split(/\s+/).filter(Boolean); }
  function pair(v) {
    var p = words(v).map(Number);
    return p.length >= 2 && isFinite(p[0]) && isFinite(p[1]) ? [p[0], p[1]] : null;
  }
  function fromAttributes(el) {
    var a = el.getAttribute("data-bz-resize");
    if (a === null) return null;
    var edges = words(a);
    if (!edges.length) edges = ["e", "s", "se"];
    var an = words(el.getAttribute("data-bz-resize-anchor"));
    return {
      sel: null,
      edges: edges.indexOf("all") >= 0 ? "all" : edges.join(" "),
      ax: an[0] || "start",
      ay: an[1] || an[0] || "start",
      min: pair(el.getAttribute("data-bz-resize-min")),
      max: pair(el.getAttribute("data-bz-resize-max")),
      bound: el.getAttribute("data-bz-resize-bound") || "window",
      key: el.getAttribute("data-bz-resize-key") || "",
      name: el.getAttribute("data-bz-resize-name") || "",
    };
  }
  function configOf(el) {
    for (var i = 0; i < BOXES.length; i++) {
      try { if (el.matches(BOXES[i].sel)) return BOXES[i]; } catch (_) { /* not an element */ }
    }
    return fromAttributes(el);
  }
  function edgesOf(cfg) {
    var list = cfg.edges === "all" ? ALL : words(cfg.edges);
    return list.filter(function (e) { return ALL.indexOf(e) >= 0; });
  }
  function mainOf(edges) {
    for (var i = 0; i < MAIN.length; i++) if (edges.indexOf(MAIN[i]) >= 0) return MAIN[i];
    return null;
  }

  // ── The box's own sums: its scale, its room, its limits ────────────────────────────────
  function scaleOf(el, rect) {
    var s = el.offsetWidth ? rect.width / el.offsetWidth : 1;
    return s > 0 && isFinite(s) ? s : 1;
  }
  function roomOf(el, cfg) {
    if (cfg.bound === "parent") {
      var p = el.offsetParent || el.parentElement;
      if (p) { var r = p.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }
    }
    return { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: window.innerHeight };
  }
  // The limits for a drag that grows toward dirX ("e" or "w") and dirY ("s" or "n").
  function limitsFor(el, cfg, dirX, dirY, rect, scale) {
    var ax = cfg.ax || "start", ay = cfg.ay || "start";
    var o = {
      ax: ax, ay: ay,
      minW: cfg.min ? cfg.min[0] : MIN_W, minH: cfg.min ? cfg.min[1] : MIN_H,
      maxW: cfg.max && cfg.max[0] ? cfg.max[0] : Infinity, maxH: cfg.max && cfg.max[1] ? cfg.max[1] : Infinity,
    };
    if (cfg.bound !== "none") {
      var room = roomOf(el, cfg), w, h;
      if (ax === "center") w = (room.right - room.left - 2 * MARGIN) / scale;
      else if (ax === "end" || dirX === "w") w = (rect.right - room.left - MARGIN) / scale;
      else w = (room.right - rect.left - MARGIN) / scale;
      if (ay === "center") h = (room.bottom - room.top - 2 * MARGIN) / scale;
      else if (ay === "end" || dirY === "n") h = (rect.bottom - room.top - MARGIN) / scale;
      else h = (room.bottom - rect.top - MARGIN) / scale;
      o.maxW = Math.min(o.maxW, w);
      o.maxH = Math.min(o.maxH, h);
    }
    if (o.maxW < o.minW) o.maxW = o.minW;
    if (o.maxH < o.minH) o.maxH = o.minH;
    return o;
  }
  // Grows toward the side it is NOT held by.
  function dirsOf(cfg) {
    return { x: cfg.ax === "end" ? "w" : "e", y: cfg.ay === "end" ? "n" : "s" };
  }
  function extraOf(el) {
    var cs = getComputedStyle(el);
    if (cs.boxSizing === "border-box") return { x: 0, y: 0 };
    return {
      x: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0),
      y: (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0),
    };
  }
  // Put a size on the box. Only the axes given; the box's own caps (max-width…) step aside,
  // the room above already keeps it inside the window.
  function setBox(el, size) {
    var ex = extraOf(el);
    if (size.w != null) { el.style.width = Math.round(size.w - ex.x) + "px"; el.style.maxWidth = "none"; }
    if (size.h != null) { el.style.height = Math.round(size.h - ex.y) + "px"; el.style.maxHeight = "none"; }
    if (size.x != null) el.style.left = Math.round(size.x) + "px";
    if (size.y != null) el.style.top = Math.round(size.y) + "px";
  }
  function clearBox(el) {
    el.style.width = ""; el.style.height = ""; el.style.maxWidth = ""; el.style.maxHeight = "";
  }
  function emit(el, name, detail) {
    try { el.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: detail })); } catch (_) { /* old browser */ }
  }

  // ── A box that is resizable ────────────────────────────────────────────────────────────
  function ensure(el, cfg) {
    var st = el._bzrs;
    var first = !st;
    if (first) {
      st = el._bzrs = { cfg: cfg, size: null, off: false, drag: null };
      tracked.push(el);
      if (getComputedStyle(el).position === "static") el.style.position = "relative";
      if (cfg.off) {
        // Folded up (Feedback's .min) it is a different box: no strips, no size.
        try { new MutationObserver(function () { sync(el); }).observe(el, { attributes: true, attributeFilter: ["class"] }); } catch (_) { /* no observer */ }
      }
      if (cfg.key && cfg.save !== "none") { var saved = load(cfg.key); if (saved) st.size = saved; }
    }
    var edges = edgesOf(cfg), main = mainOf(edges);
    edges.forEach(function (edge) {
      for (var i = 0; i < el.children.length; i++) if (el.children[i].getAttribute("data-edge") === edge && el.children[i].classList.contains("bz-rs")) return;
      el.appendChild(handle(el, edge, edge === main));
    });
    sync(el);
  }
  function handle(el, edge, isMain) {
    var h = document.createElement("span");
    h.className = "bz-rs bz-rs-" + edge + (isMain ? " bz-rs-main" : "");
    h.setAttribute("data-edge", edge);
    if (isMain) {
      var name = el._bzrs.cfg.name || el.getAttribute("aria-label") || "this box";
      h.tabIndex = 0;
      h.setAttribute("role", "button");
      h.setAttribute("aria-label", "Resize " + name + ". Arrow keys change its size, Home puts it back.");
      h.title = "Drag to make it bigger or smaller. Double-click puts it back.";
      h.addEventListener("keydown", onKey);
    } else {
      h.setAttribute("aria-hidden", "true");
    }
    h.addEventListener("pointerdown", onDown);
    h.addEventListener("dblclick", onReset);
    // A press that lands here is the resize's, not the box's: nothing under it should see it.
    h.addEventListener("click", function (e) { e.stopPropagation(); });
    h.addEventListener("dragstart", function (e) { e.preventDefault(); });
    return h;
  }
  // Off (folded, or the window is too small for it): no size, no strips; back on: its size.
  function sync(el) {
    var st = el._bzrs;
    if (!st) return;
    var cfg = st.cfg, off = false;
    try {
      if (cfg.off && el.matches(cfg.off)) off = true;
      if (cfg.media && !window.matchMedia(cfg.media).matches) off = true;
    } catch (_) { /* keep it on */ }
    if (off !== st.off || (!off && st.size && !el.style.width && !el.style.height)) {
      st.off = off;
      if (off) { el.setAttribute("data-bz-rs-off", ""); clearBox(el); }
      else { el.removeAttribute("data-bz-rs-off"); if (st.size) setBox(el, st.size); }
    }
  }
  function remember(el, size) {
    var st = el._bzrs, cfg = st.cfg;
    var mine = {};
    var edges = edgesOf(cfg).join("");
    if (/[ew]/.test(edges) && size.w != null) mine.w = Math.round(size.w);
    if (/[ns]/.test(edges) && size.h != null) mine.h = Math.round(size.h);
    st.size = mine;
    if (cfg.key && cfg.save !== "none") save(cfg.key, mine);
  }
  function reset(el) {
    var st = el._bzrs;
    if (!st) return;
    st.size = null;
    clearBox(el);
    if (st.cfg.key && st.cfg.save !== "none") save(st.cfg.key, null);
    emit(el, "bz:resized", { w: null, h: null, x: null, y: null, reset: true });
  }
  function onReset(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = e.currentTarget.parentNode;
    if (el._bzrs && !el._bzrs.off) reset(el);
  }

  // ── Dragging ───────────────────────────────────────────────────────────────────────────
  function onDown(e) {
    var h = e.currentTarget, el = h.parentNode, st = el._bzrs;
    if (!st || st.off || st.drag) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.isPrimary === false) return;
    e.preventDefault();
    e.stopPropagation();
    var cfg = st.cfg, edge = h.getAttribute("data-edge");
    var rect = el.getBoundingClientRect(), scale = scaleOf(el, rect), cs = getComputedStyle(el);
    var start = { w: el.offsetWidth, h: el.offsetHeight, x: parseFloat(cs.left), y: parseFloat(cs.top) };
    var o = limitsFor(el, cfg,
      edge.indexOf("w") >= 0 ? "w" : "e",
      edge.indexOf("n") >= 0 ? "n" : "s", rect, scale);
    var before = { width: el.style.width, height: el.style.height, maxWidth: el.style.maxWidth, maxHeight: el.style.maxHeight, left: el.style.left, top: el.style.top };
    var x0 = e.clientX, y0 = e.clientY, last = null, pid = e.pointerId;
    var cursor = /^(n|s)$/.test(edge) ? "ns" : /^(e|w)$/.test(edge) ? "ew" : (edge === "nw" || edge === "se") ? "nwse" : "nesw";
    st.drag = true;
    try { h.setPointerCapture(pid); } catch (_) { /* the page still gets the moves */ }
    document.documentElement.setAttribute("data-bz-rs", cursor);
    emit(el, "bz:resizestart", {});

    function move(ev) {
      if (ev.pointerId !== pid) return;
      var d = { x: (ev.clientX - x0) / scale, y: (ev.clientY - y0) / scale };
      var out = dragBox(start, edge, d, o);
      var put = {};
      if (/[ew]/.test(edge)) put.w = out.w;
      if (/[ns]/.test(edge)) put.h = out.h;
      if (edge.indexOf("w") >= 0 && o.ax === "start") put.x = out.x;
      if (edge.indexOf("n") >= 0 && o.ay === "start") put.y = out.y;
      setBox(el, put);
      last = { w: el.offsetWidth, h: el.offsetHeight, x: put.x != null ? put.x : start.x, y: put.y != null ? put.y : start.y };
      emit(el, "bz:resize", last);
    }
    function finish(ev, keep) {
      if (ev && ev.pointerId !== undefined && ev.pointerId !== pid) return;
      h.removeEventListener("pointermove", move);
      h.removeEventListener("pointerup", up);
      h.removeEventListener("pointercancel", cancel);
      h.removeEventListener("lostpointercapture", cancel);
      document.removeEventListener("keydown", esc, true);
      document.documentElement.removeAttribute("data-bz-rs");
      try { h.releasePointerCapture(pid); } catch (_) { /* already let go */ }
      st.drag = null;
      if (keep && last) {
        remember(el, last);
        emit(el, "bz:resized", last);
      } else if (!keep) {
        el.style.width = before.width; el.style.height = before.height;
        el.style.maxWidth = before.maxWidth; el.style.maxHeight = before.maxHeight;
        el.style.left = before.left; el.style.top = before.top;
        if (last) emit(el, "bz:resize", { w: el.offsetWidth, h: el.offsetHeight, x: start.x, y: start.y });
      }
      emit(el, "bz:resizeend", {});
    }
    function up(ev) { finish(ev, true); }
    function cancel(ev) { finish(ev, false); }
    // Esc takes the drag back. It is the drag's own: the box does not close, and nothing
    // else hears it.
    function esc(ev) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(null, false);
    }
    h.addEventListener("pointermove", move);
    h.addEventListener("pointerup", up);
    h.addEventListener("pointercancel", cancel);
    h.addEventListener("lostpointercapture", cancel);
    document.addEventListener("keydown", esc, true);
  }

  // The corner you can Tab to: arrows change the size, Home puts it back.
  function onKey(e) {
    var h = e.currentTarget, el = h.parentNode, st = el._bzrs;
    if (!st || st.off) return;
    var by = e.shiftKey ? BIG : STEP, dw = 0, dh = 0;
    if (e.key === "ArrowRight") dw = by;
    else if (e.key === "ArrowLeft") dw = -by;
    else if (e.key === "ArrowDown") dh = by;
    else if (e.key === "ArrowUp") dh = -by;
    else if (e.key === "Home") { e.preventDefault(); e.stopPropagation(); reset(el); return; }
    else return;
    e.preventDefault();
    e.stopPropagation();
    var cfg = st.cfg, edges = edgesOf(cfg).join("");
    if (!/[ew]/.test(edges)) dw = 0;       // a strip along the bottom only changes the height
    if (!/[ns]/.test(edges)) dh = 0;
    if (!dw && !dh) return;
    var rect = el.getBoundingClientRect(), scale = scaleOf(el, rect), dir = dirsOf(cfg);
    var o = limitsFor(el, cfg, dir.x, dir.y, rect, scale);
    var next = sizeBy({ w: el.offsetWidth, h: el.offsetHeight, x: 0, y: 0 }, dw, dh, o);
    var put = {};
    if (dw) put.w = next.w;
    if (dh) put.h = next.h;
    setBox(el, put);
    var now = { w: el.offsetWidth, h: el.offsetHeight, x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 };
    remember(el, now);
    emit(el, "bz:resize", now);
    emit(el, "bz:resized", now);
  }

  // ── Finding boxes ──────────────────────────────────────────────────────────────────────
  function consider(node) {
    if (!node || node.nodeType !== 1 || (node.classList && node.classList.contains("bz-rs"))) return;
    var cfg = configOf(node);
    if (cfg) ensure(node, cfg);
  }
  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    consider(node);
    var sels = BOXES.map(function (b) { return b.sel; }).concat(["[data-bz-resize]"]).join(",");
    var found = node.querySelectorAll(sels);
    for (var i = 0; i < found.length; i++) consider(found[i]);
  }
  function refit() {
    tracked = tracked.filter(function (el) { return el.isConnected; });
    tracked.forEach(function (el) {
      var st = el._bzrs;
      sync(el);
      if (st.off || st.drag || !st.size || st.cfg.bound === "none") return;
      // The window got smaller: a box that was made big enough to leave it comes back in.
      var rect = el.getBoundingClientRect();
      if (!rect.width) return;
      var dir = dirsOf(st.cfg);
      var o = limitsFor(el, st.cfg, dir.x, dir.y, rect, scaleOf(el, rect));
      var put = {};
      if (el.offsetWidth > o.maxW + 0.5) put.w = o.maxW;
      if (el.offsetHeight > o.maxH + 0.5) put.h = o.maxH;
      if (put.w != null || put.h != null) setBox(el, put);
    });
  }

  // ── Looks ──────────────────────────────────────────────────────────────────────────────
  var CSS = [
    ".bz-rs{position:absolute;z-index:6;touch-action:none;-webkit-user-select:none;user-select:none}",
    "[data-bz-rs-off]>.bz-rs{display:none}",
    ".bz-rs-n,.bz-rs-s{left:18px;right:18px;height:6px}",
    ".bz-rs-e,.bz-rs-w{top:18px;bottom:18px;width:6px}",
    ".bz-rs-n{top:0;cursor:ns-resize}.bz-rs-s{bottom:0;cursor:ns-resize}",
    ".bz-rs-e{right:0;cursor:ew-resize}.bz-rs-w{left:0;cursor:ew-resize}",
    ".bz-rs-ne,.bz-rs-nw,.bz-rs-se,.bz-rs-sw{width:18px;height:18px}",
    ".bz-rs-ne{top:0;right:0;cursor:nesw-resize}.bz-rs-sw{bottom:0;left:0;cursor:nesw-resize}",
    ".bz-rs-nw{top:0;left:0;cursor:nwse-resize}.bz-rs-se{bottom:0;right:0;cursor:nwse-resize}",
    // A line lights along the edge you are about to grab.
    ".bz-rs-n:hover::after,.bz-rs-s:hover::after,.bz-rs-e:hover::after,.bz-rs-w:hover::after{content:'';position:absolute;background:#ffc107;opacity:.85;border-radius:2px}",
    ".bz-rs-n:hover::after,.bz-rs-s:hover::after{left:0;right:0;height:2px}",
    ".bz-rs-n:hover::after{top:0}.bz-rs-s:hover::after{bottom:0}",
    ".bz-rs-e:hover::after,.bz-rs-w:hover::after{top:0;bottom:0;width:2px}",
    ".bz-rs-e:hover::after{right:0}.bz-rs-w:hover::after{left:0}",
    // The corner you can Tab to wears a small grip: this one resizes.
    ".bz-rs-main{color:inherit}",
    ".bz-rs-main.bz-rs-ne::before,.bz-rs-main.bz-rs-nw::before,.bz-rs-main.bz-rs-se::before,.bz-rs-main.bz-rs-sw::before{content:'';position:absolute;width:10px;height:10px;opacity:.5;pointer-events:none;" +
      "background:linear-gradient(135deg,transparent 0 46%,currentColor 46% 56%,transparent 56% 70%,currentColor 70% 80%,transparent 80%)}",
    ".bz-rs-main.bz-rs-se::before{right:3px;bottom:3px}",
    ".bz-rs-main.bz-rs-sw::before{left:3px;bottom:3px;transform:scaleX(-1)}",
    ".bz-rs-main.bz-rs-nw::before{left:3px;top:3px;transform:scale(-1,-1)}",
    ".bz-rs-main.bz-rs-ne::before{right:3px;top:3px;transform:scaleY(-1)}",
    ".bz-rs-main:hover::before,.bz-rs-main:focus-visible::before{opacity:1;color:#ffc107}",
    ".bz-rs-main:focus-visible{outline:2px solid #ffc107;outline-offset:-2px;border-radius:4px}",
    // Dragging: the pointer keeps the resize shape wherever it goes, and nothing is selected.
    "html[data-bz-rs],html[data-bz-rs] *{-webkit-user-select:none!important;user-select:none!important}",
    "html[data-bz-rs=ns],html[data-bz-rs=ns] *{cursor:ns-resize!important}",
    "html[data-bz-rs=ew],html[data-bz-rs=ew] *{cursor:ew-resize!important}",
    "html[data-bz-rs=nwse],html[data-bz-rs=nwse] *{cursor:nwse-resize!important}",
    "html[data-bz-rs=nesw],html[data-bz-rs=nesw] *{cursor:nesw-resize!important}",
    // A finger needs more to hold.
    "@media (pointer:coarse){.bz-rs-n,.bz-rs-s{height:14px}.bz-rs-e,.bz-rs-w{width:14px}.bz-rs-ne,.bz-rs-nw,.bz-rs-se,.bz-rs-sw{width:28px;height:28px}",
    ".bz-rs-main.bz-rs-se::before{right:6px;bottom:6px}.bz-rs-main.bz-rs-sw::before{left:6px;bottom:6px}.bz-rs-main.bz-rs-nw::before{left:6px;top:6px}.bz-rs-main.bz-rs-ne::before{right:6px;top:6px}}",
  ].join("\n");
  function paint() {
    if (document.getElementById("bz-resize-css")) return;
    var s = document.createElement("style");
    s.id = "bz-resize-css";
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Start ──────────────────────────────────────────────────────────────────────────────
  function start() {
    paint();
    scan(document.documentElement);
    var queue = [], waiting = false;
    function flush() {
      waiting = false;
      var nodes = queue; queue = [];
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.isConnected) scan(n);
      }
    }
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type === "attributes") { queue.push(m.target); continue; }
        // A box whose children were swept away (a card drawn again) needs its strips back;
        // a node that arrived may be a box, or hold one.
        if (m.target && m.target._bzrs) queue.push(m.target);
        for (var j = 0; j < m.addedNodes.length; j++) if (m.addedNodes[j].nodeType === 1) queue.push(m.addedNodes[j]);
      }
      if (queue.length && !waiting) { waiting = true; (window.requestAnimationFrame || setTimeout)(flush); }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-bz-resize"] });
    window.addEventListener("resize", refit);
  }

  root.BeeZillaResize = {
    dragBox: dragBox,
    sizeBy: sizeBy,
    /** Make one box resizable now (the same attributes, as an object: edges, ax, ay, min, max, bound, key, name). */
    attach: function (el, cfg) { if (el && cfg) ensure(el, cfg); },
    /** Forget a box that is going away (a dialog that closed): it is no longer tracked, so nothing here keeps it alive. */
    detach: function (el) {
      if (!el) return;
      tracked = tracked.filter(function (x) { return x !== el; });
      try { delete el._bzrs; } catch (_) { el._bzrs = null; }
    },
    /** Put a box back at the size it opens at. */
    reset: reset,
    boxes: BOXES,
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(typeof window !== "undefined" ? window : this);
