/* Mark a sentence that would commit the company, before approval.
   A refund, a deadline, a discount, a penalty, an admission, or a legal
   position stays unapproved until the owner accepts those exact words.
   This file is plain script, so the page and the server share one check.
   The check never rewrites the draft and never adds a promise. */
(function (root) {
  function splitSentences(draft) {
    var text = String(draft || "").replace(/\r\n/g, "\n");
    var out = [];
    var buf = "";
    var abbrev = /(?:^|[\s(])(?:mr|mrs|ms|dr|st|inc|ltd|co|no|vs|jr|sr)\.$/i;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      buf += ch;
      if (ch === "\n") {
        flush();
        continue;
      }
      if (ch === "!" || ch === "?") {
        var closer = text.charAt(i + 1);
        if (closer === '"' || closer === "'") {
          buf += closer;
          i++;
        }
        flush();
        continue;
      }
      if (ch === ".") {
        var prev = i > 0 ? text.charAt(i - 1) : "";
        var next = i + 1 < text.length ? text.charAt(i + 1) : "";
        if (/\d/.test(prev) && /\d/.test(next)) continue;
        if (abbrev.test(buf)) continue;
        if (next === "" || /\s/.test(next) || next === '"' || next === "'") {
          if (next === '"' || next === "'") {
            buf += next;
            i++;
          }
          flush();
        }
      }
    }
    flush();
    return out;

    function flush() {
      var sentence = buf.replace(/^\s+|\s+$/g, "");
      buf = "";
      if (sentence) out.push(sentence);
    }
  }

  function acceptedMap(list) {
    var map = {};
    var rows = Array.isArray(list) ? list : [];
    for (var i = 0; i < rows.length; i++) {
      if (typeof rows[i] === "string" && rows[i]) map[rows[i]] = true;
    }
    return map;
  }

  function commitsRefund(sentence) {
    if (!/\b(?:refunds?|money back|reimburs(?:e|ed|es|ement))\b/i.test(sentence)) return false;
    if (/\?\s*["']?\s*$/.test(sentence) && !/\b(?:we will|we'll|we shall|we offer|we agree)\b/i.test(sentence)) {
      return false;
    }
    if (/\b(?:we|we'll|i|our|the company)\b/i.test(sentence)) return true;
    if (/\b(?:full|partial|your)\s+refund\b/i.test(sentence)) return true;
    if (/\brefund (?:you|your|the|in full)\b/i.test(sentence)) return true;
    if (/\bmoney back\b/i.test(sentence)) return true;
    return false;
  }

  function refundReason(sentence) {
    if (/\b(?:do not|don't|will not|won't|never|no refund|not offer)\b/i.test(sentence)) {
      return "This commits the company on a refund.";
    }
    return "This offers a refund.";
  }

  function commitsDeadline(sentence) {
    var actor = /\b(?:we will|we'll|we shall|we agree|we commit|we promise|we guarantee|i will|i'll|the company will|our (?:team|shop|crew) will)\b/i.test(sentence);
    var time = /\b(?:by|before|no later than|on or before|within\s+\d+\s+(?:business\s+)?(?:day|week|month)s?|deadline)\b/i.test(sentence);
    var date = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(sentence);
    if (!actor) {
      if (/\bguaranteed\b/i.test(sentence) && (time || date)) return true;
      return false;
    }
    if (/\bplease\s+(?:pay|reply|confirm|send|call)\b/i.test(sentence) && !/\b(?:we will|we'll|we shall)\b/i.test(sentence)) {
      return false;
    }
    if (time) return true;
    if (date && /\b(?:deliver|finish|complete|install|ship|arrive|done|ready|send it|have it)\b/i.test(sentence)) return true;
    return false;
  }

  function commitsDiscount(sentence) {
    if (/\bdiscounts?\b/i.test(sentence) && /\b(?:we|we'll|we will|we can|we offer|i will|i'll|the company|%\s*off|percent)\b/i.test(sentence)) {
      return true;
    }
    if (/\b\d+(?:\.\d+)?\s*%\s*off\b/i.test(sentence)) return true;
    if (/\b(?:percent|per cent) off\b/i.test(sentence)) return true;
    if (/\b(?:no charge|at no cost|at no charge|for free|free of charge|complimentary|on the house)\b/i.test(sentence)) return true;
    if (/\bwaive(?:s|d)?\s+(?:the\s+|our\s+|your\s+)?(?:fee|charge|cost|price)\b/i.test(sentence)) return true;
    if (/\b(?:reduced price|price reduction|mark(?:ed)? down|knock(?:ing)? off)\b/i.test(sentence)) return true;
    return false;
  }

  function commitsPenalty(sentence) {
    if (/\bpenalt(?:y|ies)\b/i.test(sentence)) return true;
    if (/\blate fees?\b/i.test(sentence)) return true;
    if (/\bliquidated damages\b/i.test(sentence)) return true;
    if (/\b(?:we|we'll|we will|the company)\b/i.test(sentence) && /\b(?:fine|interest|surcharge)\b/i.test(sentence) && /\b(?:charge|add|pay|owe|impose)\b/i.test(sentence)) {
      return true;
    }
    return false;
  }

  function commitsAdmission(sentence) {
    if (/\b(?:we|i)\s+admit\b/i.test(sentence)) return true;
    if (/\badmit(?:s|ted|ting)?\s+(?:fault|liability|responsibility|that we)\b/i.test(sentence)) return true;
    if (/\b(?:our|my)\s+(?:fault|mistake|error)\b/i.test(sentence)) return true;
    if (/\bwe\s+(?:were|are)\s+(?:at fault|responsible|negligent|in the wrong|wrong)\b/i.test(sentence)) return true;
    if (/\bwe\s+(?:caused|failed to)\b/i.test(sentence)) return true;
    if (/\baccept(?:s|ing|ed)?\s+(?:full\s+)?(?:fault|blame|responsibility)\b/i.test(sentence)) return true;
    if (/\b(?:we|i)\s+apologize\b/i.test(sentence)) return true;
    return false;
  }

  function commitsLegal(sentence) {
    if (/\bliab(?:le|ility)\b/i.test(sentence)) return true;
    if (/\bbreach(?: of|ed|es)?\b/i.test(sentence) && /\b(?:contract|agreement|you|we)\b/i.test(sentence)) return true;
    if (/\bindemnif/i.test(sentence)) return true;
    if (/\bwarrant(?:y|ies)\b/i.test(sentence)) return true;
    if (/\bhold harmless\b/i.test(sentence)) return true;
    if (/\bbinding\s+(?:agreement|contract|offer)\b/i.test(sentence)) return true;
    if (/\b(?:not responsible|no liability|you are entitled|without prejudice)\b/i.test(sentence)) return true;
    if (/\b(?:lawsuit|in court|at law|legally)\b/i.test(sentence)) return true;
    if (/\bthis is (?:not )?a contract\b/i.test(sentence)) return true;
    if (/\bwe\s+(?:deny|dispute)\s+(?:liability|the claim|responsibility|that)\b/i.test(sentence)) return true;
    if (/\blegal\s+(?:advice|position|claim|action)\b/i.test(sentence)) return true;
    if (/\bwaiv(?:e|es|ed|er|ing)\b/i.test(sentence) && !/\bwaive(?:s|d)?\s+(?:the\s+|our\s+|your\s+)?(?:fee|charge|cost|price)\b/i.test(sentence)) {
      return true;
    }
    return false;
  }

  function classify(sentence) {
    var reasons = [];
    var kinds = [];
    if (commitsRefund(sentence)) {
      kinds.push("refund");
      reasons.push(refundReason(sentence));
    }
    if (commitsDeadline(sentence)) {
      kinds.push("deadline");
      reasons.push("This sets a deadline the company would have to meet.");
    }
    if (commitsDiscount(sentence)) {
      kinds.push("discount");
      reasons.push("This offers a discount.");
    }
    if (commitsPenalty(sentence)) {
      kinds.push("penalty");
      reasons.push("This names a penalty.");
    }
    if (commitsAdmission(sentence)) {
      kinds.push("admission");
      reasons.push("This admits fault.");
    }
    if (commitsLegal(sentence)) {
      kinds.push("legal");
      reasons.push("This takes a legal position.");
    }
    if (!kinds.length) return null;
    return { kind: kinds[0], text: sentence, reason: reasons.join(" ") };
  }

  function checkPromise(input) {
    var src = input || {};
    var draft = typeof src.draft === "string" ? src.draft : "";
    var accepted = acceptedMap(src.accepted);
    var found = splitSentences(draft);
    var items = [];
    for (var i = 0; i < found.length; i++) {
      var hit = classify(found[i]);
      if (!hit) continue;
      var ok = !!accepted[hit.text];
      items.push({
        tone: ok ? "accepted" : "promise",
        kind: hit.kind,
        text: hit.text,
        reason: hit.reason,
        accepted: ok,
      });
    }
    return {
      items: items,
      blocksApproval: items.some(function (item) { return !item.accepted; }),
      draft: draft,
    };
  }

  root.checkPromise = checkPromise;
})(typeof globalThis !== "undefined" ? globalThis : this);
