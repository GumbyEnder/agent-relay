/*
 * BeeZilla works its own screen (roadmap phase 6 — live interface piloting).
 *
 * A chat reply can carry `actions`: things the owner asked BeeZilla to do on this
 * page, in their own words ("open the whiteboard", "show me only music"), built on
 * the server from a closed list (src/lib/buzzy/pilot.ts). BeeZillaPilot.run(actions)
 * carries them out one at a time where the owner can watch:
 *   - a card lists the steps, and each control lights up before it is pressed;
 *   - Stop ends the run at any step; the card can be minimised or closed;
 *   - a step whose control is not on the page stops the run and says which;
 *   - a step marked `ask` (less privacy, the microphone) waits for Allow or Skip.
 * It only presses this page's own buttons, the way the owner would.
 * Plain IIFE, no dependencies.
 */
(function () {
  "use strict";

  var LIT_MS = 700; // how long a control stays lit before it is pressed
  var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var current = null; // the run on screen, if any

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, reduce ? Math.min(ms, 120) : ms); });
  }

  function shown(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }

  // The page may still be drawing the control (a tab's pane, a pop-up): look for
  // it for a moment before giving up.
  function find(selector, ms) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function look() {
        var list = document.querySelectorAll(selector);
        for (var i = 0; i < list.length; i++) if (shown(list[i])) return resolve(list[i]);
        if (Date.now() - start > (ms || 2500)) return resolve(null);
        setTimeout(look, 100);
      })();
    });
  }

  function pressed(el) { return el.getAttribute("aria-pressed") === "true"; }
  function cap(s) { return String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1); }

  var KIND_NAME = { all: "All", photo: "Pictures", audio: "Music", "3d": "3D", document: "Documents" };

  // Each action as presses on this page's own controls. `already` says the press
  // isn't needed (the Idea Board is already open); `optional` never fails the run.
  function presses(a) {
    var v = a.value;
    switch (a.do) {
      case "inspiration":
        return [
          { sel: '[data-tab="inspiration"]', name: "the Inspiration tab", already: function (el) { return el.getAttribute("aria-selected") === "true"; } },
          { sel: '.bz-insp-kinds [data-kind="' + v + '"]', name: "“" + (KIND_NAME[v] || v) + "” above the Inspiration wall" },
        ];
      case "tab":
        return [{ sel: '[data-tab="' + v + '"]', name: "the " + cap(v) + " tab" }];
      case "whiteboard":
        // No button for it on the page any more (it opens when you talk, and folds with
        // its own Fold away): the switch stays in the page, out of sight.
        return [{ sel: "#boardToggle", name: "the Idea Board", hiddenOk: true, already: function (el) { return pressed(el) === (v === "open"); } }];
      case "privacy":
        return [
          { sel: "#privacyBtn", name: "the Privacy button", already: function () { var p = document.getElementById("privacyPop"); return !!p && !p.classList.contains("hidden"); } },
          { sel: '.pp-slider [data-mode="' + v + '"]', name: "“" + cap(v) + "”" },
          { sel: "#privacyClose", name: "Close", optional: true },
        ];
      case "mode":
        // Chat and Work are one bar now; the switch stays in the page, out of sight.
        return [{ sel: '#modeTabs [data-mode="' + v + '"]', name: "the " + cap(v) + " setting", hiddenOk: true }];
      case "history":
        return [{ sel: '[data-tab="history"]', name: "History, under the search bar" }];
      case "newChat":
        // The board's New conversation button, History's, or the one kept out of sight.
        return [{ sel: ".wb-new, .bz-pane-head [data-new], #newSessionBtn", name: "New conversation", hiddenOk: true }];
      case "speak":
        // One voice switch: Talk to BeeZilla (#micBtn) starts listening and speaks
        // replies together, and turns both off (toggleMic), so "speak on" is that
        // button pressed. The header's voice switch is gone (owner, 2026-11-18).
        return [{ sel: "#micBtn", name: "the Talk to BeeZilla button", already: function (el) { return pressed(el) === (v === "on"); } }];
      case "voice":
        return [{ sel: "#micBtn", name: "the microphone button", already: pressed }];
      case "go":
        return [{ sel: 'a[data-nav="' + v + '"], a[href="/buzzy/' + v + '"]', name: "the " + cap(v) + " link", go: "/buzzy/" + v }];
    }
    return null;
  }

  // ── The card ─────────────────────────────────────────────────────────
  var STYLE =
    ".bz-pilot{position:fixed;right:16px;bottom:96px;z-index:2147483000;width:min(360px,calc(100vw - 32px));" +
    "background:var(--bz-col,#1a1a1a);color:#f2f2f2;border:1px solid rgba(255,255,255,.14);border-radius:14px;" +
    "box-shadow:0 12px 32px rgba(0,0,0,.45);font:15px/1.4 var(--bz-font,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif)}" +
    ".bz-pilot-head{display:flex;align-items:center;gap:6px;padding:10px 10px 6px 14px}" +
    ".bz-pilot-title{flex:1;font-weight:650}" +
    ".bz-pilot-head button{border:0;background:transparent;color:inherit;font-size:16px;width:30px;height:30px;border-radius:8px;cursor:pointer}" +
    ".bz-pilot-head button:hover,.bz-pilot-head button:focus-visible{background:rgba(127,127,127,.18)}" +
    ".bz-pilot ol{list-style:none;margin:0;padding:0 14px 4px}" +
    ".bz-pilot li{display:flex;gap:10px;align-items:baseline;padding:5px 0}" +
    ".bz-pilot-mark{flex:0 0 18px;text-align:center;font-weight:700}" +
    ".bz-pilot li[data-state=done] .bz-pilot-mark{color:var(--bz-status-green,#5baf6b)}" +
    ".bz-pilot li[data-state=failed] .bz-pilot-mark,.bz-pilot li[data-state=failed] .bz-pilot-note{color:#e07a7a}" +
    ".bz-pilot li[data-state=waiting],.bz-pilot li[data-state=stopped],.bz-pilot li[data-state=skipped]{opacity:.6}" +
    ".bz-pilot-note{display:block;font-size:13px;opacity:.85}" +
    ".bz-pilot-ask{display:flex;gap:8px;margin-top:6px}" +
    ".bz-pilot-ask button,.bz-pilot-foot button{border:1px solid rgba(127,127,127,.45);background:transparent;color:inherit;border-radius:999px;padding:4px 14px;font:inherit;cursor:pointer}" +
    ".bz-pilot-ask .bz-pilot-allow{background:var(--bz-yellow,#ffc107);border-color:var(--bz-yellow,#ffc107);color:#0a0a0a;font-weight:650}" +
    ".bz-pilot-foot{display:flex;justify-content:space-between;align-items:center;padding:6px 14px 12px;font-size:13px}" +
    ".bz-pilot.min ol,.bz-pilot.min .bz-pilot-foot{display:none}" +
    ".bz-pilot-target{outline:3px solid var(--bz-yellow,#ffc107)!important;outline-offset:3px!important;box-shadow:0 0 0 8px rgba(255,193,7,.32)!important;" +
    "border-radius:8px;transition:outline-offset .2s}" +
    "@media (max-width:600px){.bz-pilot{right:16px;left:16px;width:auto;bottom:88px}}";

  function injectStyle() {
    if (document.getElementById("bz-pilot-style")) return;
    var st = document.createElement("style");
    st.id = "bz-pilot-style";
    st.textContent = STYLE;
    document.head.appendChild(st);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var MARK = { waiting: "○", doing: "…", done: "✓", failed: "✕", stopped: "–", skipped: "–", asking: "?" };

  function Run(actions) {
    var self = this;
    this.actions = actions;
    this.stopped = false;
    this.card = el("section", "bz-pilot");
    this.card.setAttribute("role", "region");
    this.card.setAttribute("aria-label", "BeeZilla is doing this");
    var head = el("div", "bz-pilot-head");
    this.title = el("span", "bz-pilot-title", "BeeZilla is doing this");
    var min = el("button", "bz-pilot-min", "–");
    min.type = "button";
    min.setAttribute("aria-label", "Minimise");
    min.title = "Minimise";
    var close = el("button", "bz-pilot-close", "✕");
    close.type = "button";
    close.setAttribute("aria-label", "Stop and close");
    close.title = "Stop and close";
    head.appendChild(this.title);
    head.appendChild(min);
    head.appendChild(close);
    this.list = el("ol");
    this.rows = actions.map(function (a) {
      var li = el("li");
      li.setAttribute("data-state", "waiting");
      var mark = el("span", "bz-pilot-mark", MARK.waiting);
      mark.setAttribute("aria-hidden", "true");
      var body = el("span");
      body.appendChild(el("span", "bz-pilot-say", a.say || a.do));
      var note = el("span", "bz-pilot-note");
      body.appendChild(note);
      li.appendChild(mark);
      li.appendChild(body);
      self.list.appendChild(li);
      return { li: li, mark: mark, note: note, body: body };
    });
    var foot = el("div", "bz-pilot-foot");
    this.status = el("span", "bz-pilot-status");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.stopBtn = el("button", "bz-pilot-stop", "Stop");
    this.stopBtn.type = "button";
    foot.appendChild(this.status);
    foot.appendChild(this.stopBtn);
    this.card.appendChild(head);
    this.card.appendChild(this.list);
    this.card.appendChild(foot);
    this.stopBtn.addEventListener("click", function () { self.stop(); });
    close.addEventListener("click", function () { self.stop(); self.remove(); });
    min.addEventListener("click", function () {
      var on = !self.card.classList.contains("min");
      self.card.classList.toggle("min", on);
      min.textContent = on ? "+" : "–";
      min.setAttribute("aria-label", on ? "Show the steps" : "Minimise");
      min.title = on ? "Show the steps" : "Minimise";
    });
    injectStyle();
    document.body.appendChild(this.card);
  }

  Run.prototype.set = function (i, state, note) {
    var r = this.rows[i];
    if (!r) return;
    r.li.setAttribute("data-state", state);
    r.mark.textContent = MARK[state] || "";
    if (note != null) r.note.textContent = note;
  };

  Run.prototype.stop = function () {
    if (this.stopped || this.finished) return;
    this.stopped = true;
    if (this.resolveAsk) this.resolveAsk(false);
    for (var i = 0; i < this.rows.length; i++) {
      var s = this.rows[i].li.getAttribute("data-state");
      if (s === "waiting" || s === "doing" || s === "asking") this.set(i, "stopped", "Stopped");
    }
    this.end("Stopped.");
  };

  Run.prototype.end = function (text) {
    this.finished = true;
    // Fold the More menu away again if this run opened it.
    var panel = document.getElementById("talkMorePanel");
    if (this.openedMore && panel && !panel.classList.contains("hidden")) {
      var more = document.getElementById("talkMoreBtn");
      if (more) more.click();
    }
    this.status.textContent = text;
    this.stopBtn.textContent = "Close";
    var self = this;
    this.stopBtn.onclick = function () { self.remove(); };
    if (this.lit) { this.lit.classList.remove("bz-pilot-target"); this.lit = null; }
  };

  Run.prototype.remove = function () {
    if (this.lit) this.lit.classList.remove("bz-pilot-target");
    if (this.card.parentNode) this.card.parentNode.removeChild(this.card);
    if (current === this) current = null;
  };

  // Allow / Skip under a step that waits for the owner.
  Run.prototype.ask = function (i) {
    var self = this;
    var r = this.rows[i];
    this.set(i, "asking", "Waiting for you");
    var box = el("span", "bz-pilot-ask");
    var allow = el("button", "bz-pilot-allow", "Allow");
    var skip = el("button", "bz-pilot-skip", "Skip");
    allow.type = skip.type = "button";
    box.appendChild(allow);
    box.appendChild(skip);
    r.body.appendChild(box);
    this.status.textContent = "Waiting for you to allow step " + (i + 1) + ".";
    return new Promise(function (resolve) {
      self.resolveAsk = function (yes) {
        self.resolveAsk = null;
        if (box.parentNode) box.parentNode.removeChild(box);
        resolve(yes);
      };
      allow.addEventListener("click", function () { self.resolveAsk && self.resolveAsk(true); });
      skip.addEventListener("click", function () { self.resolveAsk && self.resolveAsk(false); });
    });
  };

  // Controls that aren't talking live behind the Talk bar's More button: open it
  // first, lit like any other press, so the owner sees where the control is.
  Run.prototype.reveal = async function (sel) {
    var panel = document.getElementById("talkMorePanel");
    var more = document.getElementById("talkMoreBtn");
    if (!panel || !more || !panel.classList.contains("hidden")) return;
    var inside = panel.querySelector(sel);
    if (!inside) return;
    more.classList.add("bz-pilot-target");
    this.lit = more;
    await wait(LIT_MS);
    more.classList.remove("bz-pilot-target");
    this.lit = null;
    if (this.stopped) return;
    more.click();
    this.openedMore = true;
    await wait(200);
  };

  Run.prototype.press = async function (p) {
    if (!p.hiddenOk) await this.reveal(p.sel);
    if (this.stopped) return "stopped";
    var target = await find(p.sel, p.optional || p.hiddenOk ? 600 : 2500);
    if (this.stopped) return "stopped";
    if (!target && p.hiddenOk) {
      // A setting with no button on screen: change it directly, nothing to light up.
      var quiet = document.querySelector(p.sel);
      if (quiet) {
        if (!(p.already && p.already(quiet))) quiet.click();
        await wait(150);
        return "ok";
      }
    }
    if (!target) {
      if (p.optional) return "ok";
      if (p.go) { location.assign(p.go); return "ok"; }
      return "missing";
    }
    if (p.already && p.already(target)) return "ok";
    try { target.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" }); } catch (e) { /* old browsers */ }
    target.classList.add("bz-pilot-target");
    this.lit = target;
    await wait(LIT_MS);
    target.classList.remove("bz-pilot-target");
    this.lit = null;
    if (this.stopped) return "stopped";
    target.click();
    await wait(250);
    return "ok";
  };

  Run.prototype.play = async function () {
    var n = this.actions.length;
    for (var i = 0; i < n; i++) {
      if (this.stopped) return;
      var a = this.actions[i];
      var list = presses(a);
      if (!list) { this.set(i, "failed", "BeeZilla doesn't know how to do this here."); return this.end("Couldn't finish."); }
      if (a.ask) {
        var yes = await this.ask(i);
        if (this.stopped) return;
        if (!yes) { this.set(i, "skipped", "Skipped"); continue; }
      }
      this.set(i, "doing", "");
      this.status.textContent = "Step " + (i + 1) + " of " + n + "…";
      for (var j = 0; j < list.length; j++) {
        var result = await this.press(list[j]);
        if (result === "stopped") return;
        if (result === "missing") {
          this.set(i, "failed", "Couldn't find " + list[j].name + " on this page, so BeeZilla stopped here.");
          for (var k = i + 1; k < n; k++) this.set(k, "stopped", "Not done");
          return this.end("Couldn't finish.");
        }
      }
      this.set(i, "done", "");
    }
    this.end("Done.");
    var self = this;
    setTimeout(function () { if (self.finished && !self.stopped && !self.card.matches(":hover, :focus-within")) self.remove(); }, 6000);
  };

  window.BeeZillaPilot = {
    run: function (actions) {
      if (!Array.isArray(actions) || !actions.length) return null;
      if (current) { current.stop(); current.remove(); }
      current = new Run(actions.slice(0, 4));
      current.play();
      return current;
    },
    stop: function () { if (current) current.stop(); },
  };
})();
