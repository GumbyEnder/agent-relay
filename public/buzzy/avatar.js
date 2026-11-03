/**
 * BeeZilla avatar — a live face, not a swapped PNG.
 *
 * The brand art is a robot head with a black display face: two white square
 * eyes and no mouth. That is the perfect canvas for animation — we draw the
 * shell image, then paint an animated display over the screen area:
 *
 *   idle       slow blink, soft breathing bob, tiny eye drift
 *   listening  eyes widen, ring pulses with the microphone level
 *   thinking   eyes look up-right, mouth becomes a small scanning dot
 *   speaking   mouth opens with the REAL audio level, eyes squint on loud bits
 *   draft      eyes up, mouth closed, one confident nod
 *
 * Mouth/eye geometry is measured from revision6_expressions_17-attentive.png
 * (229×225): face screen ≈ x 74–170, y 104–186; eyes ≈ (84–103) and
 * (139–158) at y 128–148.
 *
 * Usage:
 *   var av = BeeZillaAvatar.mount(canvasEl, { size: 200 });
 *   av.setState("speaking"); av.setLevel(0.4);   // level 0..1, audio RMS
 *   av.setLevel(0);                              // silence
 */
(function () {
  "use strict";

  var SHELL_SRC = "/buzzy/brand/revision6_expressions_17-attentive.png";
  var IMG_W = 229;
  var IMG_H = 225;
  var FACE = { x: 74, y: 104, w: 96, h: 82, r: 22 };
  var EYE_L = { x: 84, y: 128, w: 20, h: 21 };
  var EYE_R = { x: 139, y: 128, w: 20, h: 21 };
  var MOUTH = { cx: 121, cy: 166, w: 34 };

  var shell = null;
  var shellState = "idle";
  var shellCallbacks = [];
  function loadShell(cb) {
    if (shell) return cb(shell);
    if (shellState === "loading") return shellCallbacks.push(cb);
    shellState = "loading";
    var img = new Image();
    img.onload = function () {
      shell = img;
      shellState = "ready";
      shellCallbacks.forEach(function (f) { f(img); });
      shellCallbacks = [];
    };
    img.onerror = function () {
      shellState = "error";
      shellCallbacks = [];
    };
    img.src = SHELL_SRC;
    shellCallbacks.push(cb);
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function Avatar(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.size = opts.size || canvas.clientWidth || 64;
    this.state = "idle";
    this.level = 0;         // smoothed audio level 0..1
    this.target = 0;        // raw level from the analyser
    this.blink = 0;         // 0 = open, 1 = shut
    this.nextBlink = 1.5 + Math.random() * 3;
    this.t = 0;
    this.nod = 0;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.resize();
    this.running = false;
    this.start();
  }

  Avatar.prototype.resize = function () {
    var s = this.size;
    this.canvas.width = Math.round(s * this.dpr);
    this.canvas.height = Math.round((s * IMG_H / IMG_W) * this.dpr);
    this.canvas.style.width = s + "px";
    this.canvas.style.height = Math.round(s * IMG_H / IMG_W) + "px";
  };

  Avatar.prototype.setState = function (state) {
    if (state === this.state) return;
    if (state === "draft") this.nod = 1;
    this.state = state;
    if (state === "listening") this.target = Math.max(this.target, 0.12);
  };

  Avatar.prototype.setLevel = function (v) {
    this.target = clamp(Number(v) || 0, 0, 1);
  };

  /**
   * Viseme input from the real audio spectrum. A single loudness number can
   * only make the mouth taller — every syllable looks the same. These three
   * numbers come from the spectrum and give the mouth a SHAPE:
   *   open   0..1  low-band energy  → jaw drop (ah/oh)
   *   wide   0..1  high-band ratio  → lip spread (ee/ih) vs rounded (oo)
   *   bright 0..1  spectral tilt    → eye squint / brow lift on hard consonants
   */
  Avatar.prototype.setViseme = function (v) {
    this.visOpen = clamp(Number(v && v.open) || 0, 0, 1);
    this.visWide = clamp(Number(v && v.wide) || 0, 0, 1);
    this.visBright = clamp(Number(v && v.bright) || 0, 0, 1);
  };

  Avatar.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    var self = this;
    var last = performance.now();
    function frame(now) {
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      self.t += dt;
      self.tick(dt);
      self.draw();
      if (self.running) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  };

  Avatar.prototype.stop = function () { this.running = false; };

  Avatar.prototype.tick = function (dt) {
    // Blink: scheduled, fast down, slower up.
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) {
      this.blink = 1;
      this.nextBlink = 2.2 + Math.random() * 4.2;
    }
    this.blink = Math.max(0, this.blink - dt * (this.blink > 0.6 ? 7 : 4));

    // Audio level: fast attack, slow release — reads like a mouth, not a bar.
    var k = this.target > this.level ? 0.5 : 0.12;
    this.level = lerp(this.level, this.target, k);
    // Visemes: fast in, slower out, so a consonant still reads on 16ms frames.
    this.smoothOpen = lerp(this.smoothOpen || 0, this.visOpen || 0, (this.visOpen || 0) > (this.smoothOpen || 0) ? 0.55 : 0.18);
    this.smoothWide = lerp(this.smoothWide == null ? 0.5 : this.smoothWide, this.visWide == null ? 0.5 : this.visWide, 0.2);
    this.smoothBright = lerp(this.smoothBright || 0, this.visBright || 0, 0.25);
    if (this.state !== "speaking" && this.state !== "listening") {
      this.level = lerp(this.level, 0, 0.15);
    }
    if (this.nod > 0) this.nod = Math.max(0, this.nod - dt * 0.9);
  };

  Avatar.prototype.draw = function () {
    var self = this;
    loadShell(function (img) { self.paint(img); });
  };

  Avatar.prototype.paint = function (img) {
    var ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    var S = this.size;
    var scale = S / IMG_W;
    var H = S * IMG_H / IMG_W;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, S, H);

    // Breathing + nod — the head is alive even when silent.
    var breathe = Math.sin(this.t * 1.35) * 1.1 * scale;
    var nod = Math.sin(this.nod * Math.PI) * 3.2 * scale;
    var tilt = this.state === "thinking" ? Math.sin(this.t * 0.9) * 0.02 : 0;

    // Halo: only while the avatar has a voice.
    var glow = this.state === "speaking" ? 0.35 + this.level * 0.65
      : this.state === "listening" ? 0.18 + Math.sin(this.t * 2.4) * 0.08
      : 0;
    if (glow > 0.02) {
      var cx = S / 2, cy = H / 2;
      var g = ctx.createRadialGradient(cx, cy, S * 0.18, cx, cy, S * 0.62);
      g.addColorStop(0, "rgba(255,193,7," + (0.30 * glow).toFixed(3) + ")");
      g.addColorStop(0.55, "rgba(255,193,7," + (0.10 * glow).toFixed(3) + ")");
      g.addColorStop(1, "rgba(255,193,7,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, S * 0.62, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.translate(S / 2, H / 2 + breathe + nod);
    ctx.rotate(tilt);
    ctx.translate(-S / 2, -H / 2);
    ctx.drawImage(img, 0, 0, S, H);

    // ── Display face ────────────────────────────────────────────────
    var fx = FACE.x * scale, fy = FACE.y * scale, fw = FACE.w * scale, fh = FACE.h * scale;
    ctx.save();
    roundRect(ctx, fx, fy, fw, fh, FACE.r * scale);
    ctx.clip();
    // Match the display glass, and hide the static printed eyes beneath.
    var glass = ctx.createLinearGradient(fx, fy, fx, fy + fh);
    glass.addColorStop(0, "#08080c");
    glass.addColorStop(1, "#101018");
    ctx.fillStyle = glass;
    ctx.fillRect(fx, fy, fw, fh);

    var speaking = this.state === "speaking";
    var listening = this.state === "listening";
    var thinking = this.state === "thinking";
    var lvl = this.level;

    // Eye shape: widen when listening, squint a little on loud syllables.
    var openY = listening ? 1.06 : speaking ? 1 - lvl * 0.18 : 1;
    var openX = listening ? 1.04 : 1;
    var eyeShiftY = thinking ? -1.6 * scale : 0;
    var eyeShiftX = thinking ? 1.4 * scale : 0;
    var blinkScale = 1 - this.blink * 0.92;

    var eyeGlow = listening ? "#fffdf2" : "#ffffff";
    ctx.fillStyle = eyeGlow;
    ctx.shadowColor = "rgba(255,246,214," + (speaking || listening ? 0.9 : 0.45) + ")";
    ctx.shadowBlur = (speaking ? 10 : 6) * scale;
    [EYE_L, EYE_R].forEach(function (e) {
      var w = e.w * scale * openX;
      var h = e.h * scale * openY * blinkScale;
      var cx = (e.x + e.w / 2) * scale + eyeShiftX;
      var cy = (e.y + e.h / 2) * scale + eyeShiftY;
      roundRect(ctx, cx - w / 2, cy - h / 2, w, Math.max(1.2 * scale, h), 3.5 * scale);
      ctx.fill();
    });
    ctx.shadowBlur = 0;

    // Mouth: shape follows the spectrum, not just loudness. Wide when the sound
    // is bright (ee/ih), rounded when it is dark (oo/oh), taller on low energy.
    var mouthCx = MOUTH.cx * scale;
    var mouthCy = MOUTH.cy * scale;
    var wideAmt = this.smoothWide == null ? 0.5 : this.smoothWide;
    var openAmt = speaking ? Math.max(lvl, this.smoothOpen || 0) : 0;
    var shapeW = (0.72 + wideAmt * 0.62) * (1 - openAmt * 0.16);
    var mouthW = MOUTH.w * scale * shapeW * (thinking ? 0.35 : 1);
    var mouthH;
    if (thinking) {
      mouthH = 2.2 * scale + Math.abs(Math.sin(this.t * 3.2)) * 2.6 * scale;
    } else if (speaking) {
      mouthH = (1.4 + openAmt * 24) * scale;
    } else {
      mouthH = 2.6 * scale;
    }
    ctx.fillStyle = speaking ? "#ffe9a8" : "#f7f2e2";
    ctx.shadowColor = "rgba(255,214,102," + (speaking ? 0.85 : 0.35) + ")";
    ctx.shadowBlur = (speaking ? 12 : 4) * scale;
    roundRect(ctx, mouthCx - mouthW / 2, mouthCy - mouthH / 2, mouthW, mouthH, Math.min(mouthH / 2, (5 + wideAmt * 5) * scale));
    ctx.fill();
    ctx.shadowBlur = 0;

    // Listening: a thin waveform under the eyes, driven by mic level.
    if (listening) {
      var bars = 7;
      var bw = 2.4 * scale;
      var gap = 4.6 * scale;
      var totalW = bars * gap;
      for (var i = 0; i < bars; i++) {
        var phase = this.t * 6 + i * 0.7;
        var amp = (0.25 + 0.75 * Math.abs(Math.sin(phase))) * (0.35 + lvl * 2.4);
        var bh = clamp(amp * 9 * scale, 1.2 * scale, 14 * scale);
        ctx.fillStyle = "rgba(255,193,7,0.85)";
        roundRect(ctx, mouthCx - totalW / 2 + i * gap, fy + fh - 12 * scale - bh / 2, bw, bh, bw / 2);
        ctx.fill();
      }
    }
    ctx.restore(); // clip
    ctx.restore(); // transform
  };

  var BeeZillaAvatar = {
    mount: function (canvas, opts) {
      if (!canvas) return null;
      if (canvas.__bzAvatar) return canvas.__bzAvatar;
      var av = new Avatar(canvas, opts);
      canvas.__bzAvatar = av;
      return av;
    },
    version: "1.0.0",
  };

  window.BeeZillaAvatar = BeeZillaAvatar;
})();
