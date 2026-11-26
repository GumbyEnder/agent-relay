/**
 * The brain: the Memory tab's folder tree (and the full Memory page's).
 *
 * Owner, 2026-11-23: "whenever somebody clicks a folder, they should also see a /brain at the
 * very core, which they can breadcrumb back to. When they breadcrumb back to it, it shows them
 * their memories. Their memories are stored in a structured folder tree that goes from A to Z…
 * At the core, it'll be like, instead of /C, it'll be like brain." And: "using colors and
 * shapes to help ground people's thinking and where they are in the greater tree of
 * knowledge… The abstractions are useful for quick mental shortcuts, but you need to be able to
 * just understand it logically, step by step as well, everything."
 *
 * So the Memory tab is a plain explorer, the way a computer shows its drive:
 *  - a breadcrumb that always starts at "brain" (press any part to go back up to it), and the
 *    folder's full address under its name (brain/knowledge/programming), to read or copy;
 *  - the whole tree down the left, A to Z at every level, each branch in its own colour and
 *    shape (brain a pink hexagon, knowledge a blue circle, systems a teal square, assets a
 *    violet triangle) wherever it appears;
 *  - at brain itself, the person's memories, newest first, under the three branches;
 *  - in a folder: who works there (the bots that work in it most), what is in it, and the
 *    recent conversations about it.
 * The person is in charge of it (owner: "Mac abstracts everything. Windows gives you full
 * control"): they can move a memory, conversation, file or recipe to another folder (the tidy
 * then leaves it there), hand it back to the tidy, make folders and remove empty ones, and tidy
 * now. Everything can be dragged to the Idea Board. Dialogs close only with Esc or their X.
 *
 * The server side is src/lib/buzzy/brain.ts (/api/buzzy/brain); the colours and shapes come
 * from src/lib/buzzy/brainMap.ts (scripts/test-brain.ts checks the copy below matches).
 *
 * window.BeeZillaBrain:
 *   mount(el, { path }) → { open(path), reload(), destroy() }   an explorer in `el`
 *   show(path)        open the Memory tab at a folder (Talk's places row), or the open explorer
 *   want(path)        the folder the next explorer opens at
 */
