/**
 * The voice workspace (owner's reference zMWSgG0, top): while voice is on, a big
 * yellow mic with the live level drawn under it, the words as they are heard, and
 * the whiteboard beside it. Pressing the mic again ends voice (same as End voice).
 *
 * talk.html owns the voice engine; it lends this file three things:
 *   window.bzVoice           — the engine's state object (read-only use here)
 *   window.bzVoiceOut(level) — called with the reply's playback level, 0..1
 *   window.bzVoiceWords(text, final) — called with what the recogniser heard
 * The mic level comes from our own AnalyserNode on voice.micStream, so nothing
 * in the engine's capture path changes.
 */
(function () {
  "use strict";

  var stage = document.getElementById("voiceStage");
  var wave = document.getElementById("vsWave");
  var words = document.getElementById("vsText");
  var mic = document.getElementById("vsMic");
  if (!stage || !wave) return;

  if (mic) {
    mic.addEventListener("click", function () {
      var end = document.getElementById("voiceStageEnd");
      if (end) end.click();
    });
  }

  // ── Words: interim text from the recogniser, cleared when a turn starts ──
  var wordsTimer = 0;
  window.bzVoiceWords = function (text, isFinal) {
    if (!words) return;
    words.textContent = String(text || "");
    words.classList.toggle("vs-text-final", !!isFinal);
    clearTimeout(wordsTimer);
    if (isFinal) wordsTimer = setTimeout(function () { words.textContent = ""; }, 6000);
  };

  // ── Levels ───────────────────────────────────────────────────────────
  var outLevel = 0;
  window.bzVoiceOut = function (level) { outLevel = Math.max(0, Math.min(1, Number(level) || 0)); };

  var meter = { stream: null, ctx: null, src: null, an: null, buf: null };
  function micLevel() {
    var v = window.bzVoice;
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

  // ── Draw: mirrored bars, the reference's yellow ─────────────────────────
  var BARS = 13;
  var heights = new Array(BARS).fill(0.08);
  var raf = 0;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function draw() {
    raf = 0;
    if (stage.classList.contains("hidden")) { dropMeter(); return; }
    var v = window.bzVoice || {};
    var level = v.speaking ? outLevel : micLevel();
    var dpr = window.devicePixelRatio || 1;
    var w = wave.clientWidth || 150, h = wave.clientHeight || 46;
    if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(h * dpr); }
    var g = wave.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    var t = performance.now() / 1000;
    var gap = w / BARS;
    var bw = Math.max(2, gap * 0.42);
    for (var i = 0; i < BARS; i++) {
      // Taller in the middle, each bar with its own wobble; quiet = a low line.
      var shape = 1 - Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2) * 0.55;
      var wobble = reduce ? 1 : 0.65 + 0.35 * Math.sin(t * 7 + i * 1.7);
      var target = Math.max(0.08, Math.min(1, level * shape * wobble * 1.25));
      heights[i] += (target - heights[i]) * 0.35;
      var bh = Math.max(3, heights[i] * h);
      var x = i * gap + (gap - bw) / 2;
      g.fillStyle = "#FFC107";
      g.globalAlpha = 0.55 + 0.45 * heights[i];
      roundBar(g, x, (h - bh) / 2, bw, bh, bw / 2);
    }
    g.globalAlpha = 1;
    stage.classList.toggle("vs-hot", level > 0.12);
    raf = requestAnimationFrame(draw);
  }
  function roundBar(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
    g.fill();
  }

  // ── The whiteboard: beside the voice workspace while voice is on; under the
  // Talk bar when opened from its "Whiteboard" button. One board at a time,
  // per conversation (the shared bz_session_id), saved in this browser.
  var boardSlot = document.getElementById("vsBoard");
  var soloSlot = document.getElementById("boardSolo");
  var toggle = document.getElementById("boardToggle");
  var board = null, boardWhere = null, soloWanted = false, closedForVoice = false;
  function boardId() {
    try { return localStorage.getItem("bz_session_id") || "talk"; } catch (_) { return "talk"; }
  }
  function unmountBoard() {
    if (board) { try { board.destroy(); } catch (_) {} }
    board = null; boardWhere = null;
    stage.classList.add("vs-no-board");
  }
  function placeBoard() {
    if (!window.BeeZillaWhiteboard || !boardSlot) return;
    var voiceOn = !stage.classList.contains("hidden");
    if (!voiceOn) closedForVoice = false;
    var where = voiceOn && !closedForVoice ? "voice" : soloWanted ? "solo" : null;
    if (where === boardWhere) return;
    unmountBoard();
    if (!where) return;
    var slot = where === "voice" ? boardSlot : soloSlot;
    if (!slot) return;
    board = window.BeeZillaWhiteboard.mount(slot, {
      boardId: boardId(),
      onClose: function () {
        if (boardWhere === "voice") closedForVoice = true;
        else { soloWanted = false; if (toggle) toggle.setAttribute("aria-pressed", "false"); }
        unmountBoard();
        placeBoard();
      },
    });
    boardWhere = where;
    if (where === "voice") stage.classList.remove("vs-no-board");
  }
  if (toggle) {
    toggle.addEventListener("click", function () {
      soloWanted = !soloWanted;
      toggle.setAttribute("aria-pressed", soloWanted ? "true" : "false");
      placeBoard();
    });
  }

  // Run only while the stage is on screen; start whenever it opens.
  new MutationObserver(function () {
    if (!stage.classList.contains("hidden") && !raf) raf = requestAnimationFrame(draw);
    if (stage.classList.contains("hidden") && words) words.textContent = "";
    placeBoard();
  }).observe(stage, { attributes: true, attributeFilter: ["class"] });
  if (!stage.classList.contains("hidden")) raf = requestAnimationFrame(draw);
  placeBoard();
})();
