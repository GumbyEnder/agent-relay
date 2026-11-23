/**
 * The Zilla agents: a sidebar of helpers down the left of every page.
 *
 * Owner, 2026-11-21:
 *   "On the left side, we need to create an agent system… where you have a series of
 *    agents that can do things on your behalf. Each agent should have a name by default
 *    given to them and a size and color."
 *   "We're going to start people on the left side of the screen with a bunch of these
 *    Zilla-type creatures as the default agents. We'll have the bunny-eared one just
 *    underneath the bee one… just one other, the bunny one, and it's grayed out. And then
 *    there'll be a plus symbol… you can click the plus symbol to add more."
 *   "We're going to move everything on the Zilla website slightly to the right, and we're
 *    going to insert these as images."
 *   "You can click on the plus or bunny Zilla, and it'll say, what role do you want me to
 *    play? It'll open a new talk to Zilla thing with the whiteboard, except the color of
 *    the button will change to the primary color of the creature in question."
 *   "By default, the face of all the ones except Zilla will be the thing it's helping
 *    with… if I say, you're in charge of my to-do list, it'll find a to-do-list emoji and
 *    make that the face."
 *   "When you click on it, it'll open up a sidebar on the left that expands. You'll see,
 *    e.g., Bunnyzilla in small text, and then 'helps with to-do list'… You can scroll up
 *    and down the sidebar to see maybe hundreds of agents."
 *   "They would have to X out to lose their progress, not just click to the side. That's
 *    a fundamental principle of our design: no click-outside-to-close. Escape key or an X
 *    closes anything that opens up."
 *
 * What is here:
 *  - A strip of faces (72 px) fixed to the left edge of every page that has the website's
 *    header, and the page moves over to make room (html.bz-has-agents). BeeZilla (the bee)
 *    first, then the person's agents, then a plus. Pressing the strip, or its foot button,
 *    opens it into a sidebar with each name and what it helps with; its right edge pulls
 *    it wider or narrower. It scrolls, for hundreds of agents. On a phone it is a drawer.
 *  - An agent with no job yet is grey. Pressing it (or the plus) opens Talk as that agent:
 *    "What role do you want me to play?". The answer gives it a job and a face (talk.html
 *    sends it to the server's /identity). An agent with a job wears its emoji, ringed in
 *    its own colour, with its Zilla peeking from the corner.
 *  - Everything in the strip can be dragged to the Idea Board (the site's critical rule):
 *    it carries a picture card with the agent's name and job.
 *  - "Edit" (the ⋯ button, or a right-click) changes the name, job, face, colour and size,
 *    or removes the agent. It is a dialog that only Esc or its X closes (no click-outside
 *    close, ever), and its box can be pulled bigger by the corner.
 *
 * Talk lends one door: window.BeeZillaTalk.talkAs(agent) (talk.html). This file lends
 * window.BeeZillaAgents to it: paint(agent) dresses the header (button colour, face, name,
 * the words in the box), update(agent) and noteSession(id, sessionId) keep the strip honest.
 */
