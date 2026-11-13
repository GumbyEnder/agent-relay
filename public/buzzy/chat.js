/**
 * BeeZilla chat — a mountable surface, not a page.
 *
 * The owner's words: "I dont want to be tied to just the 'talk' page for talking
 * to Beezilla." So this file is the conversation, and any page can host it.
 *
 *   <script src="/buzzy/chat.js"></script>
 *   <script>
 *     var chat = BeeZillaChat.mount(document.getElementById("slot"), {
 *       title: "Ask about this project",
 *       jobId: "job_123",            // optional: the turn is recorded against it
 *       placeholder: "What changed?",
 *     });
 *   </script>
 *
 * It rides the SAME contract as talk.html — POST /api/buzzy/chat with stream:true,
 * SSE frames event: stage | tool | text | done | error — and it persists the same
 * session id (bz_session_id) so a turn started here continues on Talk and back.
 * Duplicating the reader instead of refactoring talk.html is deliberate: Talk's
 * voice lane is large and working, and a rewrite to share it would risk the mic.
 */
(function () {
  "use strict";

  var CHAT = "/api/buzzy/chat";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function styled(root) {
    if (document.getElementById("bz-chat-css")) return;
    var s = document.createElement("style");
    s.id = "bz-chat-css";
    s.textContent = [
      ".bzc{display:flex;flex-direction:column;gap:.5rem;background:#151515;border:1px solid #242424;border-radius:14px;padding:.75rem;height:100%;min-height:260px;color:#f2f2f2;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif}",
      ".bzc-head{display:flex;align-items:center;gap:.5rem;font-weight:600;font-size:.9rem}",
      ".bzc-log{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:.45rem;padding-right:.2rem}",
      ".bzc-b{padding:.45rem .65rem;border-radius:10px;max-width:92%;white-space:pre-wrap;word-wrap:break-word}",
      ".bzc-u{background:#1f1f1f;align-self:flex-end}",
      ".bzc-a{background:#101010;border:1px solid #242424;align-self:flex-start}",
      ".bzc-stage{color:#8d8d8d;font-size:.78rem}",
      ".bzc-row{display:flex;gap:.4rem}",
      ".bzc-in{flex:1;background:#101010;border:1px solid #242424;color:#f2f2f2;border-radius:9px;padding:.45rem .6rem;font:inherit}",
      ".bzc-btn{background:#ffd40d;color:#111;border:0;border-radius:9px;padding:.45rem .8rem;font-weight:600;cursor:pointer}",
      ".bzc-btn:disabled{opacity:.5;cursor:default}",
      ".bzc-card{display:flex;gap:.5rem;align-items:center;background:#0c0c0c;border:1px solid #242424;border-radius:10px;padding:.4rem .5rem}",
      ".bzc-card img{max-width:110px;border-radius:6px;display:block}",
      ".bzc-card a{color:#ffd40d;text-decoration:none;font-size:.8rem}",
    ].join("");
    document.head.appendChild(s);
  }

  function authHeaders() {
    try {
      var t = localStorage.getItem("bz_token") || localStorage.getItem("bz_access_token");
      return t ? { Authorization: "Bearer " + t } : {};
    } catch (_) { return {}; }
  }

  function getSession() {
    try { return localStorage.getItem("bz_session_id") || null; } catch (_) { return null; }
  }
  function setSession(id) {
    if (!id) return;
    try { localStorage.setItem("bz_session_id", id); } catch (_) {}
  }

  function mount(host, opts) {
    if (!host) throw new Error("BeeZillaChat.mount needs an element");
    opts = opts || {};
    styled(host);
    host.innerHTML = "";

    var root = el("div", "bzc");
    var head = el("div", "bzc-head", opts.title || "BeeZilla");
    var log = el("div", "bzc-log");
    var stage = el("div", "bzc-stage");
    var row = el("div", "bzc-row");
    var input = el("input", "bzc-in");
    input.type = "text";
    input.placeholder = opts.placeholder || "Ask BeeZilla…";
    var sendBtn = el("button", "bzc-btn", "Send");
    row.appendChild(input);
    row.appendChild(sendBtn);
    root.appendChild(head);
    root.appendChild(log);
    root.appendChild(stage);
    root.appendChild(row);
    host.appendChild(root);

    function bubble(kind, text) {
      var b = el("div", "bzc-b " + kind, text || "");
      log.appendChild(b);
      log.scrollTop = log.scrollHeight;
      return b;
    }

    function card(art) {
      var c = el("div", "bzc-card");
      if (art.kind === "image" && art.url) {
        var img = el("img");
        img.src = art.url;
        img.alt = "";
        c.appendChild(img);
      }
      var a = el("a", null, art.kind === "image" ? "Open image" : (art.name || "Download"));
      a.href = art.url || "#";
      a.target = "_blank";
      a.rel = "noopener";
      c.appendChild(a);
      var size = el("span", null, Math.round((art.bytes || 0) / 1024) + " KB");
      size.style.color = "#8d8d8d";
      size.style.fontSize = ".78rem";
      c.appendChild(size);
      log.appendChild(c);
      log.scrollTop = log.scrollHeight;
    }

    // Asking for a 3D model starts one on the server (same rule as Talk). It takes a
    // minute or two, so the turn returns the task id and this polls until the file is
    // stored — the reply already said it is on its way, and here is where it lands.
    function watchModel(taskId) {
      var line = bubble("bzc-a", "Building the 3D model…");
      var tries = 0;
      var misses = 0;
      var tick = setInterval(function () {
        tries++;
        fetch("/api/buzzy/model3d/" + encodeURIComponent(taskId), {
          credentials: "same-origin",
          headers: authHeaders(),
        }).then(function (r) { return r.json(); }).then(function (p) {
          var status = String(p.status || "");
          if (p.asset) {
            clearInterval(tick);
            line.textContent = "Your 3D model is ready.";
            card({ kind: "model", url: p.asset.url, name: p.asset.name, bytes: p.asset.bytes });
          } else if (p.ok === false || status === "FAILED" || status === "CANCELED" || status === "EXPIRED" || tries > 60) {
            clearInterval(tick);
            line.textContent = "The 3D model did not finish" + (p.error ? ": " + p.error : ".");
          } else if (status === "error") {
            if (++misses >= 4) { clearInterval(tick); line.textContent = "Lost touch with the 3D model."; }
          } else {
            misses = 0;
            line.textContent = "Building the 3D model… " + (p.progress || 0) + "%";
          }
        }).catch(function () {
          if (++misses >= 4) { clearInterval(tick); line.textContent = "Lost touch with the 3D model — check the connection."; }
        });
      }, 4000);
    }

    function send() {
      var text = (input.value || "").trim();
      if (!text) return;
      input.value = "";
      bubble("bzc-u", text);
      sendBtn.disabled = true;
      var live = bubble("bzc-a", "");
      var liveText = "";
      var started = performance.now();
      stage.textContent = "Working…";

      var body = { message: text, stream: true };
      // Same privacy slider as Talk (stored per browser): Lockdown turns off web
      // lookups and outside makers on the server.
      try {
        var pv = localStorage.getItem("bz.privacy");
        if (pv === "advocate" || pv === "lockdown" || pv === "open") body.privacy = pv;
      } catch (_) {}
      if (opts.jobId) body.jobId = opts.jobId;
      var sid = getSession();
      if (sid) body.sessionId = sid;

      fetch(CHAT, {
        method: "POST",
        credentials: "same-origin",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify(body),
      }).then(function (res) {
        var ctype = res.headers.get("content-type") || "";
        if (!res.ok || !res.body || ctype.indexOf("text/event-stream") === -1) {
          return res.json().catch(function () { return { error: "The turn failed." }; }).then(function (j) {
            if (j && j.error) throw new Error(j.error);
            return j;
          });
        }
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = "";
        var finalData = null;
        function frame(f) {
          var ev = "message", data = [];
          f.split("\n").forEach(function (line) {
            if (line.indexOf("event:") === 0) ev = line.slice(6).trim();
            else if (line.indexOf("data:") === 0) data.push(line.slice(5).trim());
          });
          if (!data.length) return;
          var p;
          try { p = JSON.parse(data.join("\n")); } catch (_) { return; }
          if (ev === "text") { liveText += p.t || ""; live.textContent = liveText; log.scrollTop = log.scrollHeight; }
          else if (ev === "stage") { stage.textContent = p.label || p.phase || "Working…"; }
          else if (ev === "tool") { stage.textContent = p.state === "running" ? "Working — " + String(p.name || "a tool").replace(/_/g, " ") + "…" : "Writing the reply…"; }
          else if (ev === "done") {
            finalData = p;
            // Adopt the item this turn produced, or the next turn would start a new
            // one every time (#238). The session id is not the job id any more.
            if (p && p.jobId && !opts.jobId) opts.jobId = p.jobId;
          }
          else if (ev === "error") { throw new Error(p.error || "The turn failed."); }
        }
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) {
              if (!finalData) throw new Error("The turn ended without a reply.");
              return finalData;
            }
            buf += dec.decode(r.value, { stream: true });
            var i;
            while ((i = buf.indexOf("\n\n")) !== -1) { frame(buf.slice(0, i)); buf = buf.slice(i + 2); }
            return pump();
          });
        }
        return pump();
      }).then(function (data) {
        sendBtn.disabled = false;
        stage.textContent = Math.round(performance.now() - started) / 1000 + "s";
        if (data.sessionId) setSession(data.sessionId);
        if (data.reply) live.textContent = data.reply;
        else if (!liveText) live.textContent = "(no reply)";
        (data.artifacts || []).forEach(card);
        if (data.audio && data.audio.url) card({ kind: "audio", url: data.audio.url, name: data.audio.name, bytes: data.audio.bytes });
        if (data.model3d && data.model3d.taskId) watchModel(data.model3d.taskId);
      }).catch(function (e) {
        sendBtn.disabled = false;
        stage.textContent = "";
        live.textContent = "That turn failed: " + e.message;
      });
    }

    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") send(); });

    return {
      root: root,
      say: function (t) { bubble("bzc-a", t); },
      destroy: function () { host.innerHTML = ""; },
    };
  }

  window.BeeZillaChat = { mount: mount, version: "1" };
})();
