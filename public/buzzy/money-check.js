/* Compare a draft to the paper and the confirmed brief before approval.
   A wrong amount blocks approval. A number nobody supplied stays absent.
   This file is plain script, so the page and the server share one check. */
(function (root) {
  function moneyRe() {
    return /\$\s?\d[\d,]*(?:\.\d{2})?|\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g;
  }

  function dateRe() {
    return /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi;
  }

  function chargeRe() {
    return /(?:sales\s+tax|\btax\b|penalt(?:y|ies)|late\s+fee|\binterest\b|surcharge|finance\s+charge)/i;
  }

  function moneyNumber(token) {
    var n = Number(String(token).replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n.toFixed(2) : "";
  }

  function moneyTokens(text) {
    var found = String(text || "").match(moneyRe()) || [];
    var out = [];
    var seen = {};
    for (var i = 0; i < found.length; i++) {
      var num = moneyNumber(found[i]);
      if (!num || seen[num]) continue;
      seen[num] = true;
      out.push(num);
    }
    return out;
  }

  function displayMoney(num) {
    var n = Number(num);
    if (!Number.isFinite(n)) return String(num);
    var sign = n < 0 ? "-" : "";
    var fixed = Math.abs(n).toFixed(2);
    var parts = fixed.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return sign + "$" + parts[0] + "." + parts[1];
  }

  function moneyList(nums) {
    var out = [];
    for (var i = 0; i < nums.length; i++) out.push(displayMoney(nums[i]));
    return out.join(" and ");
  }

  function factByKey(facts, key) {
    for (var i = 0; i < facts.length; i++) {
      if (facts[i] && facts[i].key === key) return facts[i];
    }
    return null;
  }

  function usable(fact) {
    if (!fact) return false;
    var status = fact.status || "";
    if (status !== "proposed" && status !== "confirmed") return false;
    return String(fact.value || "").trim().length > 0;
  }

  function paperNoun(kind) {
    var k = String(kind || "").toLowerCase();
    if (k === "quote" || k === "invoice" || k === "letter" || k === "notice" || k === "form" || k === "photo") {
      return k;
    }
    return "paper";
  }

  function confirmedBrief(brief) {
    var lines = [];
    var amounts = [];
    var seen = {};
    var list = Array.isArray(brief) ? brief : [];
    for (var i = 0; i < list.length; i++) {
      var line = list[i] || {};
      if (line.status !== "confirmed") continue;
      var value = String(line.value || "").trim();
      if (!value || value === "skipped") continue;
      lines.push(value);
      var nums = moneyTokens(value);
      for (var j = 0; j < nums.length; j++) {
        if (seen[nums[j]]) continue;
        seen[nums[j]] = true;
        amounts.push(nums[j]);
      }
    }
    return { lines: lines, amounts: amounts };
  }

  function mentioned(draft, value) {
    var needle = String(value || "").trim().toLowerCase();
    if (!needle) return false;
    return String(draft || "").toLowerCase().indexOf(needle) !== -1;
  }

  function checkMoney(input) {
    var src = input || {};
    var draft = typeof src.draft === "string" ? src.draft : "";
    var facts = Array.isArray(src.facts) ? src.facts : [];
    var noun = paperNoun(src.kind);
    var items = [];
    var amountFact = factByKey(facts, "amount");
    var dateFact = factByKey(facts, "date");
    var dueFact = factByKey(facts, "due");
    var partiesFact = factByKey(facts, "parties");
    var hasPaper = facts.length > 0;
    var paperAmount = "";
    if (usable(amountFact)) {
      var parsed = moneyTokens(amountFact.value);
      if (parsed.length === 1) paperAmount = parsed[0];
    }
    var ownerEntered = !!(
      paperAmount &&
      amountFact.status === "confirmed" &&
      (amountFact.source === "You corrected this" || amountFact.source === "You added this")
    );
    var place = paperAmount && amountFact.place ? String(amountFact.place) : "";
    var briefInfo = confirmedBrief(src.brief);
    var draftAmounts = moneyTokens(draft);
    var matter = hasPaper || draftAmounts.length > 0 || briefInfo.amounts.length > 0;
    if (!matter) return { items: [], blocksApproval: false, draft: draft };

    var supplied = briefInfo.amounts.slice();
    if (paperAmount && supplied.indexOf(paperAmount) === -1) supplied.push(paperAmount);
    var invented = [];
    for (var i = 0; i < draftAmounts.length; i++) {
      if (supplied.indexOf(draftAmounts[i]) === -1) invented.push(draftAmounts[i]);
    }
    var hasPaperAmount = draftAmounts.indexOf(paperAmount) !== -1;
    var droppedPaperAmount = !!(paperAmount && draftAmounts.length > 0 && !hasPaperAmount);

    if (!paperAmount && !draftAmounts.length) {
      items.push({ tone: "blank", text: "No price was on the " + noun + ", so none was written." });
    } else if (!paperAmount && invented.length) {
      items.push({
        tone: "wrong",
        text:
          "No price was on the " +
          noun +
          ", so none was written. This draft names " +
          moneyList(invented) +
          ", and nobody supplied that number.",
      });
    } else if (!paperAmount) {
      items.push({
        tone: "match",
        text: "The amount is the one you typed (" + moneyList(draftAmounts) + ").",
      });
    } else if (invented.length || droppedPaperAmount) {
      var shown = invented.length ? invented : draftAmounts;
      var expected = ownerEntered
        ? "The amount you entered is " + displayMoney(paperAmount) + "."
        : "The " + noun + " you supplied says " + displayMoney(paperAmount) + (place ? " (" + place + ")" : "") + ".";
      items.push({
        tone: "wrong",
        text:
          "This draft says " +
          moneyList(shown) +
          ". " +
          expected +
          " Approval stays closed until the amount matches.",
      });
    } else if (!draftAmounts.length) {
      items.push({ tone: "blank", text: "The amount is blank. Nothing was filled in." });
    } else if (ownerEntered) {
      items.push({
        tone: "match",
        text: "The amount is the one you entered (" + displayMoney(paperAmount) + ").",
      });
    } else if (amountFact.status === "confirmed") {
      items.push({
        tone: "match",
        text: "The amount matches the " + noun + " you supplied." + (place ? " It is from " + place + "." : ""),
      });
    } else {
      items.push({
        tone: "unconfirmed",
        text:
          "The amount matches the " +
          noun +
          " you supplied." +
          (place ? " It is from " + place + "." : "") +
          " You have not accepted that line yet.",
      });
    }

    if (paperAmount && hasPaperAmount && !invented.length && !droppedPaperAmount) {
      var extraOwned = [];
      for (var e = 0; e < draftAmounts.length; e++) {
        if (draftAmounts[e] !== paperAmount && briefInfo.amounts.indexOf(draftAmounts[e]) !== -1) {
          extraOwned.push(draftAmounts[e]);
        }
      }
      if (extraOwned.length) {
        items.push({
          tone: "match",
          text: "Another figure is the one you typed (" + moneyList(extraOwned) + ").",
        });
      }
    }

    if (hasPaper) {
      pushLine(dueFact, "The due date is blank.", "The due date matches the " + noun + " you supplied.");
      pushLine(dateFact, "The date is blank.", "The date matches the " + noun + " you supplied.");
      pushParties();
      pushStrayDates();
    }
    pushCharge();

    return {
      items: items,
      blocksApproval: items.some(function (item) { return item.tone === "wrong"; }),
      draft: draft,
    };

    function pushLine(fact, blankText, matchText) {
      if (!usable(fact) || !mentioned(draft, fact.value)) {
        items.push({ tone: "blank", text: blankText });
        return;
      }
      if (fact.status === "confirmed") {
        items.push({ tone: "match", text: matchText });
        return;
      }
      items.push({ tone: "unconfirmed", text: matchText + " You have not accepted that line yet." });
    }

    function pushParties() {
      if (!usable(partiesFact)) {
        items.push({ tone: "blank", text: "Who it's between is blank." });
        return;
      }
      var value = String(partiesFact.value);
      var names = value.replace(/^from\s+/i, "").split(/\s+to\s+/i);
      var missing = [];
      for (var n = 0; n < names.length; n++) {
        var name = names[n].trim();
        if (name && !mentioned(draft, name)) missing.push(name);
      }
      if (!missing.length) {
        items.push({
          tone: partiesFact.status === "confirmed" ? "match" : "unconfirmed",
          text:
            partiesFact.status === "confirmed"
              ? "The names match what you confirmed."
              : "The names match the " + noun + " you supplied. You have not accepted that line yet.",
        });
        return;
      }
      if (missing.length === names.filter(function (name) { return name.trim(); }).length) {
        items.push({ tone: "blank", text: "Who it's between is blank." });
        return;
      }
      items.push({
        tone: "unconfirmed",
        text: "A name on the " + noun + " is not in this draft (" + missing.join(", ") + "). Nothing was filled in for you.",
      });
    }

    function pushStrayDates() {
      var allowed = [];
      if (usable(dueFact)) allowed.push(String(dueFact.value).toLowerCase());
      if (usable(dateFact)) allowed.push(String(dateFact.value).toLowerCase());
      for (var b = 0; b < briefInfo.lines.length; b++) allowed.push(briefInfo.lines[b].toLowerCase());
      var found = String(draft).match(dateRe()) || [];
      var stray = [];
      for (var d = 0; d < found.length; d++) {
        var token = found[d];
        var low = token.toLowerCase();
        var ok = false;
        for (var a = 0; a < allowed.length; a++) {
          if (allowed[a].indexOf(low) !== -1) ok = true;
        }
        if (!ok && stray.indexOf(token) === -1) stray.push(token);
      }
      if (!stray.length) return;
      items.push({
        tone: "unconfirmed",
        text: "A date in this draft (" + stray.join(", ") + ") could not be confirmed. Nothing was added in its place.",
      });
    }

    function pushCharge() {
      if (!chargeRe().test(draft)) return;
      var paperText = [];
      for (var f = 0; f < facts.length; f++) {
        if (usable(facts[f])) paperText.push(String(facts[f].value));
      }
      if (chargeRe().test(paperText.join("\n"))) return;
      if (chargeRe().test(briefInfo.lines.join("\n"))) return;
      items.push({
        tone: "wrong",
        text: "No tax, penalty, or fee was on the " + noun + ", so none was written. Approval stays closed while this draft adds one.",
      });
    }
  }

  root.checkMoney = checkMoney;
})(typeof globalThis !== "undefined" ? globalThis : this);
