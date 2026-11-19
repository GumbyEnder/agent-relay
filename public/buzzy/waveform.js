/**
 * Music you can see. Owner, 2026-11-18: "Music should always have a visual waveform
 * to it so you can see the music."
 *
 *   BeeZillaWave.player(url, { title })  → an element: play/pause, the track's real
 *                                          waveform (click or drag to seek), the time
 *   BeeZillaWave.placeholder(label)      → a moving waveform for a track still being made
 *   BeeZillaWave.peaks(url, n)           → Promise<number[]> of n peaks, 0..1
 *
 * Peaks are decoded once per URL with an OfflineAudioContext (no user gesture needed)
 * and cached for the page. Only one player plays at a time. Plain DOM + canvas.
 */
(function () {
  "use strict";
  if (window.BeeZillaWave) return;

  var CSS =
    ".bzw{display:flex;align-items:center;gap:10px;min-width:0;width:100%}" +
    ".bzw-play{flex:0 0 auto;width:34px;height:34px;border-radius:50%;border:0;background:#ffc107;color:#111;" +
    "display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}" +
    ".bzw-play:focus-visible{outline:2px solid #fff;outline-offset:2px}" +
    ".bzw-play svg{width:14px;height:14px;fill:currentColor}" +
    ".bzw-wave{flex:1 1 auto;min-width:60px;height:40px;cursor:pointer;display:block}" +
    ".bzw-time{flex:0 0 auto;font:600 12px/1 system-ui,-apple-system,'Segoe UI',sans-serif;color:#b9b9b9;" +
    "font-variant-numeric:tabular-nums;min-width:36px;text-align:right}" +
    ".bzw-making{display:flex;align-items:center;gap:10px;width:100%}" +
    ".bzw-making canvas{flex:1 1 auto;height:40px;min-width:60px}" +
    ".bzw-making span{font:600 12px/1.3 system-ui,-apple-system,'Segoe UI',sans-serif;color:#d8c36a}";
  function style() {
    if (document.getElementById("bzw-css")) return;
    var s = document.createElement("style");
    s.id = "bzw-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  var cache = {};
  function peaks(url, n) {
    n = n || 160;
    var key = url + "#" + n;
    if (cache[key]) return cache[key];
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    cache[key] = fetch(url, { credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("audio " + r.status); return r.arrayBuffer(); })
      .then(function (buf) {
        if (!OAC) throw new Error("no audio decoding here");
        var ctx = new OAC(1, 2, 44100);
        return new Promise(function (resolve, reject) {
          var p = ctx.decodeAudioData(buf, resolve, reject);
          if (p && p.then) p.then(resolve, reject);
        });
      })
      .then(function (audio) {
        var data = audio.getChannelData(0);
        var step = Math.max(1, Math.floor(data.length / n));
        var out = [];
        var top = 0;
        for (var i = 0; i < n; i++) {
          var max = 0;
          for (var j = i * step, end = Math.min(data.length, j + step); j < end; j += 4) {
            var v = data[j] < 0 ? -data[j] : data[j];
            if (v > max) max = v;
          }
          out.push(max);
          if (max > top) top = max;
        }
        return out.map(function (v) { return top ? Math.max(0.04, v / top) : 0.04; });
      })
      .catch(function () {
        delete cache[key];
        return null;
      });
    return cache[key];
  }

  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function draw(canvas, pk, progress) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 200, h = canvas.clientHeight || 40;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    var g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    var bars = Math.max(16, Math.floor(w / 3));
    var src = pk && pk.length ? pk : null;
    for (var i = 0; i < bars; i++) {
      var v = src ? src[Math.floor((i / bars) * src.length)] : 0.12;
      var bh = Math.max(2, v * (h - 4));
      g.fillStyle = (i / bars) < progress ? "#ffc107" : "rgba(230,230,230,0.42)";
      g.fillRect(i * (w / bars), (h - bh) / 2, Math.max(1, w / bars - 1), bh);
    }
  }

  var playing = null;
  var PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
  var PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>';

  function player(url, opts) {
    style();
    opts = opts || {};
    var root = document.createElement("div");
    root.className = "bzw";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bzw-play";
    btn.innerHTML = PLAY;
    btn.setAttribute("aria-label", "Play " + (opts.title || "the track"));
    var canvas = document.createElement("canvas");
    canvas.className = "bzw-wave";
    canvas.setAttribute("role", "slider");
    canvas.setAttribute("aria-label", "Position in " + (opts.title || "the track"));
    canvas.setAttribute("aria-valuemin", "0");
    canvas.setAttribute("aria-valuemax", "100");
    canvas.setAttribute("aria-valuenow", "0");
    canvas.tabIndex = 0;
    var time = document.createElement("span");
    time.className = "bzw-time";
    time.textContent = "0:00";
    var audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = url;
    root.appendChild(btn);
    root.appendChild(canvas);
    root.appendChild(time);
    root.appendChild(audio);

    var pk = null;
    function progress() { return audio.duration ? audio.currentTime / audio.duration : 0; }
    function paint() {
      draw(canvas, pk, progress());
      time.textContent = audio.duration && !audio.paused ? fmt(audio.currentTime) : fmt(audio.duration || 0);
      canvas.setAttribute("aria-valuenow", String(Math.round(progress() * 100)));
    }
    // Decode only once the player is on screen: a wall of tracks must not download
    // every song just to be drawn.
    function load() { peaks(url, 200).then(function (p) { pk = p; paint(); }); }
    if (window.IntersectionObserver) {
      var io = new IntersectionObserver(function (entries) {
        if (entries.some(function (en) { return en.isIntersecting; })) { io.disconnect(); load(); }
      }, { rootMargin: "200px" });
      io.observe(canvas);
    } else load();
    var raf = 0;
    function loop() { paint(); raf = audio.paused ? 0 : requestAnimationFrame(loop); }
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (audio.paused) {
        if (playing && playing !== audio) playing.pause();
        playing = audio;
        var p = audio.play();
        if (p && p.catch) p.catch(function () {});
      } else audio.pause();
    });
    audio.addEventListener("play", function () { btn.innerHTML = PAUSE; btn.setAttribute("aria-label", "Pause"); if (!raf) raf = requestAnimationFrame(loop); });
    audio.addEventListener("pause", function () { btn.innerHTML = PLAY; btn.setAttribute("aria-label", "Play " + (opts.title || "the track")); paint(); });
    audio.addEventListener("ended", function () { paint(); });
    audio.addEventListener("loadedmetadata", paint);
    function seekTo(e) {
      var r = canvas.getBoundingClientRect();
      var f = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1)));
      if (audio.duration) audio.currentTime = f * audio.duration;
      paint();
    }
    canvas.addEventListener("pointerdown", function (e) {
      e.stopPropagation();
      e.preventDefault();
      seekTo(e);
      canvas.setPointerCapture(e.pointerId);
      var mv = function (ev) { seekTo(ev); };
      var up = function () { canvas.removeEventListener("pointermove", mv); canvas.removeEventListener("pointerup", up); };
      canvas.addEventListener("pointermove", mv);
      canvas.addEventListener("pointerup", up);
    });
    canvas.addEventListener("keydown", function (e) {
      if (!audio.duration) return;
      if (e.key === "ArrowRight") { audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); paint(); e.preventDefault(); }
      if (e.key === "ArrowLeft") { audio.currentTime = Math.max(0, audio.currentTime - 5); paint(); e.preventDefault(); }
      if (e.key === " " || e.key === "Enter") { btn.click(); e.preventDefault(); }
    });
    if (window.ResizeObserver) new ResizeObserver(paint).observe(canvas);
    requestAnimationFrame(paint);
    root.audio = audio;
    return root;
  }

  function placeholder(label) {
    style();
    var root = document.createElement("div");
    root.className = "bzw-making";
    var canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    var text = document.createElement("span");
    text.textContent = label || "Composing…";
    root.appendChild(canvas);
    root.appendChild(text);
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var t0 = performance.now();
    function frame() {
      if (!root.isConnected && performance.now() - t0 > 2000) return;
      var t = (performance.now() - t0) / 1000;
      var n = 64, pk = [];
      for (var i = 0; i < n; i++) pk.push(reduce ? 0.3 : 0.15 + 0.55 * Math.abs(Math.sin(t * 2.2 + i * 0.45) * Math.cos(t * 0.9 + i * 0.13)));
      draw(canvas, pk, 0);
      if (!reduce) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    root.setLabel = function (s) { text.textContent = s; };
    return root;
  }

  window.BeeZillaWave = { player: player, placeholder: placeholder, peaks: peaks };
})();
