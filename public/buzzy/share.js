/* share.js — the BeeZilla Share window.
 *
 *   BeeZillaShare.open({ docId, title, returnFocus })   opens the dialog for a document
 *   BeeZillaShare.close()                               closes it; does nothing when closed
 *   BeeZillaShare.isOpen()                              true while the window or its pill is up
 *
 * Plain IIFE, no dependencies. Load share.css with it, and qr.js before it (window.BeeZillaQR
 * draws the QR code of a public link). Every request uses the signed-in session
 * (credentials "same-origin"). Text from the server only ever goes in through textContent; the
 * QR code is the one piece of markup, parsed with DOMParser from our own encoder's output.
 *
 * Sharing is always an explicit choice. Neither "Selected team" nor "Public" is preselected,
 * and a public link is created only after its warning is on screen and its button is pressed.
 */
(function () {
  "use strict";

  var FOCUSABLE = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])"
  ].join(", ");

  var ROLE_OPTIONS = [["member", "Member"], ["reviewer", "Reviewer"], ["admin", "Admin"]];
  var ROLE_NAMES = { owner: "Owner", admin: "Admin", member: "Member", reviewer: "Reviewer" };
  var STATUS_NAMES = { invited: "Invited", active: "Active", revoked: "Revoked" };

  var session = null;   // the open window: { token, close, minimise, restore }
  var tokens = 0;

  // ---- DOM helpers: elements and text only ------------------------------------------------

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function say(node, text) {
    node.textContent = text || "";
  }

  function nameOf(map, key) {
    return typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key)
      ? map[key]
      : String(key || "");
  }

  // Visible focusable controls inside a container, in tab order.
  function focusables(container) {
    var found = container.querySelectorAll(FOCUSABLE);
    var out = [];
    for (var i = 0; i < found.length; i++) {
      if (found[i].getClientRects().length > 0) out.push(found[i]);
    }
    return out;
  }

  function absolute(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return location.origin + (path.charAt(0) === "/" ? "" : "/") + path;
  }

  function makeCard(name, value, heading, text) {
    var label = make("label", "sh-card");
    var input = make("input", "sh-radio");
    input.type = "radio";
    input.name = name;
    input.value = value;
    var words = make("span", "sh-card-text");
    words.appendChild(make("span", "sh-card-title", heading));
    var desc = make("span", "sh-card-desc", text);
    words.appendChild(desc);
    label.appendChild(input);
    label.appendChild(words);
    return { label: label, input: input, desc: desc };
  }

  // ---- requests ---------------------------------------------------------------------------

  // One API call. Always resolves to { ok, status, data }; a network failure has status 0.
  function api(method, path, body) {
    var init = { method: method, credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(path, init)
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          if (text) {
            try { data = JSON.parse(text); } catch (e) { data = null; }
          }
          return { ok: res.ok, status: res.status, data: data };
        });
      })
      .catch(function () {
        return { ok: false, status: 0, data: null };
      });
  }

  // A sentence for a failed call, carrying the server's own error text. Its errors look like
  // { error: "text", code: "code" }.
  function failure(prefix, res) {
    if (res.status === 0) return prefix + "BeeZilla could not be reached. Check your connection.";
    var data = res.data || {};
    var text = typeof data.error === "string" && data.error ? data.error : "";
    if (!text) text = "Something went wrong on BeeZilla's side. Try again in a moment.";
    return prefix + text;
  }

  // The QR code of a link as an inline svg. Only our encoder's markup is parsed here.
  function qrNode(text) {
    try {
      var QR = window.BeeZillaQR;
      if (!QR || typeof QR.svg !== "function") throw new Error("qr.js is not loaded");
      // Whole pixels per module, so the modules stay crisp: about 200px including the quiet zone.
      var modules = QR.encode(text).size + 8;   // symbol plus the default 4-module quiet zone
      var px = modules * Math.max(2, Math.floor(200 / modules));
      var markup = QR.svg(text, { label: "QR code for the public link", size: px });
      var doc = new DOMParser().parseFromString(markup, "image/svg+xml");
      if (!doc.documentElement || doc.getElementsByTagName("parsererror").length) throw new Error("bad svg");
      return document.importNode(doc.documentElement, true);
    } catch (e) {
      return make("p", "sh-note", "The QR code could not be drawn. Copy the link instead.");
    }
  }

  function expiryText(value) {
    var when = value ? new Date(value) : null;
    if (when && !isNaN(when.getTime())) {
      return "Turns off on " + when.toLocaleString(undefined, {
        day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit"
      }) + ".";
    }
    // The server has not given a date for this link, but every link has a limit.
    return "Turns off automatically after a time limit.";
  }

  // Copies the field's text. "Link copied." is shown only when the copy really happened.
  function copyField(field, feedback) {
    if (!field.value) return;
    field.focus();
    field.select();
    function byCommand() {
      var copied = false;
      try {
        copied = typeof document.execCommand === "function" && document.execCommand("copy");
      } catch (e) {
        copied = false;
      }
      say(feedback, copied ? "Link copied." : "Couldn't copy — select the link and copy it.");
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(field.value).then(function () {
        say(feedback, "Link copied.");
      }, byCommand);
    } else {
      byCommand();
    }
  }

  // ---- the window -------------------------------------------------------------------------

  function open(options) {
    options = options || {};
    if (session) session.close();

    var docId = options.docId === undefined || options.docId === null ? "" : String(options.docId);
    var title = typeof options.title === "string" && options.title.trim() ? options.title.trim() : "Untitled";
    var returnTo = options.returnFocus || document.activeElement || null;
    var token = ++tokens;
    var uid = "sh-" + token;

    var minimised = false;
    var lastFocus = null;
    var link = null;            // { id, absolute, expiresAt } while a public link is on
    var teamLoading = false;
    var inviting = false;
    var creating = false;
    var turningOff = false;

    function current() {
      return session !== null && session.token === token;
    }

    // Header: title, minimise, close.
    var root = make("div", "sh-root");
    var scrim = make("div", "sh-scrim");
    var dialog = make("div", "sh-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", uid + "-title");
    dialog.tabIndex = -1;

    var head = make("header", "sh-head");
    var heading = make("h2", "sh-title", "Share “" + title + "”");
    heading.id = uid + "-title";
    var actions = make("div", "sh-head-actions");
    var minimiseBtn = make("button", "sh-icon", "–");
    minimiseBtn.type = "button";
    minimiseBtn.title = "Minimise";
    minimiseBtn.setAttribute("aria-label", "Minimise");
    var closeBtn = make("button", "sh-icon", "✕");
    closeBtn.type = "button";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close");
    actions.appendChild(minimiseBtn);
    actions.appendChild(closeBtn);
    head.appendChild(heading);
    head.appendChild(actions);

    // Who can see it: two cards, neither checked.
    var body = make("div", "sh-body");
    var choices = make("fieldset", "sh-choices");
    choices.appendChild(make("legend", "sh-legend", "Who can see this?"));
    choices.appendChild(make("p", "sh-hint", "Nothing is shared until you choose one."));
    var cards = make("div", "sh-cards");
    var group = uid + "-who";
    var teamCard = makeCard(group, "team", "Selected team", "Only people on your team.");
    var publicCard = makeCard(group, "public", "Public", "Anyone with the link can read it.");
    if (!docId) {
      publicCard.input.disabled = true;
      publicCard.label.classList.add("sh-card-disabled");
      say(publicCard.desc, "Make or open a document first.");
    }
    cards.appendChild(teamCard.label);
    cards.appendChild(publicCard.label);
    choices.appendChild(cards);

    // Selected team: the team list, and the invite form for the owner.
    var teamPanel = make("section", "sh-panel sh-panel-team");
    teamPanel.setAttribute("aria-label", "Selected team");
    teamPanel.hidden = true;
    teamPanel.appendChild(make("p", "sh-note",
      "Teammates you invite sign in with their own email and can open your work; nothing becomes public."));
    var teamStatus = make("p", "sh-status");
    teamStatus.setAttribute("role", "status");
    var memberList = make("ul", "sh-members");
    var noMembers = make("p", "sh-empty", "No teammates yet.");
    noMembers.hidden = true;
    var ownerNote = make("p", "sh-note", "Only the owner can invite teammates.");
    ownerNote.hidden = true;

    var inviteForm = make("form", "sh-invite");
    inviteForm.noValidate = true;
    inviteForm.hidden = true;
    var emailField = make("label", "sh-field");
    emailField.appendChild(make("span", "sh-field-label", "Teammate's email"));
    var emailInput = make("input", "sh-input");
    emailInput.type = "email";
    emailInput.name = "email";
    emailInput.autocomplete = "off";
    emailInput.setAttribute("placeholder", "name@example.com");
    emailField.appendChild(emailInput);
    var roleField = make("label", "sh-field");
    roleField.appendChild(make("span", "sh-field-label", "Role"));
    var roleSelect = make("select", "sh-input");
    roleSelect.name = "role";
    for (var r = 0; r < ROLE_OPTIONS.length; r++) {
      var option = make("option", null, ROLE_OPTIONS[r][1]);
      option.value = ROLE_OPTIONS[r][0];
      roleSelect.appendChild(option);
    }
    roleField.appendChild(roleSelect);
    var inviteRow = make("div", "sh-invite-row");
    inviteRow.appendChild(emailField);
    inviteRow.appendChild(roleField);
    var inviteBtn = make("button", "sh-btn sh-btn-primary", "Create invitation");
    inviteBtn.type = "submit";
    var inviteStatus = make("p", "sh-status");
    inviteStatus.setAttribute("role", "status");
    var inviteResult = make("div", "sh-invite-result");
    inviteResult.hidden = true;
    var inviteLink = make("input", "sh-input sh-link-field");
    inviteLink.type = "text";
    inviteLink.readOnly = true;
    inviteLink.setAttribute("aria-label", "Invitation link");
    var inviteCopy = make("button", "sh-btn", "Copy");
    inviteCopy.type = "button";
    var inviteCopyRow = make("div", "sh-copy-row");
    inviteCopyRow.appendChild(inviteLink);
    inviteCopyRow.appendChild(inviteCopy);
    var inviteCopyMsg = make("p", "sh-status");
    inviteCopyMsg.setAttribute("role", "status");
    inviteResult.appendChild(inviteCopyRow);
    inviteResult.appendChild(inviteCopyMsg);
    inviteForm.appendChild(inviteRow);
    inviteForm.appendChild(inviteBtn);
    inviteForm.appendChild(inviteStatus);
    inviteForm.appendChild(inviteResult);

    teamPanel.appendChild(teamStatus);
    teamPanel.appendChild(memberList);
    teamPanel.appendChild(noMembers);
    teamPanel.appendChild(ownerNote);
    teamPanel.appendChild(inviteForm);

    // Public: the warning first, then the link once it exists.
    var publicPanel = make("section", "sh-panel sh-panel-public");
    publicPanel.setAttribute("aria-label", "Public");
    publicPanel.hidden = true;
    publicPanel.appendChild(make("div", "sh-warning",
      "This makes the accepted version of “" + title +
      "” readable by anyone who has the link. You can turn the link off at any time."));
    var createBtn = make("button", "sh-btn sh-btn-primary", "Create public link");
    createBtn.type = "button";
    createBtn.disabled = !docId;
    var pubStatus = make("p", "sh-status");
    pubStatus.setAttribute("role", "status");
    var linkBox = make("div", "sh-link");
    linkBox.hidden = true;
    var linkField = make("input", "sh-input sh-link-field");
    linkField.type = "text";
    linkField.readOnly = true;
    linkField.id = uid + "-link";
    var linkLabel = make("label", "sh-field-label", "Public link");
    linkLabel.htmlFor = linkField.id;
    var copyBtn = make("button", "sh-btn", "Copy");
    copyBtn.type = "button";
    var copyRow = make("div", "sh-copy-row");
    copyRow.appendChild(linkField);
    copyRow.appendChild(copyBtn);
    var copyMsg = make("p", "sh-status");
    copyMsg.setAttribute("role", "status");
    var qr = make("figure", "sh-qr");
    var qrSlot = make("div", "sh-qr-slot");
    qr.appendChild(qrSlot);
    qr.appendChild(make("figcaption", "sh-qr-caption", "QR code for the public link"));
    var expiry = make("p", "sh-expiry");
    var offBtn = make("button", "sh-btn sh-btn-danger", "Turn link off");
    offBtn.type = "button";
    linkBox.appendChild(linkLabel);
    linkBox.appendChild(copyRow);
    linkBox.appendChild(copyMsg);
    linkBox.appendChild(qr);
    linkBox.appendChild(expiry);
    linkBox.appendChild(offBtn);
    publicPanel.appendChild(createBtn);
    publicPanel.appendChild(pubStatus);
    publicPanel.appendChild(linkBox);

    body.appendChild(choices);
    body.appendChild(teamPanel);
    body.appendChild(publicPanel);
    dialog.appendChild(head);
    dialog.appendChild(body);
    root.appendChild(scrim);
    root.appendChild(dialog);

    // The pill that stands in for the window while it is minimised (bottom-left).
    var pill = make("button", "sh-pill", "Share “" + title + "”");
    pill.type = "button";
    pill.title = "Show the share window";
    pill.hidden = true;

    document.body.appendChild(root);
    document.body.appendChild(pill);

    // ---- choosing who can see it ----------------------------------------------------------

    function chooseMode(mode) {
      teamCard.label.classList.toggle("sh-card-on", mode === "team");
      publicCard.label.classList.toggle("sh-card-on", mode === "public");
      teamPanel.hidden = mode !== "team";
      publicPanel.hidden = mode !== "public";
      if (mode === "team") loadTeam();
    }
    teamCard.input.addEventListener("change", function () { chooseMode("team"); });
    publicCard.input.addEventListener("change", function () { chooseMode("public"); });

    // ---- selected team ---------------------------------------------------------------------

    function renderMembers(members) {
      clear(memberList);
      for (var i = 0; i < members.length; i++) {
        var member = members[i] || {};
        var row = make("li", "sh-member");
        row.appendChild(make("span", "sh-member-email", String(member.email || "")));
        row.appendChild(make("span", "sh-member-role", nameOf(ROLE_NAMES, member.role)));
        row.appendChild(make("span", "sh-member-status", nameOf(STATUS_NAMES, member.status)));
        memberList.appendChild(row);
      }
      memberList.hidden = members.length === 0;
      noMembers.hidden = members.length !== 0;
    }

    function loadTeam() {
      if (teamLoading) return;
      teamLoading = true;
      say(teamStatus, "Loading your team…");
      api("GET", "/api/buzzy/team").then(function (res) {
        teamLoading = false;
        if (!current()) return;
        if (!res.ok || !res.data || !Array.isArray(res.data.members)) {
          say(teamStatus, failure("Couldn't load your team: ", res));
          return;
        }
        say(teamStatus, "");
        renderMembers(res.data.members);
        var owner = !!(res.data.acting && res.data.acting.isOwner);
        inviteForm.hidden = !owner;
        ownerNote.hidden = owner;
      });
    }

    inviteForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (inviting) return;
      var email = emailInput.value.trim();
      inviting = true;
      inviteBtn.disabled = true;
      inviteResult.hidden = true;
      say(inviteStatus, "Creating the invitation…");
      api("POST", "/api/buzzy/team/invite", { email: email, role: roleSelect.value }).then(function (res) {
        inviting = false;
        inviteBtn.disabled = false;
        if (!current()) return;
        if (!res.ok || !res.data || !res.data.ok) {
          say(inviteStatus, failure("Couldn't create the invitation: ", res));
          return;
        }
        // No mail is sent on this deployment, so the owner is handed the link to send.
        var member = res.data.member || {};
        var sentTo = String(member.email || email);
        var days = typeof res.data.expiresInDays === "number" ? res.data.expiresInDays : 7;
        var inviteUrl = typeof res.data.inviteUrl === "string" && res.data.inviteUrl ? absolute(res.data.inviteUrl) : "";
        if (inviteUrl) {
          say(inviteStatus, "Invitation created for " + sentTo +
            ". No email was sent, so send them this link yourself. It expires in " + days + " days.");
          inviteLink.value = inviteUrl;
          say(inviteCopyMsg, "");
          inviteResult.hidden = false;
        } else {
          say(inviteStatus, "Invitation created for " + sentTo + ". No email was sent.");
        }
        emailInput.value = "";
        loadTeam();
      });
    });

    inviteCopy.addEventListener("click", function () { copyField(inviteLink, inviteCopyMsg); });

    // ---- public link -----------------------------------------------------------------------

    function shareFailure(res) {
      var code = res.data && typeof res.data.code === "string" ? res.data.code : "";
      if (code === "not_accepted_version") {
        return "Only an accepted version can be shared. Review and accept it first.";
      }
      return failure("Couldn't create the link: ", res);
    }

    function showLink() {
      linkField.value = link.absolute;
      clear(qrSlot);
      qrSlot.appendChild(qrNode(link.absolute));
      say(expiry, expiryText(link.expiresAt));
      say(copyMsg, "");
      createBtn.hidden = true;
      linkBox.hidden = false;
    }

    function hideLink() {
      link = null;
      linkField.value = "";
      clear(qrSlot);
      say(expiry, "");
      say(copyMsg, "");
      linkBox.hidden = true;
      createBtn.hidden = !docId;
    }

    createBtn.addEventListener("click", function () {
      if (!docId || creating || link) return;
      creating = true;
      createBtn.disabled = true;
      say(pubStatus, "Creating the link…");
      api("POST", "/api/buzzy/documents/" + encodeURIComponent(docId) + "/share", {}).then(function (res) {
        creating = false;
        createBtn.disabled = !docId;
        if (!current()) return;
        var share = res.ok && res.data && res.data.ok ? res.data.share : null;
        if (!share || typeof share.url !== "string") {
          say(pubStatus, shareFailure(res));
          return;
        }
        // People who get the link see a reading page, not the raw data behind it.
        var page = typeof share.token === "string" && /^sh_[A-Za-z0-9]+$/.test(share.token) ? "/buzzy/shared#" + share.token : share.url;
        link = { id: String(share.id), absolute: absolute(page), expiresAt: share.expiresAt || null };
        say(pubStatus, "");
        showLink();
      });
    });

    copyBtn.addEventListener("click", function () { copyField(linkField, copyMsg); });

    offBtn.addEventListener("click", function () {
      if (!link || turningOff) return;
      turningOff = true;
      offBtn.disabled = true;
      api("DELETE", "/api/buzzy/shares/" + encodeURIComponent(link.id)).then(function (res) {
        turningOff = false;
        offBtn.disabled = false;
        if (!current()) return;
        if (res.ok && res.data && res.data.ok) {
          hideLink();
          say(pubStatus, "The link is off.");
        } else {
          say(pubStatus, failure("Couldn't turn the link off: ", res));
        }
      });
    });

    // ---- minimise, restore, close ----------------------------------------------------------

    function minimise() {
      if (minimised || !current()) return;
      lastFocus = dialog.contains(document.activeElement) ? document.activeElement : null;
      minimised = true;
      root.hidden = true;
      pill.hidden = false;
      pill.focus();
    }

    function restore() {
      if (!minimised || !current()) return;
      minimised = false;
      pill.hidden = true;
      root.hidden = false;
      var target = lastFocus && document.documentElement.contains(lastFocus)
        ? lastFocus
        : (focusables(dialog)[0] || dialog);
      target.focus();
    }

    function close() {
      if (!current()) return;
      session = null;
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      if (root.parentNode) root.parentNode.removeChild(root);
      if (pill.parentNode) pill.parentNode.removeChild(pill);
      if (returnTo && document.documentElement.contains(returnTo) && typeof returnTo.focus === "function") {
        returnTo.focus();
      }
    }

    // Escape closes; Tab stays inside the dialog while it is open.
    function onKeyDown(event) {
      if (!current()) return;
      if (event.key === "Escape" || event.key === "Esc") {
        if (!minimised || pill.contains(document.activeElement)) {
          event.preventDefault();
          close();
        }
        return;
      }
      if (event.key === "Tab" && !minimised) {
        var items = focusables(dialog);
        if (items.length === 0) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        var first = items[0];
        var last = items[items.length - 1];
        var active = document.activeElement;
        var inside = dialog.contains(active);
        if (event.shiftKey) {
          if (!inside || active === first || active === dialog) {
            event.preventDefault();
            last.focus();
          }
        } else if (!inside || active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    // Focus that lands outside the dialog (a click on the page, or a Tab from it) comes back in.
    function onFocusIn(event) {
      if (!current() || minimised) return;
      if (!dialog.contains(event.target)) {
        var items = focusables(dialog);
        (items[0] || dialog).focus();
      }
    }

    minimiseBtn.addEventListener("click", minimise);
    closeBtn.addEventListener("click", close);
    pill.addEventListener("click", restore);

    session = { token: token, close: close, minimise: minimise, restore: restore };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    dialog.focus();
  }

  window.BeeZillaShare = {
    open: open,
    close: function () { if (session) session.close(); },
    isOpen: function () { return session !== null; }
  };
})();