(function () {
  "use strict";
  if (window.BeeZillaBrain) return;

  var API = "/api/buzzy/brain";
  // brainMap.ts: ROOT and BRANCHES. A folder keeps its branch's colour and shape everywhere.
  var BRANCH = {
    brain: { color: "#F472B6", shape: "hexagon", label: "brain" },
    knowledge: { color: "#4DA3FF", shape: "circle", label: "knowledge" },
    systems: { color: "#2DD4BF", shape: "square", label: "systems" },
    assets: { color: "#A78BFA", shape: "triangle", label: "assets" },
  };
  var NOTES = {
    "": "Everything BeeZilla and your agents keep, in one tree: what they learned, how they work, and the files they made.",
    knowledge: "What you and your agents have learned: decisions, facts and conversations, filed by subject.",
    systems: "How the work gets done: your bots (each with its agent.md and picture), the skills they use, and your recipes.",
    assets: "Pictures, videos, music and files to use again, so nothing is made twice.",
    "systems/bots": "One folder per bot: its agent.md (who it is, its job, where it works) and its picture.",
    "systems/skills": "Skills belong to no bot. They are filed by what they are useful for, and any of your agents can use them.",
    "systems/recipes": "Recipes you made on the Idea Board: chains of skills you can run again.",
  };
  var wanted = null;
  var live = [];

  function el(tag, cls, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) Object.keys(attrs).forEach(function (k) { if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]); });
    return n;
  }
  function text(tag, cls, words) { var n = el(tag, cls); n.textContent = words == null ? "" : String(words); return n; }
  function branchOf(path) { return BRANCH[String(path || "").split("/")[0]] || BRANCH.brain; }
  function shape(kind, color, px) {
    var s = px || 14;
    var w = el("span", "bzb-shape", { "aria-hidden": "true" });
    var d = kind === "circle" ? '<circle cx="12" cy="12" r="8.5"/>'
      : kind === "square" ? '<rect x="4" y="4" width="16" height="16" rx="3.5"/>'
      : kind === "triangle" ? '<path d="M12 3.6l9 16H3z" stroke-linejoin="round"/>'
      : '<path d="M12 2.6l8.2 4.7v9.4L12 21.4l-8.2-4.7V7.3z" stroke-linejoin="round"/>';
    w.innerHTML = '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '">' + d + "</svg>";
    w.style.setProperty("--bc", color);
    return w;
  }
  function shapeFor(path, px) { var b = branchOf(path); return shape(b.shape, b.color, px); }
  function api(method, path, body) {
    var opts = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) { return { status: r.status, ok: r.ok && !(j && j.ok === false), body: j || {} }; });
    });
  }
  function ago(at) {
    var t = Date.parse(at);
    if (!t) return "";
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) { var m = Math.round(s / 60); return m + (m === 1 ? " minute ago" : " minutes ago"); }
    if (s < 86400) { var h = Math.round(s / 3600); return h + (h === 1 ? " hour ago" : " hours ago"); }
    var d = Math.round(s / 86400);
    if (d === 1) return "yesterday";
    if (d < 30) return d + " days ago";
    try { return new Date(t).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }); } catch { return ""; }
  }
  function until(at) {
    var t = Date.parse(at);
    if (!t) return "";
    var h = Math.max(0, Math.round((t - Date.now()) / 3600000));
    return h <= 1 ? "within the hour" : "in " + h + " hours";
  }
  function inside(path, top) { return path === top || path.indexOf(top + "/") === 0; }
  function things(n) { return n === 1 ? "1 thing" : (n || 0) + " things"; }
  function parentOf(path) { var i = path.lastIndexOf("/"); return i < 0 ? "" : path.slice(0, i); }

  // ── One explorer ─────────────────────────────────────────────────────────
  function mount(host, opts) {
    var M = { host: host, data: null, path: "", sort: "az", open: { "": true, knowledge: true, systems: true, assets: true }, seq: 0, dead: false, dialog: null };
    var start = (opts && opts.path) || wanted || "";
    wanted = null;
    var root = el("div", "bzb", { "data-bzb": "1" });
    host.textContent = "";
    host.appendChild(root);
    var top = el("div", "bzb-top");
    var crumbs = el("nav", "bzb-crumbs", { "aria-label": "Where you are in your brain" });
    var tools = el("div", "bzb-tools");
    var tidyNote = text("span", "bzb-tidy-note", "");
    var tidyBtn = text("button", "bzb-btn", "Tidy now");
    tidyBtn.type = "button";
    tidyBtn.setAttribute("data-act", "tidy");
    var newBtn = text("button", "bzb-btn", "New folder");
    newBtn.type = "button";
    newBtn.setAttribute("data-act", "new-folder");
    tools.appendChild(tidyNote); tools.appendChild(newBtn); tools.appendChild(tidyBtn);
    top.appendChild(crumbs); top.appendChild(tools);
    var cols = el("div", "bzb-cols");
    var tree = el("nav", "bzb-tree", { "aria-label": "Your brain, A to Z" });
    var treeList = el("ul", "bzb-tree-list", { role: "tree", "aria-label": "Folders" });
    tree.appendChild(treeList);
    var main = el("section", "bzb-main", { "aria-live": "polite" });
    cols.appendChild(tree); cols.appendChild(main);
    root.appendChild(top); root.appendChild(cols);
    var msg = el("p", "bzb-msg", { role: "status", "aria-live": "polite" });
    msg.hidden = true;
    root.appendChild(msg);

    function say(words) { msg.textContent = words || ""; msg.hidden = !words; if (words) setTimeout(function () { if (msg.textContent === words) msg.hidden = true; }, 6000); }
    function folder(path) { return (M.data && M.data.folders || []).filter(function (f) { return f.path === path; })[0] || null; }
    function labelOf(path) { if (!path) return "brain"; var f = folder(path); return f ? f.label : path.split("/").pop(); }
    function childrenOf(path) {
      var depth = path ? path.split("/").length + 1 : 1;
      return (M.data && M.data.folders || []).filter(function (f) { return f.depth === depth && (path ? f.path.indexOf(path + "/") === 0 : true); });
    }
    function itemsIn(path) { return (M.data && M.data.items || []).filter(function (it) { return it.path === path; }); }

    // ── the breadcrumb: always from brain ─────────────────────────────────
    function paintCrumbs() {
      crumbs.textContent = "";
      var parts = M.path ? M.path.split("/") : [];
      var trail = [""].concat(parts.map(function (_, i) { return parts.slice(0, i + 1).join("/"); }));
      trail.forEach(function (p, i) {
        if (i) crumbs.appendChild(text("span", "bzb-sep", "›"));
        var b = el("button", "bzb-crumb" + (p === M.path ? " is-here" : ""), { type: "button", "data-path": p });
        if (p === M.path) b.setAttribute("aria-current", "location");
        b.appendChild(shapeFor(p, 13));
        b.appendChild(text("span", "", labelOf(p)));
        b.style.setProperty("--bc", branchOf(p).color);
        crumbs.appendChild(b);
      });
    }

    // ── the tree ─────────────────────────────────────────────────────────
    function treeRow(path, level) {
      var li = el("li", "bzb-node", { role: "treeitem", "aria-level": String(level), "aria-selected": path === M.path ? "true" : "false" });
      var kids = childrenOf(path);
      var f = folder(path);
      if (kids.length) li.setAttribute("aria-expanded", M.open[path] ? "true" : "false");
      var row = el("button", "bzb-row" + (path === M.path ? " is-here" : ""), { type: "button", "data-path": path, tabindex: path === M.path ? "0" : "-1", draggable: "true" });
      row.style.setProperty("--lvl", String(level - 1));
      row.style.setProperty("--bc", branchOf(path).color);
      var chev = el("span", "bzb-chev" + (kids.length ? "" : " is-leaf"), { "aria-hidden": "true", "data-toggle": kids.length ? path : null });
      chev.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M9 6l6 6-6 6"/></svg>';
      row.appendChild(chev);
      row.appendChild(shapeFor(path, level === 1 ? 15 : 12));
      row.appendChild(text("span", "bzb-name", labelOf(path)));
      var n = path ? (f ? f.total : 0) : (M.data ? M.data.items.length : 0);
      if (n) row.appendChild(text("span", "bzb-count", n));
      row.setAttribute("data-bz-card", JSON.stringify({ kind: "note", title: "Folder brain" + (path ? "/" + path : ""), body: things(n) + " in it. " + (NOTES[path] || "") }));
      li.appendChild(row);
      if (kids.length && M.open[path]) {
        var ul = el("ul", "bzb-tree-sub", { role: "group" });
        kids.forEach(function (k) { ul.appendChild(treeRow(k.path, level + 1)); });
        li.appendChild(ul);
      }
      return li;
    }
    function paintTree() {
      treeList.textContent = "";
      treeList.appendChild(treeRow("", 1));
      var here = treeList.querySelector(".bzb-row.is-here");
      if (here && here.scrollIntoView && M.revealed !== M.path) {
        M.revealed = M.path;
        try { here.scrollIntoView({ block: "nearest" }); } catch { /* old browsers */ }
      }
    }

    // ── one thing ────────────────────────────────────────────────────────
    function card(it) {
      var li = el("li", "bzb-item bzb-k-" + it.kind, { draggable: "true", "data-item": it.id });
      var cardBody = it.kind === "avatar" || (it.kind === "file" && /^image\//.test(it.contentType || ""))
        ? { kind: "image", title: it.title, url: it.url, contentType: it.contentType || "image/webp" }
        : { kind: "note", title: it.title, body: String(it.body || it.sub || "").slice(0, 1200) };
      li.setAttribute("data-bz-card", JSON.stringify(cardBody));
      var lead = el("span", "bzb-lead", { "aria-hidden": "true" });
      if ((it.kind === "avatar" || it.kind === "file") && it.url && (it.kind === "avatar" || /^image\//.test(it.contentType || ""))) {
        lead.appendChild(el("img", "", { src: it.url, alt: "", loading: "lazy", draggable: "false" }));
      } else {
        lead.textContent = { memory: "✦", conversation: "💬", file: "📄", "agent-md": "📝", skill: "⚡", recipe: "🧩" }[it.kind] || "•";
      }
      li.appendChild(lead);
      var mid = el("div", "bzb-mid");
      mid.appendChild(text("p", "bzb-title", it.title));
      if (it.kind === "agent-md" && it.body) mid.appendChild(text("pre", "bzb-md", it.body));
      else if (it.kind === "memory" && it.body) mid.appendChild(text("p", "bzb-body", it.body));
      var subLine = [it.sub, it.kind === "memory" || it.kind === "conversation" || it.kind === "file" ? ago(it.at) : ""].filter(Boolean).join(" · ");
      if (subLine) mid.appendChild(text("p", "bzb-sub", subLine));
      if (it.placedBy === "person") mid.appendChild(text("p", "bzb-pin", "You put this here. The tidy leaves it alone."));
      li.appendChild(mid);
      var acts = el("div", "bzb-acts");
      function act(label, name, extra) {
        var b = text("button", "bzb-act", label);
        b.type = "button";
        b.setAttribute("data-act", name);
        b.setAttribute("data-item", it.id);
        if (extra) Object.keys(extra).forEach(function (k) { b.setAttribute(k, extra[k]); });
        acts.appendChild(b);
      }
      if (it.kind === "conversation" && it.sessionId) act("Open", "open-chat", { "data-session": it.sessionId });
      if (it.kind === "file" && it.url) act("Open", "open-file", { "data-url": it.url });
      if ((it.kind === "agent-md" || it.kind === "avatar") && it.agentId) {
        if (it.agentId !== "bzilla") act(it.kind === "avatar" ? "Change picture" : "Edit", "edit-agent", { "data-agent": it.agentId });
        act("Talk to it", "talk-agent", { "data-agent": it.agentId });
      }
      if (it.kind === "skill" && it.ask) act("Try it", "try-skill", { "data-ask": it.ask });
      if (it.kind === "recipe") act("Open Recipes", "recipes");
      if (it.movable) act("Move…", "move");
      // A remembered decision of a job can be forgotten (the job's work stays: forget is not delete).
      if (it.kind === "memory" && /^fact:[^:]+:/.test(it.id)) act("Forget", "forget");
      li.appendChild(acts);
      return li;
    }

    // ── the page for one folder (or brain itself) ───────────────────────────
    function hero(path) {
      var b = branchOf(path);
      var h = el("div", "bzb-hero");
      h.style.setProperty("--bc", b.color);
      h.appendChild(shapeFor(path, 30));
      var words = el("div", "bzb-hero-words");
      words.appendChild(text("h2", "bzb-h2", labelOf(path)));
      var addr = el("p", "bzb-addr");
      addr.appendChild(text("code", "", "brain" + (path ? "/" + path : "")));
      words.appendChild(addr);
      var note = NOTES[path] || (path.indexOf("systems/skills/") === 0 ? "Skills useful for " + labelOf(path).toLowerCase() + ". Any of your agents can use them." : path.indexOf("systems/bots/") === 0 ? "Who " + labelOf(path) + " is, and its picture." : "");
      if (note) words.appendChild(text("p", "bzb-note", note));
      h.appendChild(words);
      return h;
    }
    function paintMain() {
      main.textContent = "";
      if (!M.data) { main.appendChild(text("p", "bzb-empty", "Loading your brain…")); return; }
      main.appendChild(hero(M.path));
      if (!M.path) {
        var cards = el("div", "bzb-branches");
        (M.data.branches || []).forEach(function (b) {
          var f = folder(b.id);
          var c = el("button", "bzb-branch", { type: "button", "data-path": b.id });
          c.style.setProperty("--bc", b.color);
          c.appendChild(shape(b.shape, b.color, 22));
          c.appendChild(text("span", "bzb-branch-name", b.label));
          c.appendChild(text("span", "bzb-branch-count", things(f ? f.total : 0)));
          c.appendChild(text("span", "bzb-branch-blurb", b.blurb));
          cards.appendChild(c);
        });
        main.appendChild(cards);
        main.appendChild(text("h3", "bzb-h3", "Your memories, newest first"));
        var mem = M.data.items.filter(function (it) { return it.kind === "memory" || it.kind === "conversation"; })
          .sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; }).slice(0, 14);
        if (!mem.length) main.appendChild(text("p", "bzb-empty", "Nothing remembered yet. As you talk to BeeZilla and your agents, what they learn is filed here by subject, A to Z."));
        else {
          var ul = el("ul", "bzb-items");
          mem.forEach(function (it) {
            var li = card(it);
            var where = el("button", "bzb-where", { type: "button", "data-path": it.path });
            where.appendChild(shapeFor(it.path, 11));
            where.appendChild(text("span", "", "brain/" + it.path));
            li.querySelector(".bzb-mid").appendChild(where);
            ul.appendChild(li);
          });
          main.appendChild(ul);
        }
        return;
      }
      var workers = el("div", "bzb-workers", { hidden: "" });
      main.appendChild(workers);
      var subs = childrenOf(M.path);
      if (subs.length) {
        var grid = el("div", "bzb-subs");
        subs.forEach(function (f) {
          var b = el("button", "bzb-sub-folder", { type: "button", "data-path": f.path, draggable: "true" });
          b.style.setProperty("--bc", branchOf(f.path).color);
          b.appendChild(shapeFor(f.path, 16));
          b.appendChild(text("span", "bzb-sub-name", f.label));
          b.appendChild(text("span", "bzb-sub-count", f.total ? things(f.total) : "empty"));
          b.setAttribute("data-bz-card", JSON.stringify({ kind: "note", title: "Folder brain/" + f.path, body: things(f.total) + " in it." }));
          grid.appendChild(b);
        });
        main.appendChild(grid);
      }
      var items = itemsIn(M.path).slice();
      if (items.length) {
        var bar = el("div", "bzb-sortbar", { role: "radiogroup", "aria-label": "Order" });
        [["az", "A to Z"], ["new", "Newest"]].forEach(function (o) {
          var b = text("button", "bzb-sort", o[1]);
          b.type = "button";
          b.setAttribute("role", "radio");
          b.setAttribute("data-sort", o[0]);
          b.setAttribute("aria-checked", M.sort === o[0] ? "true" : "false");
          bar.appendChild(b);
        });
        main.appendChild(bar);
        items.sort(M.sort === "new"
          ? function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; }
          : function (a, b) { return String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base", numeric: true }); });
        var list = el("ul", "bzb-items");
        items.forEach(function (it) { list.appendChild(card(it)); });
        main.appendChild(list);
      } else if (!subs.length) {
        main.appendChild(text("p", "bzb-empty", emptyWords(M.path)));
      }
      var recent = el("div", "bzb-recent", { hidden: "" });
      main.appendChild(recent);
    }
    function emptyWords(path) {
      if (inside(path, "assets")) return "Nothing here yet. Pictures, videos, music and files BeeZilla makes or you upload are filed here, so you can use them again.";
      if (inside(path, "systems/recipes")) return "No recipes yet. On the Idea Board, drag a box around your agent.md, skills and end result, then choose Create recipe.";
      if (inside(path, "knowledge")) return "Nothing filed here yet. When you talk about this with BeeZilla or your agents, what they learn lands here.";
      return "Nothing here yet.";
    }
    // Who works here and the recent conversations about it (GET /folder).
    function paintFolderInfo(info) {
      M.lastInfo = info;
      var workers = main.querySelector(".bzb-workers");
      var recent = main.querySelector(".bzb-recent");
      if (!workers || !recent) return;
      workers.textContent = "";
      if (info.workers && info.workers.length) {
        workers.appendChild(text("span", "bzb-w-label", "Works here:"));
        info.workers.forEach(function (w, i) {
          var b = el("button", "bzb-worker" + (i < 3 ? " is-top" : ""), { type: "button", "data-agent": w.id, title: w.name + (w.role ? ", " + w.role : "") });
          b.style.setProperty("--c", /^#[0-9a-fA-F]{6}$/.test(w.color) ? w.color : "#ffd40d");
          b.appendChild(el("img", "", { src: /^\/buzzy\/zillas\/[a-z0-9-]+\.webp$/.test(w.image) ? w.image : "/buzzy/zillas/bee.webp", alt: "", draggable: "false" }));
          b.appendChild(text("span", "", w.name));
          workers.appendChild(b);
        });
        workers.hidden = false;
      } else workers.hidden = true;
      recent.textContent = "";
      // The conversations filed in this folder are listed above already; these are the others about it.
      var shown = {};
      itemsIn(M.path).forEach(function (it) { if (it.sessionId) shown[it.sessionId] = true; });
      var others = (info.sessions || []).filter(function (s) { return !shown[s.id]; });
      if (others.length) {
        recent.appendChild(text("h3", "bzb-h3", "Other recent conversations about it"));
        var ul = el("ul", "bzb-items bzb-chats");
        others.forEach(function (s) {
          var li = el("li", "bzb-item bzb-k-conversation", { draggable: "true", "data-bz-card": JSON.stringify({ kind: "note", title: s.title, body: s.summary || "" }) });
          li.appendChild(text("span", "bzb-lead", "💬"));
          var mid = el("div", "bzb-mid");
          mid.appendChild(text("p", "bzb-title", s.title));
          mid.appendChild(text("p", "bzb-sub", [s.summary, ago(s.updatedAt)].filter(Boolean).join(" · ")));
          li.appendChild(mid);
          var acts = el("div", "bzb-acts");
          var b = text("button", "bzb-act", "Open");
          b.type = "button";
          b.setAttribute("data-act", "open-chat");
          b.setAttribute("data-session", s.id);
          acts.appendChild(b);
          li.appendChild(acts);
          ul.appendChild(li);
        });
        recent.appendChild(ul);
        recent.hidden = false;
      } else recent.hidden = true;
    }
    function paintTools() {
      var t = M.data && M.data.tidy;
      tidyNote.textContent = !t || !t.at
        ? "BeeZilla tidies your brain once a day, or sooner when 20 new things come in."
        : "Tidied " + ago(t.at) + (t.moved ? ", " + t.moved + " moved" : "") + ". Next " + until(t.next) + ", or sooner when 20 new things come in.";
      var can = !!M.path && (inside(M.path, "knowledge") || inside(M.path, "assets") || inside(M.path, "systems/recipes"));
      newBtn.disabled = !can;
      newBtn.setAttribute("aria-disabled", can ? "false" : "true");
      newBtn.title = can ? "Make a folder inside " + labelOf(M.path) : "Open a folder in knowledge, assets or your recipes to make one inside it. Bots and skills are kept by BeeZilla.";
    }
    function paint() {
      if (M.dead) return;
      root.setAttribute("data-here", M.path);
      root.style.setProperty("--here", branchOf(M.path).color);
      paintCrumbs();
      paintTree();
      paintMain();
      paintTools();
    }

    // ── going somewhere ──────────────────────────────────────────────────
    function open(path, quiet) {
      var p = String(path || "").replace(/^brain\/?/, "").replace(/^\/+|\/+$/g, "");
      if (M.data && p && !folder(p)) {
        // A folder that is not in the tree (yet): its nearest parent that is.
        while (p && !folder(p)) p = parentOf(p);
      }
      M.path = p;
      M.lastInfo = null;
      var up = p.split("/");
      for (var i = 1; i <= up.length; i++) M.open[up.slice(0, i).join("/")] = true;
      paint();
      if (opts && opts.onPath) opts.onPath(p);
      var seq = ++M.seq;
      if (!p) { if (!quiet) tell(p, null); return; }
      api("GET", API + "/folder?path=" + encodeURIComponent(p)).then(function (res) {
        if (M.dead || seq !== M.seq || !res.ok) return;
        paintFolderInfo(res.body);
        if (!quiet) tell(p, res.body);
      }).catch(function () { /* the folder still shows; who works here waits for the next look */ });
    }
    // The sidebar follows: the bots that work in this folder light up, and its panel shows it.
    function tell(path, info) {
      try { window.dispatchEvent(new CustomEvent("bz:brain-folder", { detail: { path: path, info: info, from: "brain" } })); } catch { /* old browsers */ }
    }
    function load(then) {
      return api("GET", API).then(function (res) {
        if (M.dead) return;
        if (res.status === 401) { main.textContent = ""; main.appendChild(text("p", "bzb-empty", "Sign in to see your brain: it is kept with your account.")); return; }
        if (!res.ok) { main.textContent = ""; main.appendChild(text("p", "bzb-empty", "Your brain couldn't be loaded just now. Try again in a moment.")); return; }
        M.data = res.body;
        if (then) then();
        else open(M.path, true);
      }).catch(function () {
        if (M.dead) return;
        main.textContent = "";
        main.appendChild(text("p", "bzb-empty", "Couldn't reach BeeZilla to load your brain. Check the connection and try again."));
      });
    }

    // ── dialogs: only Esc or the X closes them ─────────────────────────────
    function closeDialog() {
      if (!M.dialog) return;
      var back = M.dialog.opener;
      M.dialog.node.remove();
      document.removeEventListener("keydown", M.dialog.key, true);
      M.dialog = null;
      if (back && back.isConnected) back.focus();
    }
    function dialog(title, build, opener) {
      closeDialog();
      var wrap = el("div", "bzb-modal");
      var box = el("div", "bzb-box", { role: "dialog", "aria-modal": "true", "aria-label": title });
      var head = el("div", "bzb-box-head");
      head.appendChild(text("h2", "bzb-box-title", title));
      var x = el("button", "bzb-x", { type: "button", "aria-label": "Close" });
      x.innerHTML = "&#10005;";
      head.appendChild(x);
      box.appendChild(head);
      var note = el("p", "bzb-box-msg", { role: "status", "aria-live": "polite" });
      build(box, note);
      box.appendChild(note);
      wrap.appendChild(box);
      root.appendChild(wrap);
      var key = function (e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeDialog(); return; }
        if (e.key === "Tab") {
          var f = Array.prototype.filter.call(box.querySelectorAll("button, input, select"), function (n) { return !n.disabled; });
          if (!f.length) return;
          if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
        }
      };
      document.addEventListener("keydown", key, true);
      x.addEventListener("click", closeDialog);
      M.dialog = { node: wrap, key: key, opener: opener || null };
      var first = box.querySelector("input, select, .bzb-btn.primary");
      if (first) first.focus();
    }
    function fits(kind, path) {
      if (kind === "memory" || kind === "conversation") return inside(path, "knowledge");
      if (kind === "file") return inside(path, "assets");
      if (kind === "recipe") return inside(path, "systems/recipes");
      return false;
    }
    function moveDialog(it, opener) {
      dialog("Move “" + it.title + "”", function (box, note) {
        box.appendChild(text("p", "bzb-box-text", "It is in brain/" + it.path + ". Pick the folder it goes in. BeeZilla's tidy leaves things you placed where you put them."));
        var sel = el("select", "bzb-select", { "aria-label": "Folder" });
        (M.data.folders || []).filter(function (f) { return fits(it.kind, f.path); }).forEach(function (f) {
          var o = el("option", "", { value: f.path });
          o.textContent = "brain/" + f.path + (f.path === it.path ? "  (where it is now)" : "");
          if (f.path === it.path) o.selected = true;
          sel.appendChild(o);
        });
        box.appendChild(sel);
        var row = el("div", "bzb-box-row");
        if (it.placedBy === "person") {
          var back = text("button", "bzb-btn", "Let BeeZilla file it");
          back.type = "button";
          back.addEventListener("click", function () { place(it, null, note); });
          row.appendChild(back);
        }
        row.appendChild(el("span", "bzb-gap"));
        var go = text("button", "bzb-btn primary", "Move here");
        go.type = "button";
        go.addEventListener("click", function () { place(it, sel.value, note); });
        row.appendChild(go);
        box.appendChild(row);
      }, opener);
    }
    function place(it, path, note) {
      note.textContent = "";
      api("PUT", API + "/place", { item: it.id, path: path }).then(function (res) {
        if (!res.ok) { note.textContent = (res.body && res.body.error) || "That couldn't be moved."; return; }
        closeDialog();
        say(path ? "Moved to brain/" + res.body.path + "." : "BeeZilla will file it from now on: it is in brain/" + res.body.path + ".");
        load(function () { open(res.body.path || M.path, true); });
      }).catch(function () { note.textContent = "Couldn't reach BeeZilla. Try again."; });
    }
    function newFolderDialog(opener) {
      dialog("New folder in brain/" + M.path, function (box, note) {
        var input = el("input", "bzb-input", { type: "text", maxlength: "48", autocomplete: "off", placeholder: "for example: kitchen remodel", "aria-label": "Folder name" });
        box.appendChild(input);
        box.appendChild(text("p", "bzb-box-text", "Letters, numbers and spaces. It is yours: the tidy never removes it."));
        var row = el("div", "bzb-box-row");
        row.appendChild(el("span", "bzb-gap"));
        var go = text("button", "bzb-btn primary", "Make folder");
        go.type = "button";
        row.appendChild(go);
        box.appendChild(row);
        function make() {
          note.textContent = "";
          api("POST", API + "/folders", { parent: M.path, name: input.value }).then(function (res) {
            if (!res.ok) { note.textContent = (res.body && res.body.error) || "That folder couldn't be made."; return; }
            closeDialog();
            load(function () { open(res.body.path); });
          }).catch(function () { note.textContent = "Couldn't reach BeeZilla. Try again."; });
        }
        go.addEventListener("click", make);
        input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); make(); } });
      }, opener);
    }

    // ── presses ──────────────────────────────────────────────────────────
    function itemById(id) { return (M.data && M.data.items || []).filter(function (it) { return it.id === id; })[0] || null; }
    function openChat(sessionId) {
      var go = window.BeeZillaShell && window.BeeZillaShell.go ? Promise.resolve(window.BeeZillaShell.go("/buzzy/talk")) : Promise.resolve();
      go.then(function () {
        if (window.bzOpenSession) {
          window.bzOpenSession({ id: sessionId });
          try { localStorage.setItem("bz_session_id", sessionId); } catch { /* private mode */ }
          try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { window.scrollTo(0, 0); }
        }
      });
    }
    root.addEventListener("click", function (e) {
      var t = e.target;
      var tog = t.closest && t.closest("[data-toggle]");
      if (tog) {
        var tp = tog.getAttribute("data-toggle");
        M.open[tp] = !M.open[tp];
        paintTree();
        return;
      }
      var actBtn = t.closest && t.closest("[data-act]");
      if (actBtn) {
        var act = actBtn.getAttribute("data-act");
        if (actBtn.disabled) return;
        if (act === "tidy") {
          actBtn.disabled = true;
          api("POST", API + "/tidy").then(function (res) {
            actBtn.disabled = false;
            if (!res.ok) { say((res.body && res.body.error) || "The tidy couldn't run just now."); return; }
            var moved = res.body.tidy && res.body.tidy.moved || 0;
            say(moved ? "Tidied: " + moved + (moved === 1 ? " thing" : " things") + " moved to a faster place." : "Tidied: everything was already where it belongs.");
            load();
          }).catch(function () { actBtn.disabled = false; say("Couldn't reach BeeZilla. Try again."); });
          return;
        }
        if (act === "new-folder") { newFolderDialog(actBtn); return; }
        if (act === "open-chat") { openChat(actBtn.getAttribute("data-session")); return; }
        if (act === "open-file") { window.open(actBtn.getAttribute("data-url"), "_blank", "noopener"); return; }
        if (act === "edit-agent") { if (window.BeeZillaAgents && window.BeeZillaAgents.edit) window.BeeZillaAgents.edit(actBtn.getAttribute("data-agent"), actBtn); return; }
        if (act === "talk-agent") { if (window.BeeZillaAgents && window.BeeZillaAgents.open) window.BeeZillaAgents.open(actBtn.getAttribute("data-agent")); return; }
        if (act === "try-skill") { if (window.bzPrompt) window.bzPrompt(actBtn.getAttribute("data-ask")); try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { window.scrollTo(0, 0); } return; }
        if (act === "recipes") { if (window.bzBrowseSelect) window.bzBrowseSelect("recipes"); return; }
        if (act === "move") { var it = itemById(actBtn.getAttribute("data-item")); if (it) moveDialog(it, actBtn); return; }
        if (act === "forget") {
          // Twice, on purpose: the first press asks, the second forgets.
          if (actBtn.getAttribute("data-sure") !== "1") { actBtn.setAttribute("data-sure", "1"); actBtn.textContent = "Forget for good?"; return; }
          var id = String(actBtn.getAttribute("data-item") || "").slice(5);
          var cut = id.indexOf(":");
          actBtn.disabled = true;
          api("DELETE", "/api/buzzy/memory", { jobId: id.slice(0, cut), key: id.slice(cut + 1) }).then(function (res) {
            if (!res.ok) { actBtn.disabled = false; say((res.body && res.body.error) || "That couldn't be forgotten."); return; }
            say("Forgotten. BeeZilla won't use it again; the job's work is untouched.");
            load();
          }).catch(function () { actBtn.disabled = false; say("Couldn't reach BeeZilla. Try again."); });
          return;
        }
      }
      var w = t.closest && t.closest(".bzb-worker");
      if (w) { if (window.BeeZillaAgents && window.BeeZillaAgents.open) window.BeeZillaAgents.open(w.getAttribute("data-agent")); return; }
      var s = t.closest && t.closest("[data-sort]");
      if (s) { M.sort = s.getAttribute("data-sort"); paintMain(); var info = M.lastInfo; if (info) paintFolderInfo(info); return; }
      var go = t.closest && t.closest("[data-path]");
      if (go && root.contains(go)) { open(go.getAttribute("data-path")); var f = root.querySelector('.bzb-row[data-path="' + go.getAttribute("data-path") + '"]'); if (f && go.classList.contains("bzb-row")) f.focus({ preventScroll: true }); }
    });
    // The tree answers the arrow keys the way a computer's folder tree does.
    tree.addEventListener("keydown", function (e) {
      var row = e.target.closest && e.target.closest(".bzb-row");
      if (!row) return;
      var rows = Array.prototype.slice.call(tree.querySelectorAll(".bzb-row"));
      var i = rows.indexOf(row);
      var path = row.getAttribute("data-path");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        var next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) { next.tabIndex = 0; row.tabIndex = -1; next.focus(); }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (childrenOf(path).length && !M.open[path]) { M.open[path] = true; paintTree(); var again = tree.querySelector('.bzb-row[data-path="' + path + '"]'); if (again) again.focus(); }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (M.open[path] && childrenOf(path).length) { M.open[path] = false; paintTree(); }
        else if (path) { open(parentOf(path)); }
        var back = tree.querySelector('.bzb-row[data-path="' + (M.open[path] ? path : parentOf(path)) + '"]') || tree.querySelector('.bzb-row[data-path="' + path + '"]');
        if (back) back.focus();
      }
    });
    root.addEventListener("dragstart", function (e) {
      var n = e.target.closest && e.target.closest("[data-bz-card]");
      if (!n) return;
      try {
        e.dataTransfer.setData("application/x-beezilla-card", n.getAttribute("data-bz-card"));
        e.dataTransfer.effectAllowed = "copy";
      } catch { /* best effort */ }
    });
    var handle = {
      open: function (p) { if (!M.data) { M.path = String(p || ""); return; } open(p); },
      reload: function () { return load(); },
      destroy: function () {
        M.dead = true;
        closeDialog();
        live = live.filter(function (h) { return h !== handle; });
        // Leaving the Memory tab: the strip stops lighting up this folder's bots (the panel keeps a folder it shows).
        try { window.dispatchEvent(new CustomEvent("bz:brain-folder", { detail: { path: "", info: null, from: "brain", closed: true } })); } catch { /* old browsers */ }
      },
      get path() { return M.path; },
      get node() { return root; },
    };
    live.push(handle);
    M.path = String(start || "").replace(/^brain\/?/, "");
    paint();
    load(function () { open(M.path); });
    return handle;
  }

  // The Memory tab at a folder: the explorer on screen if there is one, else Talk's places row.
  function show(path) {
    var p = String(path || "");
    var on = live.filter(function (h) { return h.node && h.node.isConnected && h.node.offsetParent !== null; })[0];
    if (on) {
      on.open(p);
      try { on.node.scrollIntoView({ block: "start", behavior: "smooth" }); } catch { /* old browsers */ }
      return;
    }
    wanted = p;
    if (window.bzBrowseSelect) {
      window.bzBrowseSelect("memory");
      setTimeout(function () {
        var now = live.filter(function (h) { return h.node && h.node.isConnected && h.node.offsetParent !== null; })[0];
        if (now) try { now.node.scrollIntoView({ block: "start", behavior: "smooth" }); } catch { /* old browsers */ }
      }, 450);
      return;
    }
    window.location.href = "/buzzy/memory#" + encodeURIComponent("brain" + (p ? "/" + p : ""));
  }

  window.BeeZillaBrain = {
    mount: mount,
    show: show,
    want: function (p) { wanted = p == null ? null : String(p); },
    wanted: function () { return wanted; },
    BRANCH: BRANCH,
  };
  try { window.dispatchEvent(new CustomEvent("bz:brain-ready")); } catch { /* old browsers */ }
})();
