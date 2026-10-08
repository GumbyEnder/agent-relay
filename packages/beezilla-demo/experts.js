/**
 * BeeZilla — EXPERT tab data and spend display
 *
 * Plain-JavaScript IIFE (no bundler, no TS imports).
 * Sibling of index.html.
 *
 * Exports:
 *   EXPERTS — array of expert records (seed with 4 launch experts)
 *   JOB_SOFT_BUDGET_USD — soft budget constant ($5)
 *   window.__bzJobSpend — stub that returns shaped data identical to
 *     the adapter's jobSpend() so the demo page can render spend.
 */
(function () {
  "use strict";

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  var JOB_SOFT_BUDGET_USD = 5;

  // -----------------------------------------------------------------------
  // EXPERT registry
  // -----------------------------------------------------------------------

  var EXPERTS = [
    {
      id: "legal",
      name: "Legal Assistant",
      domain: "Legal",
      modelId: "claude-sonnet-4-20250514",
      blurb:
        "Helps you draft letters, notices, agreements, and other legal-style documents in plain English. It knows the standard clauses and formatting but isn't a lawyer — always review before sending.",
      skillPack: ["contract-drafting", "notice-letters", "terms-review"],
      tools: ["web-search", "document-format", "fairness-check"],
      status: "live",
    },
    {
      id: "medical",
      name: "Medical Assistant",
      domain: "Medical",
      modelId: "claude-sonnet-4-20250514",
      blurb:
        "Helps you write medical release forms, insurance correspondence, and patient summaries. It pulls from common medical documentation standards but doesn't diagnose or replace a healthcare professional.",
      skillPack: ["release-forms", "insurance-correspondence", "patient-summaries"],
      tools: ["web-search", "document-format", "fairness-check"],
      status: "live",
    },
    {
      id: "tech",
      name: "Software & Tech",
      domain: "Software / Tech",
      modelId: "gpt-4o",
      blurb:
        "Writes technical specs, explains how systems work, and helps with code snippets and scripts. Great for turning technical jargon into plain language your team can act on.",
      skillPack: ["technical-specs", "code-explainers", "how-it-works"],
      tools: ["web-search", "code-format", "fairness-check"],
      status: "live",
    },
    {
      id: "accounting",
      name: "Accounting Assistant",
      domain: "Accounting",
      modelId: "claude-sonnet-4-20250514",
      blurb:
        "Helps you draft invoices, budgets, and financial correspondence. It follows standard accounting formats but isn't a CPA — your numbers should always be verified by a qualified professional.",
      skillPack: ["invoice-drafting", "budget-forms", "financial-correspondence"],
      tools: ["web-search", "document-format", "fairness-check"],
      status: "curating",
    },
  ];

  // -----------------------------------------------------------------------
  // Spend stub (simulated until the real adapter is wired)
  // -----------------------------------------------------------------------

  // Shape matches the adapter's jobSpend() return type exactly.
  // When metering lands, swap this stub for the real adapter call.
  window.__bzJobSpend = function (jobId) {
    // Simulated spend — always labeled as such in the UI.
    return {
      totalTokens: 12400,
      promptTokens: 7200,
      completionTokens: 5200,
      estCostUsd: 0.04,
      byPhase: {
        draft: { tokens: 8000, cost: 0.03 },
        review: { tokens: 4400, cost: 0.01 },
      },
      byModel: {
        "claude-sonnet-4-20250514": { tokens: 10000, cost: 0.035 },
        "gpt-4o": { tokens: 2400, cost: 0.005 },
      },
    };
  };

  // -----------------------------------------------------------------------
  // Render helpers
  // -----------------------------------------------------------------------

  /** Render the Experts tab content */
  function renderExpertsTab(container) {
    var cards = EXPERTS.map(function (exp) {
      var statusBadge =
        exp.status === "live"
          ? '<span class="tag">Live</span>'
          : '<span class="tag" style="color: var(--bz-status-lavender); background: rgba(155,142,196,0.15);">Curating</span>';

      var skills = exp.skillPack
        .map(function (s) {
          return "<li>" + s + "</li>";
        })
        .join("");

      var tools = exp.tools
        .map(function (t) {
          return "<li>" + t + "</li>";
        })
        .join("");

      return (
        '<div class="card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">' +
        '<h2 style="margin:0;">' + exp.name + '</h2>' +
        statusBadge +
        "</div>" +
        '<p>' + exp.blurb + "</p>" +
        '<p class="muted">Domain: ' + exp.domain + " · Model: " + exp.modelId + "</p>" +
        '<p style="margin-bottom:0.25rem;"><strong>Skills:</strong></p>' +
        '<ul class="fairness-list">' + skills + "</ul>" +
        '<p style="margin-bottom:0.25rem;margin-top:0.5rem;"><strong>Tools:</strong></p>' +
        '<ul class="fairness-list">' + tools + "</ul>" +
        "</div>"
      );
    }).join("");

    var disclaimer =
      '<p class="muted" style="margin-top:1.5rem;padding:0.75rem;border-left:3px solid var(--bz-status-lavender);background:rgba(155,142,196,0.06);border-radius:4px;">' +
      'Experts are AI assistants with curated domain knowledge, not licensed professionals.' +
      "</p>";

    container.innerHTML =
      '<img class="mascot-sm" src="brand/revision6_expressions_17-attentive.png" alt="BeeZilla" />' +
      '<h1>Experts</h1>' +
      '<p>AI specialists trained for your business needs. Each one handles a specific domain — pick the one that fits your job.</p>' +
      cards +
      disclaimer;
  }

  /** Render the spend line for a job (used on the draft/result pages) */
  function renderSpendLine(jobId) {
    if (typeof window.__bzJobSpend !== "function") return "";

    var spend = window.__bzJobSpend(jobId);
    if (!spend || spend.estCostUsd === null) return "";

    var totalK = (spend.totalTokens / 1000).toFixed(1);
    var line =
      '<p class="muted" style="margin-top:0.75rem;">' +
      'Estimated agent work so far: $' +
      spend.estCostUsd.toFixed(2) +
      " (" +
      totalK +
      "k tokens, simulated)" +
      "</p>";

    // Soft-budget hook
    if (spend.estCostUsd >= JOB_SOFT_BUDGET_USD) {
      line +=
        '<p class="muted" style="color: var(--bz-status-red); margin-top:0.25rem;">' +
        "This job is approaching its agent-work budget — you can continue or wrap up here." +
        "</p>";
    }

    return line;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  window.BeeZillaExperts = {
    EXPERTS: EXPERTS,
    JOB_SOFT_BUDGET_USD: JOB_SOFT_BUDGET_USD,
    renderExpertsTab: renderExpertsTab,
    renderSpendLine: renderSpendLine,
  };
})();