(function () {
  "use strict";
  if (window.BeeZillaAgents) return;

  var API = "/api/buzzy/agents";
  var RAIL_W = 72;
  var OPEN_W = 248;
  var OPEN_MIN = 200;
  var OPEN_MAX = 420;
  var SIZES = { s: 36, m: 46, l: 56 };
  var LS_OPEN = "bz.agents.open";
  var LS_W = "bz.agents.w";
  var TALK = "/buzzy/talk";
  var FACES = ["✅", "🗓️", "✉️", "💰", "🧾", "✈️", "🏠", "📚", "🧸", "🐶", "🌱", "🎵", "📷", "🎬", "✍️", "📱", "📰", "⚖️", "🚗", "💼", "🤝", "📣", "🔎", "💻", "🎮", "🍳", "🛒", "🏋️", "🩺", "🎁", "🎉", "💡", "✨"];

  var root = document.documentElement;
  var phone = window.matchMedia ? window.matchMedia("(max-width: 700px)") : { matches: false, addEventListener: function () {} };
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The page-level state: what the server said, and how the strip is showing.
  var S = {
    bzilla: null,
    agents: [],
    colors: [],
    creatures: [],
    open: false,
    width: OPEN_W,
    current: "bzilla",    // the id of the agent whose conversation is open ("bzilla" for none)
    loaded: false,
    failed: false,
  };
  var rail = null, scroll = null, list = null, addRow = null, addBtn = null, toggleBtn = null, edge = null, msgEl = null, tab = null;
  var modal = null, modalOpener = null;
  var retryTimer = 0, msgTimer = 0;
  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });

  // ── tiny helpers ─────────────────────────────────────────────────────────
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch { /* private mode */ } }
  function el(tag, cls, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) Object.keys(attrs).forEach(function (k) { if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]); });
    return n;
  }
  function svg(html) {
    var w = document.createElement("span");
    w.innerHTML = html;
    return w.firstChild;
  }
  var ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  var ICON_CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  var ICON_MORE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
  function safeImage(src) { return typeof src === "string" && /^\/buzzy\/zillas\/[a-z0-9-]+\.webp$/.test(src) ? src : "/buzzy/zillas/bee.webp"; }
  function safeColor(c) { return typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#ffd40d"; }
  function pathNow() { return location.pathname.replace(/\.html$/, "").replace(/\/+$/, ""); }
  function wantsRail() {
    var p = pathNow();
    return /^\/buzzy(\/|$)/.test(p) && !/^\/buzzy\/(landing|login|shared|join)$/.test(p);
  }
  function api(method, path, body) {
    var opts = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) { return { status: r.status, ok: r.ok && !(j && j.ok === false), body: j || {} }; });
    });
  }

  // colour maths for the Talk button (a three-tone gradient from the agent's one colour)
  function rgb(hex) { var n = parseInt(safeColor(hex).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function toHex(c) { return "#" + c.map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"); }).join(""); }
  function mix(hex, other, t) { var a = rgb(hex), b = rgb(other); return toHex([0, 1, 2].map(function (i) { return a[i] + (b[i] - a[i]) * t; })); }
  function luminance(hex) {
    var c = rgb(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) { var l1 = luminance(a), l2 = luminance(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
  function inkFor(hex) { return contrast(hex, "#141414") >= contrast(hex, "#ffffff") ? "#141414" : "#ffffff"; }

  // ── what an agent is, in words ───────────────────────────────────────────
  function isBz(a) { return !!a && a.id === "bzilla"; }
  function isSet(a) { return isBz(a) || !!(a && (a.ready || a.role)); }
  function jobWords(a) {
    if (isBz(a)) return a.role || "your executive assistant";
    return a.role ? "helps with " + a.role : "waiting for a job";
  }
  function tipFor(a) {
    if (isBz(a)) return a.name + ": " + jobWords(a);
    return isSet(a) ? a.name + " " + jobWords(a) : a.name + " is waiting for a job. Press it to tell it what to take care of.";
  }
  // What it is when it goes on the Idea Board: a picture card with its name and job.
  function cardFor(a) {
    return {
      kind: "image",
      title: isBz(a) ? a.name : a.name + (a.role ? ", helps with " + a.role : ""),
      url: safeImage(a.image),
      contentType: "image/webp",
      body: isBz(a) ? "Your executive assistant, who looks after all your Zilla agents." : (a.role ? a.name + " is your Zilla agent for " + a.role + "." : a.name + " is a Zilla agent waiting for a job."),
    };
  }

  // ── the faces ────────────────────────────────────────────────────────────
  function avatar(a, px) {
    var av = el("span", "bzag-av");
    av.style.setProperty("--s", px + "px");
    if (!isBz(a) && a.role && a.face) {
      var ring = el("span", "bzag-ring");
      var face = el("span", "bzag-face");
      face.textContent = a.face;
      ring.appendChild(face);
      av.appendChild(ring);
      var badge = el("img", "bzag-badge", { alt: "", src: safeImage(a.image), draggable: "false" });
      av.appendChild(badge);
    } else {
      av.appendChild(el("img", "bzag-pic", { alt: "", src: safeImage(a.image), draggable: "false" }));
    }
    return av;
  }
  function sizeOf(a) { return SIZES[a && a.size] || SIZES.m; }

  function rowFor(a) {
    var li = el("li", "bzag-row");
    var set = isSet(a);
    var item = el("div", "bzag-item" + (set ? "" : " is-unset"), {
      role: "button",
      tabindex: "0",
      draggable: "true",
      "data-agent": a.id,
      "aria-label": isBz(a) ? a.name + ", " + jobWords(a) : set ? a.name + ", " + jobWords(a) : a.name + ", waiting for a job",
    });
    item.style.setProperty("--c", safeColor(a.color));
    item.setAttribute("data-tip", tipFor(a));
    var slot = el("span", "bzag-slot");
    slot.appendChild(avatar(a, sizeOf(a)));
    item.appendChild(slot);
    var text = el("span", "bzag-text");
    var name = el("span", "bzag-name"); name.textContent = a.name;
    var role = el("span", "bzag-role"); role.textContent = jobWords(a);
    text.appendChild(name); text.appendChild(role);
    item.appendChild(text);
    if (S.current === a.id) item.setAttribute("aria-current", "true");
    li.appendChild(item);
    if (!isBz(a)) {
      var more = el("button", "bzag-more", { type: "button", "aria-label": "Edit " + a.name, "data-more": a.id });
      more.appendChild(svg(ICON_MORE));
      li.appendChild(more);
    }
    return li;
  }

  function render() {
    if (!rail) return;
    var keep = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute("data-agent") : null;
    list.textContent = "";
    if (S.bzilla) list.appendChild(rowFor(S.bzilla));
    S.agents.forEach(function (a) { list.appendChild(rowFor(a)); });
    syncTitles();
    if (keep) { var again = list.querySelector('[data-agent="' + keep + '"]'); if (again) again.focus({ preventScroll: true }); }
    root.setAttribute("data-bz-agent-count", String(S.agents.length));
  }
  // The strip shows faces only, so each face carries its words as a tooltip; opened, the
  // words are on the page and the tooltip would only repeat them.
  function syncTitles() {
    if (!rail) return;
    var open = root.classList.contains("bz-agents-open") || root.classList.contains("bz-agents-drawer");
    Array.prototype.forEach.call(rail.querySelectorAll(".bzag-item"), function (n) {
      if (open) { n.removeAttribute("title"); n.removeAttribute("data-bz-tip"); }
      else if (!n.hasAttribute("data-bz-tip")) n.setAttribute("title", n.getAttribute("data-tip") || "");
    });
    if (addBtn) {
      if (open) { addBtn.removeAttribute("title"); addBtn.removeAttribute("data-bz-tip"); }
      else if (!addBtn.hasAttribute("data-bz-tip")) addBtn.setAttribute("title", "Add an agent");
    }
  }

  // ── the strip: build, open, size ─────────────────────────────────────────
  function build() {
    if (rail) return;
    rail = el("aside", "", { id: "bzAgents", "aria-label": "Your Zilla agents" });
    scroll = el("div", "bzag-scroll", { id: "bzagScroll" });
    list = el("ul", "bzag-list", { role: "list" });
    scroll.appendChild(list);
    addRow = el("div", "bzag-addrow");
    addRow.style.setProperty("--s", SIZES.m + "px");
    addBtn = el("button", "bzag-add", { type: "button", "aria-label": "Add an agent" });
    var plusSlot = el("span", "bzag-slot");
    var plus = el("span", "bzag-plus");
    plus.appendChild(svg(ICON_PLUS));
    plusSlot.appendChild(plus);
    var plusText = el("span", "bzag-add-text");
    plusText.textContent = "Add an agent";
    addBtn.appendChild(plusSlot);
    addBtn.appendChild(plusText);
    addRow.appendChild(addBtn);
    scroll.appendChild(addRow);
    rail.appendChild(scroll);

    msgEl = el("p", "bzag-msg", { role: "status", "aria-live": "polite" });
    msgEl.hidden = true;
    rail.appendChild(msgEl);

    var foot = el("div", "bzag-foot");
    toggleBtn = el("button", "bzag-toggle", { type: "button", "aria-expanded": "false", "aria-controls": "bzAgents" });
    toggleBtn.appendChild(svg(ICON_CHEV));
    var tt = el("span", "bzag-toggle-text");
    tt.textContent = "Hide names";
    toggleBtn.appendChild(tt);
    foot.appendChild(toggleBtn);
    rail.appendChild(foot);

    edge = el("div", "bzag-edge", { role: "separator", "aria-orientation": "vertical", "aria-label": "Make the agents sidebar wider or narrower", tabindex: "0" });
    rail.appendChild(edge);

    var close = el("button", "bzag-close", { type: "button", "aria-label": "Close the agents" });
    close.innerHTML = "&#10005;";
    rail.appendChild(close);

    document.body.appendChild(rail);

    // A phone gets a small tab to open the drawer with.
    tab = el("button", "", { id: "bzAgentsTab", type: "button", "aria-label": "Show your Zilla agents", title: "Your Zilla agents" });
    tab.appendChild(el("img", "", { alt: "", src: "/buzzy/zillas/bee.webp", draggable: "false" }));
    document.body.appendChild(tab);

    wire(close);
  }

  function setWidthVar() {
    var open = root.classList.contains("bz-agents-open");
    root.style.setProperty("--bzag-w", (open ? S.width : RAIL_W) + "px");
  }
  function setOpen(open, instant) {
    S.open = !!open;
    if (instant) { root.classList.remove("bz-agents-anim"); if (rail) rail.classList.add("bzag-noanim"); }
    root.classList.toggle("bz-agents-open", S.open);
    setWidthVar();
    if (toggleBtn) {
      toggleBtn.setAttribute("aria-expanded", S.open ? "true" : "false");
      toggleBtn.setAttribute("aria-label", S.open ? "Hide the agents' names" : "Show the agents' names");
      toggleBtn.title = S.open ? "" : "Show the agents' names and what each one helps with";
      if (S.open) toggleBtn.removeAttribute("title");
    }
    syncTitles();
    if (instant) requestAnimationFrame(function () { requestAnimationFrame(function () { if (rail) rail.classList.remove("bzag-noanim"); root.classList.add("bz-agents-anim"); }); });
  }
  function toggle() {
    setOpen(!S.open);
    lsSet(LS_OPEN, S.open ? "1" : "0");
  }
  function openDrawer() { root.classList.add("bz-agents-drawer"); syncTitles(); var f = rail && rail.querySelector(".bzag-item"); if (f) f.focus({ preventScroll: true }); }
  function closeDrawer() { root.classList.remove("bz-agents-drawer"); syncTitles(); if (tab && phone.matches) tab.focus({ preventScroll: true }); }

  function say(text, ms) {
    if (!msgEl) return;
    clearTimeout(msgTimer);
    msgEl.textContent = text;
    msgEl.hidden = !text;
    if (text) msgTimer = setTimeout(function () { msgEl.hidden = true; }, ms || 6000);
  }

  // ── talking to an agent ──────────────────────────────────────────────────
  function isTalkShowing() {
    var sh = window.BeeZillaShell;
    var key = String((sh && sh.currentKey) || pathNow()).replace(/[?#].*$/, "").replace(/\.html$/, "").replace(/\/+$/, "");
    return /^\/buzzy(\/talk)?$/.test(key);
  }
  function whenTalk() {
    return new Promise(function (resolve) {
      var tries = 0;
      (function look() {
        var t = window.BeeZillaTalk;
        if (t && t.talkAs && isTalkShowing()) return resolve(t);
        if (++tries > 80) return resolve(null);
        setTimeout(look, 100);
      })();
    });
  }
  function openAgent(a, opts) {
    if (!a) return;
    if (phone.matches) closeDrawer();
    var sh = window.BeeZillaShell;
    var moved = sh && sh.go ? Promise.resolve(sh.go(TALK)) : Promise.resolve();
    moved.then(whenTalk).then(function (talk) {
      if (talk) { talk.talkAs(isBz(a) ? null : a); return; }
      // Talk is not here (or not ready): load it, and it opens as this agent. (A page
      // that was itself opened with ?agent= does not try again: no loop.)
      if (opts && opts.fromUrl) return;
      window.location.href = TALK + "?agent=" + encodeURIComponent(a.id);
    });
  }
  function byId(id) { return id === "bzilla" ? S.bzilla : S.agents.filter(function (a) { return a.id === id; })[0] || null; }

  function add() {
    var waiting = S.agents.filter(function (a) { return !isSet(a); })[0];
    // One waiting seat at a time: the plus brings you to it instead of piling up grey faces.
    if (waiting) { say(waiting.name + " is still waiting for a job. Tell it what to take care of first."); scrollTo(waiting.id); openAgent(waiting); return; }
    if (addBtn.getAttribute("aria-busy") === "true") return;
    addBtn.setAttribute("aria-busy", "true");
    api("POST", API, {}).then(function (res) {
      addBtn.removeAttribute("aria-busy");
      if (!res.ok || !res.body.agent) { say((res.body && res.body.error) || "That agent couldn't be added. Try again in a moment."); return; }
      S.agents.push(res.body.agent);
      render();
      scrollTo(res.body.agent.id);
      openAgent(res.body.agent);
    }).catch(function () {
      addBtn.removeAttribute("aria-busy");
      say("Couldn't reach BeeZilla to add an agent. Check the connection and try again.");
    });
  }
  function scrollTo(id) {
    var n = list && list.querySelector('[data-agent="' + id + '"]');
    if (n && n.scrollIntoView) { try { n.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" }); } catch { n.scrollIntoView(); } }
  }

  // ── dressing the header as an agent ──────────────────────────────────────
  // Talk is the header of every page, so this lasts while you move around: the Talk
  // button wears the agent's colour, the face and name at the top left become the
  // agent's, and the box asks for the agent by name.
  function paint(a) {
    var agent = a && !isBz(a) ? a : null;
    var brand = document.querySelector(".bz-brandrow .bz-brand") || document.querySelector(".bz-brand");
    var input = document.getElementById("chatInput");
    if (!agent) {
      root.removeAttribute("data-bz-agent");
      ["--bzag", "--bzag-hi", "--bzag-lo", "--bzag-glow", "--bzag-glow-strong", "--bzag-ink"].forEach(function (k) { root.style.removeProperty(k); });
      if (brand) {
        var s0 = brand.querySelector("strong");
        if (s0 && brand.getAttribute("data-bzag-name")) s0.textContent = brand.getAttribute("data-bzag-name");
        brand.removeAttribute("data-bzag-name");
        var f0 = brand.querySelector(".bz-agent-face");
        if (f0) f0.remove();
      }
      if (input && input.getAttribute("data-bzag-ph") !== null) {
        input.setAttribute("placeholder", input.getAttribute("data-bzag-ph"));
        input.setAttribute("aria-label", input.getAttribute("data-bzag-aria") || "What would you like to make?");
        input.removeAttribute("data-bzag-ph"); input.removeAttribute("data-bzag-aria");
      }
      S.current = "bzilla";
      markCurrent();
      return;
    }
    var c = safeColor(agent.color);
    root.setAttribute("data-bz-agent", agent.id);
    root.style.setProperty("--bzag", c);
    root.style.setProperty("--bzag-hi", mix(c, "#ffffff", 0.28));
    root.style.setProperty("--bzag-lo", mix(c, "#000000", 0.14));
    var rg = rgb(c);
    root.style.setProperty("--bzag-glow", "rgba(" + rg.join(",") + ",0.45)");
    root.style.setProperty("--bzag-glow-strong", "rgba(" + rg.join(",") + ",0.75)");
    root.style.setProperty("--bzag-ink", inkFor(c));
    if (brand) {
      var strong = brand.querySelector("strong");
      if (strong) {
        if (!brand.getAttribute("data-bzag-name")) brand.setAttribute("data-bzag-name", strong.textContent);
        strong.textContent = agent.name;
      }
      var face = brand.querySelector(".bz-agent-face");
      if (!face) {
        // After the original face and before the name. voice-stage.js repaints the FIRST
        // <img> in the brand with BeeZilla's expressions, so this one is not an <img>.
        face = el("span", "bz-agent-face", { "aria-hidden": "true" });
        brand.insertBefore(face, brand.querySelector("strong"));
      }
      face.textContent = "";
      face.style.backgroundImage = "";
      if (agent.role && agent.face) { face.classList.remove("is-picture"); face.textContent = agent.face; }
      else { face.classList.add("is-picture"); face.style.backgroundImage = 'url("' + safeImage(agent.image) + '")'; }
    }
    if (input) {
      if (input.getAttribute("data-bzag-ph") === null) {
        input.setAttribute("data-bzag-ph", input.getAttribute("placeholder") || "");
        input.setAttribute("data-bzag-aria", input.getAttribute("aria-label") || "");
      }
      // Short, because the box is narrow while the board is open and a second line would
      // stretch the whole bar; the name goes in the label for screen readers instead.
      input.setAttribute("placeholder", agent.role ? "What do you need?" : "What should my job be?");
      input.setAttribute("aria-label", agent.role ? "What do you need from " + agent.name + "?" : "Tell " + agent.name + " what job to take on");
    }
    S.current = agent.id;
    markCurrent();
  }
  function markCurrent() {
    if (!rail) return;
    Array.prototype.forEach.call(rail.querySelectorAll(".bzag-item"), function (n) {
      if (n.getAttribute("data-agent") === S.current) n.setAttribute("aria-current", "true");
      else n.removeAttribute("aria-current");
    });
  }

  // ── keeping the strip honest ─────────────────────────────────────────────
  function update(a) {
    if (!a || !a.id || isBz(a)) return;
    var found = false;
    S.agents = S.agents.map(function (x) { if (x.id === a.id) { found = true; return a; } return x; });
    if (!found) S.agents.push(a);
    render();
    if (S.current === a.id) paint(a);
  }
  function noteSession(id, sessionId) {
    var a = byId(id);
    if (a && sessionId) a.lastSessionId = sessionId;
  }

  // ── loading ──────────────────────────────────────────────────────────────
  function drop() {
    if (rail) { rail.remove(); rail = null; }
    if (tab) { tab.remove(); tab = null; }
    root.classList.remove("bz-has-agents", "bz-agents-open", "bz-agents-anim", "bz-agents-drawer");
    root.style.removeProperty("--bzag-w");
  }
  function load() {
    return api("GET", API).then(function (res) {
      // Signed out, or a server that doesn't have agents: no strip, and no gap.
      if (res.status === 401 || res.status === 404) { drop(); S.loaded = true; readyResolve(null); return; }
      if (!res.ok) throw new Error("agents " + res.status);
      var b = res.body;
      S.bzilla = b.bzilla || { id: "bzilla", name: "BeeZilla", role: "your executive assistant", color: "#FFC107", size: "l", image: "/buzzy/zillas/bee.webp", ready: true };
      S.agents = Array.isArray(b.agents) ? b.agents : [];
      S.colors = Array.isArray(b.colors) ? b.colors : [];
      S.creatures = Array.isArray(b.creatures) ? b.creatures : [];
      S.loaded = true; S.failed = false;
      build();
      render();
      readyResolve(S);
    }).catch(function () {
      S.failed = true;
      if (!rail) {
        S.bzilla = S.bzilla || { id: "bzilla", name: "BeeZilla", role: "your executive assistant", color: "#FFC107", size: "l", image: "/buzzy/zillas/bee.webp", ready: true };
        build();
        render();
      }
      say("Couldn't load your agents. Trying again in a moment.");
      clearTimeout(retryTimer);
      retryTimer = setTimeout(load, 8000);
    });
  }

  // ── events ───────────────────────────────────────────────────────────────
  function focusables() { return Array.prototype.slice.call(rail.querySelectorAll(".bzag-item, .bzag-add")); }
  function wire(closeBtn) {
    rail.addEventListener("click", function (e) {
      var more = e.target.closest && e.target.closest(".bzag-more");
      if (more) { var m = byId(more.getAttribute("data-more")); if (m) editDialog(m, more); return; }
      var item = e.target.closest && e.target.closest(".bzag-item");
      if (item) { openAgent(byId(item.getAttribute("data-agent"))); return; }
      if (e.target.closest(".bzag-add")) { add(); return; }
      if (e.target.closest(".bzag-toggle")) { toggle(); return; }
      // The empty part of the strip opens and closes it too ("when you click on it,
      // it'll open up a sidebar on the left that expands"). Faces and buttons have
      // their own jobs, so only a press on the bare strip counts.
      if (e.target === scroll || e.target === list || e.target === rail) { if (!phone.matches) toggle(); }
    });
    rail.addEventListener("keydown", function (e) {
      var item = e.target.closest && e.target.closest(".bzag-item");
      if (item && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openAgent(byId(item.getAttribute("data-agent"))); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        var fs = focusables();
        var i = fs.indexOf(document.activeElement);
        if (i < 0) return;
        e.preventDefault();
        var next = fs[Math.max(0, Math.min(fs.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) next.focus();
      }
      if (e.key === "Escape" && root.classList.contains("bz-agents-drawer")) { e.preventDefault(); closeDrawer(); }
    });
    rail.addEventListener("contextmenu", function (e) {
      var item = e.target.closest && e.target.closest(".bzag-item");
      if (!item) return;
      var a = byId(item.getAttribute("data-agent"));
      if (!a || isBz(a)) return;
      e.preventDefault();
      editDialog(a, item);
    });
    // Everything goes on the Idea Board: a face carries a picture card with its name and job.
    rail.addEventListener("dragstart", function (e) {
      var item = e.target.closest && e.target.closest(".bzag-item");
      if (!item) return;
      var a = byId(item.getAttribute("data-agent"));
      if (!a) return;
      item.classList.add("bzag-dragging");
      try {
        e.dataTransfer.setData("application/x-beezilla-card", JSON.stringify(cardFor(a)));
        e.dataTransfer.setData("application/x-bz-agent", a.id);
        e.dataTransfer.setData("text/plain", a.name);
        e.dataTransfer.effectAllowed = "copyMove";
      } catch { /* best effort */ }
    });
    rail.addEventListener("dragend", function (e) {
      var item = e.target.closest && e.target.closest(".bzag-item");
      if (item) item.classList.remove("bzag-dragging");
    });
    closeBtn.addEventListener("click", closeDrawer);
    tab.addEventListener("click", openDrawer);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && root.classList.contains("bz-agents-drawer") && !(modal && modal.classList.contains("open"))) { closeDrawer(); }
    });

    // The right edge: drag it (or use the arrow keys on it) to change the opened width.
    edge.addEventListener("pointerdown", function (e) {
      if (!root.classList.contains("bz-agents-open")) return;
      e.preventDefault();
      edge.setPointerCapture(e.pointerId);
      rail.classList.add("bzag-sizing", "bzag-noanim");
      root.classList.remove("bz-agents-anim");
    });
    edge.addEventListener("pointermove", function (e) {
      if (!rail.classList.contains("bzag-sizing")) return;
      S.width = Math.max(OPEN_MIN, Math.min(OPEN_MAX, Math.round(e.clientX)));
      setWidthVar();
    });
    function endSize(e) {
      if (!rail.classList.contains("bzag-sizing")) return;
      rail.classList.remove("bzag-sizing", "bzag-noanim");
      root.classList.add("bz-agents-anim");
      try { edge.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      lsSet(LS_W, String(S.width));
    }
    edge.addEventListener("pointerup", endSize);
    edge.addEventListener("pointercancel", endSize);
    edge.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      S.width = Math.max(OPEN_MIN, Math.min(OPEN_MAX, S.width + (e.key === "ArrowRight" ? 16 : -16)));
      setWidthVar();
      lsSet(LS_W, String(S.width));
    });
    if (phone.addEventListener) phone.addEventListener("change", function () { if (!phone.matches) root.classList.remove("bz-agents-drawer"); syncTitles(); });
    else if (phone.addListener) phone.addListener(function () { if (!phone.matches) root.classList.remove("bz-agents-drawer"); syncTitles(); });
  }

  // ── the edit dialog ──────────────────────────────────────────────────────
  // Only Esc or the X closes it. There is deliberately no click handler on the backdrop:
  // what you typed is only lost on purpose.
  function ensureModal() {
    if (modal && modal.isConnected) return modal;
    modal = el("div", "", { id: "bzAgentsModal" });
    document.body.appendChild(modal);
    return modal;
  }
  function onModalKey(e) {
    if (!modal || !modal.classList.contains("open")) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeModal(); return; }
    if (e.key === "Tab") {
      var f = Array.prototype.filter.call(modal.querySelectorAll("button, input, [tabindex]:not([tabindex='-1'])"), function (n) { return !n.disabled && n.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function openModal(box, opener) {
    var m = ensureModal();
    m.textContent = "";
    m.appendChild(box);
    m.classList.add("open");
    modalOpener = opener || null;
    document.addEventListener("keydown", onModalKey, true);
  }
  function closeModal() {
    if (!modal) return;
    modal.classList.remove("open");
    modal.textContent = "";
    document.removeEventListener("keydown", onModalKey, true);
    var back = modalOpener;
    modalOpener = null;
    if (back && back.isConnected && back.focus) back.focus({ preventScroll: true });
  }
  function field(label, control, hint) {
    var w = el("label", "bzag-field");
    var s = el("span"); s.textContent = label;
    w.appendChild(s); w.appendChild(control);
    if (hint) { var p = el("p", "bzag-note"); p.textContent = hint; w.appendChild(p); }
    return w;
  }

  function editDialog(agent, opener) {
    var draft = { name: agent.name, role: agent.role || "", face: agent.face || "", look: agent.look || "", color: safeColor(agent.color), size: agent.size || "m" };
    var box = el("div", "bzag-box", { role: "dialog", "aria-modal": "true", "aria-labelledby": "bzagTitle" });
    var head = el("div", "bzag-head");
    var pic = el("img", "", { alt: "", src: safeImage(agent.image) });
    var h2 = el("h2", "", { id: "bzagTitle" }); h2.textContent = "Edit " + agent.name;
    var x = el("button", "bzag-x", { type: "button", "aria-label": "Close" }); x.innerHTML = "&#10005;";
    head.appendChild(pic); head.appendChild(h2); head.appendChild(x);
    box.appendChild(head);

    var name = el("input", "", { type: "text", maxlength: "40", autocomplete: "off", spellcheck: "false" });
    name.value = draft.name;
    box.appendChild(field("Name", name));

    var role = el("input", "", { type: "text", maxlength: "80", autocomplete: "off", placeholder: "for example: my to-do list" });
    role.value = draft.role;
    box.appendChild(field("Helps with", role));

    var face = el("input", "", { type: "text", maxlength: "12", autocomplete: "off", spellcheck: "false", placeholder: "an emoji" });
    face.value = draft.face;
    var faceWrap = field("Face", face);
    var faces = el("div", "bzag-faces");
    FACES.forEach(function (f) {
      var b = el("button", "bzag-emo", { type: "button", "aria-pressed": f === draft.face ? "true" : "false", "aria-label": "Use " + f });
      b.textContent = f;
      b.addEventListener("click", function () { face.value = f; paintFaces(); });
      faces.appendChild(b);
    });
    function paintFaces() {
      Array.prototype.forEach.call(faces.children, function (b) { b.setAttribute("aria-pressed", b.textContent === face.value ? "true" : "false"); });
    }
    face.addEventListener("input", paintFaces);
    faceWrap.appendChild(faces);
    box.appendChild(faceWrap);

    var swatchesWrap = el("div", "bzag-field", { role: "group", "aria-label": "Colour" });
    var sl = el("span"); sl.textContent = "Colour";
    var swatches = el("div", "bzag-swatches");
    var picks = [{ name: "", hex: null }].concat(S.colors.map(function (c) { return { name: c.name, hex: c.hex }; }));
    var own = (S.creatures.filter(function (c) { return c.id === agent.creature; })[0] || {}).color;
    function paintSwatches() {
      Array.prototype.forEach.call(swatches.children, function (b, i) {
        var p = picks[i];
        b.setAttribute("aria-pressed", String(p.name === draft.look));
      });
    }
    picks.forEach(function (p) {
      var b = el("button", "bzag-sw" + (p.name ? "" : " bzag-sw-own"), { type: "button", "aria-pressed": "false", "aria-label": p.name ? "Colour: " + p.name : "Colour: the original", title: p.name || "The original" });
      b.style.setProperty("--c", p.hex || own || "#ffd40d");
      b.addEventListener("click", function () {
        draft.look = p.name;
        draft.color = p.hex || own || draft.color;
        var base = agent.creature || "bunny";
        pic.setAttribute("src", "/buzzy/zillas/" + base + (p.name ? "-" + p.name : "") + ".webp");
        paintSwatches();
      });
      swatches.appendChild(b);
    });
    swatchesWrap.appendChild(sl); swatchesWrap.appendChild(swatches);
    box.appendChild(swatchesWrap);
    paintSwatches();

    var sizeWrap = el("div", "bzag-field", { role: "group", "aria-label": "Size" });
    var zl = el("span"); zl.textContent = "Size";
    var sizes = el("div", "bzag-size");
    [["s", "Small"], ["m", "Medium"], ["l", "Large"]].forEach(function (p) {
      var b = el("button", "", { type: "button", "aria-pressed": String(draft.size === p[0]) });
      b.textContent = p[1];
      b.addEventListener("click", function () {
        draft.size = p[0];
        Array.prototype.forEach.call(sizes.children, function (c, i) { c.setAttribute("aria-pressed", String(["s", "m", "l"][i] === draft.size)); });
      });
      sizes.appendChild(b);
    });
    sizeWrap.appendChild(zl); sizeWrap.appendChild(sizes);
    box.appendChild(sizeWrap);

    var msg = el("p", "bzag-msg", { role: "status", "aria-live": "polite" });
    box.appendChild(msg);
    var row = el("div", "bzag-row");
    var del = el("button", "bzag-btn danger", { type: "button" }); del.textContent = "Remove this agent";
    var gap = el("span", "bzag-gap");
    var save = el("button", "bzag-btn primary", { type: "button" }); save.textContent = "Save";
    row.appendChild(del); row.appendChild(gap); row.appendChild(save);
    box.appendChild(row);

    var armed = false;
    del.addEventListener("click", function () {
      if (!armed) {
        armed = true;
        del.textContent = "Yes, remove " + agent.name;
        msg.textContent = "Its conversations stay in History. Press again to remove it.";
        return;
      }
      del.disabled = true;
      api("DELETE", API + "/" + encodeURIComponent(agent.id)).then(function (res) {
        if (!res.ok) { del.disabled = false; msg.textContent = (res.body && res.body.error) || "That agent couldn't be removed."; return; }
        S.agents = S.agents.filter(function (a) { return a.id !== agent.id; });
        var wasCurrent = S.current === agent.id;
        render();
        closeModal();
        if (wasCurrent && window.BeeZillaTalk && window.BeeZillaTalk.talkAs) window.BeeZillaTalk.talkAs(null);
      }).catch(function () { del.disabled = false; msg.textContent = "Couldn't reach BeeZilla. Try again."; });
    });
    save.addEventListener("click", function () {
      var patch = {};
      var nm = name.value.replace(/\s+/g, " ").trim();
      if (!nm) { msg.textContent = "Give it a name first."; name.focus(); return; }
      if (nm !== agent.name) patch.name = nm;
      if (role.value.trim() !== (agent.role || "")) patch.role = role.value.trim();
      if (face.value.trim() !== (agent.face || "")) patch.face = face.value.trim();
      if (draft.look !== (agent.look || "")) { patch.look = draft.look; patch.color = draft.color; }
      if (draft.size !== (agent.size || "m")) patch.size = draft.size;
      if (!Object.keys(patch).length) { closeModal(); return; }
      save.disabled = true;
      msg.textContent = "";
      api("PATCH", API + "/" + encodeURIComponent(agent.id), patch).then(function (res) {
        save.disabled = false;
        if (!res.ok || !res.body.agent) { msg.textContent = (res.body && res.body.error) || "That couldn't be saved."; return; }
        update(res.body.agent);
        closeModal();
      }).catch(function () { save.disabled = false; msg.textContent = "Couldn't reach BeeZilla. Try again."; });
    });
    x.addEventListener("click", closeModal);
    openModal(box, opener);
    name.focus();
    name.select();
  }

  // ── start ────────────────────────────────────────────────────────────────
  function start() {
    if (!wantsRail()) { readyResolve(null); return; }
    // A reader who was signed in last time gets the room for the strip at once, so the
    // page does not jump over when the list arrives. (Signed out, it goes again.)
    var known = lsGet("bz_identity");
    var width = parseInt(lsGet(LS_W) || "", 10);
    if (width >= OPEN_MIN && width <= OPEN_MAX) S.width = width;
    var open = lsGet(LS_OPEN) === "1" && !phone.matches;
    if (known && known !== "null") {
      root.classList.add("bz-has-agents");
      root.classList.toggle("bz-agents-open", open);
      S.open = open;
      setWidthVar();
    }
    // /buzzy/talk?agent=<id> (a link, or the fallback above): Talk opens as that agent.
    var wanted = null;
    try { wanted = /^\/buzzy(\/talk)?$/.test(pathNow()) ? new URLSearchParams(location.search).get("agent") : null; } catch { wanted = null; }
    load().then(function () {
      if (!rail) return;
      root.classList.add("bz-has-agents");
      setOpen(open, true);
      if (wanted) {
        try { window.history.replaceState({}, "", TALK); } catch { /* best effort */ }
        openAgent(byId(wanted), { fromUrl: true });
      }
    });
  }

  window.BeeZillaAgents = {
    ready: ready,
    open: function (id) { var a = byId(id); if (a) openAgent(a); },
    get: function (id) { return ready.then(function () { return byId(id); }); },
    list: function () { return S.agents.slice(); },
    current: function () { return S.current && S.current !== "bzilla" ? byId(S.current) : null; },
    paint: paint,
    update: update,
    noteSession: noteSession,
    refresh: load,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
