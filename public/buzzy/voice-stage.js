/**
 * The Talk page's one control and the workspace it opens.
 *
 * Owner, 2026-11-17: "It should just be one. Talk to BeeZilla. Then it opens up the
 * whiteboard area. And in the whiteboard area, you can talk and interact with it…
 * It should be clear that it's receiving you, it's hearing you… We don't want a
 * mascot on top of a button, on top of 9 different ways it's seeing you and hearing
 * you. Just make it one thing."
 *
 *  - The Talk to BeeZilla button is the only voice signal. Its label says Listening…
 *    or BeeZilla is talking (talk.html paintVoice), and a small live level inside it
 *    moves with your voice, or with BeeZilla's while it speaks.
 *  - What BeeZilla hears appears in the box where you would type, as you speak.
 *  - Talking, sending a message or asking for the whiteboard opens the workspace:
 *    the conversation on the left, the whiteboard on the right. The whiteboard's own
 *    close button folds it away; Whiteboard in the More menu brings it back.
 *  - Everything that isn't talking (new conversation, conversations, attach, speak
 *    replies, Chat or Work, privacy) sits behind the one More button on the bar.
 *
 * talk.html owns the voice engine; it lends this file three things:
 *   window.bzVoice           — the engine's state object (read-only use here)
 *   window.bzVoiceOut(level) — called with the reply's playback level, 0..1
 *   window.bzVoiceWords(text, final) — called with what the recogniser heard
 * The mic level comes from our own AnalyserNode on voice.micStream, so nothing in
 * the engine's capture path changes. The old big-mic panel (#voiceStage) stays in
 * the page for the engine's bookkeeping and is never shown (calm.css).
 */
