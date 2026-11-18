/**
 * The Whiteboard — where BeeZilla's work happens, live.
 *
 * Owner, 2026-11-18:
 *   "It should start building the whiteboard immediately… the moment it reads the
 *    agent.md, it puts the agent.md on the whiteboard. And then the moment it goes to
 *    your first skill, it draws a line from the agent.md to the skill, and the next
 *    skill… You're seeing what the agent is doing in real time so that you can edit
 *    the process."
 *   "I need to be able to design my own orchestrations… the agent.md… a bunch of skills
 *    and how they connect, and the output… select a bunch of those things, like an
 *    area within the board, and say create recipe."
 *   "When you generate music or 3D, it should happen in a bubble in the whiteboard."
 *   "The whiteboard by default should be distinct from its background… everything
 *    should be able to be dragged in there."
 *
 * Board behaviour follows Miro's defaults, so it works the way people already expect:
 *   - Pan: drag with the Hand tool (H), hold Space and drag, middle-drag, or scroll /
 *     two-finger swipe. Zoom: pinch, or Ctrl/⌘ + scroll, at the cursor; − / + and
 *     "Fit" (Shift+1) sit bottom-right with the zoom level.
 *   - Select (V): click a card, Shift-click to add, drag on empty board for a box
 *     selection. Ctrl/⌘+A all, Esc none, Delete removes, Ctrl/⌘+D duplicates,
 *     Ctrl/⌘+Z / Shift+Ctrl/⌘+Z undo and redo, arrow keys nudge (Shift = 10×).
 *   - A floating bar over a selection holds what you can do with it: Create recipe,
 *     Remove.
 *   - Cards: agent.md, skills, outputs, notes — and every file kind. Drag a yellow
 *     corner handle onto another card to connect them. Double-click to edit text.
 *   - Drop anything on it: files from your computer, Inspiration cards, search
 *     results, links.
 *
 *   var board = BeeZillaWhiteboard.mount(el, { boardId, onFold });
 *   board.flow(step)        // a live step from the chat stream (see FlowStep in server.ts)
 *   board.addCard(card)     // a file, a note, anything
 *   board.addGraph(graph)   // a saved recipe, back on the board to edit or run
 *   board.instructions()    // the person's own edits, sent with their next message
 *   board.dock / board.side // slots the page fills: the Talk bar and the conversation
 *
 * One board per conversation, saved to the person's account so it follows them to any
 * computer, with a History to go back to (see "Saving" below). This browser keeps a
 * copy too (localStorage "bz.board.<id>", version 2): the board opens from it at once,
 * and it holds every edit while the account can't be reached.
 * Built from DOM nodes and textContent only — nothing from a card is ever HTML.
 */
