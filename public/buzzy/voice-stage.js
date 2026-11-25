/**
 * The Talk page: one Talk to BeeZilla, and the whiteboard it opens.
 *
 * Owner, 2026-11-18:
 *   "My initial vision had a single button you push called Talk to BeeZilla. With a
 *    single line chat bubble… That would be above everything else."
 *   "When you start talking to it, it expands the whiteboard and puts the Talk to
 *    BeeZilla thing in the whiteboard."
 *   "We have a voice toggle. That does not need to be there. When you talk to
 *    BeeZilla, that is the voice toggle."
 *   "Since we already have a BeeZilla logo, why don't we move the guy … to the top
 *    left there? Also, he has an apathetic face as his default face that blinks…
 *    it should be in the repo, the proper faces."
 *   "History can move down to where library, memory, and experts is… The more button
 *    should be below as well."
 *
 * Owner, 2026-11-19:
 *   "When you click on it the first time, it should switch to a pause button. You can
 *    click on that pause anytime, think as much as you want, and then continue clicking
 *    on it and dictate it, and then pause it again, so that you have complete control."
 *
 *  - Talk to BeeZilla → Pause → Continue → Pause …: what you say collects in the box
 *    (talk.html's dictation) and nothing is sent until you send it yourself.
 *  - Folded: the Talk bar sits alone at the top of every page (#obStart, in the
 *    website's header #bzHead).
 *  - A visit opens folded, on a blank board (owner, 2026-11-20: "The whiteboard
 *    shouldn't be open until I say something… It should open to a blank page each
 *    time"). Pressing Talk to BeeZilla, sending, a live step from the agent, or
 *    putting something on the board opens it full width; the Talk bar moves INTO its
 *    top edge and the conversation sits on the board as a card you can move and
 *    scroll. "Fold away" puts the bar back on top. Talking opens it again.
 *  - The live process: chat stream "flow" steps (agent.md, skills, outputs) are drawn
 *    on the board as they happen (window.__bzFlow, fed by talk.html).
 *  - The face top-left is the real brand art (revision6 expressions), switched by
 *    what BeeZilla is doing — content, listening, thinking, working, talking, done.
 *    Nothing is drawn over it, and it does not blink.
 *  - No More menu: the paper clip and privacy sit on the Talk bar, New conversation
 *    on the board and in History, and "Your AI key" (the person's own provider key,
 *    in the cloud version too) behind the settings gear.
 *  - Anything dragged anywhere on the site can go on the board: while a drag is on,
 *    a drop strip shows at the top of the window (bzDropStrip below).
 *
 * talk.html owns the voice engine and lends this file:
 *   window.bzVoice             — the engine's state (read-only here)
 *   window.bzVoiceOut(level)   — the reply's playback level, 0..1
 */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }
  var micBtn = $("micBtn");
  var levelCanvas = micBtn && micBtn.querySelector(".tb-level");
  var input = $("chatInput");
  var composer = $("composerCard");
  var start = $("obStart");
  var boardHost = $("obBoard");
  var threadCol = $("talkWsThread");
  var thread = threadCol && threadCol.querySelector("#chatMessages");
  var parking = $("obParking");
  var toggle = $("boardToggle");
  if (!micBtn || !composer || !boardHost) return;

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function state() { return window.bzVoice || {}; }
  // "armed": a voice session is on and waiting for you between turns (talk.html).
  function voiceOn() { var v = state(); return !!(v.mic || v.armed || v.speaking || v.sending); }

  // ── What the voice is doing, said where you would type ──────────────
  // The words themselves go into the box (talk.html's dictation); while it is empty
  // the hint says what is happening and what the button does next.
  var restingPlaceholder = null;
  function paintWords() {
    if (!input) return;
    var v = state();
    if (!voiceOn() && !v.paused) {
      if (restingPlaceholder !== null) {
        input.setAttribute("placeholder", restingPlaceholder);
        restingPlaceholder = null;
      }
      return;
    }
    if (restingPlaceholder === null) restingPlaceholder = input.getAttribute("placeholder") || "";
    var words = v.note ? v.note
      : v.speaking ? "BeeZilla is talking. Press Pause to stop it."
        : v.sending ? "Thinking…"
          : v.paused ? "Paused. Press Continue when you're ready."
            : "Listening. Just talk.";
    if (input.getAttribute("placeholder") !== words) input.setAttribute("placeholder", words);
  }

  // ── The live level inside the Talk button ─────────────────────────────
  var outLevel = 0;
  window.bzVoiceOut = function (level) { outLevel = Math.max(0, Math.min(1, Number(level) || 0)); };
  var meter = { stream: null, ctx: null, src: null, an: null, buf: null };
  function micLevel() {
    var v = state();
    var stream = v && v.mic && v.micStream;
    if (!stream) { dropMeter(); return 0; }
    if (meter.stream !== stream) {
      dropMeter();
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        meter.ctx = new AC();
        meter.src = meter.ctx.createMediaStreamSource(stream);
        meter.an = meter.ctx.createAnalyser();
        meter.an.fftSize = 512;
        meter.src.connect(meter.an);
        meter.buf = new Float32Array(meter.an.fftSize);
        meter.stream = stream;
        if (meter.ctx.state === "suspended") Promise.resolve(meter.ctx.resume()).catch(function () {});
      } catch (_) { dropMeter(); return 0; }
    }
    meter.an.getFloatTimeDomainData(meter.buf);
    var sum = 0;
    for (var i = 0; i < meter.buf.length; i++) sum += meter.buf[i] * meter.buf[i];
    return Math.min(1, Math.sqrt(sum / meter.buf.length) * 9);
  }
  function dropMeter() {
    try { if (meter.src) meter.src.disconnect(); } catch (_) { /* best effort */ }
    try { if (meter.ctx) Promise.resolve(meter.ctx.close()).catch(function () {}); } catch (_) { /* best effort */ }
    meter = { stream: null, ctx: null, src: null, an: null, buf: null };
  }
  var BARS = 5;
  var heights = [0.15, 0.15, 0.15, 0.15, 0.15];
  var raf = 0;
  function draw() {
    raf = 0;
    if (!voiceOn() || !levelCanvas) { dropMeter(); return; }
    var v = state();
    var level = v.speaking ? outLevel : v.sending ? 0.18 : micLevel();
    var dpr = window.devicePixelRatio || 1;
    var w = levelCanvas.clientWidth || 26, h = levelCanvas.clientHeight || 18;
    if (levelCanvas.width !== Math.round(w * dpr)) {
      levelCanvas.width = Math.round(w * dpr);
      levelCanvas.height = Math.round(h * dpr);
    }
    var g = levelCanvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    var t = performance.now() / 1000;
    var gap = w / BARS;
    var bw = Math.max(2, gap * 0.55);
    for (var i = 0; i < BARS; i++) {
      var shape = 1 - Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2) * 0.45;
      var wobble = reduce ? 1 : 0.7 + 0.3 * Math.sin(t * (v.sending ? 3 : 8) + i * 1.3);
      var target = Math.max(0.15, Math.min(1, level * shape * wobble * 1.4));
      heights[i] += (target - heights[i]) * 0.35;
      var bh = Math.max(3, heights[i] * h);
      g.fillStyle = "#141414";
      var x = i * gap + (gap - bw) / 2, y = (h - bh) / 2, r = bw / 2;
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + bw, y, x + bw, y + bh, r);
      g.arcTo(x + bw, y + bh, x, y + bh, r);
      g.arcTo(x, y + bh, x, y, r);
      g.arcTo(x, y, x + bw, y, r);
      g.closePath();
      g.fill();
    }
    raf = requestAnimationFrame(draw);
  }

  // ── The face, top left: the real brand art, by what BeeZilla is doing ──────
  var FACES = {
    idle: "12-content", listening: "16-smiling", thinking: "08-thinking", working: "11-loading",
    talking: "02-joy", done: "13-idea", trouble: "10-nervous", happy: "02-joy",
  };
  function faceUrl(name) { return "/buzzy/brand/revision6_expressions_" + name + ".png"; }
  Object.keys(FACES).forEach(function (k) { var i = new Image(); i.src = faceUrl(FACES[k]); });
  var faceNow = "";
  var faceHold = null;
  var running = {};
  function faceImg() { return document.querySelector(".bz-brand img"); }
  function baseFace() {
    var v = state();
    if (v.speaking) return "talking";
    if (Object.keys(running).length) return "working";
    if (v.sending || $("thinkingIndicator")) return "thinking";
    if (v.mic || v.armed) return "listening";
    return "idle";
  }
  function paintFace() {
    var img = faceImg();
    if (!img) return;
    var mood = faceHold && Date.now() < faceHold.until ? faceHold.mood : baseFace();
    var name = FACES[mood] || FACES.idle;
    if (name === faceNow) return;
    faceNow = name;
    img.classList.add("bz-face-swap");
    img.src = faceUrl(name);
    img.alt = "";
    img.setAttribute("data-mood", mood);
    setTimeout(function () { img.classList.remove("bz-face-swap"); }, 260);
  }
  function holdFace(mood, ms) {
    faceHold = { mood: mood, until: Date.now() + (ms || 2600) };
    paintFace();
    setTimeout(paintFace, (ms || 2600) + 30);
  }
  // talk.html still calls setChatMascot("13-idea") and friends at its moments
  // (a draft is ready, a session opened); those become short, real expressions.
  window.bzFace = function (expr) {
    var e = String(expr || "");
    if (/idea|joy|content|smiling|affection|love/.test(e)) holdFace(/idea/.test(e) ? "done" : "happy", 2200);
    else if (/nervous|tears|dizzy|crossed|angry/.test(e)) holdFace("trouble", 2600);
    else paintFace();
  };

  // ── The whiteboard: folded on top, or open full width ─────────────────
  var board = null, boardKey = null;
  var folded = false;   // folded away with the board's own button
  var wanted = false;   // opened by a send, a step, or something put on the board
  // Voice can come back "armed" from an earlier visit (talk.html): that alone never
  // opens the board. It opens once the person presses Talk to BeeZilla in this page.
  var asked = false;
  micBtn.addEventListener("click", function () { asked = true; }, true);
  function boardId() {
    try { return localStorage.getItem("bz_session_id") || "talk"; } catch (_) { return "talk"; }
  }
  function hasConversation() { return !!(thread && thread.querySelector(".bubble.me")); }
  // The first message sent from the board in front of a new conversation ("talk")
  // gets the conversation its id just before the turn starts: carry the cards drawn
  // there over, in this browser and in the account (whiteboard.js). Only then:
  // opening an older conversation from the list leaves "talk" where it is.
  var carryFor = null;  // the conversation this send just started from "talk"
  function carryOver(from, to) {
    if (from !== "talk" || !to || carryFor !== to) return;
    carryFor = null;
    if (window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.carry) window.BeeZillaWhiteboard.carry(from, to);
  }
  // A board folded away still steers the next message (its instructions): keep this
  // browser's copy up to date with the account, which another computer may have changed.
  function refreshFolded(id) {
    if (!board && window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.sync) window.BeeZillaWhiteboard.sync(id);
  }
  function mountBoard() {
    if (board && boardKey !== boardId()) { var was = boardKey; unmountBoard(); carryOver(was, boardId()); }
    if (board || !window.BeeZillaWhiteboard) return;
    boardKey = boardId();
    board = window.BeeZillaWhiteboard.mount(boardHost, {
      boardId: boardKey,
      onFold: function () { folded = true; wanted = false; sync(); },
      onRecipe: function () { window.dispatchEvent(new CustomEvent("bz:recipes")); },
    });
    board.dock.appendChild(composer);
    if (threadCol) board.side.appendChild(threadCol);
    // New conversation, where the conversation is (it used to wait in a More menu).
    var tools = board.root.querySelector(".wb-tools");
    var fresh = $("newSessionBtn");
    if (tools && fresh) {
      var nb = document.createElement("button");
      nb.type = "button";
      nb.className = "wb-btn wb-new";
      nb.textContent = "New conversation";
      nb.title = "Start a new conversation on a blank board. This one stays in History.";
      nb.addEventListener("click", function () { fresh.click(); });
      tools.insertBefore(nb, tools.firstChild);
    }
  }
  function unmountBoard() {
    if (!board) return;
    if (start) start.appendChild(composer);
    if (threadCol && parking) parking.appendChild(threadCol);
    try { board.destroy(); } catch (_) { /* best effort */ }
    board = null;
    boardKey = null;
  }
  var wasOpen = false;
  function sync() {
    // A paused session keeps its board: the words wait in the box beside it.
    var talking = asked && (voiceOn() || !!state().paused);
    var want = talking || hasConversation() || wanted;
    if (want && !wasOpen && asked && voiceOn()) folded = false; // Talk opens the whiteboard
    var open = want && !folded;
    if (open) mountBoard(); else unmountBoard();
    document.documentElement.classList.toggle("ob-open", open);
    boardHost.classList.toggle("hidden", !open);
    // The conversation sits on the board as a card once there is one to show (placed
    // after the board is on screen, so it lands where you can see it).
    if (board && board.conversation && hasConversation()) board.conversation();
    if (toggle) toggle.setAttribute("aria-pressed", open ? "true" : "false");
    wasOpen = open;
    paintSeeBoard();
    paintWords();
    paintStatus();
    paintFace();
    if (voiceOn() && !raf) raf = requestAnimationFrame(draw);
  }
  function openBoard() { folded = false; wanted = true; sync(); }
  // The bee in the corner (nav.js) brings you home with the board folded away, so the
  // Talk bar waits alone at the top again (owner, 2026-11-21: "when you click the bee
  // itself… it should bring you back to the top page with the thing folded away").
  // Nothing is lost: the conversation stays in History, the board is kept, and See board
  // or talking opens them again. `asked` goes too, so a voice session that is still
  // running cannot throw the board straight back open; pressing Talk to BeeZilla again
  // (or sending a message) does that, as on a fresh visit.
  window.bzFoldBoard = function () { folded = true; wanted = false; asked = false; sync(); };
  if (toggle) {
    toggle.addEventListener("click", function () {
      if (board) { folded = true; wanted = false; }
      else { folded = false; wanted = true; }
      sync();
    });
  }
  // Owner, 2026-11-20: "you know how you can fold up talk to Bezilla? You should be
  // able to fold it back down with the open button. Maybe a see board button. Or just
  // clicking in the what would you like to make box should open up the board as well."
  // Clicking (or tapping) in the Talk box opens the board; while it's folded, a See
  // board button sits by the Talk bar wherever the Idea Board button itself is out of
  // sight (in the More menu).
  if (input) {
    input.addEventListener("pointerdown", function () { if (!board) openBoard(); });
  }
  var seeBoard;          // (no "= null": sync() may paint it before this line runs)
  function paintSeeBoard() {
    var open = !!board;
    var toggleInSight = !!(toggle && (toggle.offsetWidth || toggle.offsetHeight) && !toggle.closest(".hidden"));
    if (open || toggleInSight || !composer || !composer.parentNode) {
      if (seeBoard) seeBoard.hidden = true;
      return;
    }
    if (!seeBoard) {
      seeBoard = document.createElement("button");
      seeBoard.type = "button";
      seeBoard.className = "ob-see-board";
      seeBoard.textContent = "See board";
      seeBoard.title = "Open the Idea Board";
      seeBoard.setAttribute("aria-label", "See the Idea Board");
      seeBoard.addEventListener("click", function () { openBoard(); });
    }
    if (seeBoard.parentNode !== composer.parentNode || seeBoard.previousSibling !== composer) composer.parentNode.insertBefore(seeBoard, composer.nextSibling);
    seeBoard.hidden = false;
  }
  // The Idea Board button comes into sight and goes again with the More menu.
  var morePanelForSee = $("talkMorePanel");
  if (morePanelForSee && window.MutationObserver) new MutationObserver(function () { paintSeeBoard(); }).observe(morePanelForSee, { attributes: true, attributeFilter: ["class"] });

  // ── The live process, from talk.html's stream readers ─────────────────
  window.__bzTurnStart = function () {
    // talk.html stores the new conversation's id just before this; the board still
    // knows it was on "talk".
    var was = board ? boardKey : lastKey;
    if (was === "talk" && boardId() !== "talk") carryFor = boardId();
    openBoard();
    paintFace();
  };
  window.__bzFlow = function (step) {
    if (!step || !step.id) return;
    openBoard();
    if (step.state === "running" && step.kind !== "agent") running[step.id] = 1;
    else delete running[step.id];
    if (board) board.flow(step);
    if (step.state === "failed") holdFace("trouble", 2600);
    else if (step.kind === "output" && step.state !== "running") holdFace("done", 2400);
    else paintFace();
  };
  // When the reply lands: anything it produced that the stream did not already put
  // on the board (an older server, a document, a turn without a stream) goes up now.
  function flowIdFor(url) {
    var m = /\/api\/buzzy\/assets\/(\d+)/.exec(url || "");
    if (m) return "out:" + m[1];
    var d = /\/api\/buzzy\/documents\/([^?#]+)/.exec(url || "");
    if (d) return "out:doc:" + decodeURIComponent(d[1]);
    return "out:url:" + url;
  }
  window.__bzTurnDone = function (data) {
    running = {};
    if (!data) { paintFace(); return; }
    // An agent asked BeeZilla, or she asked one: the Hive window (agents.js), if it is open,
    // reads what was said without waiting for its next look.
    if ((data.tools || []).some(function (t) { return t && /^ask_(bzilla|agent)$/.test(t.name); })) {
      try { window.dispatchEvent(new CustomEvent("bz:hive")); } catch (_) { /* old browsers */ }
    }
    var outs = [];
    (data.artifacts || []).forEach(function (a) { if (a && a.url) outs.push({ url: a.url, title: a.name, contentType: a.contentType }); });
    [data.audio, data.image].forEach(function (a) { if (a && a.url) outs.push({ url: a.url, title: a.name, contentType: a.type }); });
    if (data.document && data.document.downloadUrl) {
      outs.push({ url: data.document.libraryUrl || data.document.downloadUrl, title: data.document.filename, contentType: data.document.contentType, id: data.document.documentId ? "out:doc:" + data.document.documentId : null });
    }
    if (outs.length) openBoard();
    var seen = {};
    outs.forEach(function (o) {
      var id = o.id || flowIdFor(o.url);
      if (seen[id] || !board) return;
      seen[id] = 1;
      board.flow({ kind: "output", id: id, title: o.title || "Result", url: o.url, contentType: o.contentType || "", state: "done", parent: "agent" });
    });
    paintFace();
  };
  // The person's edits on the board, sent with their next message (talk.html).
  window.bzBoardInstructions = function () {
    var once = window.__bzNextBoardInstructions;
    if (once) { window.__bzNextBoardInstructions = null; return once; }
    if (board) return board.instructions();
    return window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.instructionsFor ? window.BeeZillaWhiteboard.instructionsFor(boardId()) : "";
  };
  // The board's browser nodes (globes), with their details: BeeZilla runs one when the work
  // reaches the step it is joined to (talk.html sends them with the message).
  window.bzBoardNodes = function () {
    if (board && board.browserNodes) return board.browserNodes();
    return window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.nodesFor ? window.BeeZillaWhiteboard.nodesFor(boardId()) : [];
  };
  // Run a saved recipe: its steps ride the next message as board instructions.
  window.bzRunRecipe = function (recipe) {
    if (!recipe || !input) return;
    window.__bzNextBoardInstructions = String(recipe.instructions || "").slice(0, 4000);
    input.value = "Run my recipe “" + (recipe.name || "My recipe") + "”.";
    openBoard();
    var send = $("chatSend");
    try { window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" }); } catch (_) { /* best effort */ }
    if (send && !send.disabled) send.click();
    else input.focus();
  };
  window.bzPutRecipeOnBoard = function (recipe) {
    if (!recipe || !recipe.graph) return;
    openBoard();
    if (board) { board.addGraph(recipe.graph); board.say("“" + recipe.name + "” is on the board. Edit it, then talk to run it."); }
    try { window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" }); } catch (_) { /* best effort */ }
  };
  window.bzAddToBoard = function (card) {
    openBoard();
    if (board) board.addCard(card);
  };

  // ── Everything on the site goes on the board ──────────────────────────
  // Owner, 2026-11-20: "Everything on this website has got to be movable to the
  // whiteboard." While anything is dragged, on any page (a picture, an Inspiration
  // card, a search result, a link, words, a file from the computer), a strip at the
  // top of the window shows where it goes. Dropping it there puts it on the Idea
  // Board, which opens if it was folded; dropping straight onto the open board still
  // puts it where you let go. Pressing an Inspiration card brings the strip up first,
  // so you see where the card goes before you move it (window.bzDirectToBoard), and
  // clicking the strip then puts it there without dragging at all.
  var ARROW_UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>';
  var strip = document.createElement("div");
  strip.className = "bz-dropstrip";
  strip.hidden = true;
  strip.setAttribute("role", "status");
  strip.setAttribute("aria-live", "polite");
  strip.innerHTML = '<span class="bz-ds-ico">' + ARROW_UP + '</span><span class="bz-ds-text"></span>' +
    '<button type="button" class="bz-ds-go" hidden>Show it</button>';
  ($("bzHead") || document.body).appendChild(strip);
  var stripText = strip.querySelector(".bz-ds-text");
  var stripGo = strip.querySelector(".bz-ds-go");
  var pendingCard = null, stripTimer = 0, dragOn = false;
  function showStrip(mode, text) {
    clearTimeout(stripTimer);
    strip.hidden = false;
    strip.className = "bz-dropstrip bz-ds-" + mode;
    stripText.textContent = text;
    stripGo.hidden = true;
  }
  function hideStrip(ms) {
    clearTimeout(stripTimer);
    stripTimer = setTimeout(function () { strip.hidden = true; pendingCard = null; }, ms || 0);
  }
  function boardInView() {
    if (!board) return false;
    var r = boardHost.getBoundingClientRect();
    return r.height > 0 && r.bottom > 120 && r.top < window.innerHeight - 120;
  }
  function landed(ok) {
    showStrip("done", ok ? "It's on your Idea Board." : "That couldn't go on the board.");
    stripGo.hidden = !ok || boardInView();
    hideStrip(ok ? 4200 : 3000);
  }
  function putOnBoard(fn) {
    asked = true;
    openBoard();
    var ok = false;
    try { ok = !!(board && fn(board)); } catch (_) { ok = false; }
    landed(ok);
  }
  stripGo.addEventListener("click", function (e) {
    e.stopPropagation();
    hideStrip(0);
    try { boardHost.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" }); } catch (_) { /* best effort */ }
  });
  strip.addEventListener("dragover", function (e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    strip.classList.add("bz-ds-over");
  });
  strip.addEventListener("dragleave", function () { strip.classList.remove("bz-ds-over"); });
  strip.addEventListener("drop", function (e) {
    e.preventDefault();
    e.stopPropagation();
    dragOn = false;
    var dt = e.dataTransfer;
    putOnBoard(function (b) { return b.drop(dt); });
  });
  strip.addEventListener("click", function () {
    if (!pendingCard) return;
    var card = pendingCard;
    pendingCard = null;
    putOnBoard(function (b) { return b.addCard(card); });
  });
  window.bzDirectToBoard = function (card) {
    showStrip("press", "Drag it up here to put it on your Idea Board, or click here.");
    pendingCard = card || null;
    hideStrip(6000);
  };
  window.addEventListener("bz:dropped", function () { if (!strip.hidden && !/bz-ds-done/.test(strip.className)) hideStrip(0); });

  // A drag that says nothing about itself still carries what it is: a picture, a
  // sound, a link, or an element that names its card (data-bz-card).
  function fileName(u) { try { return decodeURIComponent(new URL(u, location.href).pathname.split("/").pop() || "") || "Picture"; } catch (_) { return "Picture"; } }
  function describe(t) {
    var own = t.closest("[data-bz-card]");
    if (own) { try { return JSON.parse(own.getAttribute("data-bz-card")); } catch (_) { /* fall through */ } }
    if (t.tagName === "IMG") return { kind: "image", title: t.alt || fileName(t.currentSrc || t.src), url: t.currentSrc || t.src };
    var media = t.closest("audio, video");
    if (media && (media.currentSrc || media.src)) return { kind: media.tagName === "AUDIO" ? "track" : "video", title: fileName(media.currentSrc || media.src), url: media.currentSrc || media.src };
    var a = t.closest("a[href]");
    if (a && /^(https?:|\/)/i.test(a.getAttribute("href") || "")) {
      var words = String(a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
      return { kind: "file", title: words || a.href, url: a.href };
    }
    return null;
  }
  document.addEventListener("dragstart", function (e) {
    var t = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
    if (!t || !t.closest || t.closest(".wb-panel")) return;   // moving cards on the board itself
    dragOn = true;
    var dt = e.dataTransfer;
    var card = describe(t);
    if (dt && card && Array.prototype.indexOf.call(dt.types || [], "application/x-beezilla-card") < 0) {
      try { dt.setData("application/x-beezilla-card", JSON.stringify(card)); } catch (_) { /* best effort */ }
    }
    showStrip("drag", "Drop here to put it on your Idea Board");
  }, true);
  document.addEventListener("dragend", function () {
    if (!dragOn) return;
    dragOn = false;
    if (!/bz-ds-done/.test(strip.className)) hideStrip(250);
  }, true);
  // Files from the computer never fire dragstart in the page.
  document.addEventListener("dragenter", function (e) {
    if (dragOn) return;
    var types = e.dataTransfer && e.dataTransfer.types ? Array.prototype.slice.call(e.dataTransfer.types) : [];
    if (types.indexOf("Files") < 0) return;
    if (strip.hidden || !/bz-ds-drag/.test(strip.className)) showStrip("drag", "Drop here to put it on your Idea Board");
  }, true);
  document.addEventListener("dragleave", function (e) {
    if (dragOn || e.relatedTarget) return;
    if (/bz-ds-drag/.test(strip.className)) hideStrip(200);   // the file left the window
  }, true);
  document.addEventListener("drop", function () {
    dragOn = false;
    if (/bz-ds-drag/.test(strip.className)) hideStrip(150);
  }, true);

  // ── Where the work stands: one line at the top of the conversation ────────
  var status = document.createElement("div");
  status.className = "talk-ws-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  if (threadCol) threadCol.insertBefore(status, threadCol.firstChild);
  var lastStatus = "";
  function paintStatus() {
    var banner = $("draftBanner");
    var waiting = !!(banner && !banner.classList.contains("hidden"));
    var working = !!$("thinkingIndicator");
    var now = working ? "working" : waiting ? "waiting" : "";
    if (now === lastStatus) return;
    lastStatus = now;
    status.innerHTML = "";
    if (!now) return;
    var dot = document.createElement("span");
    dot.className = "ws-dot " + (working ? "ws-busy" : "ws-wait");
    status.appendChild(dot);
    status.appendChild(document.createTextNode(working ? "BeeZilla is working on it…" : "A draft is waiting for your approval."));
    if (waiting) {
      var go = document.createElement("button");
      go.type = "button";
      go.textContent = "Review it";
      go.addEventListener("click", function () {
        var b = $("draftBanner");
        if (b) b.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
      });
      status.appendChild(go);
    }
  }
  var draftBanner = $("draftBanner");
  if (draftBanner) new MutationObserver(paintStatus).observe(draftBanner, { attributes: true, attributeFilter: ["class"] });

  new MutationObserver(sync).observe(micBtn, { attributes: true, childList: true, subtree: true, characterData: true });
  if (thread) new MutationObserver(function () { sync(); }).observe(thread, { childList: true });
  window.addEventListener("storage", function (e) { if (e.key === "bz_session_id") sync(); });
  // A new or reopened conversation has its own board.
  var lastKey = boardId();
  setInterval(function () {
    var k = boardId();
    if (k === lastKey) return;
    var was = lastKey;
    lastKey = k;
    // Already showing this conversation's board (the send switched it): mounting it
    // again would close whatever was open on it — a drawing, an editor.
    if (board && boardKey === k) return;
    if (board) { unmountBoard(); carryOver(was, k); sync(); }
    else carryOver(was, k);
    refreshFolded(k);
  }, 1500);
  sync();
  // A visit starts on a blank board: the one in front of a new conversation is
  // emptied (its earlier versions stay in the board's History).
  if (boardId() === "talk" && window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.reset) window.BeeZillaWhiteboard.reset("talk");
  else refreshFolded(boardId());
  // Boards from before they were saved to the account (and changes made offline
  // and never sent) go up quietly, once the page has settled.
  setTimeout(function () {
    if (window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.sweep) window.BeeZillaWhiteboard.sweep();
  }, 6000);

  // ── Your AI key (owner: "Even on the cloud mode, I need to be able to put in my
  // own API key") ─────────────────────────────────────────────────────
  var keyBtn = $("aiKeyBtn");
  var keyDlg = null;
  function keyDialog() {
    if (keyDlg) { keyDlg.remove(); keyDlg = null; }
    var d = document.createElement("div");
    d.className = "ob-dialog";
    d.setAttribute("role", "dialog");
    d.setAttribute("aria-modal", "true");
    d.setAttribute("aria-labelledby", "obKeyTitle");
    d.innerHTML =
      '<form class="ob-dialog-box" novalidate>' +
      '<div class="ob-dialog-head"><h2 id="obKeyTitle">Your AI key</h2>' +
      '<button type="button" class="ob-x" aria-label="Close">&#10005;</button></div>' +
      '<p class="ob-dialog-text">Use your own AI account for BeeZilla\'s answers. Your key is locked away on BeeZilla\'s server and is never shown again — only its last four characters.</p>' +
      '<p class="ob-key-now" aria-live="polite"></p>' +
      '<label class="ob-field"><span>Provider</span><select name="provider"></select></label>' +
      '<label class="ob-field ob-custom" hidden><span>Address (https://…)</span><input name="baseUrl" type="url" placeholder="https://api.example.com/v1" autocomplete="off" /></label>' +
      '<label class="ob-field"><span>API key</span><input name="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your key" /></label>' +
      '<label class="ob-field"><span>Model (optional)</span><input name="model" type="text" autocomplete="off" spellcheck="false" placeholder="The model name your provider uses" /></label>' +
      '<p class="ob-dialog-note">Talking out loud still uses BeeZilla\'s own voice service. Pictures, music and 3D use BeeZilla\'s makers.</p>' +
      '<p class="ob-key-msg" role="status" aria-live="polite"></p>' +
      '<div class="ob-dialog-row"><button type="submit" class="ob-primary">Test and save</button>' +
      '<button type="button" class="ob-forget" hidden>Remove my key</button></div>' +
      "</form>";
    ($("bzHead") || document.body).appendChild(d);
    keyDlg = d;
    var form = d.querySelector("form");
    var sel = form.querySelector("[name=provider]");
    var msg = form.querySelector(".ob-key-msg");
    var now = form.querySelector(".ob-key-now");
    var forget = form.querySelector(".ob-forget");
    var custom = form.querySelector(".ob-custom");
    function close() { d.remove(); keyDlg = null; document.removeEventListener("keydown", onEsc, true); if (keyBtn) keyBtn.focus(); }
    // Esc closes it wherever focus is: a press on the dark around the box moves focus
    // out of it, and with no click-outside close Esc must still work from there.
    function onEsc(e) { if (e.key === "Escape") { e.preventDefault(); close(); } }
    document.addEventListener("keydown", onEsc, true);
    d.querySelector(".ob-x").addEventListener("click", close);
    // Only its X or Esc closes it: a click on the page around it does nothing, so a key
    // half-pasted is never lost by accident (owner, 2026-11-21: "no click-outside-to-close").
    sel.addEventListener("change", function () { custom.hidden = sel.value !== "custom"; });
    function paintNow(k) {
      if (k && k.saved) {
        now.textContent = "In use: your key ending " + k.hint + (k.model ? " · model " + k.model : "") + ".";
        forget.hidden = false;
        if (k.provider) sel.value = k.provider;
        custom.hidden = sel.value !== "custom";
        if (k.provider === "custom" && k.baseUrl) form.querySelector("[name=baseUrl]").value = k.baseUrl;
        if (k.model) form.querySelector("[name=model]").value = k.model;
      } else {
        now.textContent = "Not set: BeeZilla's own AI answers you.";
        forget.hidden = true;
      }
    }
    fetch("/api/buzzy/ai-key", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (j) {
      var ps = (j && j.providers) || [];
      sel.innerHTML = ps.map(function (p) { return '<option value="' + p.id + '">' + p.label.replace(/</g, "&lt;") + "</option>"; }).join("") +
        '<option value="custom">Another provider (OpenAI-compatible)</option>';
      paintNow(j && j.key);
    }).catch(function () { msg.textContent = "Couldn't reach BeeZilla — check the connection."; });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var key = form.querySelector("[name=apiKey]").value.trim();
      if (!key) { msg.textContent = "Paste your API key first."; form.querySelector("[name=apiKey]").focus(); return; }
      msg.textContent = "Checking the key with your provider…";
      var go = form.querySelector(".ob-primary");
      go.disabled = true;
      fetch("/api/buzzy/ai-key", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: sel.value,
          baseUrl: form.querySelector("[name=baseUrl]").value.trim(),
          apiKey: key,
          model: form.querySelector("[name=model]").value.trim(),
          test: true,
        }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        go.disabled = false;
        if (!j || !j.ok) { msg.textContent = (j && j.error) || "That key couldn't be saved."; return; }
        form.querySelector("[name=apiKey]").value = "";
        paintNow(j.key);
        msg.textContent = j.works === false
          ? "Saved, but it didn't work yet: " + (j.problem || "the provider said no") + " BeeZilla keeps using it until you fix or remove it."
          : "Saved and working. BeeZilla now answers on your key.";
      }).catch(function () { go.disabled = false; msg.textContent = "Couldn't reach BeeZilla — check the connection."; });
    });
    forget.addEventListener("click", function () {
      fetch("/api/buzzy/ai-key", { method: "DELETE", credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function () { paintNow(null); msg.textContent = "Removed. BeeZilla's own AI answers you again."; })
        .catch(function () { msg.textContent = "Couldn't reach BeeZilla — check the connection."; });
    });
    sel.focus();
  }
  if (keyBtn) keyBtn.addEventListener("click", keyDialog);
  window.bzOpenKeyDialog = keyDialog;
})();
