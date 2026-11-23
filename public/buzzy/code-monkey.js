/*
 * Code Monkey's workshop — the coding environment's screen.
 *
 * Opens from a card under a Talk reply, from a `#code` / `#code=<job>` link on any
 * page, or from window.BeeZillaCodeMonkey.open(jobId) (the agents strip). Shows
 * one coding project at a time: the result card, its slices moving through
 * Waiting · Working · Needs you · Checking · Done, and the proof each slice
 * brought back. Talk stays the one place to talk: changing a decision puts a
 * sentence in the Talk box instead of opening a second chat.
 *
 * Screen rules (docs/BEEZILLA-SCREEN-RULES.md): closes only with its X or Esc,
 * never on an outside click; resizable by its edge where resize.js is loaded;
 * every card drags to the Idea Board (data-bz-card).
 * Server: src/lib/buzzy/codeMonkey.nitro.ts. Design: docs/beezilla/CODE-MONKEY.md.
 */
(function () {
  "use strict";
  if (window.BeeZillaCodeMonkey) return;

  var API = "/api/buzzy/code";
  var POLL_MS = 8000;
  // Shapes carry meaning as well as colour (screen rules: SVG icons, never colour alone).
  var ICON = {
    ring: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/>',
    half: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/>',
    diamond: '<path d="M8 1.8 14.2 8 8 14.2 1.8 8z" fill="currentColor"/>',
    target: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="8" r="2.2" fill="currentColor"/>',
    check: '<path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
    // Stakes are "care bars" (1-3), so they never borrow the brain's shapes
    // (circle, square, triangle, hexagon mean knowledge/systems/assets/brain).
    bars1: '<rect x="2" y="9" width="3" height="5" rx="1" fill="currentColor"/><rect x="6.5" y="6" width="3" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="11" y="2.5" width="3" height="11.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/>',
    bars2: '<rect x="2" y="9" width="3" height="5" rx="1" fill="currentColor"/><rect x="6.5" y="6" width="3" height="8" rx="1" fill="currentColor"/><rect x="11" y="2.5" width="3" height="11.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/>',
    bars3: '<rect x="2" y="9" width="3" height="5" rx="1" fill="currentColor"/><rect x="6.5" y="6" width="3" height="8" rx="1" fill="currentColor"/><rect x="11" y="2.5" width="3" height="11.5" rx="1" fill="currentColor"/>',
    undo: '<path d="M5 5H10a3.5 3.5 0 0 1 0 7H6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M6.5 2.5 3.5 5l3 2.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    stop: '<path d="M5.3 1.5h5.4l3.8 3.8v5.4l-3.8 3.8H5.3l-3.8-3.8V5.3z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 4.8v3.6M8 10.9v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  };
  function icon(name) {
    return '<svg class="bzcm-i" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' + (ICON[name] || "") + "</svg>";
  }
  var STATES = {
    waiting: { label: "Waiting", shape: "ring" },
    working: { label: "Working", shape: "half" },
    "needs-you": { label: "Needs you", shape: "diamond" },
    checking: { label: "Checking", shape: "target" },
    done: { label: "Done", shape: "check" },
  };
  var STAKES = {
    play: { label: "Play", shape: "bars1", hint: "for you and people close to you" },
    product: { label: "Product", shape: "bars2", hint: "other people will use it" },
    critical: { label: "Critical", shape: "bars3", hint: "a mistake would really hurt" },
  };

  var panel = null;
  var body = null;
  var current = null;
  var timer = null;
  var busy = false;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function cardAttr(title, text) {
    return esc(JSON.stringify({ kind: "note", title: String(title || "").slice(0, 120), body: String(text || "").slice(0, 600) }));
  }

  function ensureCss() {
    if (document.querySelector('link[href="/buzzy/code-monkey.css"]')) return;
    var l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "/buzzy/code-monkey.css";
    document.head.appendChild(l);
  }

  function build() {
    if (panel) return;
    ensureCss();
    panel = document.createElement("aside");
    panel.className = "bzcm";
    panel.id = "bzCodeMonkey";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Code Monkey's workshop");
    panel.setAttribute("data-bz-resize", "w");
    panel.setAttribute("data-bz-resize-anchor", "end");
    panel.setAttribute("data-bz-resize-key", "code-monkey");
    panel.innerHTML =
      '<div class="bzcm-head">' +
        '<span class="bzcm-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M8.5 7 4 12l4.5 5M15.5 7 20 12l-4.5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
        '<div class="bzcm-titles"><p class="bzcm-kicker">Code Monkey</p><h2 class="bzcm-title">Workshop</h2></div>' +
        '<button type="button" class="bzcm-all" data-cm-list>All projects</button>' +
        '<button type="button" class="bzcm-x" data-cm-close aria-label="Close the workshop">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>' +
        "</button>" +
      "</div>" +
      '<div class="bzcm-body" aria-live="polite"></div>';
    body = panel.querySelector(".bzcm-body");
    document.body.appendChild(panel);
    panel.addEventListener("click", onClick);
  }

  function open(jobId) {
    build();
    panel.classList.add("is-open");
    current = jobId || null;
    if (current) loadProject(); else loadList();
    startPolling();
  }

  function close() {
    if (!panel) return;
    panel.classList.remove("is-open");
    stopPolling();
    if (/^#code/.test(location.hash)) {
      try { history.replaceState(null, "", location.pathname + location.search); } catch (_) { /* ignore */ }
    }
  }

  function startPolling() {
    stopPolling();
    timer = setInterval(function () {
      if (!panel || !panel.classList.contains("is-open") || document.visibilityState !== "visible" || busy) return;
      if (current) loadProject(true);
    }, POLL_MS);
  }
  function stopPolling() { if (timer) clearInterval(timer); timer = null; }

  function get(url) {
    return fetch(url, { credentials: "same-origin", cache: "no-store" }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, j: j }; }, function () { return { status: r.status, j: {} }; });
    });
  }
  function post(payload) {
    busy = true;
    return fetch(API, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, j: j }; }, function () { return { status: r.status, j: {} }; });
    }).finally(function () { busy = false; });
  }

  function signedOut() {
    body.innerHTML = '<p class="bzcm-empty">Sign in to see what Code Monkey is making for you.</p>';
  }

  function loadList() {
    body.innerHTML = '<p class="bzcm-empty">Loading…</p>';
    get(API).then(function (r) {
      if (r.status === 401) return signedOut();
      var list = (r.j && r.j.projects) || [];
      if (!list.length) {
        body.innerHTML = '<div class="bzcm-empty"><p><b>Nothing being made yet.</b></p>' +
          "<p>Tell Code Monkey what you want in Talk — what it is and who it's for. Small or clear things start straight away; " +
          "big or unclear ones get one quick question first.</p></div>";
        return;
      }
      body.innerHTML = '<ul class="bzcm-list">' + list.map(function (p) {
        return '<li><button type="button" class="bzcm-proj" data-cm-open="' + esc(p.jobId) + '" draggable="true" data-bz-card="' +
          cardAttr(p.making, "Code Monkey project · " + p.status) + '">' +
          '<span class="bzcm-proj-name">' + esc(p.making || "Untitled project") + "</span>" +
          '<span class="bzcm-proj-sub">' + esc(p.status === "done" ? "Done" : "In the workshop") + "</span></button></li>";
      }).join("") + "</ul>";
    }).catch(function () { body.innerHTML = '<p class="bzcm-empty">Could not load your projects — check your connection.</p>'; });
  }

  function loadProject(quiet) {
    var id = current;
    if (!quiet) body.innerHTML = '<p class="bzcm-empty">Loading…</p>';
    return get(API + "?job=" + encodeURIComponent(id)).then(function (r) {
      if (id !== current) return;
      if (r.status === 401) return signedOut();
      if (r.status === 404) { body.innerHTML = '<p class="bzcm-empty">That project isn\'t yours or no longer exists.</p>'; return; }
      if (!r.j || !r.j.project) return;
      paint(r.j.project, quiet);
    }).catch(function () { if (!quiet) body.innerHTML = '<p class="bzcm-empty">Could not load the project — check your connection.</p>'; });
  }

  function paint(p, quiet) {
    // Don't repaint over a half-typed answer; the next poll after it is sent will.
    if (quiet && panel.querySelector("textarea:focus")) return;
    var c = p.card || {};
    var st = STAKES[c.stakes] || STAKES.product;
    var counts = p.counts || {};
    var summary = ["needs-you", "working", "checking", "waiting", "done"].filter(function (k) { return counts[k]; })
      .map(function (k) { return '<span class="bzcm-count s-' + k + '">' + icon(STATES[k].shape) + " " + counts[k] + " " + STATES[k].label.toLowerCase() + "</span>"; }).join("");

    var html = "";
    html += '<section class="bzcm-card" draggable="true" data-bz-card="' + cardAttr(c.making, "For " + c.forWhom + ". " + c.outcome) + '">' +
      '<div class="bzcm-card-top"><span class="bzcm-stakes" title="' + esc(st.hint) + '">' + icon(st.shape) + " " + esc(st.label) + "</span>" +
      (p.stakesRaisedFrom ? '<span class="bzcm-raised">raised from ' + esc(p.stakesRaisedFrom) + " — " + esc(c.stakesWhy) + "</span>" : "") + "</div>" +
      '<h3 class="bzcm-making">' + esc(c.making) + "</h3>" +
      '<p class="bzcm-line"><b>For</b> ' + esc(c.forWhom) + "</p>" +
      '<p class="bzcm-line"><b>So that</b> ' + esc(c.outcome) + "</p>" +
      list("Done when", (c.doneWhen || []).map(function (d) { return d.text; }), "bzcm-checks") +
      ((c.notDoing || []).length ? list("Not doing", c.notDoing, "bzcm-not") : "") +
      ((c.assumptions || []).length
        ? '<div class="bzcm-sub"><p class="bzcm-sub-h">Decisions I made for you</p><ul class="bzcm-assume">' +
          c.assumptions.map(function (a) {
            return "<li><span>" + esc(a) + '</span><button type="button" class="bzcm-link" data-cm-change="' + esc(a) + '">Change</button></li>';
          }).join("") + "</ul></div>"
        : "") +
      "</section>";
    // The owner's own words, kept exactly as typed; the card above is only a summary of them.
    if (p.source && p.source.words) {
      html += '<details class="bzcm-words"><summary>Your words' + (p.source.at ? " · " + esc(new Date(p.source.at).toLocaleString()) : "") + "</summary>" +
        '<p class="bzcm-words-text">' + esc(p.source.words) + "</p></details>";
    }
    var notes = [];
    notes.push(p.reviewIndependent
      ? "Every step is checked by a second AI from another company" + (p.reviewerProvider ? " (" + esc(p.reviewerProvider) + ")" : "") + " before it counts."
      : '<b>No second AI from another company is set up</b>, so steps finish marked "not independently reviewed".');
    if (p.launch && p.launch.authorized) {
      notes.push("Going live is allowed for this project — " + (p.launch.source === "your words" ? 'you asked: "' + esc(p.launch.evidence) + '"' : "you said go on “" + esc(p.launch.evidence) + "”") + ".");
    } else if ((p.slices || []).some(function (s) { return s.door === "one-way"; })) {
      notes.push("Anything that can't be undone waits for your OK. Other steps keep going meanwhile.");
    }
    html += '<ul class="bzcm-notes">' + notes.map(function (n) { return "<li>" + n + "</li>"; }).join("") + "</ul>";
    html += '<div class="bzcm-counts">' + summary + "</div>";
    html += '<p class="bzcm-sub-h">Steps</p><ol class="bzcm-slices">' + (p.slices || []).map(sliceHtml).join("") + "</ol>";
    body.innerHTML = html;
  }

  function list(title, items, cls) {
    return '<div class="bzcm-sub"><p class="bzcm-sub-h">' + esc(title) + '</p><ul class="' + cls + '">' +
      items.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul></div>";
  }

  function proofHtml(s) {
    var links = (s.proof && s.proof.links) || [];
    var out = "";
    if (s.proof && s.proof.summary) out += '<p class="bzcm-proof-sum">' + esc(s.proof.summary) + "</p>";
    if (links.length) {
      out += '<ul class="bzcm-proof">' + links.map(function (u) {
        var safe = /^https?:\/\//i.test(u) ? u : "";
        if (!safe) return "";
        var img = /\.(png|jpe?g|gif|webp)(\?|$)/i.test(safe);
        return "<li>" + (img
          ? '<a href="' + esc(safe) + '" target="_blank" rel="noopener"><img src="' + esc(safe) + '" alt="Screenshot from the work" loading="lazy"></a>'
          : '<a href="' + esc(safe) + '" target="_blank" rel="noopener">' + esc(safe.replace(/^https?:\/\//, "").slice(0, 70)) + "</a>") + "</li>";
      }).join("") + "</ul>";
    }
    if (s.reviewed === "pass") out += '<p class="bzcm-review ok">' + icon("check") + " Checked by a second AI from another company.</p>";
    if (s.reviewed === "not-available") out += '<p class="bzcm-review warn">Not independently reviewed — no reviewer from another company is set up.</p>';
    if (s.review && s.review.summary) out += '<p class="bzcm-review"><b>Second opinion:</b> ' + esc(s.review.summary) + "</p>";
    return out ? '<div class="bzcm-proof-wrap"><p class="bzcm-sub-h">Proof</p>' + out + "</div>" : "";
  }

  function sliceHtml(s) {
    var st = STATES[s.state] || STATES.waiting;
    var door = s.door === "one-way"
      ? '<span class="bzcm-door one-way" title="' + esc(s.doorWhy) + '">' + icon("stop") + " asks you first — " + esc(s.doorWhy) + "</span>"
      : '<span class="bzcm-door">' + icon("undo") + " can be undone</span>";
    var act = "";
    if (s.question) {
      act += '<div class="bzcm-ask"><p><b>Code Monkey asks:</b> ' + esc(s.question.text) + "</p>" +
        '<textarea rows="2" data-cm-answer-for="' + esc(s.question.callId) + '" placeholder="Your answer"></textarea>' +
        '<button type="button" class="bzcm-btn" data-cm-answer="' + esc(s.question.callId) + '">Send answer</button></div>';
    } else if (s.ownerLooks) {
      act += '<div class="bzcm-ask"><p>' + (s.door === "one-way"
        ? "It's built and checked. The last part can't be undone — say go when you're ready. Other steps keep going meanwhile."
        : "It's built and checked. Because this one matters a lot, have a look at the proof before it counts.") + "</p>" +
        '<div class="bzcm-row"><button type="button" class="bzcm-btn" data-cm-ok="' + esc(s.key) + '">' + (s.door === "one-way" ? "Go ahead" : "Looks right") + "</button>" +
        '<button type="button" class="bzcm-btn ghost" data-cm-notyet="' + esc(s.key) + '">Not yet…</button></div>' +
        '<div class="bzcm-notyet" data-cm-notyet-box="' + esc(s.key) + '" hidden><textarea rows="2" placeholder="What should change?"></textarea>' +
        '<button type="button" class="bzcm-btn" data-cm-sendback="' + esc(s.key) + '">Send it back</button></div></div>';
    }
    return '<li class="bzcm-slice s-' + esc(s.state) + '" draggable="true" data-bz-card="' + cardAttr(s.title, "Try it: " + s.shows + ". Done when: " + (s.doneWhen || []).join("; ")) + '">' +
      '<div class="bzcm-slice-top"><span class="bzcm-state s-' + esc(s.state) + '">' + icon(st.shape) + " " + st.label + "</span>" + door + "</div>" +
      '<h4 class="bzcm-slice-title">' + esc(s.title) + "</h4>" +
      '<p class="bzcm-try"><b>Try it:</b> ' + esc(s.shows) + "</p>" +
      (s.authorizedBy ? '<p class="bzcm-authorized">You already asked for this: “' + esc(s.authorizedBy) + "”</p>" : "") +
      '<ul class="bzcm-checks small">' + (s.doneWhen || []).map(function (d) { return "<li>" + esc(d) + "</li>"; }).join("") + "</ul>" +
      (s.progress && s.state === "working" ? '<p class="bzcm-progress">' + esc(s.progress) + "</p>" : "") +
      proofHtml(s) + act + "</li>";
  }

  function talkSay(text) {
    var box = document.getElementById("chatInput");
    if (!box) { location.href = "/buzzy/talk"; return; }
    box.value = text;
    try { box.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) { /* ignore */ }
    box.focus();
  }

  function onClick(e) {
    var t = e.target.closest ? e.target.closest("button") : null;
    if (!t) return;
    if (t.hasAttribute("data-cm-close")) return close();
    if (t.hasAttribute("data-cm-list")) { current = null; return loadList(); }
    if (t.hasAttribute("data-cm-open")) { current = t.getAttribute("data-cm-open"); return loadProject(); }
    if (t.hasAttribute("data-cm-change")) {
      var making = (panel.querySelector(".bzcm-making") || {}).textContent || "the project";
      return talkSay('About "' + making + '": instead of "' + t.getAttribute("data-cm-change") + '", ');
    }
    if (t.hasAttribute("data-cm-answer")) {
      var callId = t.getAttribute("data-cm-answer");
      var ta = panel.querySelector('textarea[data-cm-answer-for="' + callId.replace(/"/g, "") + '"]');
      var text = ta ? ta.value.trim() : "";
      if (!text) { if (ta) ta.focus(); return; }
      t.disabled = true;
      return post({ action: "answer", jobId: current, callId: callId, text: text }).then(function () { loadProject(true); });
    }
    if (t.hasAttribute("data-cm-ok")) {
      t.disabled = true;
      return post({ action: "looks-right", jobId: current, slice: t.getAttribute("data-cm-ok") }).then(function () { loadProject(true); });
    }
    if (t.hasAttribute("data-cm-notyet")) {
      var box = panel.querySelector('[data-cm-notyet-box="' + t.getAttribute("data-cm-notyet").replace(/"/g, "") + '"]');
      if (box) { box.hidden = false; var tx = box.querySelector("textarea"); if (tx) tx.focus(); }
      return;
    }
    if (t.hasAttribute("data-cm-sendback")) {
      var key = t.getAttribute("data-cm-sendback");
      var wrap = panel.querySelector('[data-cm-notyet-box="' + key.replace(/"/g, "") + '"]');
      var why = wrap ? (wrap.querySelector("textarea").value || "").trim() : "";
      if (!why) return;
      t.disabled = true;
      return post({ action: "not-yet", jobId: current, slice: key, text: why }).then(function () { loadProject(true); });
    }
  }

  // Esc closes wherever focus is (the listener is on the document), never an outside click.
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && panel && panel.classList.contains("is-open")) close();
  });

  // The Talk card's button, wherever the card is rendered.
  document.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("[data-code-job]") : null;
    if (!b) return;
    e.preventDefault();
    open(b.getAttribute("data-code-job"));
  });

  function fromHash() {
    var m = /^#code(?:=([A-Za-z0-9_-]+))?$/.exec(location.hash || "");
    if (m) open(m[1] || null);
  }
  window.addEventListener("hashchange", fromHash);

  window.BeeZillaCodeMonkey = {
    open: open,
    close: close,
    refresh: function () { if (current) loadProject(true); else loadList(); },
    /** The card Talk shows under a reply that started a project. */
    cardHtml: function (cp) {
      var st = STAKES[cp.stakes] || STAKES.product;
      return '<div class="bzcm-talk-card" draggable="true" data-bz-card="' + cardAttr(cp.making, "Code Monkey is making this · " + cp.slices + " steps") + '">' +
        '<span class="bzcm-talk-shape">' + icon(st.shape) + "</span>" +
        '<span class="bzcm-talk-text"><b>Code Monkey is making:</b> ' + esc(cp.making) + ' <span class="bzcm-talk-sub">· ' +
        esc(String(cp.slices)) + " step" + (cp.slices === 1 ? "" : "s") + " · " + esc(st.label) + "</span></span>" +
        '<button type="button" class="bzcm-btn" data-code-job="' + esc(cp.jobId) + '">Open the workshop</button></div>';
    },
  };
  ensureCss();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fromHash);
  else fromHash();
})();
