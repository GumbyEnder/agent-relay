/* Company tabs shared by Jobs, Chat, Library, and Memory.
   The active company is kept in localStorage so a switch moves the whole workspace. */
(function () {
  var KEY = "bz_active_company";
  var state = { companies: [], activeId: null, ready: false, started: false, signedOut: false };
  var listeners = [];
  var mounts = [];
  var adding = false;
  var err = "";

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
      ".bz-co-form{max-width:1120px;margin:0 auto;padding:0 1.5rem 0.75rem;display:flex;flex-wrap:wrap;gap:0.45rem;align-items:center}" +
      ".bz-co-form input{font:inherit;padding:0.45rem 0.6rem;border-radius:6px;border:1px solid #333;background:#0A0A0A;color:#fff;min-width:16rem}" +
      ".bz-co-form button{font:inherit;font-size:0.85rem;padding:0.42rem 0.75rem;border-radius:6px;border:1px solid #FFC107;background:#FFC107;color:#0A0A0A;font-weight:800;cursor:pointer}" +
      ".bz-co-form button.bz-co-cancel{background:transparent;color:#FFC107}" +
      ".bz-co-err{color:#C45B5B;font-size:0.8rem}";
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

  function renderInto(el) {
    var html = '<div class="bz-co-bar" role="tablist" aria-label="Companies">';
    if (!state.companies.length) html += '<span class="bz-co-empty">No company yet</span>';
    state.companies.forEach(function (c) {
      var on = c.id === state.activeId;
      html += '<button type="button" class="bz-co-tab' + (on ? " is-on" : "") + '" role="tab" aria-selected="' +
        (on ? "true" : "false") + '" data-co="' + esc(c.id) + '"' +
        (on ? ' title="Current company"' : "") + ">" + esc(c.name) + "</button>";
    });
    html += '<button type="button" class="bz-co-add">Add company</button></div>';
    if (adding) {
      html += '<form class="bz-co-form">' +
        '<label>Company name <input name="name" maxlength="80" required placeholder="The name you use for this business"></label>' +
        '<button type="submit">Add company</button>' +
        '<button type="button" class="bz-co-cancel">Cancel</button>' +
        (err ? '<span class="bz-co-err">' + esc(err) + "</span>" : "") +
        "</form>";
    }
    el.innerHTML = html;
    el.querySelectorAll(".bz-co-tab").forEach(function (btn) {
      btn.addEventListener("click", function () { select(btn.getAttribute("data-co")); });
    });
    var add = el.querySelector(".bz-co-add");
    if (add) add.addEventListener("click", function () { adding = true; err = ""; renderAll(); });
    var form = el.querySelector(".bz-co-form");
    if (form) {
      var input = form.querySelector("input");
      if (input) input.focus();
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var name = input ? input.value.trim() : "";
        if (!name) { err = "Type the company name."; renderAll(); return; }
        create(name);
      });
      form.querySelector(".bz-co-cancel").addEventListener("click", function () {
        adding = false;
        err = "";
        renderAll();
      });
    }
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

  function create(name) {
    err = "";
    renderAll();
    fetch("/api/buzzy/companies", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name: name }),
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; })
        .catch(function () { return { ok: false, status: r.status, data: {} }; });
    }).then(function (res) {
      if (res.status === 401) { err = "Sign in to add a company."; renderAll(); return; }
      var company = res.data && res.data.company;
      if (!res.ok || !company) { err = (res.data && res.data.error) || "Couldn't add that company."; renderAll(); return; }
      state.companies.push(company);
      state.activeId = company.id;
      try { localStorage.setItem(KEY, company.id); } catch (e) { /* private mode */ }
      adding = false;
      err = "";
      renderAll();
      emit();
    }).catch(function () {
      err = "Couldn't add that company. Try again.";
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