(function () {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";
  var MAX_CARDS = 160;
  var ZMIN = 0.2, ZMAX = 3;
  var CORNERS = ["nw", "ne", "sw", "se"];
  var COL_GAP = 120;

  // ── Icons: inline SVG (an emoji glyph does not render everywhere) ──────────
  var ICONS = {
    select: "M5 3l13 8-6 1.5 3.5 7-2.5 1.2-3.5-7L5 18z",
    hand: "M8 11V5.5a1.5 1.5 0 013 0V10m0-.5V4.5a1.5 1.5 0 013 0V10m0-4a1.5 1.5 0 013 0v7a7 7 0 01-7 7h-.6a6 6 0 01-4.6-2.2L4 15.5a1.6 1.6 0 012.4-2.1L8 15V11",
    note: "M5 4h14v10l-5 6H5zM14 20v-6h5",
    agent: "M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7",
    skill: "M12 2l2.2 6.3L21 9l-5.2 4 1.8 6.6L12 16l-5.6 3.6L8.2 13 3 9l6.8-.7z",
    output: "M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 17v3h16v-3",
    upload: "M12 21V9m0 0l-4.5 4.5M12 9l4.5 4.5M4 7V4h16v3",
    fit: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
    minus: "M5 12h14",
    plus: "M12 5v14M5 12h14",
    recipe: "M5 6h14M5 12h10M5 18h6",
    trash: "M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13",
    keys: "M3 7h18v10H3zM6 10h1M9 10h1M12 10h1M15 10h1M18 10h1M7 14h10",
    fold: "M6 14l6-6 6 6",
    play: "M7 4.5v15l13-7.5z",
    cube: "M12 2l9 5v10l-9 5-9-5V7zM12 12l9-5M12 12L3 7M12 12v10",
    doc: "M6 3h9l4 4v14H6zM15 3v4h4",
    image: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15 9.5a1.5 1.5 0 100 .1",
    video: "M3 6h13v12H3zM16 10l5-3v10l-5-3",
    file: "M6 3h9l4 4v14H6z",
    memory: "M12 3a7 7 0 00-4 12.7V19h8v-3.3A7 7 0 0012 3zM9 22h6",
    history: "M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2",
  };
  function icon(name, cls) {
    var s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", "wb-ico" + (cls ? " " + cls : ""));
    var p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", ICONS[name] || ICONS.file);
    s.appendChild(p);
    return s;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function uid() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function typingInto(t) {
    return !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
  }

  // What a card is, from whatever the source called it.
  function kindOf(c) {
    var k = String(c.kind || "").toLowerCase();
    if (k === "agent" || k === "skill" || k === "memory" || k === "note") return k;
    var name = String(c.title || c.url || "").toLowerCase();
    var t = String(c.contentType || "").toLowerCase();
    if (k === "photo" || k === "image" || /^image\//.test(t) || /\.(png|jpe?g|gif|webp|svg|avif)$/.test(name)) return "image";
    if (k === "audio" || k === "track" || /^audio\//.test(t) || /\.(mp3|wav|m4a|ogg|flac)$/.test(name)) return "track";
    if (k === "3d" || k === "model" || /gltf|glb/.test(t) || /\.(glb|gltf|obj|usdz)$/.test(name)) return "model";
    if (k === "video" || /^video\//.test(t) || /\.(mp4|mov|webm)$/.test(name)) return "video";
    if (/\.(xlsx?|csv)$/.test(name) || /sheet|csv/.test(t) || k === "sheet") return "sheet";
    if (/\.(pptx?|key)$/.test(name) || /presentation/.test(t) || k === "slides") return "slides";
    if (/\.pdf$/.test(name) || /pdf/.test(t) || k === "pdf") return "pdf";
    if (k === "document" || k === "output" || /\.(docx?|md|txt|rtf)$/.test(name) || /word|text\//.test(t)) return "document";
    return "file";
  }
  var ROLE = { agent: "agent", skill: "skill", memory: "skill", note: "note" };
  function roleOf(kind) { return ROLE[kind] || "output"; }
  var GLYPH = { document: "W", sheet: "E", slides: "P", pdf: "PDF" };
  var KIND_LABEL = {
    agent: "Instructions", skill: "Skill", memory: "Memory", note: "Note", image: "Picture", track: "Music",
    model: "3D model", video: "Video", document: "Document", sheet: "Spreadsheet", slides: "Slides", pdf: "PDF", file: "File",
  };

  // ── Saving: this browser at once, then the person's account ───────────────
  //
  // Asked 2026-11-18: save the board "to the person's account instead of only this
  // browser, so a board follows them to any computer, with a simple history to go
  // back to."
  //
  //  - Every change is written to this browser straight away (localStorage
  //    "bz.board.<id>"). That copy is also the buffer while the account can't be
  //    reached: nothing is lost offline, and it catches up when the connection is back.
  //  - A moment later the board goes to the account (PUT /api/buzzy/whiteboards/<id>),
  //    naming the revision it started from. If another computer saved in between, the
  //    account sends its copy back and the two are merged card by card — each side's
  //    changes kept, and where both changed the same thing, this computer's wins —
  //    before saving again. Nothing is silently overwritten.
  //  - Opening a board reads the account's copy. A board that was only ever in this
  //    browser moves up to the account (older ones too, quietly, in the background).
  //  - History (the clock by the zoom) lists the account's earlier versions; "Go back
  //    to this" brings one back, and the board you had stays in the list.
  //
  // The local copy carries a `sync` note that never leaves this browser:
  //   rev   — the account's revision this copy is based on (null: not there yet)
  //   dirty — changed here since the account last confirmed it
  //   base  — the cards and lines as of `rev`, kept while dirty, to merge against
  //   who   — which account it was last saved to (a short code from the account), so
  //           on a shared computer one person's unsaved board never goes into another's
  var API = "/api/buzzy/whiteboards/";
  var PREFIX = "bz.board.";
  var SCRATCH = "talk";                  // the board in front of a conversation with no id yet
  var PUSH_WAIT = 1500, PUSH_MAX_WAIT = 10000;
  function keyFor(id) { return PREFIX + String(id || "default").slice(0, 80); }
  function blank() { return { v: 2, cards: [], links: [], view: { x: 0, y: 0, z: 1 }, sync: { rev: null, dirty: false, base: null } }; }
  function copy(v) { return JSON.parse(JSON.stringify(v)); }
  function hasContent(s) { return !!(s && ((s.cards && s.cards.length) || (s.links && s.links.length))); }

  // v1 boards from the old panel are upgraded in place; boards from before the
  // account kept them have no sync note yet, and count as not saved there.
  function load(key) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || "null");
      if (!v || !Array.isArray(v.cards)) return null;
      if (v.v !== 2) {
        v.cards.forEach(function (c) { c.kind = kindOf(c); c.body = c.body || ""; });
        v.links = (v.links || []).map(function (l) {
          return { id: uid(), from: l.from.id, to: l.to.id, fc: l.from.corner, tc: l.to.corner };
        });
        v.v = 2;
      }
      v.links = Array.isArray(v.links) ? v.links : [];
      v.view = v.view || { x: 0, y: 0, z: 1 };
      if (!v.sync || typeof v.sync !== "object") v.sync = { rev: null, dirty: hasContent(v), base: null };
      return v;
    } catch (_) { return null; }
  }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch (_) { return false; } }

  // Stable JSON (keys sorted): the account hands cards back with its own key order.
  function canon(v) {
    if (v === null || v === undefined || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    return "{" + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort()
      .map(function (k) { return JSON.stringify(k) + ":" + canon(v[k]); }).join(",") + "}";
  }
  // What a board holds, as the account keeps it: its cards and lines (the view is this
  // screen's, and a line's drawing flag is only for this page).
  function linkOut(l) {
    var o = { id: l.id, from: l.from, to: l.to };
    if (l.fc) o.fc = l.fc;
    if (l.tc) o.tc = l.tc;
    return o;
  }
  function contentOf(s) { return { cards: (s && s.cards) || [], links: ((s && s.links) || []).map(linkOut) }; }
  function sigOf(s) { return canon(contentOf(s)); }
  function forAccount(s) {
    var c = contentOf(s);
    var out = { v: 2, cards: c.cards, links: c.links, view: s.view || { x: 0, y: 0, z: 1 } };
    if (s.viewSet) out.viewSet = true;
    return out;
  }

  // Two copies of one board, merged: `base` is what both started from, `mine` this
  // computer's, `theirs` the account's. Card by card and line by line, each side's
  // changes are kept; a card both sides changed is merged field by field, and where
  // both changed the same field this computer's wins. A card removed on one side and
  // changed on the other is kept rather than lost. A step BeeZilla drew on both
  // computers (the same step id) stays one card. With nothing in common to start
  // from, this computer's new cards go below the account's, not on top of them.
  function merge3(base, mine, theirs) {
    function byId(list) { var m = {}; (list || []).forEach(function (x) { if (x && x.id != null) m[x.id] = x; }); return m; }
    function same(a, b) { return canon(a) === canon(b); }
    function both(b, m, t) {
      if (same(m, t)) return m;
      if (b && same(m, b)) return t;
      if (b && same(t, b)) return m;
      var out = {}, keys = {};
      [b || {}, m, t].forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = 1; }); });
      Object.keys(keys).forEach(function (k) {
        var v = canon(m[k]) === canon(t[k]) ? m[k] : b && canon(b[k]) === canon(m[k]) ? t[k] : m[k];
        if (v !== undefined) out[k] = v;
      });
      return out;
    }
    function side(listB, listM, listT) {
      var B = byId(listB), M = byId(listM), T = byId(listT);
      var out = [], seen = {};
      function take(x) {
        if (!x || x.id == null || seen[x.id]) return;
        seen[x.id] = 1;
        var b = B[x.id], m = M[x.id], t = T[x.id];
        if (m && t) out.push(both(b, m, t));
        else if (m) { if (!b || !same(m, b)) out.push(m); }      // they removed it: gone, unless changed here
        else if (t) { if (!b || !same(t, b)) out.push(t); }      // removed here: gone, unless they changed it
      }
      (listM || []).forEach(take);   // this computer's order first: its screen stays put
      (listT || []).forEach(take);
      return out;
    }
    base = base || { cards: [], links: [] };
    var cards = copy(side(base.cards, mine.cards, theirs.cards));
    var T = byId(theirs.cards), M = byId(mine.cards);

    // One step, one card: the account's card stays (other computers know its id),
    // finished beats still working, and the person's own words win.
    var steps = {}, alias = {}, dropped = {};
    cards.forEach(function (c) { if (c.flow) (steps[c.flow] = steps[c.flow] || []).push(c); });
    Object.keys(steps).forEach(function (f) {
      var group = steps[f];
      if (group.length < 2) return;
      var keepC = group.filter(function (c) { return T[c.id]; })[0] || group[0];
      group.forEach(function (o) {
        if (o === keepC) return;
        // The person's words: theirs if only one card has them; this computer's if both do.
        if (o.user && (!keepC.user || (M[o.id] && !T[o.id]))) { keepC.title = o.title; keepC.body = o.body; keepC.user = true; }
        ["url", "thumb", "contentType"].forEach(function (k) { if (!keepC[k] && o[k]) keepC[k] = o[k]; });
        if (keepC.state === "running" && o.state !== "running") {
          if (o.state === undefined) delete keepC.state; else keepC.state = o.state;
          if (o.err) keepC.err = o.err;
        }
        alias[o.id] = keepC.id;
        dropped[o.id] = 1;
      });
    });
    cards = cards.filter(function (c) { return !dropped[c.id]; });

    // Nothing in common to start from (two copies that never met): this computer's
    // own cards go below the account's rather than on top of them.
    if (!(base.cards || []).length && !(mine.cards || []).some(function (c) { return c && T[c.id]; })) {
      var mineOnly = cards.filter(function (c) { return M[c.id] && !T[c.id]; });
      var theirsHere = cards.filter(function (c) { return T[c.id]; });
      if (mineOnly.length && theirsHere.length) {
        var low = -Infinity, left = Infinity, top = Infinity, mLeft = Infinity;
        theirsHere.forEach(function (c) { low = Math.max(low, (c.y || 0) + 160); left = Math.min(left, c.x || 0); });
        mineOnly.forEach(function (c) { top = Math.min(top, c.y || 0); mLeft = Math.min(mLeft, c.x || 0); });
        if (top < low + 60) {
          mineOnly.forEach(function (c) { c.x = Math.round((c.x || 0) + left - mLeft); c.y = Math.round((c.y || 0) + low + 60 - top); });
        }
      }
    }

    var have = {};
    cards.forEach(function (c) { have[c.id] = 1; });
    var pairs = {};
    var links = copy(side(base.links, mine.links, theirs.links)).map(function (l) {
      if (alias[l.from]) l.from = alias[l.from];
      if (alias[l.to]) l.to = alias[l.to];
      return l;
    }).filter(function (l) {
      if (!have[l.from] || !have[l.to] || l.from === l.to) return false;
      var k = l.from < l.to ? l.from + "|" + l.to : l.to + "|" + l.from;
      if (pairs[k]) return false;
      pairs[k] = 1;
      return true;
    });
    return { cards: cards, links: links };
  }

  // The board in front of a new conversation ("talk") joins the conversation's own
  // board once the conversation has an id. A step BeeZilla already drew there (the
  // same step id) is the same card, brought up to date rather than drawn twice, and
  // the person's own words on it are kept. New cards go below what is there.
  function graft(into, from) {
    var cards = copy(into.cards || []), links = copy((into.links || []).map(linkOut));
    var byFlow = {}, ids = {}, map = {}, added = [];
    cards.forEach(function (c) { ids[c.id] = 1; if (c.flow) byFlow[c.flow] = c; });
    (from.cards || []).forEach(function (c0) {
      var c = copy(c0);
      var same = c.flow ? byFlow[c.flow] : null;
      if (same) {
        var keepHere = { id: 1, x: 1, y: 1, user: 1 };
        if (same.user) { keepHere.title = 1; keepHere.body = 1; }
        Object.keys(c).forEach(function (k) { if (!keepHere[k]) same[k] = c[k]; });
        map[c0.id] = same.id;
        return;
      }
      if (ids[c.id]) c.id = uid();
      ids[c.id] = 1;
      map[c0.id] = c.id;
      added.push(c);
    });
    if (cards.length && added.length) {
      var low = -Infinity, left = Infinity, top = Infinity, aLeft = Infinity;
      cards.forEach(function (c) { low = Math.max(low, (c.y || 0) + 160); left = Math.min(left, c.x || 0); });
      added.forEach(function (c) { top = Math.min(top, c.y || 0); aLeft = Math.min(aLeft, c.x || 0); });
      added.forEach(function (c) { c.x = Math.round((c.x || 0) + left - aLeft); c.y = Math.round((c.y || 0) + low + 60 - top); });
    }
    added.forEach(function (c) { cards.push(c); });
    var pairs = {};
    links.forEach(function (l) { pairs[l.from < l.to ? l.from + "|" + l.to : l.to + "|" + l.from] = 1; });
    (from.links || []).forEach(function (l0) {
      var a = map[l0.from], b = map[l0.to];
      if (!a || !b || a === b) return;
      var k = a < b ? a + "|" + b : b + "|" + a;
      if (pairs[k]) return;
      pairs[k] = 1;
      var l = { id: uid(), from: a, to: b };
      if (l0.fc) l.fc = l0.fc;
      if (l0.tc) l.tc = l0.tc;
      links.push(l);
    });
    return { cards: cards, links: links };
  }

  // Change a copy that isn't on screen, and note that the account hasn't seen it.
  function editDoc(doc, fn) {
    var before = contentOf(doc);
    fn(doc);
    if (canon(contentOf(doc)) === canon(before)) return false;
    if (!doc.sync.dirty) { doc.sync.dirty = true; doc.sync.base = doc.sync.rev == null ? null : copy(before); }
    return true;
  }

  // The signed-in account, as the short code every answer from the account carries.
  var whoNow = null;
  function request(method, url, body, keepalive) {
    var init = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    if (keepalive && init.body && init.body.length < 60000) init.keepalive = true;
    return fetch(url, init).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (j && typeof j.who === "string") whoNow = j.who;
        return { status: r.status, json: j };
      });
    });
  }
  // A copy last saved to another account (someone else signed in on this computer).
  function foreign(doc) { return !!(doc && doc.sync && doc.sync.who && whoNow && doc.sync.who !== whoNow); }
  function ours(doc) { if (whoNow) doc.sync.who = whoNow; }

  // One engine per board: its saves and reads run one at a time, in order, whether
  // or not the board is on screen (a board folded away still finishes saving).
  var engines = {};
  function engine(id) {
    id = String(id || "default").slice(0, 80);
    if (!engines[id]) {
      engines[id] = {
        id: id, chain: Promise.resolve(), live: null,
        timer: 0, firstAt: 0, retryTimer: 0, backoff: 0, fails: 0,
        status: "", msg: "", stuck: null, pulledAt: 0, told: {}, keepalive: false,
        cleanCopy: null, lastSig: null,
        // The account won't keep this board (another account's conversation, or a copy
        // someone else left unsaved here): it stays on this computer. Tried again on
        // the next page load, which may be that other person's.
        off: false,
      };
    }
    return engines[id];
  }
  function enqueue(e, fn) {
    var p = e.chain.then(function () { return fn(); });
    e.chain = p.then(function () {}, function () {});
    return p;
  }
  // The copy to work on: the board on screen (written down first), or this browser's.
  // Never held across a request: read again after every answer from the account.
  function docOf(e) {
    if (e.live) { e.live.flush(); return e.live.state; }
    return load(keyFor(e.id));
  }
  function keep(e, doc) {
    if (e.live && e.live.state === doc) e.live.write();
    else save(keyFor(e.id), doc);
  }
  function applyTo(e, doc, content) {
    if (e.live && e.live.state === doc) e.live.apply(content);
    else { doc.cards = copy(content.cards); doc.links = copy(content.links); save(keyFor(e.id), doc); }
    e.lastSig = sigOf(doc);
  }
  function setStatus(e, s, msg) {
    e.status = s;
    e.msg = msg || "";
    if (e.live) e.live.status();
  }
  // Never rebuild the board under someone's hand: wait for a drag or an edit to end.
  function whenIdle(e) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function check() {
        if (!e.live || !e.live.busy() || Date.now() - start > 20000) resolve();
        else setTimeout(check, 250);
      })();
    });
  }
  // Take the account's copy as it is (nothing here that it lacks).
  function adopt(e, doc, content, rev) {
    var changed = canon(content) !== sigOf(doc);
    doc.sync.rev = rev;
    doc.sync.dirty = false;
    doc.sync.base = null;
    ours(doc);
    e.cleanCopy = copy(content);
    if (changed) applyTo(e, doc, content);
    else keep(e, doc);
  }
  // Another computer saved since this one did: keep both sides' changes. Resolves
  // true when the merged board still has to be saved.
  function mergeWith(e, board) {
    return whenIdle(e).then(function () {
      var doc = docOf(e);
      if (!doc) return false;
      var theirs = contentOf(board.state);
      if (!doc.sync.dirty) { adopt(e, doc, theirs, board.rev); return false; }
      var merged = merge3(doc.sync.base, contentOf(doc), theirs);
      var changedHere = canon(merged) !== sigOf(doc);
      var settled = canon(merged) === canon(theirs);
      doc.sync.rev = board.rev;
      doc.sync.dirty = !settled;
      doc.sync.base = settled ? null : copy(theirs);
      ours(doc);
      e.cleanCopy = copy(theirs);
      if (changedHere) applyTo(e, doc, merged);
      else keep(e, doc);
      return !settled;
    });
  }
  function retryLater(e) {
    clearTimeout(e.retryTimer);
    e.backoff = Math.min(e.backoff ? e.backoff * 3 : 5000, 120000);
    e.retryTimer = setTimeout(function () { e.retryTimer = 0; syncBoard(e); }, e.backoff);
  }
  function wentWell(e) {
    e.backoff = 0;
    e.fails = 0;
    clearTimeout(e.retryTimer);
    e.retryTimer = 0;
  }
  function couldNotReach(e) {
    e.fails++;
    setStatus(e, "offline");
    retryLater(e);
  }

  // Send this computer's changes to the account.
  function pushNow(e, round) {
    var doc = docOf(e);
    if (!doc || !doc.sync.dirty || e.off) return Promise.resolve();
    if (foreign(doc)) { e.off = true; setStatus(e, "local"); return Promise.resolve(); }
    if (doc.sync.rev == null && !hasContent(doc)) {
      // Never in the account, and nothing on it now: there is nothing to send.
      doc.sync.dirty = false;
      doc.sync.base = null;
      keep(e, doc);
      return Promise.resolve();
    }
    var body = forAccount(doc);
    var sent = canon({ cards: body.cards, links: body.links });
    if (e.stuck === sent) return Promise.resolve();       // refused as it is: wait for a change
    var sentContent = copy({ cards: body.cards, links: body.links });
    var keepalive = e.keepalive;
    e.keepalive = false;
    setStatus(e, "saving");
    return request("PUT", API + encodeURIComponent(e.id), { state: body, baseRev: doc.sync.rev }, keepalive).then(function (res) {
      var now = docOf(e);
      if (!now) return;
      var j = res.json || {};
      if (res.status === 200 && j.ok) {
        wentWell(e);
        e.stuck = null;
        now.sync.rev = j.rev;
        ours(now);
        e.cleanCopy = sentContent;
        if (sigOf(now) === sent) { now.sync.dirty = false; now.sync.base = null; }
        else now.sync.base = sentContent;                 // more changes came in meanwhile
        keep(e, now);
        setStatus(e, now.sync.dirty ? "saving" : "saved");
        if (now.sync.dirty) schedulePush(e, 400);
        return;
      }
      if (res.status === 409 && j.board) {
        wentWell(e);
        return mergeWith(e, j.board).then(function (again) {
          if (!again) { setStatus(e, "saved"); return; }
          if (round < 3) return pushNow(e, round + 1);
          schedulePush(e, 5000);
        });
      }
      if (res.status === 401) { setStatus(e, "signedout"); return; }
      if (res.status === 404 && j.code === "not_your_conversation") {
        e.off = true;
        setStatus(e, "local");
        return;
      }
      if (res.status === 413 || res.status === 400) { e.stuck = sent; setStatus(e, res.status === 413 ? "toobig" : "refused", j.error); return; }
      throw new Error("status " + res.status);
    }).catch(function () { couldNotReach(e); });
  }
  function schedulePush(e, wait) {
    var now = Date.now();
    if (!e.timer) e.firstAt = now;
    clearTimeout(e.timer);
    var w = Math.max(0, Math.min(wait == null ? PUSH_WAIT : wait, PUSH_MAX_WAIT - (now - e.firstAt)));
    e.timer = setTimeout(function () { e.timer = 0; push(e); }, w);
  }
  function push(e, keepalive) {
    clearTimeout(e.timer);
    e.timer = 0;
    if (keepalive) e.keepalive = true;
    return enqueue(e, function () { return pushNow(e, 0); });
  }

  // What the account has, against what this computer has.
  function takeIn(e, board) {
    var doc = docOf(e);
    if (!doc) {
      if (!board) return;
      doc = blank();
    }
    if (e.off) { setStatus(e, "local"); return; }
    if (foreign(doc)) {
      // Last saved to another account. Unsaved changes of theirs stay here for them
      // (never sent to this account); a saved copy is safe in their account, so this
      // account's own board takes its place.
      if (doc.sync.dirty) { e.off = true; setStatus(e, "local"); return; }
      adopt(e, doc, board ? contentOf(board.state) : { cards: [], links: [] }, board ? board.rev : null);
      setStatus(e, "saved");
      return;
    }
    if (!board) {
      if (doc.sync.rev != null && !doc.sync.dirty) {
        // The account no longer has it (it moved on into its conversation): follow.
        adopt(e, doc, { cards: [], links: [] }, null);
        setStatus(e, "saved");
        return;
      }
      if (doc.sync.dirty) return pushNow(e, 0);         // only here so far: send it up
      setStatus(e, "saved");
      return;
    }
    if (board.rev === doc.sync.rev) {
      if (doc.sync.dirty) return pushNow(e, 0);
      setStatus(e, "saved");
      return;
    }
    if (!doc.sync.dirty) { adopt(e, doc, contentOf(board.state), board.rev); setStatus(e, "saved"); return; }
    return mergeWith(e, board).then(function (again) {
      if (again) return pushNow(e, 0);
      setStatus(e, "saved");
    });
  }
  function pull(e) {
    return enqueue(e, function () {
      e.pulledAt = Date.now();
      return request("GET", API + encodeURIComponent(e.id)).then(function (res) {
        if (res.status === 401) { setStatus(e, "signedout"); return; }
        if (res.status !== 200 || !res.json || !res.json.ok) throw new Error("status " + res.status);
        wentWell(e);
        var board = res.json.board || null;
        return whenIdle(e).then(function () { return takeIn(e, board); });
      }).catch(function () { couldNotReach(e); });
    });
  }
  function syncBoard(e) { return pull(e); }

  // Go back to an earlier version (History). This computer's latest changes reach the
  // account first, so the board being left is in the history too.
  function restoreVersion(e, versionId) {
    return enqueue(e, function () {
      var doc = docOf(e);
      var first = doc && doc.sync.dirty && !e.off ? pushNow(e, 0) : Promise.resolve();
      return first.then(function () {
        var now = docOf(e);
        if (now && now.sync.dirty && !e.off) {
          return { ok: false, error: "Your latest changes haven't reached your account yet. Try again once you're back online." };
        }
        return request("POST", API + encodeURIComponent(e.id) + "/versions/" + encodeURIComponent(versionId) + "/restore", {}).then(function (res) {
          var j = res.json || {};
          if (res.status !== 200 || !j.ok || !j.board) return { ok: false, error: j.error || "" };
          return whenIdle(e).then(function () {
            var d = docOf(e) || blank();
            adopt(e, d, contentOf(j.board.state), j.board.rev);
            wentWell(e);
            setStatus(e, "saved");
            return { ok: true };
          });
        });
      });
    }).catch(function () { return { ok: false, error: "Can't reach your account right now. Try again in a moment." }; });
  }

  // The board in front of a new conversation joins the conversation once it has an
  // id (voice-stage.js), here and in the account; "talk" is then empty again.
  function carry(from, to) {
    if (from !== SCRATCH || !to || to === SCRATCH) return;
    var src = load(keyFor(from));
    if (!src || !hasContent(src) || engine(to).live || engine(from).live) return;
    var dst = load(keyFor(to)) || blank();
    var was = hasContent(dst);
    editDoc(dst, function (d) {
      var g = graft(contentOf(d), contentOf(src));
      d.cards = g.cards;
      d.links = g.links;
      if (!was) { d.view = src.view; if (src.viewSet) d.viewSet = true; }
    });
    save(keyFor(to), dst);
    editDoc(src, function (s) { s.cards = []; s.links = []; });
    save(keyFor(from), src);
    return Promise.all([push(engine(from)), syncBoard(engine(to))]);
  }

  // Boards from before the account kept them, and changes that never reached it (the
  // page was closed offline): send them up quietly, one at a time.
  var swept = null;
  function sweep(gap) {
    if (swept) return swept;
    var ids = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(PREFIX) !== 0) continue;
        var id = k.slice(PREFIX.length);
        if (id === "side" || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) continue;
        var v = load(k);
        if (v && v.sync.dirty) ids.push(id);
      }
    } catch (_) { ids = []; }
    var n = 0;
    swept = new Promise(function (done) {
      (function next() {
        if (n >= ids.length) { done(n); return; }
        var e = engine(ids[n++]);
        (e.live ? Promise.resolve() : pull(e)).then(function () {
          if (e.status === "signedout") { done(n); return; }   // not signed in: nothing more to send
          if (gap === 0) next(); else setTimeout(next, gap || 400);
        });
      })();
    });
    return swept;
  }

  if (window.addEventListener) {
    window.addEventListener("online", function () {
      Object.keys(engines).forEach(function (id) {
        var e = engines[id];
        clearTimeout(e.retryTimer);
        e.backoff = 0;
        var d = e.live ? e.live.state : load(keyFor(id));
        if (e.live || (d && d.sync.dirty)) syncBoard(e);
      });
    });
  }

  // The person's own cards (ones they wrote or edited), in board order: agent.md,
  // then each skill left to right, then the output and notes. Cards BeeZilla drew
  // and nobody touched are not sent back: they describe what it already does.
  function compile(cards) {
    var mine = (cards || []).filter(function (c) { return c && c.user && String(c.body || "").trim(); });
    if (!mine.length) return "";
    var order = mine.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    var lines = [];
    order.forEach(function (c) { if (kindOf(c) === "agent") lines.push("agent.md (how to work): " + c.body.trim()); });
    var step = 0;
    order.forEach(function (c) { if (kindOf(c) === "skill") lines.push("Step " + (++step) + " — " + c.title + ": " + c.body.trim()); });
    order.forEach(function (c) {
      var k = kindOf(c);
      if (roleOf(k) === "output") lines.push("Output — " + c.title + ": " + c.body.trim());
      else if (k === "note") lines.push("Note — " + c.body.trim());
    });
    return lines.join("\n").slice(0, 4000);
  }

  function mount(host, opts) {
    opts = opts || {};
    var boardId = String(opts.boardId || "default").slice(0, 80);
    var key = keyFor(boardId);
    var eng = engine(boardId);
    var local = load(key);
    var state = local || blank();
    var view = state.view;
    var selected = {};          // card id → true
    var selectedLink = null;    // link id
    var tool = "select";
    var saveTimer = 0;
    var undo = [], redo = [];
    var pointerBusy = false;    // a drag, a box or a line in progress
    // Written to this browser a moment after each change; a change to the cards or
    // lines (not just moving around the board) then goes to the account too.
    function persist() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(writeNow, 250);
    }
    var gone = false;           // destroyed: folded away, or another conversation's board is up
    function writeNow() {
      clearTimeout(saveTimer);
      saveTimer = 0;
      if (gone) {
        // Something that finished after the board was put away (an upload): it joins
        // this browser's copy as a change, unless the board is on screen again.
        if (eng.live) return;
        var d = load(key) || blank();
        if (editDoc(d, function (x) { x.cards = copy(state.cards); x.links = copy(state.links); })) { save(key, d); push(eng); }
        return;
      }
      var sig = sigOf(state);
      if (sig !== eng.lastSig) {
        eng.lastSig = sig;
        if (!state.sync.dirty) {
          state.sync.dirty = true;
          state.sync.base = state.sync.rev == null ? null : eng.cleanCopy;
        }
        if (!eng.off) schedulePush(eng);
      }
      save(key, state);
      if (opts.onChange) opts.onChange();
    }
    function snapshot() {
      undo.push(JSON.stringify({ cards: state.cards, links: state.links }));
      if (undo.length > 60) undo.shift();
      redo = [];
    }
    function restore(json) {
      var s = JSON.parse(json);
      state.cards = s.cards; state.links = s.links;
      rebuild();
      persist();
    }

    // ── Shell ────────────────────────────────────────────────────────────
    var root = el("section", "wb-panel");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Whiteboard");
    var head = el("div", "wb-head");
    var title = el("h3", "wb-title", "Whiteboard");
    head.appendChild(title);
    var dock = el("div", "wb-dock");            // the page puts the Talk bar here
    head.appendChild(dock);
    var tools = el("span", "wb-tools");
    var foldBtn = el("button", "wb-btn wb-fold");
    foldBtn.type = "button";
    foldBtn.appendChild(icon("fold"));
    foldBtn.appendChild(el("span", "wb-btn-label", "Fold away"));
    foldBtn.setAttribute("aria-label", "Fold the whiteboard away");
    foldBtn.title = "Fold the whiteboard away (it keeps everything)";
    tools.appendChild(foldBtn);
    head.appendChild(tools);

    var body = el("div", "wb-body");
    var bar = el("div", "wb-toolbar");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Board tools");
    var TOOLS = [
      ["select", "Select", "V"], ["hand", "Move the board", "H"], ["note", "Note", "N"],
      ["agent", "agent.md — how to work", "A"], ["skill", "Skill — a step", "K"], ["output", "Output — what to make", "O"],
      ["upload", "Add a file from your computer", "U"],
    ];
    var toolBtns = {};
    TOOLS.forEach(function (t) {
      var b = el("button", "wb-tool");
      b.type = "button";
      b.setAttribute("data-tool", t[0]);
      b.setAttribute("aria-label", t[1] + " (" + t[2] + ")");
      b.title = t[1] + " — " + t[2];
      b.appendChild(icon(t[0]));
      b.appendChild(el("span", "wb-key", t[2]));
      b.addEventListener("click", function () {
        if (t[0] === "upload") { picker.click(); return; }
        setTool(t[0]);
      });
      bar.appendChild(b);
      toolBtns[t[0]] = b;
    });
    var picker = el("input");
    picker.type = "file";
    picker.multiple = true;
    picker.hidden = true;
    picker.addEventListener("change", function () {
      var r = canvas.getBoundingClientRect();
      uploadFiles(picker.files, toWorld(r.left + r.width / 2, r.top + r.height / 3));
      picker.value = "";
    });
    bar.appendChild(picker);

    var canvas = el("div", "wb-canvas");
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Board — arrow keys move the selected card, Delete removes it");
    var world = el("div", "wb-world");
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "wb-links");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "1");
    svg.setAttribute("height", "1");
    svg.style.overflow = "visible";
    world.appendChild(svg);
    canvas.appendChild(world);
    var marquee = el("div", "wb-marquee");
    marquee.hidden = true;
    canvas.appendChild(marquee);
    var hint = el("div", "wb-hint");
    hint.appendChild(el("strong", null, "Talk to BeeZilla, and its work appears here."));
    hint.appendChild(el("span", null, "Or drag files, pictures and Inspiration cards in. Use the tools on the left to draw your own process."));
    canvas.appendChild(hint);

    var zoom = el("div", "wb-zoom");
    function zbtn(name, label, fn) {
      var b = el("button", "wb-zbtn");
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.title = label;
      b.appendChild(icon(name));
      b.addEventListener("click", fn);
      zoom.appendChild(b);
      return b;
    }
    zbtn("minus", "Zoom out (−)", function () { zoomBy(1 / 1.25); });
    var zlabel = el("button", "wb-zlabel", "100%");
    zlabel.type = "button";
    zlabel.title = "Back to 100%";
    zlabel.addEventListener("click", function () { zoomTo(1); });
    zoom.appendChild(zlabel);
    zbtn("plus", "Zoom in (+)", function () { zoomBy(1.25); });
    zbtn("fit", "Fit everything (Alt/Option+1)", fit);
    var histBtn = zbtn("history", "History: earlier versions of this board", function () { showHistory(hist.hidden); });
    var keysBtn = zbtn("keys", "Keyboard shortcuts (F1)", function () { showKeys(keyList.hidden); });
    function showKeys(open) {
      keyList.hidden = !open;
      if (open) hist.hidden = true;
    }

    // Shortcuts are never key-only: the list is one click away in the corner.
    var keyList = el("div", "wb-keylist");
    keyList.hidden = true;
    keyList.setAttribute("role", "dialog");
    keyList.setAttribute("aria-label", "Keyboard shortcuts");
    [["V", "Select"], ["H or Space", "Move the board"], ["Scroll", "Move the board"], ["Ctrl/⌘ + scroll, pinch", "Zoom"],
     ["Alt/Option + 1", "Fit everything"], ["Alt/Option + 2", "Zoom to the selection"], ["Ctrl/⌘ + 0", "Back to 100%"], ["F1", "This list"], ["N / A / K / O", "Note / agent.md / skill / output"], ["Drag on empty board", "Select an area"],
     ["Shift + click", "Add to the selection"], ["Ctrl/⌘ + A", "Select all"], ["Delete", "Remove"], ["Ctrl/⌘ + D", "Duplicate"],
     ["Ctrl/⌘ + Z", "Undo"], ["Shift+Ctrl/⌘ + Z", "Redo"], ["Double-click", "Edit a card"], ["Esc", "Clear the selection"]]
      .forEach(function (k) {
        var row = el("div", "wb-keyrow");
        row.appendChild(el("kbd", null, k[0]));
        row.appendChild(el("span", null, k[1]));
        keyList.appendChild(row);
      });
    var keyClose = el("button", "wb-keyclose", "Close");
    keyClose.type = "button";
    keyClose.addEventListener("click", function () { keyList.hidden = true; keysBtn.focus(); });
    keyList.appendChild(keyClose);

    // History: this board's earlier versions in the account, newest first.
    var hist = el("div", "wb-history");
    hist.hidden = true;
    hist.setAttribute("role", "dialog");
    hist.setAttribute("aria-label", "History of this board");
    var histHead = el("div", "wb-hist-head");
    histHead.appendChild(el("strong", null, "History"));
    var histClose = el("button", "wb-btn wb-hist-x", "Close");
    histClose.type = "button";
    histClose.addEventListener("click", function () { showHistory(false); histBtn.focus(); });
    histHead.appendChild(histClose);
    hist.appendChild(histHead);
    var histSync = el("p", "wb-hist-sync");
    histSync.setAttribute("role", "status");
    histSync.hidden = true;
    hist.appendChild(histSync);
    var histList = el("ol", "wb-hist-list");
    hist.appendChild(histList);
    hist.appendChild(el("p", "wb-hist-note",
      "Your board is saved to your account, so it's on any computer you sign in on. A copy is kept every few minutes while you work: the last 30, for up to 90 days."));
    // Keys inside the panel are the panel's (Space presses a button); Esc closes it.
    hist.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      showHistory(false);
      histBtn.focus({ preventScroll: true });
    });

    var selbar = el("div", "wb-selbar");
    selbar.hidden = true;
    selbar.setAttribute("role", "toolbar");
    selbar.setAttribute("aria-label", "Selected cards");
    var selCount = el("span", "wb-selcount", "");
    selbar.appendChild(selCount);
    var recipeBtn = el("button", "wb-selbtn wb-recipe-btn");
    recipeBtn.type = "button";
    recipeBtn.appendChild(icon("recipe"));
    recipeBtn.appendChild(el("span", null, "Create recipe"));
    selbar.appendChild(recipeBtn);
    var removeBtn = el("button", "wb-selbtn");
    removeBtn.type = "button";
    removeBtn.appendChild(icon("trash"));
    removeBtn.appendChild(el("span", null, "Remove"));
    removeBtn.addEventListener("click", function () { removeSelected(); });
    selbar.appendChild(removeBtn);
    var namer = el("form", "wb-namer");
    namer.hidden = true;
    var nameIn = el("input", "wb-namer-in");
    nameIn.type = "text";
    nameIn.maxLength = 80;
    nameIn.placeholder = "Name this recipe";
    nameIn.setAttribute("aria-label", "Recipe name");
    var nameGo = el("button", "wb-selbtn wb-primary", "Save recipe");
    nameGo.type = "submit";
    var nameNo = el("button", "wb-selbtn", "Cancel");
    nameNo.type = "button";
    namer.appendChild(nameIn); namer.appendChild(nameGo); namer.appendChild(nameNo);
    selbar.appendChild(namer);

    var toast = el("div", "wb-toast");
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.hidden = true;

    // The conversation lives inside the board, on the right, and folds to a tab.
    var sideWrap = el("aside", "wb-side");
    sideWrap.setAttribute("aria-label", "Conversation");
    var sideHead = el("div", "wb-side-head");
    sideHead.appendChild(el("span", "wb-side-title", "Conversation"));
    var sideBtn = el("button", "wb-btn wb-side-btn", "Hide");
    sideBtn.type = "button";
    sideBtn.setAttribute("aria-expanded", "true");
    sideBtn.setAttribute("aria-label", "Hide the conversation");
    sideHead.appendChild(sideBtn);
    var side = el("div", "wb-side-slot");     // the page puts the conversation here
    sideWrap.appendChild(sideHead);
    sideWrap.appendChild(side);
    var sideOpen = true;
    try { sideOpen = localStorage.getItem("bz.board.side") !== "closed"; } catch (_) { /* best effort */ }
    function paintSide() {
      sideWrap.classList.toggle("wb-side-closed", !sideOpen);
      root.classList.toggle("wb-side-is-closed", !sideOpen);
      sideBtn.textContent = sideOpen ? "Hide" : "Conversation";
      sideBtn.setAttribute("aria-expanded", sideOpen ? "true" : "false");
      sideBtn.setAttribute("aria-label", sideOpen ? "Hide the conversation" : "Show the conversation");
    }
    sideBtn.addEventListener("click", function () {
      sideOpen = !sideOpen;
      try { localStorage.setItem("bz.board.side", sideOpen ? "open" : "closed"); } catch (_) { /* best effort */ }
      paintSide();
    });
    paintSide();

    body.appendChild(bar);
    body.appendChild(canvas);
    body.appendChild(zoom);
    body.appendChild(keyList);
    body.appendChild(hist);
    body.appendChild(selbar);
    body.appendChild(toast);
    body.appendChild(sideWrap);
    root.appendChild(head);
    root.appendChild(body);
    host.appendChild(root);

    foldBtn.addEventListener("click", function () { if (opts.onFold) opts.onFold(); });

    var toastTimer = 0;
    function say(text, ms) {
      toast.textContent = text;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.hidden = true; }, ms || 3200);
    }

    // ── Saved where? History, and one quiet word when the account can't be reached ─
    var SYNC_LINE = {
      saved: "Saved to your account.",
      saving: "Saving to your account…",
      offline: "Not saved to your account yet: the connection seems to be down. Everything is kept on this computer and saves when it's back.",
      signedout: "Sign in to save this board to your account. Until then it stays on this computer.",
      local: "This conversation belongs to another account, so its board stays on this computer only.",
      toobig: "This board is too big to save to your account. Remove a few cards and it saves again.",
      refused: "This board couldn't be saved to your account, so it stays on this computer.",
    };
    function paintSync() {
      var s = eng.status;
      var line = (s === "toobig" || s === "refused") && eng.msg ? eng.msg : (SYNC_LINE[s] || "");
      histSync.textContent = line;
      histSync.hidden = !line;
      var notSaved = s === "offline" || s === "signedout" || s === "local" || s === "toobig" || s === "refused";
      histBtn.classList.toggle("wb-unsynced", notSaved);
      var label = notSaved ? "History: this board isn't saved to your account yet" : "History: earlier versions of this board";
      histBtn.setAttribute("aria-label", label);
      histBtn.title = label;
      // Said once, and only once it's more than a blip (the second try in a row).
      var tell = s === "offline" ? (eng.fails >= 2 ? "You're offline. The board is kept on this computer and saves to your account when you're back." : "")
        : s === "toobig" || s === "local" ? line : "";
      if (tell && !eng.told[s]) { eng.told[s] = 1; say(tell, 5200); }
    }
    function showHistory(open) {
      hist.hidden = !open;
      if (!open) return;
      keyList.hidden = true;
      paintSync();
      loadHistory();
      histClose.focus({ preventScroll: true });
    }
    function when(iso) {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      var t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      var today = new Date();
      today.setHours(0, 0, 0, 0);
      var day = new Date(d.getTime());
      day.setHours(0, 0, 0, 0);
      var ago = Math.round((today.getTime() - day.getTime()) / 86400000);
      if (ago === 0) return "Today, " + t;
      if (ago === 1) return "Yesterday, " + t;
      return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + ", " + t;
    }
    function histNote(text) {
      histList.textContent = "";
      histList.appendChild(el("li", "wb-hist-empty", text));
    }
    var histAsk = 0;
    function loadHistory() {
      var ask = ++histAsk;
      histNote("Looking…");
      function show() {
        if (ask !== histAsk || hist.hidden) return;
        request("GET", API + encodeURIComponent(boardId) + "/versions").then(function (res) {
          if (ask !== histAsk || hist.hidden) return;
          if (res.status === 401) { histNote("Sign in to see this board's history."); return; }
          if (res.status !== 200 || !res.json || !res.json.ok) throw new Error("status " + res.status);
          var list = res.json.versions || [];
          if (!list.length) { histNote("Nothing here yet. The first copy is kept when this board is saved to your account."); return; }
          histList.textContent = "";
          list.forEach(function (v, i) { histList.appendChild(versionRow(v, i === 0)); });
        }).catch(function () {
          if (ask === histAsk && !hist.hidden) histNote("History needs a connection. Your board is safe on this computer.");
        });
      }
      // This computer's latest changes first, so the list ends with what you see.
      if (state.sync.dirty && !eng.off) push(eng).then(show, show);
      else show();
    }
    function versionRow(v, newest) {
      var li = el("li", "wb-hist-row");
      var top = el("div", "wb-hist-top");
      top.appendChild(el("span", "wb-hist-when", when(v.savedAt)));
      top.appendChild(el("span", "wb-hist-count", v.cards === 1 ? "1 card" : v.cards + " cards"));
      li.appendChild(top);
      if (v.titles && v.titles.length) li.appendChild(el("span", "wb-hist-titles", v.titles.join(" · ")));
      if (newest && v.rev === state.sync.rev && !state.sync.dirty) {
        li.appendChild(el("span", "wb-hist-now", "What you see now"));
        return li;
      }
      if (v.reason === "restore") li.appendChild(el("span", "wb-hist-tag", "Brought back from earlier"));
      var go = el("button", "wb-selbtn wb-hist-go", "Go back to this");
      go.type = "button";
      go.addEventListener("click", function () { goBack(v, go); });
      li.appendChild(go);
      return li;
    }
    function goBack(v, btn) {
      btn.disabled = true;
      btn.textContent = "Bringing it back…";
      restoreVersion(eng, v.id).then(function (r) {
        if (!r.ok) {
          btn.disabled = false;
          btn.textContent = "Go back to this";
          say(r.error || "That version couldn't be brought back. Try again in a moment.", 4200);
          return;
        }
        selected = {};
        paintSelection();
        requestAnimationFrame(function () { fit(); });
        say("Back to the board from " + when(v.savedAt).replace(/^Today, /, "").replace(/^Yesterday/, "yesterday") +
          ". The one you had is in History too.", 4200);
        loadHistory();
      });
    }

    // ── Camera ───────────────────────────────────────────────────────────
    function applyView() {
      world.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.z + ")";
      canvas.style.setProperty("--wb-z", String(view.z));
      canvas.style.backgroundSize = (24 * view.z) + "px " + (24 * view.z) + "px, auto";
      canvas.style.backgroundPosition = view.x + "px " + view.y + "px, 0 0";
      zlabel.textContent = Math.round(view.z * 100) + "%";
      positionSelbar();
    }
    function toWorld(cx, cy) {
      var r = canvas.getBoundingClientRect();
      return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z };
    }
    function zoomAt(cx, cy, z) {
      var r = canvas.getBoundingClientRect();
      var nz = clamp(z, ZMIN, ZMAX);
      var px = cx - r.left, py = cy - r.top;
      view.x = px - (px - view.x) * (nz / view.z);
      view.y = py - (py - view.y) * (nz / view.z);
      view.z = nz;
      applyView();
      persist();
    }
    function zoomBy(f) { var r = canvas.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, view.z * f); }
    function zoomTo(z) { var r = canvas.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, z); }
    function bounds(list) {
      var b = null;
      list.forEach(function (c) {
        var n = nodes[c.id];
        var w = n ? n.offsetWidth : 180, h = n ? n.offsetHeight : 120;
        if (!b) b = { x1: c.x, y1: c.y, x2: c.x + w, y2: c.y + h };
        else { b.x1 = Math.min(b.x1, c.x); b.y1 = Math.min(b.y1, c.y); b.x2 = Math.max(b.x2, c.x + w); b.y2 = Math.max(b.y2, c.y + h); }
      });
      return b;
    }
    // The part of the board you can actually see: not under the tools on the left,
    // the conversation on the right, or the zoom bar at the bottom.
    function openArea() {
      var r = canvas.getBoundingClientRect();
      if (r.width <= 760) {
        // Phone: the tools are a row along the top, the conversation sits below.
        var top = (bar.offsetTop || 8) + (bar.offsetHeight || 40) + 12;
        var bottom = r.height - (sideOpen && sideWrap.offsetHeight ? sideWrap.offsetHeight + 70 : 64);
        return { x: 12, y: top, w: Math.max(120, r.width - 24), h: Math.max(120, bottom - top) };
      }
      var left = (bar.offsetLeft || 12) + (bar.offsetWidth || 52) + 16;
      var right = r.width - (sideOpen && sideWrap.offsetWidth ? sideWrap.offsetWidth + 24 : 16);
      return { x: left, y: 16, w: Math.max(120, right - left), h: Math.max(120, r.height - 16 - 64) };
    }
    function frame(list, maxZ) {
      var b = bounds(list);
      var r = canvas.getBoundingClientRect();
      if (!b || !r.width) { view.x = 80; view.y = 40; view.z = 1; applyView(); persist(); return; }
      var a = openArea();
      var z = clamp(Math.min((a.w - 40) / Math.max(1, b.x2 - b.x1), (a.h - 40) / Math.max(1, b.y2 - b.y1)), ZMIN, maxZ);
      view.z = z;
      view.x = a.x + (a.w - (b.x2 - b.x1) * z) / 2 - b.x1 * z;
      view.y = a.y + (a.h - (b.y2 - b.y1) * z) / 2 - b.y1 * z;
      applyView();
      persist();
    }
    function fit() { frame(state.cards, 1); }
    function zoomToSelection() {
      var list = state.cards.filter(function (c) { return selected[c.id]; });
      if (!list.length) { fit(); return; }
      frame(list, 2);
    }
    // Keep a new card in sight: pan just enough, never jump around.
    function reveal(c) {
      var n = nodes[c.id];
      var r = canvas.getBoundingClientRect();
      if (!n || !r.width) return;
      var w = n.offsetWidth * view.z, h = n.offsetHeight * view.z;
      var sx = c.x * view.z + view.x, sy = c.y * view.z + view.y;
      var m = 30, dx = 0, dy = 0;
      var sw = sideOpen ? (sideWrap.offsetWidth || 0) : 0;
      if (sx + w > r.width - m - sw) dx = (r.width - m - sw) - (sx + w);
      if (sx + dx < m + bar.offsetWidth) dx = m + bar.offsetWidth - sx;
      if (sy + h > r.height - m) dy = r.height - m - (sy + h);
      if (sy + dy < m) dy = m - sy;
      if (!dx && !dy) return;
      world.classList.add("wb-glide");
      view.x += dx; view.y += dy;
      applyView();
      setTimeout(function () { world.classList.remove("wb-glide"); }, 420);
      persist();
    }

    // ── Cards ────────────────────────────────────────────────────────────
    var nodes = {};
    function cardById(id) { for (var i = 0; i < state.cards.length; i++) if (state.cards[i].id === id) return state.cards[i]; return null; }
    function cardByFlow(fid) { for (var i = 0; i < state.cards.length; i++) if (state.cards[i].flow === fid) return state.cards[i]; return null; }

    function fillCard(n, c) {
      var keep = Array.prototype.filter.call(n.childNodes, function (x) { return x.classList && (x.classList.contains("wb-handle") || x.classList.contains("wb-rm")); });
      n.textContent = "";
      var k = kindOf(c);
      n.className = "wb-card wb-k-" + k + " wb-r-" + roleOf(k) + (c.state ? " wb-s-" + c.state : "") + (selected[c.id] ? " wb-on" : "");
      var top = el("div", "wb-ctop");
      top.appendChild(icon(k === "track" ? "play" : k === "model" ? "cube" : k === "image" ? "image" : k === "video" ? "video" :
        k === "memory" ? "memory" : (k === "agent" || k === "skill" || k === "note") ? k : "doc", "wb-cico"));
      top.appendChild(el("span", "wb-ckind", KIND_LABEL[k] || "File"));
      if (c.state === "running") top.appendChild(el("span", "wb-badge wb-badge-run", "Working"));
      else if (c.state === "failed") top.appendChild(el("span", "wb-badge wb-badge-fail", "Didn't work"));
      n.appendChild(top);
      n.appendChild(el("span", "wb-name", c.title || "Untitled"));
      if (k === "image" && c.url) {
        var img = el("img", "wb-img");
        img.src = c.url; img.alt = c.title || ""; img.loading = "lazy"; img.draggable = false;
        n.appendChild(img);
      } else if (k === "track") {
        var waveBox = el("div", "wb-wave");
        if (c.url && c.state !== "running" && window.BeeZillaWave) waveBox.appendChild(window.BeeZillaWave.player(c.url, { title: c.title }));
        else if (window.BeeZillaWave) waveBox.appendChild(window.BeeZillaWave.placeholder(c.body || "Composing…"));
        n.appendChild(waveBox);
      } else if (k === "model") {
        var m = el("div", "wb-model");
        if (c.thumb) { var t = el("img", "wb-img"); t.src = c.thumb; t.alt = ""; t.draggable = false; m.appendChild(t); }
        else m.appendChild(icon("cube", "wb-cube" + (c.state === "running" ? " wb-spin" : "")));
        if (c.state === "running") m.appendChild(el("span", "wb-progress", c.body || "Building the 3D model…"));
        else if (c.url) {
          var dl = el("a", "wb-open", "Download the 3D model");
          dl.href = c.url; dl.download = c.title || "model.glb";
          dl.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
          m.appendChild(dl);
        }
        n.appendChild(m);
      } else if (k === "video") {
        if (c.url && c.state !== "running") {
          var v = el("video", "wb-video");
          v.src = c.url; v.controls = true; v.preload = "metadata";
          v.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
          n.appendChild(v);
        } else n.appendChild(el("span", "wb-progress", c.body || "Rendering the video…"));
      } else if (GLYPH[k]) {
        var g = el("span", "wb-glyph wb-g-" + k, GLYPH[k]);
        g.setAttribute("aria-hidden", "true");
        n.appendChild(g);
      }
      if ((k === "agent" || k === "skill" || k === "memory" || k === "note" || (roleOf(k) === "output" && !c.url)) && c.body) {
        n.appendChild(el("p", "wb-body-text", c.body));
      } else if ((k === "agent" || k === "skill" || k === "note") && !c.body) {
        n.appendChild(el("p", "wb-body-text wb-empty", "Double-click to write it."));
      }
      if (c.state === "failed" && c.err) n.appendChild(el("p", "wb-err", c.err));
      keep.forEach(function (x) { n.appendChild(x); });
      if (!keep.length) {
        var rm = el("button", "wb-rm");
        rm.type = "button";
        rm.textContent = "×";
        rm.setAttribute("aria-label", "Remove " + (c.title || "card"));
        rm.title = "Remove";
        rm.addEventListener("click", function (e) { e.stopPropagation(); snapshot(); removeCards([c.id]); });
        n.appendChild(rm);
        CORNERS.forEach(function (corner) {
          var h = el("span", "wb-handle wb-" + corner);
          h.setAttribute("data-corner", corner);
          h.title = "Drag to another card to connect";
          n.appendChild(h);
        });
      }
      n.setAttribute("aria-label", (KIND_LABEL[k] || "Card") + ": " + (c.title || "Untitled"));
    }
    function renderCard(c) {
      var n = el("div", "wb-card");
      n.tabIndex = 0;
      n.setAttribute("role", "group");
      n.style.left = c.x + "px";
      n.style.top = c.y + "px";
      fillCard(n, c);
      wireCard(n, c);
      world.appendChild(n);
      nodes[c.id] = n;
      return n;
    }
    function place(c) {
      var n = nodes[c.id];
      if (n) { n.style.left = c.x + "px"; n.style.top = c.y + "px"; }
    }
    function refreshHint() {
      hint.hidden = state.cards.length > 0;
      root.classList.toggle("wb-has-cards", state.cards.length > 0);
    }
    function rebuild() {
      Object.keys(nodes).forEach(function (id) { nodes[id].remove(); });
      nodes = {};
      selected = {};
      state.cards.forEach(renderCard);
      drawLinks();
      refreshHint();
      paintSelection();
    }
    // A free spot near (x, y): step down until nothing overlaps.
    function freeSpot(x, y, w, h) {
      w = w || 200; h = h || 130;
      for (var i = 0; i < 80; i++) {
        var yy = y + i * 28;
        var hit = state.cards.some(function (c) {
          var n = nodes[c.id];
          var cw = n ? n.offsetWidth : 200, ch = n ? n.offsetHeight : 130;
          return x < c.x + cw + 16 && x + w + 16 > c.x && yy < c.y + ch + 16 && yy + h + 16 > c.y;
        });
        if (!hit) return { x: Math.round(x), y: Math.round(yy) };
      }
      return { x: Math.round(x), y: Math.round(y) };
    }
    function viewCentre() {
      var r = canvas.getBoundingClientRect();
      return toWorld(r.left + Math.max(140, r.width * 0.35), r.top + Math.max(80, r.height * 0.3));
    }
    function addCard(card, at, noUndo) {
      if (state.cards.length >= MAX_CARDS) { say("The board is full — remove a few cards first."); return null; }
      if (!noUndo) snapshot();
      var spot = at || viewCentre();
      var c = {
        id: uid(),
        kind: kindOf(card),
        title: String(card.title || card.name || "Untitled").slice(0, 140),
        body: String(card.body || "").slice(0, 4000),
        url: card.url ? String(card.url) : "",
        contentType: card.contentType ? String(card.contentType) : "",
        x: 0, y: 0,
      };
      if (card.flow) c.flow = String(card.flow);
      if (card.state) c.state = card.state;
      if (card.user) c.user = true;
      if (card.taskId) c.taskId = String(card.taskId);
      if (card.thumb) c.thumb = String(card.thumb);
      var free = at && card.exact ? spot : freeSpot(spot.x, spot.y);
      c.x = free.x; c.y = free.y;
      state.cards.push(c);
      renderCard(c);
      refreshHint();
      persist();
      return c;
    }
    function removeCards(ids) {
      var gone = {};
      ids.forEach(function (id) { gone[id] = true; });
      state.cards = state.cards.filter(function (c) { return !gone[c.id]; });
      state.links = state.links.filter(function (l) { return !gone[l.from] && !gone[l.to]; });
      ids.forEach(function (id) { if (nodes[id]) { nodes[id].remove(); delete nodes[id]; } delete selected[id]; });
      selectedLink = null;
      drawLinks();
      refreshHint();
      paintSelection();
      persist();
    }
    function removeSelected() {
      var ids = Object.keys(selected);
      if (selectedLink) {
        snapshot();
        state.links = state.links.filter(function (l) { return l.id !== selectedLink; });
        selectedLink = null;
        drawLinks();
        persist();
      }
      if (ids.length) { snapshot(); removeCards(ids); }
    }

    // ── Selection ────────────────────────────────────────────────────────
    function paintSelection() {
      Object.keys(nodes).forEach(function (id) { nodes[id].classList.toggle("wb-on", !!selected[id]); });
      var n = Object.keys(selected).length;
      selbar.hidden = n === 0;
      if (n === 0) { namer.hidden = true; recipeBtn.hidden = false; }
      selCount.textContent = n === 1 ? "1 card" : n + " cards";
      positionSelbar();
    }
    function positionSelbar() {
      if (selbar.hidden) return;
      var list = state.cards.filter(function (c) { return selected[c.id]; });
      var b = bounds(list);
      if (!b) return;
      var cr = canvas.getBoundingClientRect(), br = body.getBoundingClientRect();
      var x = b.x1 * view.z + view.x + (cr.left - br.left);
      var y = b.y1 * view.z + view.y + (cr.top - br.top) - 50;
      var minX = (bar.offsetLeft || 12) + (bar.offsetWidth || 52) + 10;
      selbar.style.left = clamp(x, minX, Math.max(minX, br.width - selbar.offsetWidth - 12)) + "px";
      selbar.style.top = clamp(y, 8, Math.max(8, br.height - 50)) + "px";
    }
    function select(id, add) {
      if (!add) selected = {};
      if (add && selected[id]) delete selected[id]; else selected[id] = true;
      selectedLink = null;
      drawLinks();
      paintSelection();
    }
    function clearSelection() { selected = {}; selectedLink = null; drawLinks(); paintSelection(); }

    // ── Pointer: cards ───────────────────────────────────────────────────
    var preview = null;
    function cornerXY(c, corner) {
      var n = nodes[c.id];
      var w = n ? n.offsetWidth : 180, h = n ? n.offsetHeight : 120;
      return { x: c.x + (corner.charAt(1) === "e" ? w : 0), y: c.y + (corner.charAt(0) === "s" ? h : 0) };
    }
    function sidePoint(a, b) {
      // Where a line leaves card a heading for card b: the middle of the facing side.
      var na = nodes[a.id], nb = nodes[b.id];
      var aw = na ? na.offsetWidth : 180, ah = na ? na.offsetHeight : 120;
      var bw = nb ? nb.offsetWidth : 180, bh = nb ? nb.offsetHeight : 120;
      var acx = a.x + aw / 2, acy = a.y + ah / 2, bcx = b.x + bw / 2, bcy = b.y + bh / 2;
      if (Math.abs(bcx - acx) * ah >= Math.abs(bcy - acy) * aw) return { x: bcx > acx ? a.x + aw : a.x, y: acy, dir: bcx > acx ? 1 : -1, h: true };
      return { x: acx, y: bcy > acy ? a.y + ah : a.y, dir: bcy > acy ? 1 : -1, h: false };
    }
    function nearestCorner(c, p) {
      var best = "nw", bd = Infinity;
      CORNERS.forEach(function (k) {
        var q = cornerXY(c, k), d = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y);
        if (d < bd) { bd = d; best = k; }
      });
      return best;
    }
    function wireCard(n, c) {
      n.addEventListener("pointerdown", function (e) {
        if (e.button !== 0 || spaceDown || tool === "hand") return; // the board pans
        if (e.target.closest && (e.target.closest(".wb-rm") || e.target.closest(".bzw") || e.target.closest("a,video,audio"))) return;
        e.stopPropagation();
        var handle = e.target.closest ? e.target.closest(".wb-handle") : null;
        e.preventDefault();
        canvas.focus({ preventScroll: true });
        n.setPointerCapture(e.pointerId);
        if (handle) {
          var corner = handle.getAttribute("data-corner");
          var start = cornerXY(c, corner);
          preview = document.createElementNS(SVGNS, "path");
          preview.setAttribute("class", "wb-link wb-preview");
          svg.appendChild(preview);
          var move = function (ev) { var p = toWorld(ev.clientX, ev.clientY); preview.setAttribute("d", curve(start, p)); };
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
            snapshot();
            link(c.id, toId, corner, th ? th.getAttribute("data-corner") : nearestCorner(to, toWorld(ev.clientX, ev.clientY)));
            persist();
          };
          n.addEventListener("pointermove", move);
          n.addEventListener("pointerup", up);
          return;
        }
        if (!selected[c.id]) select(c.id, e.shiftKey);
        else if (e.shiftKey) { select(c.id, true); return; }
        var moving = state.cards.filter(function (x) { return selected[x.id]; });
        var startP = toWorld(e.clientX, e.clientY);
        var orig = moving.map(function (x) { return { c: x, x: x.x, y: x.y }; });
        var moved = false;
        var mv = function (ev) {
          var p = toWorld(ev.clientX, ev.clientY);
          var dx = p.x - startP.x, dy = p.y - startP.y;
          if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
          if (!moved) { moved = true; snapshot(); n.classList.add("wb-moving"); selbar.classList.add("wb-quiet"); }
          orig.forEach(function (o) { o.c.x = Math.round(o.x + dx); o.c.y = Math.round(o.y + dy); place(o.c); });
          drawLinks();
          positionSelbar();
        };
        var upm = function () {
          n.classList.remove("wb-moving");
          selbar.classList.remove("wb-quiet");
          n.removeEventListener("pointermove", mv);
          n.removeEventListener("pointerup", upm);
          if (moved) persist();
        };
        n.addEventListener("pointermove", mv);
        n.addEventListener("pointerup", upm);
      });
      n.addEventListener("dblclick", function (e) {
        if (e.target.closest && e.target.closest(".bzw,a,video")) return;
        var k = kindOf(c);
        if (roleOf(k) === "output" && c.url && k !== "track") { window.open(c.url, "_blank", "noopener"); return; }
        openEditor(c);
      });
      n.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !typingInto(e.target)) { e.preventDefault(); openEditor(c); }
      });
      n.addEventListener("focus", function () { if (!selected[c.id]) select(c.id, false); });
    }

    // ── Editing a card (instructions, a skill's steps, the output) ───────────
    var editor = null;
    function openEditor(c) {
      closeEditor();
      var k = kindOf(c);
      editor = el("form", "wb-editor");
      editor.setAttribute("role", "dialog");
      editor.setAttribute("aria-label", "Edit " + (KIND_LABEL[k] || "card"));
      var h = el("div", "wb-ed-head");
      h.appendChild(el("strong", null, "Edit " + (KIND_LABEL[k] || "card").toLowerCase()));
      var x = el("button", "wb-btn", "Close");
      x.type = "button";
      h.appendChild(x);
      editor.appendChild(h);
      var t = el("input", "wb-ed-title");
      t.value = c.title || "";
      t.maxLength = 140;
      t.setAttribute("aria-label", "Title");
      editor.appendChild(t);
      var b = el("textarea", "wb-ed-body");
      b.value = c.body || "";
      b.rows = 7;
      b.maxLength = 4000;
      b.placeholder = k === "agent" ? "How BeeZilla should work on this — your agent.md." :
        k === "skill" ? "What this step does, in your words." :
        roleOf(k) === "output" ? "What the finished thing should be." : "Anything.";
      b.setAttribute("aria-label", "Text");
      editor.appendChild(b);
      var row = el("div", "wb-ed-row");
      var go = el("button", "wb-selbtn wb-primary", "Save");
      go.type = "submit";
      row.appendChild(go);
      row.appendChild(el("span", "wb-ed-note", "BeeZilla follows your edits from your next message."));
      editor.appendChild(row);
      editor.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!nodes[c.id]) { closeEditor(); say("That card was removed, so the edit has nowhere to go."); return; }
        snapshot();
        c.title = t.value.trim().slice(0, 140) || c.title;
        c.body = b.value.slice(0, 4000);
        c.user = true;          // the person's own words now: sent with their next message
        fillCard(nodes[c.id], c);
        drawLinks();
        persist();
        closeEditor();
        nodes[c.id].focus({ preventScroll: true });
      });
      x.addEventListener("click", function () { closeEditor(); if (nodes[c.id]) nodes[c.id].focus({ preventScroll: true }); });
      editor.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); closeEditor(); } });
      body.appendChild(editor);
      var r = nodes[c.id].getBoundingClientRect(), br = body.getBoundingClientRect();
      var minE = (bar.offsetLeft || 12) + (bar.offsetWidth || 52) + 10;
      editor.style.left = clamp(r.right - br.left + 12, minE, Math.max(minE, br.width - 340)) + "px";
      editor.style.top = clamp(r.top - br.top, 8, Math.max(8, br.height - 320)) + "px";
      (c.body ? b : t).focus();
    }
    function closeEditor() { if (editor) { editor.remove(); editor = null; } }

    // ── Lines ────────────────────────────────────────────────────────────
    function link(fromId, toId, fc, tc, flowLink) {
      var dup = state.links.some(function (l) { return (l.from === fromId && l.to === toId) || (l.from === toId && l.to === fromId); });
      if (dup) return null;
      var l = { id: uid(), from: fromId, to: toId };
      if (fc) l.fc = fc;
      if (tc) l.tc = tc;
      if (flowLink) l.fresh = true;
      state.links.push(l);
      drawLinks();
      return l;
    }
    function curve(a, b, dirA, horiz) {
      if (horiz === false) {
        var dy = Math.max(40, Math.abs(b.y - a.y) * 0.45) * (dirA || 1);
        return "M" + a.x + "," + a.y + " C" + a.x + "," + (a.y + dy) + " " + b.x + "," + (b.y - dy) + " " + b.x + "," + b.y;
      }
      var dx = Math.max(50, Math.abs(b.x - a.x) * 0.45);
      var dir = dirA || (b.x >= a.x ? 1 : -1);
      return "M" + a.x + "," + a.y + " C" + (a.x + dx * dir) + "," + a.y + " " + (b.x - dx * dir) + "," + b.y + " " + b.x + "," + b.y;
    }
    function drawLinks() {
      Array.prototype.slice.call(svg.querySelectorAll(".wb-link:not(.wb-preview), .wb-hit")).forEach(function (p) { p.remove(); });
      state.links.forEach(function (l) {
        var a = cardById(l.from), b = cardById(l.to);
        if (!a || !b) return;
        var d;
        if (l.fc && l.tc) d = curve(cornerXY(a, l.fc), cornerXY(b, l.tc));
        else {
          var pa = sidePoint(a, b), pb = sidePoint(b, a);
          d = curve(pa, pb, pa.dir, pa.h);
        }
        var p = document.createElementNS(SVGNS, "path");
        var running = b.state === "running";
        p.setAttribute("class", "wb-link" + (l.id === selectedLink ? " wb-sel" : "") + (l.fresh ? " wb-draw" : "") + (running ? " wb-live" : "") + (b.state === "failed" ? " wb-bad" : ""));
        p.setAttribute("d", d);
        svg.appendChild(p);
        if (l.fresh) { delete l.fresh; }
        var hit = document.createElementNS(SVGNS, "path");
        hit.setAttribute("class", "wb-hit");
        hit.setAttribute("d", d);
        hit.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
        hit.addEventListener("click", function (e) {
          e.stopPropagation();
          selected = {};
          selectedLink = selectedLink === l.id ? null : l.id;
          paintSelection();
          drawLinks();
          canvas.focus({ preventScroll: true });
        });
        svg.appendChild(hit);
      });
    }

    // ── Pointer: the board itself (pan, box-select, place a new card) ────────
    var spaceDown = false;
    function setTool(t) {
      tool = t;
      Object.keys(toolBtns).forEach(function (k) {
        toolBtns[k].classList.toggle("on", k === t);
        toolBtns[k].setAttribute("aria-pressed", k === t ? "true" : "false");
      });
      canvas.classList.toggle("wb-hand", t === "hand");
      canvas.classList.toggle("wb-placing", t === "note" || t === "agent" || t === "skill" || t === "output");
    }
    setTool("select");
    canvas.addEventListener("pointerdown", function (e) {
      if (e.target.closest && (e.target.closest(".wb-card") || e.target.closest(".wb-hit"))) return;
      canvas.focus({ preventScroll: true });
      closeEditor();
      var pan = e.button === 1 || spaceDown || tool === "hand";
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      if (pan) {
        var sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
        canvas.classList.add("wb-panning");
        var mv = function (ev) { view.x = ox + ev.clientX - sx; view.y = oy + ev.clientY - sy; applyView(); };
        var up = function () {
          canvas.classList.remove("wb-panning");
          canvas.removeEventListener("pointermove", mv);
          canvas.removeEventListener("pointerup", up);
          persist();
        };
        canvas.addEventListener("pointermove", mv);
        canvas.addEventListener("pointerup", up);
        return;
      }
      if (tool === "note" || tool === "agent" || tool === "skill" || tool === "output") {
        var p = toWorld(e.clientX, e.clientY);
        var made = addCard({
          kind: tool === "output" ? "document" : tool,
          title: tool === "agent" ? "agent.md" : tool === "skill" ? "New skill" : tool === "output" ? "Output" : "Note",
          user: true,
        }, { x: p.x - 90, y: p.y - 30 });
        setTool("select");
        if (made) { select(made.id, false); openEditor(made); }
        return;
      }
      // Box selection.
      var r = canvas.getBoundingClientRect();
      var x0 = e.clientX - r.left, y0 = e.clientY - r.top;
      var base = e.shiftKey ? Object.assign({}, selected) : {};
      if (!e.shiftKey) clearSelection();
      var boxing = false;
      var mvb = function (ev) {
        var x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
        if (!boxing && Math.abs(x1 - x0) + Math.abs(y1 - y0) < 4) return;
        boxing = true;
        marquee.hidden = false;
        var L = Math.min(x0, x1), T = Math.min(y0, y1), W = Math.abs(x1 - x0), H = Math.abs(y1 - y0);
        marquee.style.left = L + "px"; marquee.style.top = T + "px"; marquee.style.width = W + "px"; marquee.style.height = H + "px";
        var wa = { x: (L - view.x) / view.z, y: (T - view.y) / view.z }, wb = { x: (L + W - view.x) / view.z, y: (T + H - view.y) / view.z };
        selected = Object.assign({}, base);
        state.cards.forEach(function (c) {
          var n = nodes[c.id];
          var cw = n ? n.offsetWidth : 180, ch = n ? n.offsetHeight : 120;
          // Miro's rule today: a plain drag selects every card the box touches.
          if (c.x < wb.x && c.x + cw > wa.x && c.y < wb.y && c.y + ch > wa.y) selected[c.id] = true;
        });
        paintSelection();
      };
      var upb = function () {
        marquee.hidden = true;
        canvas.removeEventListener("pointermove", mvb);
        canvas.removeEventListener("pointerup", upb);
      };
      canvas.addEventListener("pointermove", mvb);
      canvas.addEventListener("pointerup", upb);
    });
    canvas.addEventListener("wheel", function (e) {
      if (e.target.closest && e.target.closest(".wb-body-text")) {
        var t = e.target.closest(".wb-body-text");
        if (t.scrollHeight > t.clientHeight && !e.ctrlKey && !e.metaKey) return; // let long text scroll
      }
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Pinch on a trackpad arrives as ctrl+wheel with small deltas.
        var f = Math.exp(-e.deltaY * (Math.abs(e.deltaY) < 30 ? 0.012 : 0.0025));
        zoomAt(e.clientX, e.clientY, view.z * f);
      } else {
        view.x -= e.deltaX; view.y -= e.deltaY;
        applyView();
        persist();
      }
    }, { passive: false });

    // ── Keyboard ─────────────────────────────────────────────────────────
    function onKeyDown(e) {
      if (!root.isConnected || typingInto(e.target)) return;
      // Only while the board itself has focus: never while the Talk bar or the
      // conversation beside it does.
      var a = document.activeElement;
      if (!a || !body.contains(a) || sideWrap.contains(a) || hist.contains(a)) return;
      var mod = e.ctrlKey || e.metaKey;
      if (e.key === " " && !spaceDown) { spaceDown = true; canvas.classList.add("wb-hand"); e.preventDefault(); return; }
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) { if (redo.length) { undo.push(JSON.stringify({ cards: state.cards, links: state.links })); restore(redo.pop()); } }
        else if (undo.length) { redo.push(JSON.stringify({ cards: state.cards, links: state.links })); restore(undo.pop()); }
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); if (redo.length) { undo.push(JSON.stringify({ cards: state.cards, links: state.links })); restore(redo.pop()); } return; }
      if (mod && (e.key === "a" || e.key === "A")) { e.preventDefault(); selected = {}; state.cards.forEach(function (c) { selected[c.id] = true; }); paintSelection(); return; }
      if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateSelected(); return; }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSelected(); return; }
      if (e.key === "Escape") { closeEditor(); keyList.hidden = true; hist.hidden = true; clearSelection(); setTool("select"); return; }
      // Miro's keys: Alt/Option+1 fits everything, Alt/Option+2 zooms to the
      // selection, Ctrl/⌘+0 goes back to 100%, F1 lists the shortcuts.
      if ((e.altKey || e.shiftKey) && e.code === "Digit1") { e.preventDefault(); fit(); return; }
      if (e.altKey && e.code === "Digit2") { e.preventDefault(); zoomToSelection(); return; }
      if (mod && (e.key === "0" || e.code === "Digit0")) { e.preventDefault(); zoomTo(1); return; }
      if (e.key === "F1" || e.key === "?") { e.preventDefault(); showKeys(keyList.hidden); return; }
      var d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (d && Object.keys(selected).length) {
        e.preventDefault();
        var step = e.shiftKey ? 100 : 10;
        snapshot();
        state.cards.forEach(function (c) { if (selected[c.id]) { c.x += d[0] * step; c.y += d[1] * step; place(c); } });
        drawLinks(); positionSelbar(); persist();
        return;
      }
      if (mod || e.altKey) return;
      var k = e.key.toLowerCase();
      var map = { v: "select", h: "hand", n: "note", a: "agent", k: "skill", o: "output" };
      if (map[k]) { e.preventDefault(); setTool(map[k]); return; }
      if (k === "u") { e.preventDefault(); picker.click(); return; }
      if (k === "+" || k === "=") { e.preventDefault(); zoomBy(1.25); return; }
      if (k === "-") { e.preventDefault(); zoomBy(1 / 1.25); return; }
    }
    function onKeyUp(e) {
      if (e.key === " " && spaceDown) { spaceDown = false; canvas.classList.toggle("wb-hand", tool === "hand"); }
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    function duplicateSelected() {
      var list = state.cards.filter(function (c) { return selected[c.id]; });
      if (!list.length) return;
      snapshot();
      var map = {};
      var fresh = {};
      list.forEach(function (c) {
        var copy = JSON.parse(JSON.stringify(c));
        copy.id = uid();
        delete copy.flow;
        copy.x += 30; copy.y += 30;
        map[c.id] = copy.id;
        state.cards.push(copy);
        renderCard(copy);
        fresh[copy.id] = true;
      });
      state.links.slice().forEach(function (l) { if (map[l.from] && map[l.to]) state.links.push({ id: uid(), from: map[l.from], to: map[l.to], fc: l.fc, tc: l.tc }); });
      selected = fresh;
      drawLinks(); paintSelection(); refreshHint(); persist();
    }

    // ── Create recipe from the selection ─────────────────────────────────
    recipeBtn.addEventListener("click", function () {
      recipeBtn.hidden = true;
      namer.hidden = false;
      var agent = state.cards.filter(function (c) { return selected[c.id] && kindOf(c) === "agent"; })[0];
      nameIn.value = agent && agent.title && agent.title !== "agent.md" ? agent.title : "";
      nameIn.focus();
      positionSelbar();
    });
    nameNo.addEventListener("click", function () { namer.hidden = true; recipeBtn.hidden = false; positionSelbar(); });
    namer.addEventListener("submit", function (e) {
      e.preventDefault();
      var graph = selectionGraph();
      if (!graph.nodes.length) { say("Select some cards first."); return; }
      nameGo.disabled = true;
      fetch("/api/buzzy/board-recipes", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nameIn.value.trim() || "My recipe", graph: graph }),
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          nameGo.disabled = false;
          if (!res.ok || !res.j || !res.j.ok) { say((res.j && res.j.error) || "The recipe could not be saved."); return; }
          namer.hidden = true; recipeBtn.hidden = false;
          say("Saved “" + res.j.recipe.name + "”. It's under Recipes, ready to run.", 4200);
          if (opts.onRecipe) opts.onRecipe(res.j.recipe);
        })
        .catch(function () { nameGo.disabled = false; say("The recipe could not be saved — check the connection."); });
    });
    function selectionGraph() {
      var list = state.cards.filter(function (c) { return selected[c.id]; });
      var ids = {};
      list.forEach(function (c) { ids[c.id] = true; });
      return {
        nodes: list.map(function (c) {
          var k = kindOf(c);
          var r = roleOf(k);
          return { id: c.id, kind: k === "memory" ? "memory" : r, title: c.title, body: (c.body || (c.url ? c.url : "")).slice(0, 2000), x: c.x, y: c.y };
        }),
        links: state.links.filter(function (l) { return ids[l.from] && ids[l.to]; }).map(function (l) { return { from: l.from, to: l.to }; }),
      };
    }

    // ── Drops: files from the computer, Inspiration cards, search results, links ─
    var TYPE = "application/x-beezilla-card";
    function acceptable(e) {
      var t = e.dataTransfer && e.dataTransfer.types ? Array.prototype.slice.call(e.dataTransfer.types) : [];
      return t.indexOf(TYPE) >= 0 || t.indexOf("text/uri-list") >= 0 || t.indexOf("Files") >= 0;
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
      root.classList.remove("wb-target");
      if (!acceptable(e)) return;
      e.preventDefault();
      e.stopPropagation();
      var at = toWorld(e.clientX, e.clientY);
      at = { x: at.x - 90, y: at.y - 30 };
      if (e.dataTransfer.files && e.dataTransfer.files.length) { uploadFiles(e.dataTransfer.files, at); return; }
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
    function dragStarted(e) { if (acceptable(e)) root.classList.add("wb-target"); }
    function dragFinished() { root.classList.remove("wb-target"); root.classList.remove("wb-over"); }
    document.addEventListener("dragstart", dragStarted);
    document.addEventListener("dragend", dragFinished);
    document.addEventListener("drop", dragFinished);

    // A file from the computer goes to the person's Library first, then onto the board.
    function uploadFiles(files, at) {
      Array.prototype.slice.call(files || [], 0, 12).forEach(function (f, i) {
        var spot = { x: at.x + i * 24, y: at.y + i * 24 };
        var card = addCard({ title: f.name, contentType: f.type, state: "running", body: "Adding to your Library…" }, spot);
        if (!card) return;
        fetch("/api/buzzy/assets", {
          method: "POST",
          credentials: "same-origin",
          // A header carries plain ASCII only; the name is display metadata anyway.
          headers: { "Content-Type": f.type || "application/octet-stream", "x-bz-path": String(f.name || "file").replace(/[^\x20-\x7E]/g, "_").slice(0, 380) },
          body: f,
        }).then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j || !j.ok || !j.id) throw new Error((j && j.error) || "upload failed");
            card.url = "/api/buzzy/assets/" + encodeURIComponent(j.id);
            card.state = "";
            card.body = "";
            if (!nodes[card.id]) return;           // removed while it uploaded
            fillCard(nodes[card.id], card);
            drawLinks();
            persist();
          })
          .catch(function (err) {
            card.state = "failed";
            card.err = String(err && err.message || "It could not be added.").slice(0, 160);
            if (!nodes[card.id]) return;
            fillCard(nodes[card.id], card);
            persist();
          });
      });
    }

    // ── The live process: steps from the chat stream ─────────────────────
    function flow(step) {
      if (!step || !step.id || !root.isConnected) return null;
      var fid = String(step.id);
      var c = cardByFlow(fid);
      var kind = step.kind === "output" ? kindOf({ title: step.title, url: step.url, contentType: step.contentType })
        : step.kind === "agent" ? "agent" : step.kind === "memory" ? "memory" : "skill";
      if (kind === "file" && step.kind === "output") kind = "document";
      if (!c) {
        var parent = step.parent ? cardByFlow(String(step.parent)) : null;
        if (!parent && step.kind !== "agent") parent = cardByFlow("agent");
        var at;
        if (step.kind === "agent") {
          // Top-left of the part of the board you can see.
          var cr = canvas.getBoundingClientRect(), oa = openArea();
          var vc = toWorld(cr.left + oa.x + 24, cr.top + oa.y + 24);
          at = { x: vc.x, y: vc.y };
        } else if (parent) {
          var pn = nodes[parent.id];
          var px = parent.x + (pn ? pn.offsetWidth : 200) + COL_GAP;
          // Next to the parent, below whatever already hangs in that column.
          var lowest = parent.y;
          state.cards.forEach(function (o) {
            if (o.id === parent.id || Math.abs(o.x - px) > 40) return;
            var hangs = state.links.some(function (l) { return l.from === parent.id && l.to === o.id; });
            if (hangs) { var on = nodes[o.id]; lowest = Math.max(lowest, o.y + (on ? on.offsetHeight : 120) + 24); }
          });
          at = { x: px, y: lowest };
        } else at = viewCentre();
        c = addCard({
          kind: kind, title: step.title || KIND_LABEL[kind], body: step.detail || "",
          url: step.url || "", contentType: step.contentType || "", flow: fid,
          state: step.state === "done" ? "" : (step.state || ""), taskId: step.taskId,
        }, at, true);
        if (!c) return null;
        if (step.state === "failed") c.err = step.detail || "";
        if (parent) {
          var l = link(parent.id, c.id, null, null, true);
          if (l) drawLinks();
        }
        fillCard(nodes[c.id], c);
        drawLinks();
        reveal(c);
      } else {
        if (step.title && !(c.user && step.kind === "agent")) c.title = String(step.title).slice(0, 140);
        if (step.url) c.url = String(step.url);
        if (step.contentType) c.contentType = String(step.contentType);
        if (step.thumb) c.thumb = String(step.thumb);
        if (step.detail != null && !c.user && (step.state === "running" || step.kind === "agent" || !c.body)) c.body = String(step.detail).slice(0, 4000);
        if (step.state) c.state = step.state === "done" ? "" : step.state;
        if (step.state === "failed") c.err = step.detail || c.err || "";
        if (step.kind === "output" && step.url) c.kind = kindOf({ title: c.title, url: c.url, contentType: c.contentType });
        fillCard(nodes[c.id], c);
        drawLinks();
      }
      persist();
      return c;
    }

    // ── A saved recipe, back on the board ────────────────────────────────
    function addGraph(graph) {
      if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length) return;
      snapshot();
      var minX = Infinity, minY = Infinity;
      graph.nodes.forEach(function (n) { minX = Math.min(minX, n.x || 0); minY = Math.min(minY, n.y || 0); });
      var origin = viewCentre();
      var b = bounds(state.cards);
      if (b) origin = { x: origin.x, y: Math.max(origin.y, b.y2 + 60) };
      var map = {};
      selected = {};
      graph.nodes.forEach(function (n) {
        var c = addCard({
          kind: n.kind === "output" ? "document" : n.kind, title: n.title, body: n.body, user: true, exact: true,
        }, { x: origin.x + (n.x - minX), y: origin.y + (n.y - minY) }, true);
        if (c) { map[n.id] = c.id; selected[c.id] = true; }
      });
      (graph.links || []).forEach(function (l) { if (map[l.from] && map[l.to]) link(map[l.from], map[l.to], null, null, true); });
      drawLinks();
      paintSelection();
      fit();
      persist();
    }

    // ── What the person changed, as instructions for their next message ──────
    function instructions() { return compile(state.cards); }

    // ── The account's copy, put on the board in place ────────────────────
    // Cards keep their objects where they still exist, so an upload or an edit in
    // flight lands on the card it started on. Never called mid-drag or mid-edit.
    function applyRemote(content) {
      var wasEmpty = !state.cards.length;
      var byId = {};
      state.cards.forEach(function (c) { byId[c.id] = c; });
      state.cards = copy(content.cards || []).map(function (nc) {
        var cur = byId[nc.id];
        if (!cur) return nc;
        Object.keys(cur).forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(nc, k)) delete cur[k]; });
        Object.keys(nc).forEach(function (k) { cur[k] = nc[k]; });
        return cur;
      });
      state.links = copy(content.links || []);
      var was = selected;
      undo = [];
      redo = [];
      rebuild();
      Object.keys(was).forEach(function (id) { if (nodes[id]) selected[id] = true; });
      paintSelection();
      eng.lastSig = sigOf(state);
      clearTimeout(saveTimer);
      saveTimer = 0;
      save(key, state);
      // A board that arrives on an empty screen (another computer's, say) is framed to fit.
      if (wasEmpty && state.cards.length) requestAnimationFrame(function () { fit(); state.viewSet = true; });
    }

    // ── Start ────────────────────────────────────────────────────────────
    // Not cut to MAX_CARDS: two computers' cards merged can briefly hold more, and
    // cutting would lose some. Adding stops at MAX_CARDS.
    state.cards.forEach(renderCard);
    refreshHint();
    applyView();
    requestAnimationFrame(function () { drawLinks(); if (state.cards.length && !state.viewSet) { fit(); state.viewSet = true; } });
    if (window.ResizeObserver) new ResizeObserver(function () { positionSelbar(); }).observe(canvas);

    function pointerDown() { pointerBusy = true; }
    function pointerDone() { pointerBusy = false; }
    body.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("pointerup", pointerDone, true);
    window.addEventListener("pointercancel", pointerDone, true);

    // Bound to its engine: read from the account now, and again whenever the page
    // comes back into view (another computer may have changed it meanwhile); on the
    // way out, anything unsaved goes to the account.
    eng.cleanCopy = state.sync.dirty ? null : copy(contentOf(state));
    eng.lastSig = sigOf(state);
    eng.live = {
      state: state,
      flush: function () { if (saveTimer) writeNow(); },
      write: function () { if (saveTimer) writeNow(); else save(key, state); },
      apply: applyRemote,
      busy: function () { return pointerBusy || !!editor; },
      status: paintSync,
    };
    function leaving() {
      if (saveTimer) writeNow();
      if (state.sync.dirty && !eng.off) push(eng, true);
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") leaving();
      else if (Date.now() - eng.pulledAt > 4000) pull(eng);
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", leaving);
    paintSync();
    pull(eng);

    return {
      root: root,
      dock: dock,
      side: side,
      flow: flow,
      addCard: function (c) {
        var made = addCard(c);
        if (made) { fillCard(nodes[made.id], made); reveal(made); }
        return made;
      },
      addGraph: addGraph,
      instructions: instructions,
      fit: fit,
      say: say,
      clear: function () { snapshot(); state.cards = []; state.links = []; rebuild(); persist(); },
      isOpen: function () { return !!root.isConnected; },
      count: function () { return state.cards.length; },
      destroy: function () {
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("keyup", onKeyUp);
        document.removeEventListener("dragstart", dragStarted);
        document.removeEventListener("dragend", dragFinished);
        document.removeEventListener("drop", dragFinished);
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", leaving);
        window.removeEventListener("pointerup", pointerDone, true);
        window.removeEventListener("pointercancel", pointerDone, true);
        writeNow();
        gone = true;
        if (eng.live && eng.live.state === state) eng.live = null;
        // Folded away or switched: the board still finishes saving to the account.
        if (state.sync.dirty && !eng.off) push(eng);
        root.remove();
      },
    };
  }

  window.BeeZillaWhiteboard = {
    mount: mount,
    kindOf: kindOf,
    /** The person's edits on a board that is not on screen (folded away). */
    instructionsFor: function (boardId) {
      var v = load(keyFor(boardId));
      return v ? compile(v.cards) : "";
    },
    /** The board in front of a new conversation ("talk") joins it once it has an id. */
    carry: carry,
    /** A board that isn't on screen: bring this browser's copy up to date with the
     *  account (and send up what never reached it), so its instructions are current. */
    sync: function (boardId) {
      var e = engine(boardId);
      return e.live ? Promise.resolve() : syncBoard(e);
    },
    /** Send up, one at a time, the boards in this browser that never reached the account. */
    sweep: sweep,
    merge: merge3,
    graft: graft,
  };
})();
