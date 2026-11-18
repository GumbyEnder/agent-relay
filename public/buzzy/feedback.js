/*
 * Send feedback (owner, 2026-11-17: "Collect confusion points, bug reports,
 * screenshots, and real task results"). Opened from the menu under your name
 * (nav.js loads this file on first use). What you tried and what happened, plus
 * an optional screenshot, go to POST /api/buzzy/feedback; admins read them on
 * /buzzy/testers. The panel can be minimised (your words are kept) or closed.
 * Plain IIFE, no dependencies.
 */
(function () {
  "use strict";
  if (window.BeeZillaFeedback) return;

  var MAX_PICTURE = 1000000; // bytes of picture, before encoding
  var STYLE =
    ".bz-fb{position:fixed;right:16px;bottom:16px;z-index:2147483100;width:min(440px,calc(100vw - 32px));background:#1a1a1a;color:#f2f2f2;" +
    "border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 14px 34px rgba(0,0,0,.5);font:15px/1.45 var(--bz-font,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif)}" +
    ".bz-fb-head{display:flex;align-items:center;gap:6px;padding:10px 10px 4px 16px}.bz-fb-title{flex:1;font-weight:650}" +
    ".bz-fb-head button{border:0;background:transparent;color:inherit;font-size:16px;width:30px;height:30px;border-radius:8px;cursor:pointer}" +
    ".bz-fb-head button:hover,.bz-fb-head button:focus-visible{background:rgba(255,255,255,.1)}" +
    ".bz-fb-body{padding:4px 16px 14px}.bz-fb-body p{margin:0 0 8px;color:#bdbdbd;font-size:13.5px}" +
    ".bz-fb textarea{width:100%;min-height:120px;resize:vertical;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid #333;background:#0f0f0f;color:#f2f2f2;font:inherit}" +
    ".bz-fb textarea:focus{outline:2px solid #ffc107;outline-offset:1px}" +
    ".bz-fb-pic{display:flex;align-items:center;gap:10px;margin:10px 0 0;font-size:13.5px}" +
    ".bz-fb-pic label{cursor:pointer;color:#ffc107;text-decoration:underline}.bz-fb-pic input{position:absolute;width:1px;height:1px;opacity:0}" +
    ".bz-fb-pic img{max-height:54px;max-width:96px;border-radius:6px;border:1px solid #333}" +
    ".bz-fb-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px}" +
    ".bz-fb-note{font-size:13px;color:#bdbdbd}.bz-fb-note.err{color:#e07a7a}" +
    ".bz-fb-foot button{border-radius:999px;padding:6px 16px;font:inherit;cursor:pointer;border:1px solid #444;background:transparent;color:inherit}" +
    ".bz-fb-foot .bz-fb-send{background:var(--bz-yellow,#ffc107);border-color:var(--bz-yellow,#ffc107);color:#0a0a0a;font-weight:650}" +
    ".bz-fb-foot .bz-fb-send:disabled{opacity:.5;cursor:default}" +
    ".bz-fb.min .bz-fb-body{display:none}";

  var box = null, text = null, note = null, sendBtn = null, picPreview = null, picture = "";

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  function build() {
    if (!document.getElementById("bz-fb-style")) {
      var st = el("style");
      st.id = "bz-fb-style";
      st.textContent = STYLE;
      document.head.appendChild(st);
    }
    box = el("section", "bz-fb");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Send feedback");
    var head = el("div", "bz-fb-head");
    head.appendChild(el("span", "bz-fb-title", "Send feedback"));
    var min = el("button", "bz-fb-min", "–");
    min.type = "button";
    min.setAttribute("aria-label", "Minimise feedback");
    min.title = "Minimise";
    var close = el("button", "bz-fb-close", "✕");
    close.type = "button";
    close.setAttribute("aria-label", "Close feedback");
    close.title = "Close";
    head.appendChild(min);
    head.appendChild(close);

    var body = el("div", "bz-fb-body");
    body.appendChild(el("p", null, "What did you try, and what happened? Anything confusing counts. The BeeZilla team reads every one."));
    text = el("textarea");
    text.setAttribute("aria-label", "What did you try, and what happened?");
    text.maxLength = 4000;
    body.appendChild(text);

    var pic = el("div", "bz-fb-pic");
    var picId = "bzFbPic" + Date.now();
    var picLabel = el("label", null, "Add a screenshot");
    picLabel.setAttribute("for", picId);
    var picInput = el("input");
    picInput.type = "file";
    picInput.id = picId;
    picInput.accept = "image/png,image/jpeg,image/webp";
    picPreview = el("img");
    picPreview.alt = "Your screenshot";
    picPreview.hidden = true;
    pic.appendChild(picLabel);
    pic.appendChild(picInput);
    pic.appendChild(picPreview);
    body.appendChild(pic);

    var foot = el("div", "bz-fb-foot");
    note = el("span", "bz-fb-note");
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");
    var buttons = el("span");
    var cancel = el("button", "bz-fb-cancel", "Cancel");
    cancel.type = "button";
    sendBtn = el("button", "bz-fb-send", "Send");
    sendBtn.type = "button";
    buttons.appendChild(cancel);
    buttons.appendChild(document.createTextNode(" "));
    buttons.appendChild(sendBtn);
    foot.appendChild(note);
    foot.appendChild(buttons);
    body.appendChild(foot);

    box.appendChild(head);
    box.appendChild(body);
    document.body.appendChild(box);

    min.addEventListener("click", function () {
      var on = !box.classList.contains("min");
      box.classList.toggle("min", on);
      min.textContent = on ? "+" : "–";
      min.setAttribute("aria-label", on ? "Open feedback again" : "Minimise feedback");
      min.title = on ? "Open again" : "Minimise";
    });
    close.addEventListener("click", hide);
    cancel.addEventListener("click", hide);
    box.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });
    picInput.addEventListener("change", function () {
      var f = picInput.files && picInput.files[0];
      picture = "";
      picPreview.hidden = true;
      say("");
      if (!f) return;
      if (f.size > MAX_PICTURE) { say("That picture is too big. Pick one under 1 MB.", true); picInput.value = ""; return; }
      var r = new FileReader();
      r.onload = function () { picture = String(r.result || ""); picPreview.src = picture; picPreview.hidden = false; };
      r.readAsDataURL(f);
    });
    sendBtn.addEventListener("click", send);
  }

  function say(msg, bad) {
    note.textContent = msg || "";
    note.classList.toggle("err", !!bad);
  }

  function hide() {
    if (box) box.remove();
    box = null;
    picture = "";
  }

  function send() {
    var words = String(text.value || "").trim();
    if (!words) { say("Say what you tried and what happened.", true); text.focus(); return; }
    sendBtn.disabled = true;
    say("Sending…");
    fetch("/api/buzzy/feedback", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: words, page: location.pathname, screenshot: picture || null }),
    })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        if (d && d.ok) {
          say("Thank you. The team will read it.");
          setTimeout(hide, 2200);
        } else {
          sendBtn.disabled = false;
          say((d && d.error) || "That didn't send. Try again in a moment.", true);
        }
      })
      .catch(function () {
        sendBtn.disabled = false;
        say("That didn't send. Check your connection and try again.", true);
      });
  }

  window.BeeZillaFeedback = {
    open: function () {
      if (!box) build();
      box.classList.remove("min");
      text.focus();
    },
  };
})();
