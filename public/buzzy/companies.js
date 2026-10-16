/* Company tabs shared by Jobs, Chat, Library, and Memory.
   The active company is kept in localStorage so a switch moves the whole workspace.
   Adding from a website shows a card. A line is a company fact only after Confirm or Change. */
(function () {
  var KEY = "bz_active_company";
  var state = { companies: [], activeId: null, ready: false, started: false, signedOut: false };
  var listeners = [];
  var mounts = [];
  var adding = false;
  var addMode = "website";
  var busy = false;
  var err = "";
  var draftUrl = "";
  var draftName = "";
  var editingId = "";
  var editDraft = "";
  var cardMode = "hidden"; // hidden | view | edit

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function injectStyle() {
    if (document.getElementById("bz-co-style")) return;
    var style = document.createElement("style");
    style.id = "bz-co-style";
    style.textContent =
      "#companyTabs{background:#141414;border-bottom:1px solid #222}" +
      ".bz-co-bar{max-width:1120px;margin:0 auto;padding:0.55rem 1.5rem 0.7rem;display:flex;flex-wrap:wrap;gap:0.45rem;align-items:center}" +
      ".bz-co-empty{color:#9a9a9a;font-size:0.85rem;margin-right:0.25rem}" +
      ".bz-co-tab{font:inherit;font-size:0.85rem;padding:0.38rem 0.8rem;border-radius:999px;border:1px solid #3a3a3a;background:transparent;color:#C9CDD2;cursor:pointer;font-weight:600}" +
      ".bz-co-tab.is-on{background:#FFC107;color:#0A0A0A;border-color:#FFC107;font-weight:800;box-shadow:0 0 0 2px #FFC107}" +
      ".bz-co-add{font:inherit;font-size:0.85rem;padding:0.38rem 0.8rem;border-radius:999px;border:1px dashed #B8860B;background:transparent;color:#FFC107;cursor:pointer;font-weight:700}" +
      ".bz-co-form,.bz-co-wait{max-width:1120px;margin:0 auto;padding:0 1.5rem 0.75rem;display:flex;flex-wrap:wrap;gap:0.45rem;align-items:center}" +
      ".bz-co-form input{font:inherit;padding:0.45rem 0.6rem;border-radius:6px;border:1px solid #333;background:#0A0A0A;color:#fff;min-width:16rem}" +
      ".bz-co-form button,.bz-co-line button,.bz-co-edit button{font:inherit;font-size:0.85rem;padding:0.42rem 0.75rem;border-radius:6px;border:1px solid #FFC107;background:#FFC107;color:#0A0A0A;font-weight:800;cursor:pointer}" +
      ".bz-co-form button.bz-co-cancel,.bz-co-form button.bz-co-byname,.bz-co-line button.bz-co-quiet,.bz-co-edit button.bz-co-quiet{background:transparent;color:#FFC107}" +
      ".bz-co-line button.bz-co-drop{background:transparent;color:#e7b1b1;border-color:#5a3030}" +
      ".bz-co-err{color:#C45B5B;font-size:0.8rem}" +
      ".bz-co-wait{color:#C9CDD2;font-size:0.9rem}" +
      ".bz-co-card{max-width:1120px;margin:0 auto;padding:0 1.5rem 1rem}" +
      ".bz-co-card-inner{background:#0A0A0A;border:1px solid #2A2A2A;border-radius:10px;padding:0.9rem 1rem 0.4rem}" +
      ".bz-co-card h2{font-size:1.05rem;margin:0 0 0.35rem;color:#fff}" +
      ".bz-co-card .bz-co-lead{margin:0 0 0.35rem;color:#C9CDD2;font-size:0.9rem}" +
      ".bz-co-line{border-top:1px solid #222;padding:0.7rem 0}" +
      ".bz-co-k{color:#9a9a9a;font-size:0.72rem;font-weight:700;letter-spacing:0.03em;text-transform:uppercase}" +
      ".bz-co-val{display:block;color:#fff;font-size:0.98rem;margin:0.15rem 0}" +
      ".bz-co-src{color:#9a9a9a;font-size:0.78rem;margin:0.15rem 0 0.45rem}" +
      ".bz-co-src a{color:#FFC107}" +
      ".bz-co-confirmed{color:#8FCB9B;font-size:0.78rem;font-weight:700}" +
      ".bz-co-edit input{font:inherit;padding:0.4rem 0.55rem;border-radius:6px;border:1px solid #333;background:#141414;color:#fff;width:min(36rem,100%);display:block;margin:0.35rem 0}" +
      ".bz-co-tools{margin-left:auto;display:inline-flex;gap:0.4rem;align-items:center}" +
      ".bz-co-view,.bz-co-edit-btn{font:inherit;font-size:0.8rem;padding:0.32rem 0.6rem;border-radius:6px;border:1px solid #3a3a3a;background:transparent;color:#C9CDD2;cursor:pointer;font-weight:600}" +
      ".bz-co-view.is-on,.bz-co-edit-btn.is-on{background:#2A2A2A;color:#FFC107;border-color:#FFC107}";
    document.head.appendChild(style);
  }

  function active() {
    for (var i = 0; i < state.companies.length; i++) {
      if (state.companies[i].id === state.activeId) return state.companies[i];
    }
    return null;
  }

  function emit() {
    var current = active();
    listeners.slice().forEach(function (fn) {
      try { fn(current); } catch (e) { /* a page refresh must not break the tabs */ }
    });
  }

  function replaceCompany(company) {
    if (!company || !company.id) return;
    var found = false;
    state.companies = state.companies.map(function (c) {
      if (c.id !== company.id) return c;
      found = true;
      return company;
    });
    if (!found) state.companies.push(company);
  }

  function pageHref(page) {
    return /^https?:\/\//i.test(page || "") ? page : "";
  }

  function sourceHtml(line) {
    var page = pageHref(line.page);
    var link = page ? '<a href="' + esc(page) + '" target="_blank" rel="noopener">' + esc(page) + "</a>" : esc(line.page || "");
    var lead = line.edited ? "You changed this. Started from the website" : "from the website";
    return lead + (link ? " · " + link : "");
  }

  function cardHtml(company, readOnly) {
    var lines = (company && company.lines) || [];
    if (!lines.length) return "";
    var proposed = lines.some(function (l) { return l.status !== "confirmed"; });
    var html = '<section class="bz-co-card"><div class="bz-co-card-inner">';
    html += proposed && !readOnly
      ? "<h2>Check this company</h2>" +
        '<p class="bz-co-lead">BeeZilla read the public website. Each line is from that page. Confirm it, change it, or drop it. Only a line you confirm is kept.</p>'
      : "<h2>About " + esc(company.name) + "</h2>" +
        '<p class="bz-co-lead">These are the lines you kept. Dropped lines are not company facts.</p>';
    lines.forEach(function (line) {
      var confirmed = line.status === "confirmed";
      html += '<div class="bz-co-line" data-line="' + esc(line.id) + '">';
      html += '<div class="bz-co-k">' + esc(line.label || line.key) + "</div>";
      if (!readOnly && editingId === line.id) {
        html += '<div class="bz-co-edit">' +
          '<input data-edit value="' + esc(editDraft) + '" maxlength="280">' +
          '<button type="button" data-act="save">Save</button>' +
          '<button type="button" class="bz-co-quiet" data-act="cancel-edit">Cancel</button>' +
          "</div>";
      } else {
        html += '<b class="bz-co-val">' + esc(line.value) + "</b>";
        html += '<div class="bz-co-src">' +
          (confirmed ? '<span class="bz-co-confirmed">Confirmed</span> · ' : "") +
          sourceHtml(line) + "</div>";
        if (!readOnly) {
          if (!confirmed) html += '<button type="button" data-act="confirm">Confirm</button>';
          html += '<button type="button" class="bz-co-quiet" data-act="change">Change</button>';
          html += '<button type="button" class="bz-co-drop" data-act="drop">Drop</button>';
        }
      }
      html += "</div>";
    });
    if (err) html += '<p class="bz-co-err">' + esc(err) + "</p>";
    html += "</div></section>";
    return html;
  }

  function renderInto(el) {
    var current = active();
    var html = '<div class="bz-co-bar" role="tablist" aria-label="Companies">';
    if (!state.companies.length) html += '<span class="bz-co-empty">No company yet</span>';
    state.companies.forEach(function (c) {
      var on = c.id === state.activeId;
      html += '<button type="button" class="bz-co-tab' + (on ? " is-on" : "") + '" role="tab" aria-selected="' +
        (on ? "true" : "false") + '" data-co="' + esc(c.id) + '"' +
        (on ? ' title="Current company"' : "") + ">" + esc(c.name) + "</button>";
    });
    html += '<button type="button" class="bz-co-add">Add company</button>';
    if (current && current.lines && current.lines.length) {
      html += '<span class="bz-co-tools">' +
        '<button type="button" class="bz-co-view' + (cardMode === "view" ? " is-on" : "") + '" data-tool="view">View</button>' +
        '<button type="button" class="bz-co-edit-btn' + (cardMode === "edit" ? " is-on" : "") + '" data-tool="edit">Edit</button>' +
        "</span>";
    }
    html += "</div>";
    if (adding && busy) {
      html += '<p class="bz-co-wait">' +
        (addMode === "name" ? "Adding this company…" : "Reading the public website…") +
        "</p>";
    } else if (adding && addMode === "name") {
      html += '<form class="bz-co-form">' +
        '<label>Company name <input name="name" maxlength="80" required placeholder="The name you use for this business" value="' + esc(draftName) + '"></label>' +
        '<button type="submit">Add company</button>' +
        '<button type="button" class="bz-co-cancel">Cancel</button>' +
        '<button type="button" class="bz-co-byname" data-mode="website">Use a website instead</button>' +
        (err ? '<span class="bz-co-err">' + esc(err) + "</span>" : "") +
        "</form>";
    } else if (adding) {
      html += '<form class="bz-co-form">' +
        '<label>Website <input name="url" maxlength="300" required placeholder="yourbusiness.com" value="' + esc(draftUrl) + '"></label>' +
        '<button type="submit">Read the website</button>' +
        '<button type="button" class="bz-co-cancel">Cancel</button>' +
        '<button type="button" class="bz-co-byname" data-mode="name">No website — use a name</button>' +
        (err ? '<span class="bz-co-err">' + esc(err) + "</span>" : "") +
        "</form>";
    }
    if (current && !adding && cardMode !== "hidden") html += cardHtml(current, cardMode === "view");
    el.innerHTML = html;
    el.querySelectorAll(".bz-co-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        editingId = "";
        err = "";
        var id = btn.getAttribute("data-co");
        if (id === state.activeId) { renderAll(); return; }
        select(id);
      });
    });
    el.querySelectorAll("[data-tool]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var t = btn.getAttribute("data-tool");
        cardMode = cardMode === t ? "hidden" : t;
        err = "";
        editingId = "";
        renderAll();
      });
    });
    var add = el.querySelector(".bz-co-add");
    if (add) add.addEventListener("click", function () {
      adding = true;
      addMode = "website";
      err = "";
      editingId = "";
      cardMode = "hidden";
      renderAll();
    });
    var form = el.querySelector(".bz-co-form");
    if (form) {
      var input = form.querySelector("input");
      if (input) input.focus();
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (busy) return;
        if (addMode === "name") {
          draftName = input ? input.value.trim() : "";
          if (!draftName) { err = "Type the company name."; renderAll(); return; }
          create(draftName);
          return;
        }
        draftUrl = input ? input.value.trim() : "";
        if (!draftUrl) { err = "Paste the website, like yourbusiness.com."; renderAll(); return; }
        createFromWebsite(draftUrl);
      });
      form.querySelector(".bz-co-cancel").addEventListener("click", function () {
        adding = false;
        err = "";
        renderAll();
      });
      var modeBtn = form.querySelector("[data-mode]");
      if (modeBtn) modeBtn.addEventListener("click", function () {
        addMode = modeBtn.getAttribute("data-mode") === "name" ? "name" : "website";
        err = "";
        renderAll();
      });
    }
    el.querySelectorAll(".bz-co-line").forEach(function (block) {
      var lineId = block.getAttribute("data-line");
      block.querySelectorAll("[data-act]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var act = btn.getAttribute("data-act");
          if (act === "cancel-edit") { editingId = ""; err = ""; renderAll(); return; }
          if (act === "change") {
            var line = ((current && current.lines) || []).filter(function (l) { return l.id === lineId; })[0];
            editingId = lineId;
            editDraft = line ? line.value : "";
            err = "";
            renderAll();
            return;
          }
          if (act === "save") {
            var field = block.querySelector("[data-edit]");
            editDraft = field ? field.value.trim() : "";
            if (!editDraft) { err = "Type what this line should say."; renderAll(); return; }
            actLine(current.id, lineId, "edit", editDraft);
            return;
          }
          if (act === "confirm") actLine(current.id, lineId, "confirm");
          if (act === "drop") actLine(current.id, lineId, "drop");
        });
      });
    });
  }

  function renderAll() {
    injectStyle();
    mounts.forEach(renderInto);
  }

  function select(id) {
    if (!id || state.activeId === id) return;
    var known = state.companies.some(function (c) { return c.id === id; });
    if (!known) return;
    state.activeId = id;
    cardMode = "hidden";
    try { localStorage.setItem(KEY, id); } catch (e) { /* private mode */ }
    renderAll();
    emit();
  }

  function rememberActive() {
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
    var known = state.companies.some(function (c) { return c.id === saved; });
    state.activeId = known ? saved : (state.companies[0] ? state.companies[0].id : null);
    if (state.activeId) {
      try { localStorage.setItem(KEY, state.activeId); } catch (e) { /* private mode */ }
    }
  }

  function load() {
    return fetch("/api/buzzy/companies", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) {
        state.signedOut = r.status === 401;
        return r.ok ? r.json() : { companies: [] };
      })
      .then(function (d) {
        state.companies = (d && d.companies) || [];
        rememberActive();
        state.ready = true;
        renderAll();
        emit();
      })
      .catch(function () {
        state.ready = true;
        renderAll();
        emit();
      });
  }

  function applyCreated(company) {
    replaceCompany(company);
    state.activeId = company.id;
    try { localStorage.setItem(KEY, company.id); } catch (e) { /* private mode */ }
    adding = false;
    busy = false;
    err = "";
    draftUrl = "";
    draftName = "";
    editingId = "";
    cardMode = company && company.lines && company.lines.length ? "edit" : "hidden";
    renderAll();
    emit();
  }

  function readJson(r) {
    return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; })
      .catch(function () { return { ok: false, status: r.status, data: {} }; });
  }

  function create(name) {
    err = "";
    busy = true;
    renderAll();
    fetch("/api/buzzy/companies", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name: name }),
    }).then(readJson).then(function (res) {
      busy = false;
      if (res.status === 401) { err = "Sign in to add a company."; renderAll(); return; }
      var company = res.data && res.data.company;
      if (!res.ok || !company) { err = (res.data && res.data.error) || "Couldn't add that company."; renderAll(); return; }
      applyCreated(company);
    }).catch(function () {
      busy = false;
      err = "Couldn't add that company. Try again.";
      renderAll();
    });
  }

  function createFromWebsite(url) {
    err = "";
    busy = true;
    renderAll();
    fetch("/api/buzzy/companies/from-website", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url: url }),
    }).then(readJson).then(function (res) {
      busy = false;
      if (res.status === 401) { err = "Sign in to add a company."; adding = true; renderAll(); return; }
      var company = res.data && res.data.company;
      if (!res.ok || !company) {
        err = (res.data && res.data.error) || "BeeZilla couldn't read that website.";
        adding = true;
        renderAll();
        return;
      }
      applyCreated(company);
    }).catch(function () {
      busy = false;
      adding = true;
      err = "BeeZilla couldn't read that website. Try again.";
      renderAll();
    });
  }

  function actLine(companyId, lineId, action, value) {
    if (!companyId || !lineId || busy) return;
    err = "";
    busy = true;
    fetch("/api/buzzy/companies/" + encodeURIComponent(companyId) + "/lines", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ lineId: lineId, action: action, value: value }),
    }).then(readJson).then(function (res) {
      busy = false;
      if (res.status === 401) { err = "Sign in to keep this line."; renderAll(); return; }
      var company = res.data && res.data.company;
      if (!res.ok || !company) { err = (res.data && res.data.error) || "Couldn't update that line."; renderAll(); return; }
      editingId = "";
      replaceCompany(company);
      renderAll();
      emit();
    }).catch(function () {
      busy = false;
      err = "Couldn't update that line. Try again.";
      renderAll();
    });
  }

  var api = {
    ready: function () { return state.ready; },
    list: function () { return state.companies.slice(); },
    active: active,
    activeId: function () { return state.activeId; },
    onChange: function (fn) {
      listeners.push(fn);
      if (state.ready) {
        try { fn(active()); } catch (e) { /* page owns its error */ }
      }
    },
    mount: function (el) {
      if (!el || mounts.indexOf(el) >= 0) return;
      mounts.push(el);
      if (state.ready) renderInto(el);
    },
  };
  window.BZCompanies = api;

  function boot() {
    injectStyle();
    var el = document.getElementById("companyTabs");
    if (el) api.mount(el);
    if (!state.started) { state.started = true; load(); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