(function () {
  "use strict";

  var micBtn = document.getElementById("micBtn");
  var levelCanvas = micBtn && micBtn.querySelector(".tb-level");
  var input = document.getElementById("chatInput");
  var ws = document.getElementById("talkWorkspace");
  var thread = document.getElementById("chatMessages");
  var boardSlot = document.getElementById("talkWsBoard");
  var toggle = document.getElementById("boardToggle");
  if (!micBtn || !ws) return;

  function state() { return window.bzVoice || {}; }
  function voiceOn() { var v = state(); return !!(v.mic || v.speaking || v.sending); }

  // ── What BeeZilla hears, shown where you would type ──────────────────
  var heard = "";
  var heardTimer = 0;
  var restingPlaceholder = null; // the box's own placeholder, kept while voice is on
  window.bzVoiceWords = function (text, isFinal) {
    heard = String(text || "");
    clearTimeout(heardTimer);
    if (isFinal) heardTimer = setTimeout(function () { heard = ""; paintWords(); }, 4000);
    paintWords();
  };
  function paintWords() {
    if (!input) return;
    var v = state();
    if (!voiceOn()) {
      if (restingPlaceholder !== null) {
        input.setAttribute("placeholder", restingPlaceholder);
        restingPlaceholder = null;
      }
      input.classList.remove("tb-heard");
      heard = "";
      return;
    }
    if (restingPlaceholder === null) restingPlaceholder = input.getAttribute("placeholder") || "";
    var words = heard
      ? heard
      : v.speaking ? "BeeZilla is talking. Press the button to cut in."
        : v.sending ? "Thinking…" : "Listening. Just talk.";
    if (input.getAttribute("placeholder") !== words) input.setAttribute("placeholder", words);
    input.classList.toggle("tb-heard", !!heard);
  }

  // ── The live level inside the button ─────────────────────────────────
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
    // RMS of normal speech sits around 0.02–0.1; lift it into 0..1.
    return Math.min(1, Math.sqrt(sum / meter.buf.length) * 9);
  }
  function dropMeter() {
    try { if (meter.src) meter.src.disconnect(); } catch (_) {}
    try { if (meter.ctx) Promise.resolve(meter.ctx.close()).catch(function () {}); } catch (_) {}
    meter = { stream: null, ctx: null, src: null, an: null, buf: null };
  }

  var BARS = 5;
  var heights = [0.15, 0.15, 0.15, 0.15, 0.15];
  var raf = 0;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
      // Taller in the middle; while thinking, a slow wave instead of a level.
      var shape = 1 - Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2) * 0.45;
      var wobble = reduce ? 1 : 0.7 + 0.3 * Math.sin(t * (v.sending ? 3 : 8) + i * 1.3);
      var target = Math.max(0.15, Math.min(1, level * shape * wobble * 1.4));
      heights[i] += (target - heights[i]) * 0.35;
      var bh = Math.max(3, heights[i] * h);
      g.fillStyle = "#141414";
      g.beginPath();
      var x = i * gap + (gap - bw) / 2, y = (h - bh) / 2, r = bw / 2;
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

  // ── The workspace: the conversation and the whiteboard ───────────────
  var board = null, boardKey = null;
  var boardClosed = false; // folded away with the whiteboard's own close button
  var wanted = false;      // opened from the More menu without talking yet
  function boardId() {
    try { return localStorage.getItem("bz_session_id") || "talk"; } catch (_) { return "talk"; }
  }
  function hasConversation() { return !!(thread && thread.querySelector(".bubble.me")); }
  function unmountBoard() {
    if (board) { try { board.destroy(); } catch (_) {} }
    board = null;
    boardKey = null;
  }
  function placeBoard(show) {
    // One board per conversation, saved in this browser (whiteboard.js).
    if (show && board && boardKey !== boardId()) unmountBoard();
    if (show && !board && window.BeeZillaWhiteboard && boardSlot) {
      boardKey = boardId();
      board = window.BeeZillaWhiteboard.mount(boardSlot, {
        boardId: boardKey,
        onClose: function () {
          boardClosed = true;
          wanted = false;
          unmountBoard();
          sync();
        },
      });
    } else if (!show && board) {
      unmountBoard();
    }
    ws.classList.toggle("ws-no-board", !board);
    if (toggle) toggle.setAttribute("aria-pressed", board ? "true" : "false");
  }
  var wasOpen = false;
  function sync() {
    var open = voiceOn() || hasConversation() || wanted;
    if (open && !wasOpen && voiceOn()) boardClosed = false; // Talk opens the whiteboard area
    ws.classList.toggle("hidden", !open);
    document.documentElement.classList.toggle("bz-ws-open", open);
    placeBoard(open && !boardClosed);
    wasOpen = open;
    paintWords();
    if (voiceOn() && !raf) raf = requestAnimationFrame(draw);
  }
  if (toggle) {
    toggle.addEventListener("click", function () {
      if (board) { boardClosed = true; wanted = false; }
      else { boardClosed = false; wanted = true; }
      sync();
    });
  }

  // paintVoice() rewrites the button's label and pressed state on every change in
  // the engine (listening, thinking, talking, off); renderChatMessages() rewrites
  // the thread. Follow both instead of polling.
  new MutationObserver(sync).observe(micBtn, { attributes: true, childList: true, subtree: true, characterData: true });
  if (thread) new MutationObserver(sync).observe(thread, { childList: true });
  window.addEventListener("storage", function (e) { if (e.key === "bz_session_id") sync(); });
  sync();

  // ── More: one button for everything that isn't talking ───────────────
  var moreBtn = document.getElementById("talkMoreBtn");
  var morePanel = document.getElementById("talkMorePanel");
  if (moreBtn && morePanel) {
    var setMore = function (open) {
      morePanel.classList.toggle("hidden", !open);
      moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
    };
    moreBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      setMore(morePanel.classList.contains("hidden"));
    });
    document.addEventListener("click", function (e) {
      if (morePanel.classList.contains("hidden")) return;
      if (morePanel.contains(e.target) || moreBtn.contains(e.target)) return;
      setMore(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || morePanel.classList.contains("hidden")) return;
      setMore(false);
      moreBtn.focus();
    });
    // A plain item does its job and the menu folds away; Chat/Work and privacy stay
    // open so the choice you just made is still in front of you.
    morePanel.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button") : null;
      if (!b || b.closest(".mode-tabs") || b.closest(".talk-privacy")) return;
      setTimeout(function () { setMore(false); }, 0);
    });
  }
})();
