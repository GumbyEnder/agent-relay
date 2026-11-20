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
 * Connect and share (owner, 2026-11-20, after "/space" — Slashspace, Flowith, Poppy):
 *   "create the same connectors and node system, but within our own framework…
 *    We're not trying to create massive whiteboards. We're trying to allow people to
 *    cordon off a little piece of what they do, or an entire whiteboard of what they
 *    do, and be like, okay, sell this as an orchestration."
 *   - Lines mean something. Every card has one dot on its right edge; drag it onto a
 *     card to connect them, the way the work flows (left to right, with an arrow).
 *     A line into one of BeeZilla's steps — agent.md, a skill, the end result, or the
 *     conversation — means "use this here": it goes to BeeZilla in full with the next
 *     message. Lines chain (a note → a picture → a step brings both), and a picture
 *     connected to a step is the reference when BeeZilla draws or changes a picture.
 *     With no lines, BeeZilla still sees the whole board as a list, as before.
 *   - Click a step to light up everything that feeds it. Click a line to remove it.
 *     Let go of a line on empty board and a new step appears there, already connected.
 *   - An area cordons off a piece of the board: select cards, Make an area. Drag its
 *     label to move everything inside; connect it to a step to bring all of it.
 *   - Sell this orchestration (coming soon), on an area or for the whole board: trade
 *     it for Honey Drops or Honey, or open-source it — and say whether what it made can
 *     be shown as examples in Inspiration and Recipes.
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
    // A thumb and four fingers. The first drawing had a thumb and three (owner,
    // 2026-11-20: "There should be a 4th finger… 5 fingers total").
    hand: "M6.5 15V6.2a1.75 1.75 0 013.5 0V11M10 10.5V4.5a1.75 1.75 0 013.5 0v6M13.5 10.5V5.7a1.75 1.75 0 013.5 0v5.3M17 9.2a1.75 1.75 0 013.5 0v5.3a7.3 7.3 0 01-7.3 7.3h-1.6c-2.4 0-3.9-.8-5.3-2.1l-3.4-3.4a1.75 1.75 0 012.5-2.5L6.5 15",
    note: "M5 4h14v10l-5 6H5zM14 20v-6h5",
    agent: "M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7",
    skill: "M12 2l2.2 6.3L21 9l-5.2 4 1.8 6.6L12 16l-5.6 3.6L8.2 13 3 9l6.8-.7z",
    output: "M5 21V4M5 4h12l-2.5 4.5L17 13H5",
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
    area: "M4 4h4M11 4h2M16 4h4v4M20 11v2M20 16v4h-4M13 20h-2M8 20H4v-4M4 13v-2M4 8V4",
    sell: "M3 12V4h8l10 10-8 8zM7.5 7.5h.01",
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
    if (k === "area") return k;
    if (k === "agent" || k === "skill" || k === "memory" || k === "note" || k === "chat") return k;
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
  // "chat" is the conversation itself, sitting on the board as a card (owner, 2026-11-20:
  // "The conversation history… would be on the board itself as a thing that you could
  // scroll by. It would just be sitting there."). It is never an instruction, a file or a
  // step of a recipe, and there is one per board (its id is always "chat").
  // "area" is the branch's grouping box: it is never an instruction either, it is a frame
  // the recipe graph flattens back into its contents.
  var ROLE = { agent: "agent", skill: "skill", memory: "skill", note: "note", chat: "chat", area: "area" };
  var CHAT_ID = "chat";
  function roleOf(kind) { return ROLE[kind] || "output"; }
  var GLYPH = { document: "W", sheet: "E", slides: "P", pdf: "PDF" };
  var KIND_LABEL = {
    agent: "Instructions", skill: "Skill", memory: "Memory", note: "Note", chat: "Conversation", image: "Picture", track: "Music",
    model: "3D model", video: "Video", document: "Document", sheet: "Spreadsheet", slides: "Slides", pdf: "PDF", file: "File",
    area: "Area",
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
      if (c.id === CHAT_ID && ids[CHAT_ID]) { map[c0.id] = CHAT_ID; return; }   // one conversation card
      var same = c.flow ? byFlow[c.flow] : null;
      if (same) {
        // Its place stays; the person's words there stay unless new ones were written
        // on this board (then those, still counted as theirs).
        var keepHere = { id: 1, x: 1, y: 1 };
        if (same.user && !c.user) { keepHere.title = 1; keepHere.body = 1; keepHere.user = 1; }
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
    var before = copy(contentOf(doc));      // a copy: fn may change cards in place
    fn(doc);
    if (canon(contentOf(doc)) === canon(before)) return false;
    if (!doc.sync.dirty) { doc.sync.dirty = true; doc.sync.base = doc.sync.rev == null ? null : before; }
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
        cleanCopy: null, lastSig: null, touched: false,
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
  // In step with the account: the next trouble starts its waiting from the beginning.
  function settled(e) {
    wentWell(e);
    setStatus(e, "saved");
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
        return mergeWith(e, j.board).then(function (again) {
          if (!again) { settled(e); return; }
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
    return Promise.resolve(settleWith(e, board)).then(function () { return bringBack(e); });
  }
  function settleWith(e, board) {
    var doc = docOf(e);
    if (!doc) {
      if (!board) return;
      doc = blank();
    }
    if (e.off) { setStatus(e, "local"); return; }
    if (!doc.sync.who && doc.sync.dirty && e.touched) ours(doc);   // changed on this page: this account's
    if (foreign(doc)) {
      // Last saved to another account: someone else was signed in on this computer.
      // Their unsaved changes are set aside for them, never sent to this account (a
      // saved copy is safe in their account), and this account's own board comes up.
      if (doc.sync.dirty && !setAside(e.id, doc)) { e.off = true; setStatus(e, "local"); return; }
      adopt(e, doc, board ? contentOf(board.state) : { cards: [], links: [] }, board ? board.rev : null);
      settled(e);
      return;
    }
    if (!board) {
      if (doc.sync.rev != null && !doc.sync.dirty) {
        // The account no longer has it (it moved on into its conversation): follow.
        adopt(e, doc, { cards: [], links: [] }, null);
        settled(e);
        return;
      }
      if (doc.sync.dirty) return pushNow(e, 0);         // only here so far: send it up
      settled(e);
      return;
    }
    if (board.rev === doc.sync.rev) {
      if (doc.sync.dirty) return pushNow(e, 0);
      settled(e);
      return;
    }
    if (!doc.sync.dirty) { adopt(e, doc, contentOf(board.state), board.rev); settled(e); return; }
    return mergeWith(e, board).then(function (again) {
      if (again) return pushNow(e, 0);
      settled(e);
    });
  }
  // Someone else's unsaved copy, kept under their account's code ("bz.board.<id>~<who>")
  // until they are back on this computer.
  function setAside(id, doc) { return save(keyFor(id) + "~" + doc.sync.who, doc); }
  // This account's changes that were set aside while someone else was signed in here
  // join the board again, and go to the account.
  function bringBack(e) {
    if (!whoNow || e.off) return;
    var key = keyFor(e.id) + "~" + whoNow;
    var mine = load(key);
    if (!mine) return;
    var doc = docOf(e) || blank();
    var merged = merge3(mine.sync.base, contentOf(mine), contentOf(doc));
    if (canon(merged) !== sigOf(doc)) {
      if (!doc.sync.dirty) { doc.sync.dirty = true; doc.sync.base = doc.sync.rev == null ? null : copy(contentOf(doc)); }
      ours(doc);
      applyTo(e, doc, merged);
    }
    try { localStorage.removeItem(key); } catch (_) { /* best effort */ }
    return pushNow(e, 0);
  }
  function pull(e) {
    return enqueue(e, function () {
      e.pulledAt = Date.now();
      return request("GET", API + encodeURIComponent(e.id)).then(function (res) {
        if (res.status === 401) { setStatus(e, "signedout"); return; }
        if (res.status !== 200 || !res.json || !res.json.ok) throw new Error("status " + res.status);
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
          // Anything drawn while the request was out stays, on top of the version
          // brought back (the same merge as two computers).
          return mergeWith(e, j.board).then(function (again) {
            if (again) return pushNow(e, 0).then(function () { return { ok: true }; });
            settled(e);
            return { ok: true };
          });
        });
      });
    }).catch(function () { return { ok: false, error: "Can't reach your account right now. Try again in a moment." }; });
  }

  // A late result for one card of a board that is no longer on screen in this mount.
  function patchCard(boardId, cardId, fields) {
    var e = engine(boardId);
    if (e.live) { e.live.patch(cardId, fields); return; }
    var doc = load(keyFor(boardId));
    if (!doc || foreign(doc)) return;
    var changed = editDoc(doc, function (d) {
      d.cards.forEach(function (c) { if (c.id === cardId) Object.keys(fields).forEach(function (k) { c[k] = fields[k]; }); });
    });
    if (changed && save(keyFor(boardId), doc)) push(e);
  }

  // The board in front of a new conversation joins the conversation once it has an
  // id (voice-stage.js), here and in the account; "talk" is then empty again.
  function carry(from, to) {
    if (from !== SCRATCH || !to || to === SCRATCH) return Promise.resolve();
    var se = engine(from), de = engine(to);
    var src = load(keyFor(from));
    if (!src || !hasContent(src) || se.live) return Promise.resolve();
    if (foreign(src)) return Promise.resolve();   // another account's copy never joins this one
    var g;
    if (de.live) {
      // The conversation's board is already up (it opened as the turn started): the
      // cards join it there, and it saves them.
      var live = de.live.state;
      g = graft(contentOf(live), contentOf(src));
      if (!live.sync.dirty) { live.sync.dirty = true; live.sync.base = live.sync.rev == null ? null : copy(contentOf(live)); }
      ours(live);
      de.live.apply(g);
    } else {
      var dst = load(keyFor(to)) || blank();
      var was = hasContent(dst);
      editDoc(dst, function (d) {
        g = graft(contentOf(d), contentOf(src));
        d.cards = g.cards;
        d.links = g.links;
        if (!was) { d.view = src.view; if (src.viewSet) d.viewSet = true; }
      });
      if (!dst.sync.who) ours(dst);
      if (!save(keyFor(to), dst)) return Promise.resolve();   // couldn't be written down: "talk" keeps it
    }
    editDoc(src, function (s) { s.cards = []; s.links = []; });
    save(keyFor(from), src);
    return Promise.all([push(se), de.live ? push(de) : syncBoard(de)]);
  }

  // A fresh visit starts on a blank board (owner, 2026-11-20: "It should open to a blank
  // page each time"). The board in front of a new conversation is emptied, here and in
  // the account, after the account's copy has been read, so nothing from another
  // computer comes back on top of it. Its earlier versions stay in History.
  function reset(id) {
    var e = engine(id || SCRATCH);
    return pull(e).then(function () {
      return enqueue(e, function () {
        var doc = docOf(e);
        if (!doc || e.off || foreign(doc)) return;
        if (!editDoc(doc, function (d) { d.cards = []; d.links = []; })) return;
        if (e.live && e.live.state === doc) e.live.apply({ cards: [], links: [] });
        else save(keyFor(e.id), doc);
        return pushNow(e, 0);
      });
    });
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

  // What BeeZilla is told about a board, sent with the next message.
  //  - First the person's own cards (ones they wrote or edited), in board order:
  //    agent.md, then each skill left to right, then the output and notes. These are
  //    their instructions.
  //  - Then everything else on it that holds something (owner, 2026-11-19: "anything
  //    that's in the whiteboard, it should be able to see in its context"): the
  //    pictures, music, video, 3D models, files and links, whether BeeZilla made them
  //    or the person added them, and BeeZilla's own notes. Its untouched agent.md,
  //    skill and memory cards are left out: they describe what it already does.
  //    Made files go by kind, not by their generated name: the model repeats any
  //    file name it is handed.
  //  - Connected: what the person joined with a line into one of BeeZilla's steps
  //    (see "Connections" below), in full, under the step it feeds. Pictures among
  //    them are named once more on a first line the server reads and removes before
  //    the model sees anything ("[[board-pictures: 12,40]]"): it draws from them.
  function compile(cards, links) {
    var order = (cards || []).filter(Boolean).slice().sort(byPlace);
    var feeds = feedsOf(order, links);
    // The person's own notes that feed a step are written out under that step instead.
    var fed = {};
    feeds.forEach(function (g) { g.items.forEach(function (c) { fed[c.id] = true; }); });
    var mine = order.filter(function (c) {
      return c.user && String(c.body || "").trim() && kindOf(c) !== "area" && !(fed[c.id] && kindOf(c) === "note");
    });
    var lines = [];
    mine.forEach(function (c) { if (kindOf(c) === "agent") lines.push("agent.md (how to work): " + c.body.trim()); });
    var step = 0;
    mine.forEach(function (c) { if (kindOf(c) === "skill") lines.push("Step " + (++step) + " — " + c.title + ": " + c.body.trim()); });
    mine.forEach(function (c) {
      var k = kindOf(c);
      if (roleOf(k) === "output") lines.push("End result — " + c.title + ": " + c.body.trim());
      else if (k === "note") lines.push("Note — " + c.body.trim());
    });
    var listed = {};
    var pictures = [];
    if (feeds.length) {
      if (lines.length) lines.push("");
      lines.push("Connected to BeeZilla's steps — use these where they are joined:");
      feeds.forEach(function (g) {
        lines.push("Into " + stepName(g.step) + ":");
        g.items.forEach(function (c) {
          if (listed[c.id]) { lines.push("- " + shortName(c) + " (listed above)"); return; }
          listed[c.id] = true;
          lines.push(thingLine(c, kindOf(c) === "note" ? 1500 : 800));
          var m = kindOf(c) === "image" ? ASSET_URL.exec(String(c.url || "")) : null;
          if (m && pictures.indexOf(m[1]) < 0 && pictures.length < 4) pictures.push(m[1]);
        });
      });
    }
    var also = [];
    order.forEach(function (c) {
      if (mine.indexOf(c) >= 0 || listed[c.id]) return;
      var k = kindOf(c);
      if (k === "note") {
        if (String(c.title || "").trim() || String(c.body || "").trim()) also.push(thingLine(c, 240));
        return;
      }
      if (roleOf(k) !== "output") return;
      also.push(thingLine(c, 240));
    });
    if (also.length) {
      if (lines.length) lines.push("");
      lines.push("Also on the board:");
      Array.prototype.push.apply(lines, also);
    }
    var text = lines.join("\n").slice(0, feeds.length ? BOARD_TEXT_MAX : 4000);
    return pictures.length ? "[[board-pictures: " + pictures.join(",") + "]]\n" + text : text;
  }
  var BOARD_TEXT_MAX = 7800;
  var ASSET_URL = /^\/api\/buzzy\/assets\/(\d{1,12})(?:[/?#]|$)/;
  var MADE_NAME = /^(?:art|music|video|model|model3d|clip|track)-\d{4}-\d\d-\d\d/i;
  function byPlace(a, b) { return a.x - b.x || a.y - b.y; }
  // One thing on the board, in a line. Made files go by kind, never by their name.
  function thingLine(c, bodyMax) {
    var k = kindOf(c);
    var title = String(c.title || "").replace(/\s+/g, " ").trim();
    var body = String(c.body || "").replace(/\s+/g, " ").trim();
    if (k === "note") return "- Note" + (title ? " — " + title.slice(0, 120) : "") + (body ? ": " + body.slice(0, bodyMax) : "");
    var url = String(c.url || "");
    var web = /^https?:\/\//i.test(url);
    var label = k === "file" && web ? "Link" : (KIND_LABEL[k] || "File");
    var made = MADE_NAME.test(title);
    var line = "- " + label + (c.user ? " they added" : made ? " made here" : "");
    if (title && !made) line += " — " + title.slice(0, 120);
    if (body) line += ": " + body.slice(0, bodyMax);
    if (web) line += " (" + url.slice(0, 300) + ")";
    return line;
  }
  function shortName(c) {
    var k = kindOf(c);
    var title = String(c.title || "").replace(/\s+/g, " ").trim();
    var label = k === "file" && /^https?:\/\//i.test(String(c.url || "")) ? "Link" : (KIND_LABEL[k] || "File");
    return label + (title && !MADE_NAME.test(title) ? " — " + title.slice(0, 80) : "");
  }

  // ── Connections: what feeds BeeZilla's steps ──────────────────────────────
  // A step is one of BeeZilla's own cards: agent.md, a skill (or memory), an end
  // result that is still a description (no file yet), or the conversation card where
  // the page has one. Everything else — notes, pictures, music, files, links — is a
  // thing. A line points the way the work flows (from → to). A step's inputs are the
  // things with a line into it, followed back through other things (a chain), and
  // everything inside an area with a line into it; never through another step, whose
  // own inputs are listed under it. Each thing counts once per step.
  var ANCHOR_X = 105, ANCHOR_Y = 34;       // where a card "is": its title, near the top
  function isStep(c) {
    if (!c) return false;
    if (String(c.kind || "") === "chat") return true;
    var k = kindOf(c);
    if (k === "area") return false;
    return k === "agent" || k === "skill" || k === "memory" || (roleOf(k) === "output" && !c.url && !c.contentType);
  }
  function inArea(area, c) {
    if (!c || c === area || c.id === area.id || kindOf(c) === "area") return false;
    var x = c.x + ANCHOR_X, y = c.y + ANCHOR_Y;
    return x >= area.x && x <= area.x + (Number(area.w) || 0) && y >= area.y && y <= area.y + (Number(area.h) || 0);
  }
  function areaMembers(area, cards) { return (cards || []).filter(function (c) { return inArea(area, c); }); }
  function feedsOf(cards, links) {
    var list = (cards || []).filter(Boolean);
    var byId = {};
    list.forEach(function (c) { byId[c.id] = c; });
    var into = {};
    (links || []).forEach(function (l) {
      if (!l || l.from === l.to || !byId[l.from] || !byId[l.to]) return;
      (into[l.to] = into[l.to] || []).push(l.from);
    });
    var out = [];
    list.filter(isStep).sort(byPlace).forEach(function (stepCard) {
      var seen = {};
      seen[stepCard.id] = true;
      var items = [];
      var queue = (into[stepCard.id] || []).slice();
      while (queue.length) {
        var id = queue.shift();
        if (seen[id]) continue;
        seen[id] = true;
        var c = byId[id];
        if (!c || isStep(c)) continue;
        if (kindOf(c) === "area") {
          areaMembers(c, list).sort(byPlace).forEach(function (m) {
            if (seen[m.id] || isStep(m)) return;
            seen[m.id] = true;
            items.push(m);
          });
        } else items.push(c);
        Array.prototype.push.apply(queue, into[id] || []);
      }
      if (items.length) out.push({ step: stepCard, items: items.slice(0, 24) });
    });
    return out;
  }
  // Everything upstream of one card (lines and areas), for lighting up what feeds it.
  function upstreamOf(cardId, cards, links) {
    var list = (cards || []).filter(Boolean);
    var byId = {};
    list.forEach(function (c) { byId[c.id] = c; });
    var into = {};
    (links || []).forEach(function (l) { if (l && byId[l.from] && byId[l.to]) (into[l.to] = into[l.to] || []).push(l); });
    var cardsLit = {}, linksLit = {};
    var queue = [cardId];
    var seen = {};
    while (queue.length) {
      var id = queue.shift();
      if (seen[id]) continue;
      seen[id] = true;
      (into[id] || []).forEach(function (l) {
        linksLit[l.id] = true;
        cardsLit[l.from] = true;
        var from = byId[l.from];
        if (from && kindOf(from) === "area") areaMembers(from, list).forEach(function (m) { cardsLit[m.id] = true; });
        queue.push(l.from);
      });
    }
    return { cards: cardsLit, links: linksLit };
  }
  function stepName(c) {
    if (String(c.kind || "") === "chat") return "the conversation";
    var k = kindOf(c);
    var t = String(c.title || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (k === "agent") return "agent.md";
    if (k === "skill" || k === "memory") return "the step “" + (t || "Untitled") + "”";
    return "the end result “" + (t || "Untitled") + "”";
  }

  function mount(host, opts) {
    opts = opts || {};
    var boardId = String(opts.boardId || "default").slice(0, 80);
    var key = keyFor(boardId);
    var eng = engine(boardId);
    var local = load(key);
    if (local && foreign(local)) {
      // Last saved to another account (someone else signed in here): set aside for
      // them if unsaved, and this account's own board is read instead.
      if (!local.sync.dirty || setAside(boardId, local)) local = null;
    }
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
      // Put away: this copy may be stale now. Late results go through settleCard.
      if (gone) return;
      var sig = sigOf(state);
      if (sig !== eng.lastSig) {
        eng.lastSig = sig;
        eng.touched = true;
        if (!state.sync.who) ours(state);
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
    root.setAttribute("aria-label", "Idea Board");
    var head = el("div", "wb-head");
    // Named "Idea Board" since CR-4 (main, 2026-11-18); it is the same whiteboard.
    var title = el("h3", "wb-title", "Idea Board");
    head.appendChild(title);
    var dock = el("div", "wb-dock");            // the page puts the Talk bar here
    head.appendChild(dock);
    var tools = el("span", "wb-tools");
    var foldBtn = el("button", "wb-btn wb-fold");
    foldBtn.type = "button";
    foldBtn.appendChild(icon("fold"));
    foldBtn.appendChild(el("span", "wb-btn-label", "Fold away"));
    foldBtn.setAttribute("aria-label", "Fold the Idea Board away");
    foldBtn.title = "Fold the Idea Board away (it keeps everything)";
    // Owner, 2026-11-20: "we should have a coming soon button… with some options on
    // the right that says, sell this orchestration." Here: the whole board.
    var sellBtn = el("button", "wb-btn wb-sell-btn");
    sellBtn.type = "button";
    sellBtn.appendChild(icon("sell"));
    sellBtn.appendChild(el("span", "wb-btn-label", "Sell this orchestration"));
    sellBtn.appendChild(el("span", "wb-soon", "Coming soon"));
    sellBtn.title = "Sell, trade or open-source what you built here (coming soon)";
    sellBtn.setAttribute("aria-label", "Sell this orchestration (coming soon)");
    // The top bar's button is always the whole board; an area has its own on its label.
    sellBtn.addEventListener("click", function () {
      if (sell.hidden || sellFor !== null) openSell(null); else closeSell();
    });
    tools.appendChild(sellBtn);
    tools.appendChild(foldBtn);
    head.appendChild(tools);

    var body = el("div", "wb-body");
    var bar = el("div", "wb-toolbar");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Board tools");
    var TOOLS = [
      ["select", "Select", "V"], ["hand", "Move the board", "H"], ["note", "Note", "N"],
      // "Output" said nothing (owner, 2026-11-20: "It's not clear what output means"): the
      // card says what you want to have at the end.
      ["agent", "agent.md — how BeeZilla works", "A"], ["skill", "Skill — one step", "K"], ["output", "End result — what you want at the end", "E"],
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
    // Arrowheads: amber where the line feeds one of BeeZilla's steps, grey otherwise.
    var arrowId = "wbArrow" + Math.random().toString(36).slice(2, 8);
    var defs = document.createElementNS(SVGNS, "defs");
    [["feed", "wb-arrow-feed"], ["plain", "wb-arrow-plain"], ["sel", "wb-arrow-sel"]].forEach(function (m) {
      var mk = document.createElementNS(SVGNS, "marker");
      mk.setAttribute("id", arrowId + "-" + m[0]);
      mk.setAttribute("viewBox", "0 0 10 10");
      mk.setAttribute("refX", "8.5");
      mk.setAttribute("refY", "5");
      mk.setAttribute("markerWidth", "7");
      mk.setAttribute("markerHeight", "7");
      mk.setAttribute("markerUnits", "userSpaceOnUse");
      mk.setAttribute("orient", "auto");
      var tip = document.createElementNS(SVGNS, "path");
      tip.setAttribute("d", "M0,0 L10,5 L0,10 z");
      tip.setAttribute("class", m[1]);
      mk.appendChild(tip);
      defs.appendChild(mk);
    });
    svg.appendChild(defs);
    world.appendChild(svg);
    // The × on a selected line, at its middle (Poppy's way: no hunting for the line).
    var linkX = el("button", "wb-link-x", "×");
    linkX.type = "button";
    linkX.hidden = true;
    linkX.title = "Remove this line";
    linkX.setAttribute("aria-label", "Remove this line");
    linkX.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    linkX.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!selectedLink) return;
      snapshot();
      state.links = state.links.filter(function (l) { return l.id !== selectedLink; });
      selectedLink = null;
      drawLinks();
      persist();
      say("Line removed. Ctrl/⌘+Z brings it back.");
      canvas.focus({ preventScroll: true });
    });
    world.appendChild(linkX);
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
      if (open) { hist.hidden = true; closeSell(); }
    }

    // Shortcuts are never key-only: the list is one click away in the corner.
    var keyList = el("div", "wb-keylist");
    keyList.hidden = true;
    keyList.setAttribute("role", "dialog");
    keyList.setAttribute("aria-label", "Keyboard shortcuts");
    [["V", "Select"], ["H or Space", "Move the board"], ["Scroll", "Move the board"], ["Ctrl/⌘ + scroll, pinch", "Zoom"],
     ["Alt/Option + 1", "Fit everything"], ["Alt/Option + 2", "Zoom to the selection"], ["Ctrl/⌘ + 0", "Back to 100%"], ["F1", "This list"], ["N / A / K / E", "Note / agent.md / skill / end result"], ["Drag on empty board", "Select an area"],
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

    // Sell this orchestration (coming soon): the right-hand panel. Built by paintSell().
    var sell = el("div", "wb-sellpanel");
    sell.hidden = true;
    sell.setAttribute("role", "dialog");
    sell.setAttribute("aria-label", "Sell this orchestration");
    // Keys inside the panel are the panel's; Esc closes it.
    sell.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Escape") { closeSell(); sellBtn.focus({ preventScroll: true }); }
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
    var areaBtn = el("button", "wb-selbtn wb-area-btn");
    areaBtn.type = "button";
    areaBtn.appendChild(icon("area"));
    areaBtn.appendChild(el("span", null, "Make an area"));
    areaBtn.title = "Draw an area around these cards, to move, connect, save or share them together";
    areaBtn.addEventListener("click", function () {
      var list = state.cards.filter(function (c) { return selected[c.id] && kindOf(c) !== "area"; });
      var made = makeArea(list);
      if (made) { say("Area made. Drag its label to move everything inside; double-click the label to name it.", 4200); }
    });
    selbar.appendChild(areaBtn);
    var selSellBtn = el("button", "wb-selbtn wb-selsell-btn");
    selSellBtn.type = "button";
    selSellBtn.appendChild(icon("sell"));
    selSellBtn.appendChild(el("span", null, "Sell this orchestration"));
    selSellBtn.appendChild(el("span", "wb-soon", "Soon"));
    selSellBtn.title = "Sell, trade or open-source these cards (coming soon)";
    selSellBtn.addEventListener("click", function () {
      var area = state.cards.filter(function (c) { return selected[c.id] && kindOf(c) === "area"; })[0];
      if (!area) area = makeArea(state.cards.filter(function (c) { return selected[c.id] && kindOf(c) !== "area"; }));
      if (area) openSell(area.id);
    });
    selbar.appendChild(selSellBtn);
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

    // The conversation sits ON the board, as a card you can move and scroll (the
    // "chat" card); the page puts the conversation into this slot, and the card holds
    // the slot. It used to be a panel docked down the right side.
    var side = el("div", "wb-side-slot");     // the page puts the conversation here
    var sideWrap = el("div", "wb-side-none"); // nothing docked at the side any more
    var sideOpen = false;
    root.classList.add("wb-side-is-closed");
    // Until the conversation card is on the board (and while cards are redrawn) the slot
    // waits here, hidden but in the page: the page finds its conversation by id.
    var sideHome = el("div", "wb-side-home");
    sideHome.hidden = true;
    sideHome.appendChild(side);

    body.appendChild(bar);
    body.appendChild(canvas);
    body.appendChild(zoom);
    body.appendChild(keyList);
    body.appendChild(hist);
    body.appendChild(sell);
    body.appendChild(selbar);
    body.appendChild(toast);
    body.appendChild(sideHome);
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
      closeSell();
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
          btn.focus({ preventScroll: true });
          say(r.error || "That version couldn't be brought back. Try again in a moment.", 4200);
          return;
        }
        selected = {};
        paintSelection();
        requestAnimationFrame(function () { fit(); });
        // The board you left is the next entry down in History.
        say("Back to the board from " + when(v.savedAt).replace(/^Today, /, "").replace(/^Yesterday/, "yesterday") + ".", 3600);
        loadHistory();
        if (!hist.hidden) histClose.focus({ preventScroll: true });   // the pressed button is gone: Esc still closes
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

    function fillChat(n, c) {
      n.textContent = "";
      n.className = "wb-card wb-k-chat wb-r-chat" + (selected[c.id] ? " wb-on" : "");
      var top = el("div", "wb-ctop wb-chat-bar");
      top.appendChild(icon("note", "wb-cico"));
      top.appendChild(el("span", "wb-ckind", "Conversation"));
      top.appendChild(el("span", "wb-chat-grip", "Drag here to move"));
      top.title = "Your conversation with BeeZilla. Drag this bar to move it; scroll inside to read back.";
      n.appendChild(top);
      var holder = el("div", "wb-chat-body");
      holder.appendChild(side);
      // Inside the conversation, the pointer reads and selects words, and the wheel
      // scrolls it; the board moves only from the bar on top.
      holder.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
      holder.addEventListener("dblclick", function (e) { e.stopPropagation(); });
      holder.addEventListener("wheel", function (e) {
        if (e.ctrlKey || e.metaKey) return;          // zooming the board still works
        e.stopPropagation();
      }, { passive: true });
      n.appendChild(holder);
      n.setAttribute("aria-label", "Conversation");
    }
    function fillCard(n, c) {
      if (kindOf(c) === "chat") { fillChat(n, c); return; }
      if (kindOf(c) === "area") { fillArea(n, c); return; }
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
        n.appendChild(portDot(c));
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
      if (kindOf(c) === "area") { world.insertBefore(n, world.firstChild); sizeArea(c, n); }
      else world.appendChild(n);
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
      if (side.parentNode !== sideHome) sideHome.appendChild(side);   // never thrown out with a card
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
      var isChat = kindOf(card) === "chat";
      if (isChat && cardById(CHAT_ID)) return null;      // one conversation per board
      var c = {
        id: isChat ? CHAT_ID : uid(),
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
      var free = at && card.exact ? spot : isChat ? freeSpot(spot.x, spot.y, 360, 480) : freeSpot(spot.x, spot.y);
      c.x = free.x; c.y = free.y;
      state.cards.push(c);
      renderCard(c);
      refreshHint();
      persist();
      return c;
    }
    function removeCards(ids) {
      var gone = {};
      ids = ids.filter(function (id) { return id !== CHAT_ID; });
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
      areaBtn.hidden = !state.cards.some(function (c) { return selected[c.id] && kindOf(c) !== "area"; });
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
        if (handle && handle.classList.contains("wb-port")) { startConnect(e, n, c); return; }
        if (e.target.closest && e.target.closest(".wb-grip")) { startResize(e, n, c); return; }
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
        var moving = movingSet();
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
        if (c.id === CHAT_ID) return;
        if (e.target.closest && e.target.closest(".bzw,a,video")) return;
        var k = kindOf(c);
        if (roleOf(k) === "output" && c.url && k !== "track") { window.open(c.url, "_blank", "noopener"); return; }
        openEditor(c);
      });
      n.addEventListener("keydown", function (e) {
        if (c.id === CHAT_ID) return;
        if (e.key === "Enter" && !typingInto(e.target)) { e.preventDefault(); openEditor(c); }
      });
      n.addEventListener("focus", function () { if (!selected[c.id]) select(c.id, false); });
    }

    // ── Editing a card (instructions, a skill's steps, the output) ───────────
    var editor = null;
    function openEditor(c) {
      closeEditor(c.id);
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
        roleOf(k) === "output" ? "What you want to have at the end — the finished thing." : "Anything.";
      b.setAttribute("aria-label", "Text");
      if (k === "area") { b.hidden = true; t.placeholder = "Name this area"; }
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
    function closeEditor(keepId) {
      if (editor) { editor.remove(); editor = null; }
      // A step made by letting go of a line on empty board, then left blank: gone again
      // (unless it is the card whose editor is opening now).
      if (keepId && keepId === blankStep) return;
      var blank = blankStep ? cardById(blankStep) : null;
      blankStep = null;
      if (blank && !String(blank.body || "").trim() && blank.title === "New step") removeCards([blank.id]);
    }

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
    // A line leaves a card from its dot (right edge) and comes into the next card from
    // the left, the way the work flows. Lines drawn corner to corner before keep that.
    function portXY(c) {
      var n = nodes[c.id];
      if (kindOf(c) === "area") return { x: c.x + (Number(c.w) || 0), y: c.y + 20 };
      var w = n ? n.offsetWidth : 210, h = n ? n.offsetHeight : 120;
      return { x: c.x + w, y: c.y + Math.min(h / 2, 56) };
    }
    function inXY(c) {
      var n = nodes[c.id];
      if (kindOf(c) === "area") return { x: c.x, y: c.y + 20 };
      var h = n ? n.offsetHeight : 120;
      return { x: c.x - 3, y: c.y + Math.min(h / 2, 56) };
    }
    function flowCurve(p, q) {
      var dx = Math.max(40, Math.abs(q.x - p.x) * 0.5);
      return "M" + p.x + "," + p.y + " C" + (p.x + dx) + "," + p.y + " " + (q.x - dx) + "," + q.y + " " + q.x + "," + q.y;
    }
    // What lights up: everything feeding the one step that is selected.
    function litFor() {
      var ids = Object.keys(selected);
      var c = ids.length === 1 ? cardById(ids[0]) : null;
      return c && isStep(c) ? upstreamOf(c.id, state.cards, state.links) : { cards: {}, links: {} };
    }
    function drawLinks() {
      Array.prototype.slice.call(svg.querySelectorAll(".wb-link:not(.wb-preview), .wb-hit")).forEach(function (p) { p.remove(); });
      var lit = litFor();
      var feeding = {}, live = {};
      state.cards.forEach(function (c) {
        if (!isStep(c)) return;
        var up = upstreamOf(c.id, state.cards, state.links);
        Object.keys(up.links).forEach(function (id) { feeding[id] = true; if (c.state === "running") live[id] = true; });
      });
      // BeeZilla's own work lines (agent.md → skill → what it made) stay the work's colour
      // too; only a line between two things that leads to no step is plain (grey, dashed).
      state.links.forEach(function (l) { if (isStep(cardById(l.from)) || isStep(cardById(l.to))) feeding[l.id] = true; });
      var selPath = null;
      state.links.forEach(function (l) {
        var a = cardById(l.from), b = cardById(l.to);
        if (!a || !b) return;
        var d;
        if (l.fc && l.tc) d = curve(cornerXY(a, l.fc), cornerXY(b, l.tc));
        else d = flowCurve(portXY(a), inXY(b));
        var p = document.createElementNS(SVGNS, "path");
        var running = b.state === "running" || live[l.id];
        var sel = l.id === selectedLink;
        p.setAttribute("class", "wb-link" + (feeding[l.id] ? " wb-feed" : " wb-plain") + (lit.links[l.id] ? " wb-lit" : "") +
          (sel ? " wb-sel" : "") + (l.fresh ? " wb-draw" : "") + (running ? " wb-live" : "") + (b.state === "failed" ? " wb-bad" : ""));
        p.setAttribute("d", d);
        p.setAttribute("marker-end", "url(#" + arrowId + "-" + (sel ? "sel" : feeding[l.id] || lit.links[l.id] ? "feed" : "plain") + ")");
        svg.appendChild(p);
        if (sel) selPath = p;
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
      Object.keys(nodes).forEach(function (id) { nodes[id].classList.toggle("wb-lit", !!lit.cards[id]); });
      // An area's count follows what is in it now.
      state.cards.forEach(function (a) {
        if (kindOf(a) !== "area" || !nodes[a.id]) return;
        var cnt = nodes[a.id].querySelector(".wb-area-count");
        var k = areaMembers(a, state.cards).length;
        if (cnt) cnt.textContent = k === 1 ? "1 card" : k + " cards";
      });
      linkX.hidden = !selPath;
      if (selPath) {
        try {
          var mid = selPath.getPointAtLength(selPath.getTotalLength() / 2);
          linkX.style.left = mid.x + "px";
          linkX.style.top = mid.y + "px";
        } catch (_) { linkX.hidden = true; }
      }
    }

    // ── Connecting: drag a card's dot onto another card ─────────────────────
    var blankStep = null;        // a step made by letting go on empty board, until it has words
    function portDot(c) {
      var h = el("span", "wb-handle wb-port");
      h.setAttribute("data-port", "out");
      h.title = kindOf(c) === "area"
        ? "Drag onto a step: BeeZilla uses everything in this area there"
        : "Drag onto another card to connect it. Into one of BeeZilla's steps, it means: use this here.";
      return h;
    }
    function cardAt(x, y) {
      var t = document.elementFromPoint(x, y);
      var n = t && t.closest ? t.closest(".wb-card") : null;
      if (!n) return null;
      var hit = null;
      Object.keys(nodes).forEach(function (id) { if (nodes[id] === n) hit = cardById(id); });
      return hit;
    }
    function startConnect(e, n, c) {
      var start = portXY(c);
      preview = document.createElementNS(SVGNS, "path");
      preview.setAttribute("class", "wb-link wb-preview");
      preview.setAttribute("marker-end", "url(#" + arrowId + "-feed)");
      svg.appendChild(preview);
      root.classList.add("wb-connecting");
      var over = null;
      function mark(t) {
        if (over === t) return;
        if (over && nodes[over.id]) nodes[over.id].classList.remove("wb-target");
        over = t;
        if (over && nodes[over.id]) nodes[over.id].classList.add("wb-target");
      }
      var move = function (ev) {
        var p = toWorld(ev.clientX, ev.clientY);
        var t = cardAt(ev.clientX, ev.clientY);
        if (t && (t.id === c.id || kindOf(t) === "area")) t = null;
        mark(t);
        if (preview) preview.setAttribute("d", flowCurve(start, t ? inXY(t) : p));
      };
      var done = function (ev, cancelled) {
        n.removeEventListener("pointermove", move);
        n.removeEventListener("pointerup", up);
        n.removeEventListener("pointercancel", cancel);
        document.removeEventListener("keydown", esc, true);
        if (preview) { preview.remove(); preview = null; }
        root.classList.remove("wb-connecting");
        var to = over;
        mark(null);
        if (cancelled) return;
        if (to) {
          var dup = state.links.some(function (l) { return (l.from === c.id && l.to === to.id) || (l.from === to.id && l.to === c.id); });
          if (dup) { say("These two are already connected."); return; }
          snapshot();
          link(c.id, to.id, null, null, true);
          persist();
          if (isStep(to)) say("Connected. BeeZilla uses it for " + stepName(to) + " from your next message.", 4200);
          return;
        }
        // Let go on empty board: a new step there, already connected (nothing dangles).
        var target = document.elementFromPoint(ev.clientX, ev.clientY);
        if (!target || !canvas.contains(target) || (target.closest && target.closest(".wb-card"))) return;
        var p = toWorld(ev.clientX, ev.clientY);
        snapshot();
        var made = addCard({ kind: "skill", title: "New step", user: true, exact: true }, { x: Math.round(p.x + 6), y: Math.round(p.y - 34) }, true);
        if (!made) return;
        link(c.id, made.id, null, null, true);
        persist();
        select(made.id, false);
        openEditor(made);
        blankStep = made.id;
      };
      var up = function (ev) { done(ev, false); };
      var cancel = function (ev) { done(ev, true); };
      var esc = function (ev) { if (ev.key === "Escape") { ev.stopPropagation(); ev.preventDefault(); done(ev, true); } };
      n.addEventListener("pointermove", move);
      n.addEventListener("pointerup", up);
      n.addEventListener("pointercancel", cancel);
      document.addEventListener("keydown", esc, true);
    }

    // ── Areas: cordon off a piece of the board ─────────────────────────────
    // Owner, 2026-11-20: "an easy way to cordon off a piece of it and share it… a
    // little piece of what they do, or an entire whiteboard". An area is a card of its
    // own (kind "area", with a width and height) drawn under everything; what's inside
    // is whatever sits in it now, so moving a card in or out changes it.
    function sizeArea(c, n) {
      n = n || nodes[c.id];
      if (!n) return;
      n.style.width = Math.max(200, Number(c.w) || 200) + "px";
      n.style.height = Math.max(140, Number(c.h) || 140) + "px";
    }
    var SHARE_LABEL = { drops: "Honey Drops", honey: "Honey", open: "Open source" };
    function fillArea(n, c) {
      n.textContent = "";
      n.className = "wb-card wb-k-area" + (selected[c.id] ? " wb-on" : "") + (c.share ? " wb-shared" : "");
      var barEl = el("div", "wb-area-bar");
      barEl.appendChild(icon("area", "wb-cico"));
      barEl.appendChild(el("span", "wb-area-name", c.title || "My orchestration"));
      var count = areaMembers(c, state.cards).length;
      barEl.appendChild(el("span", "wb-area-count", count === 1 ? "1 card" : count + " cards"));
      if (c.share) barEl.appendChild(el("span", "wb-area-tag", (SHARE_LABEL[c.share] || "Shared") + " · coming soon"));
      var sb = el("button", "wb-area-sell");
      sb.type = "button";
      sb.appendChild(icon("sell"));
      sb.appendChild(el("span", null, "Sell"));
      sb.appendChild(el("span", "wb-soon", "Soon"));
      sb.title = "Sell this orchestration (coming soon)";
      sb.setAttribute("aria-label", "Sell this orchestration: " + (c.title || "area") + " (coming soon)");
      sb.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
      sb.addEventListener("click", function (e) { e.stopPropagation(); openSell(c.id); });
      barEl.appendChild(sb);
      barEl.title = "Drag to move this area and everything in it. Double-click to name it.";
      n.appendChild(barEl);
      var rm = el("button", "wb-rm");
      rm.type = "button";
      rm.textContent = "×";
      rm.setAttribute("aria-label", "Remove the area " + (c.title || "") + " (the cards stay)");
      rm.title = "Remove the area (the cards stay)";
      rm.addEventListener("click", function (e) { e.stopPropagation(); snapshot(); removeCards([c.id]); });
      n.appendChild(rm);
      var grip = el("span", "wb-grip");
      grip.title = "Drag to make the area bigger or smaller";
      n.appendChild(grip);
      n.appendChild(portDot(c));
      n.setAttribute("aria-label", "Area: " + (c.title || "My orchestration") + ", " + (count === 1 ? "1 card" : count + " cards"));
      sizeArea(c, n);
    }
    function makeArea(list, name) {
      list = (list || []).filter(function (c) { return kindOf(c) !== "area"; });
      var b = bounds(list);
      if (!b) { say("Select some cards first."); return null; }
      var pad = 26, top = 48;
      var agent = list.filter(function (c) { return kindOf(c) === "agent"; })[0];
      snapshot();
      var c = addCard({
        kind: "area", user: true, exact: true,
        title: name || (agent && agent.title && agent.title !== "agent.md" ? agent.title : "My orchestration"),
      }, { x: Math.round(b.x1 - pad), y: Math.round(b.y1 - top) }, true);
      if (!c) return null;
      c.w = Math.round(b.x2 - b.x1 + pad * 2);
      c.h = Math.round(b.y2 - b.y1 + top + pad);
      fillCard(nodes[c.id], c);
      selected = {};
      selected[c.id] = true;
      drawLinks();
      paintSelection();
      persist();
      return c;
    }
    function withAreaContents(list) {
      var out = list.slice();
      for (var i = 0; i < out.length; i++) {            // grows as areas inside areas are found
        var c = out[i];
        if (kindOf(c) !== "area") continue;
        areaMembers(c, state.cards).forEach(function (m) { if (out.indexOf(m) < 0) out.push(m); });
        state.cards.forEach(function (a) {
          if (a === c || kindOf(a) !== "area" || out.indexOf(a) >= 0) return;
          var x = a.x + ANCHOR_X, y = a.y + ANCHOR_Y;
          if (x >= c.x && x <= c.x + (Number(c.w) || 0) && y >= c.y && y <= c.y + (Number(c.h) || 0)) out.push(a);
        });
      }
      return out;
    }
    // What a drag (or an arrow key) moves: the selection, and what's inside a selected area.
    function movingSet() { return withAreaContents(state.cards.filter(function (x) { return selected[x.id]; })); }
    function startResize(e, n, c) {
      var startP = toWorld(e.clientX, e.clientY);
      var w0 = Number(c.w) || 200, h0 = Number(c.h) || 140;
      var moved = false;
      var mv = function (ev) {
        var p = toWorld(ev.clientX, ev.clientY);
        var dx = p.x - startP.x, dy = p.y - startP.y;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
        if (!moved) { moved = true; snapshot(); }
        c.w = Math.max(200, Math.round(w0 + dx));
        c.h = Math.max(140, Math.round(h0 + dy));
        sizeArea(c, n);
        drawLinks();
      };
      var upr = function () {
        n.removeEventListener("pointermove", mv);
        n.removeEventListener("pointerup", upr);
        if (moved) { fillCard(n, c); persist(); }
      };
      n.addEventListener("pointermove", mv);
      n.addEventListener("pointerup", upr);
    }

    // ── Sell this orchestration (coming soon) ───────────────────────────────
    // Owner, 2026-11-20: "sell this orchestration. Trade for honey drop or honey, or
    // open source it… it should ask if it can use… the outputs you've used before, to
    // help advertise it, so that when it shows up in the inspiration panel and in the
    // recipes panel, we have a lot of outputs to work with as examples."
    // Nothing is listed or charged yet: the choice is kept on the area (share,
    // examples, shareAt) and saved with the board, ready for when the store opens.
    var sellFor = null;          // the area's id, or null for the whole board
    var sellStep = "choose";
    var sellPick = null;
    var SHARE_OPTIONS = [
      ["drops", "Trade for Honey Drops", "People pay a few Honey Drops each time they use it."],
      ["honey", "Trade for Honey", "People pay once in Honey for their own copy to keep."],
      ["open", "Open source it", "Free for everyone to use, learn from and build on."],
    ];
    function sellCards() {
      var area = sellFor ? cardById(sellFor) : null;
      return area ? areaMembers(area, state.cards) : state.cards.filter(function (c) { return kindOf(c) !== "area"; });
    }
    function madeIn(list) {
      return list.filter(function (c) { var k = kindOf(c); return roleOf(k) === "output" && (c.url || c.thumb) && c.state !== "running"; });
    }
    function openSell(areaId) {
      hist.hidden = true;
      keyList.hidden = true;
      sellFor = areaId || null;
      var area = sellFor ? cardById(sellFor) : null;
      sellPick = area && area.share ? area.share : null;
      sellStep = area && area.share ? "saved" : "choose";
      paintSell();
      sell.hidden = false;
      var first = sell.querySelector("button.wb-sell-opt") || sell.querySelector(".wb-sell-row button") || sell.querySelector("button");
      if (first) first.focus({ preventScroll: true });
    }
    function closeSell() { if (sell) sell.hidden = true; }
    function sellButton(cls, label, fn) {
      var b = el("button", cls, label);
      b.type = "button";
      b.addEventListener("click", fn);
      return b;
    }
    function paintSell() {
      sell.textContent = "";
      var area = sellFor ? cardById(sellFor) : null;
      var list = sellCards();
      var headEl = el("div", "wb-sell-head");
      var h = el("strong", null, "Sell this orchestration");
      headEl.appendChild(h);
      headEl.appendChild(el("span", "wb-soon", "Coming soon"));
      var x = sellButton("wb-btn wb-sell-x", "Close", function () { closeSell(); sellBtn.focus({ preventScroll: true }); });
      headEl.appendChild(x);
      sell.appendChild(headEl);
      sell.appendChild(el("p", "wb-sell-what", (area ? "This area: " + (area.title || "My orchestration") : "The whole board") +
        " · " + (list.length === 1 ? "1 card" : list.length + " cards")));
      if (!list.length) {
        sell.appendChild(el("p", "wb-sell-note", "Nothing here yet. Talk to BeeZilla or put your own steps on the board, then come back to share it."));
        return;
      }
      if (sellStep === "choose") {
        sell.appendChild(el("p", "wb-sell-lede", "Someone may need exactly what you built. Share it, and they start where you finished instead of from scratch."));
        SHARE_OPTIONS.forEach(function (o) {
          var b = el("button", "wb-sell-opt" + (sellPick === o[0] ? " wb-picked" : ""));
          b.type = "button";
          b.setAttribute("data-share", o[0]);
          b.appendChild(el("strong", null, o[1]));
          b.appendChild(el("span", null, o[2]));
          b.addEventListener("click", function () { sellPick = o[0]; sellStep = "examples"; paintSell(); focusFirst(); });
          sell.appendChild(b);
        });
        return;
      }
      if (sellStep === "examples") {
        var made = madeIn(list);
        sell.appendChild(el("p", "wb-sell-q", "Can we show what it made?"));
        if (made.length) {
          var strip = el("div", "wb-sell-strip");
          made.slice(0, 8).forEach(function (c) {
            var k = kindOf(c);
            if (k === "image" && c.url) {
              var img = el("img", "wb-sell-thumb");
              img.src = c.url; img.alt = ""; img.loading = "lazy"; img.draggable = false;
              strip.appendChild(img);
            } else if (c.thumb) {
              var t = el("img", "wb-sell-thumb");
              t.src = c.thumb; t.alt = ""; t.draggable = false;
              strip.appendChild(t);
            } else strip.appendChild(el("span", "wb-sell-chip", KIND_LABEL[k] || "File"));
          });
          sell.appendChild(strip);
          sell.appendChild(el("p", "wb-sell-note", "What it made would appear as examples in Inspiration and Recipes, so people can see what they'll get before they use it."));
        } else {
          sell.appendChild(el("p", "wb-sell-note", "It hasn't made anything yet. When it makes pictures, music or other things, they could appear as examples in Inspiration and Recipes."));
        }
        var row = el("div", "wb-sell-row");
        row.appendChild(sellButton("wb-selbtn wb-primary", "Yes, show my examples", function () { saveShare("yes"); }));
        row.appendChild(sellButton("wb-selbtn", "No, keep them private", function () { saveShare("no"); }));
        sell.appendChild(row);
        sell.appendChild(sellButton("wb-sell-back", "Back", function () { sellStep = "choose"; paintSell(); focusFirst(); }));
        return;
      }
      // saved
      var opt = SHARE_OPTIONS.filter(function (o) { return o[0] === (area && area.share); })[0];
      sell.appendChild(el("p", "wb-sell-q", "Saved for when the store opens"));
      if (opt && area) {
        sell.appendChild(el("p", "wb-sell-pick", opt[1] + " · " + (area.examples === "yes" ? "examples shown" : "examples kept private")));
      }
      sell.appendChild(el("p", "wb-sell-note", "The Orchestration Store is coming soon. When it opens, this one is ready to list, and you'll find what other people built there too, ready to start from."));
      var row2 = el("div", "wb-sell-row");
      row2.appendChild(sellButton("wb-selbtn wb-primary", "Done", function () { closeSell(); sellBtn.focus({ preventScroll: true }); }));
      row2.appendChild(sellButton("wb-selbtn", "Change", function () { sellStep = "choose"; paintSell(); focusFirst(); }));
      sell.appendChild(row2);
    }
    function focusFirst() {
      var b = sell.querySelector("button.wb-sell-opt") || sell.querySelector(".wb-sell-row button");
      if (b) b.focus({ preventScroll: true });
    }
    function saveShare(examples) {
      var area = sellFor ? cardById(sellFor) : null;
      if (!area) {
        // The whole board: an area around everything, so it's plain what's included.
        var all = state.cards.filter(function (c) { return kindOf(c) !== "area"; });
        area = state.cards.filter(function (c) {
          return kindOf(c) === "area" && all.every(function (m) { return inArea(c, m); });
        })[0] || makeArea(all, "Whole board");
        if (!area) return;
        sellFor = area.id;
      } else snapshot();
      area.share = sellPick || "open";
      area.examples = examples === "yes" ? "yes" : "no";
      area.shareAt = new Date().toISOString();
      if (nodes[area.id]) fillCard(nodes[area.id], area);
      persist();
      sellStep = "saved";
      paintSell();
      focusFirst();
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
          title: tool === "agent" ? "agent.md" : tool === "skill" ? "New skill" : tool === "output" ? "End result" : "Note",
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
          if (kindOf(c) === "area") { if (c.x >= wa.x && c.x + cw <= wb.x && c.y >= wa.y && c.y + ch <= wb.y) selected[c.id] = true; }
          else if (c.x < wb.x && c.x + cw > wa.x && c.y < wb.y && c.y + ch > wa.y) selected[c.id] = true;
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
      if (!a || !body.contains(a) || sideWrap.contains(a) || side.contains(a) || hist.contains(a)) return;
      var mod = e.ctrlKey || e.metaKey;
      if (e.key === " " && !spaceDown) { spaceDown = true; canvas.classList.add("wb-hand"); e.preventDefault(); return; }
      if (mod && (e.key === "z" || e.key === "Z" || e.key === "y" || e.key === "Y") && pointerBusy) { e.preventDefault(); return; }
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
      if (e.key === "Escape") { closeEditor(); keyList.hidden = true; hist.hidden = true; closeSell(); clearSelection(); setTool("select"); return; }
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
        movingSet().forEach(function (c) { c.x += d[0] * step; c.y += d[1] * step; place(c); });
        drawLinks(); positionSelbar(); persist();
        return;
      }
      if (mod || e.altKey) return;
      var k = e.key.toLowerCase();
      var map = { v: "select", h: "hand", n: "note", a: "agent", k: "skill", e: "output", o: "output" };
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
      var list = state.cards.filter(function (c) { return selected[c.id] && c.id !== CHAT_ID; });
      if (!list.length) return;
      snapshot();
      var map = {};
      var fresh = {};
      list.forEach(function (c) {
        var copy = JSON.parse(JSON.stringify(c));
        copy.id = uid();
        delete copy.flow;
        copy.x += 30; copy.y += 30;
        delete copy.share; delete copy.examples; delete copy.shareAt;   // a copy is not yet shared
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
      var list = state.cards.filter(function (c) { return selected[c.id] && c.id !== CHAT_ID; });
      // An area is a frame, not a node: what the recipe should receive is the pictures and
      // cards inside it (withAreaContents), never the box itself.
      list = withAreaContents(list).filter(function (c) { return kindOf(c) !== "area"; });
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

    // ── Drops: files from the computer, Inspiration cards, search results, links, ──
    // and any words dragged from a page (they become a note). Everything on the site
    // can be moved here (owner, 2026-11-20).
    var TYPE = "application/x-beezilla-card";
    function acceptable(e) {
      var t = e.dataTransfer && e.dataTransfer.types ? Array.prototype.slice.call(e.dataTransfer.types) : [];
      return t.indexOf(TYPE) >= 0 || t.indexOf("text/uri-list") >= 0 || t.indexOf("Files") >= 0 || t.indexOf("text/plain") >= 0;
    }
    // What a drop holds, put on the board at `at` (a free spot near it). Also used by
    // the drop strip at the top of the window, which drops onto a folded board.
    function takeDrop(dt, at) {
      if (!dt) return null;
      if (dt.files && dt.files.length) { uploadFiles(dt.files, at || viewCentre()); return "file"; }
      var raw = "";
      try { raw = dt.getData(TYPE); } catch (_) { raw = ""; }
      if (raw) {
        try {
          var c = JSON.parse(raw);
          var made = addCard({ kind: c.kind, title: c.title, url: c.url, contentType: c.contentType, body: c.body, user: c.kind === "note" }, at);
          return made ? made.id : null;
        } catch (_) { return null; }
      }
      var uri = (dt.getData("text/uri-list") || "").split("\n")[0].trim();
      var text = String(dt.getData("text/plain") || "").trim();
      if (!/^https?:\/\//i.test(uri) && /^https?:\/\/\S+$/i.test(text)) uri = text;
      if (/^https?:\/\//i.test(uri)) {
        var u;
        try { u = new URL(uri); } catch (_) { return null; }
        var link = addCard({ kind: "file", title: u.host + u.pathname.replace(/\/$/, ""), url: uri }, at);
        return link ? link.id : null;
      }
      if (text) {
        var note = addCard({ kind: "note", title: "Note", body: text.slice(0, 4000), user: true }, at);
        return note ? note.id : null;
      }
      return null;
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
      takeDrop(e.dataTransfer, at);
      window.dispatchEvent(new CustomEvent("bz:dropped"));
    });
    function dragStarted(e) { if (acceptable(e)) root.classList.add("wb-target"); }
    function dragFinished() { root.classList.remove("wb-target"); root.classList.remove("wb-over"); }
    document.addEventListener("dragstart", dragStarted);
    document.addEventListener("dragend", dragFinished);
    document.addEventListener("drop", dragFinished);

    // A result that arrives later (an upload) lands on its own card, and only on it:
    // here while the board is up; otherwise on the board as it is now, on screen in a
    // newer mount or in this browser's copy (never this mount's older copy of it).
    function settleCard(id, fields) {
      if (gone) { patchCard(boardId, id, fields); return; }
      var c = cardById(id);
      if (!c) return;                      // removed meanwhile
      Object.keys(fields).forEach(function (k) { c[k] = fields[k]; });
      if (nodes[id]) fillCard(nodes[id], c);
      drawLinks();
      persist();
    }

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
            settleCard(card.id, { url: "/api/buzzy/assets/" + encodeURIComponent(j.id), state: "", body: "" });
          })
          .catch(function (err) {
            settleCard(card.id, { state: "failed", err: String(err && err.message || "It could not be added.").slice(0, 160) });
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
          // Top-left of the part of the board you can see, or right of the conversation
          // card when that is where it sits.
          var cr = canvas.getBoundingClientRect(), oa = openArea();
          var vc = toWorld(cr.left + oa.x + 24, cr.top + oa.y + 24);
          at = { x: vc.x, y: vc.y };
          var talkCard = cardById(CHAT_ID);
          if (talkCard && at.x < talkCard.x + 360 + 40 && at.x + 240 > talkCard.x) at = { x: talkCard.x + 360 + COL_GAP / 2, y: talkCard.y };
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
    function instructions() { return compile(state.cards, state.links); }

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
      patch: settleCard,
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
      /** The conversation, as a card on the board: put it there once there is one to show. */
      conversation: function () {
        var c = cardById(CHAT_ID);
        if (c) {
          var nb = nodes[c.id] && nodes[c.id].querySelector(".wb-chat-body");
          if (nb && side.parentNode !== nb) nb.appendChild(side);
          return true;
        }
        var r = canvas.getBoundingClientRect();
        if (!r.width) return false;            // not on screen yet: placed on the next look
        // Its first place: left of everything already on the board, or the top-left of
        // the part you can see. BeeZilla's steps are drawn to its right.
        var b = bounds(state.cards), oa = openArea(), at;
        if (b) at = { x: b.x1 - 360 - COL_GAP / 2, y: b.y1, exact: true };
        else at = toWorld(r.left + oa.x + 8, r.top + oa.y + 4);
        var made = addCard({ kind: "chat", title: "Conversation", exact: !!(at && at.exact) }, { x: at.x, y: at.y }, true);
        // It was put where you are looking: the board's first-look "fit everything"
        // must not move the view out from under it (the steps follow on its right).
        if (made) state.viewSet = true;
        if (made && b) reveal(made);
        return !!made;
      },
      /** A drop that landed somewhere else (the drop strip): onto a free spot in view. */
      drop: function (dt) {
        var id = takeDrop(dt, null);
        if (id && id !== "file" && nodes[id]) reveal(cardById(id));
        return !!id;
      },
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
      return v ? compile(v.cards, v.links) : "";
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
    /** Empty a board that isn't on screen, here and in the account (a fresh visit's "talk"). */
    reset: reset,
    merge: merge3,
    graft: graft,
  };
})();
