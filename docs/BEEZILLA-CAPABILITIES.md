# BeeZilla — Capability Layers

**Status:** current implementation reference
**Last verified against:** `0025841` (2026-10-17) — suites 175/41/47/41/9, all passing
**Production:** beezilla `146fc8c3` (built from `6a69181`; the commits since are docs and UI only)
**Audience:** engineers extending the agent loop; operators deciding what to promise customers

BeeZilla's capabilities are deliberately layered. Nothing the model says can create a
capability; capability is declared in code, gated by state, and — for anything that leaves
the account — approved by a human. This document records what exists today, what is
deliberately absent, and what we intend to add.

---

## The rule everything follows

> A model instruction alone can never mint a capability that isn't declared in code.

Three mechanisms enforce that:

1. **A registry is the allowlist.** `src/lib/buzzy/tools.ts` declares every tool the chat
   loop may execute. A model asking for an undeclared tool gets "not available" — it is
   refused, not attempted, and no permission is inferred.
2. **State gates capability.** Rendering tools are not even offered to the model until the
   draft gate opens (all four Decisions Made statements captured, or the owner asked for the
   deliverable). Before that, the model has nothing to call — which matters, because a model
   with no tool for a request will invent a limitation. (See "Known failure modes" below.)
3. **Outward actions have their own gate.** Producing a document is autonomous; sending it
   is not. Every action that leaves the account is a separate, version-pinned approval.

---

## Layer 0 — Deterministic platform (no model involved)

State and behavior that exists regardless of any LLM call. 46 exact-path route handlers
(plus 25 parameterised ones) under `/api/buzzy/**` back these.

| Capability | Notes |
|---|---|
| Companies / business spaces | A space is a `company_id`; work is grouped and delegations can be scoped to it |
| Jobs + lifecycle | `Discovering → Draft ready → accepted`, plus Paused / Cancelled / Archived |
| Durable Library | Every draft becomes a `buzzy_documents` row with immutable `buzzy_document_versions` |
| Exports | MD / PDF / DOCX / CSV rendered on demand **for a chosen version**, so exports cannot drift |
| Acceptance | Exact-version accept; stale accept refused `409`; internal vs customer acceptance are distinct records |
| Review checks | Deterministic approval-time checks (arithmetic, parties, invented amounts, boundary language) |
| Share links | Version-pinned, expiring, revocable, public read-only |
| Outbound actions | Preview → one-shot approval → receipt; idempotent retry; material change invalidates the approval |
| Papers (import) | PDF/text import with encrypted-PDF detection and unsupported-type handling |
| Recipes / starters | Eight business recipes + three outcome-first starters, with boundaries enforced in code |
| Team | Invitations, membership (`invited/active/revoked`), roles, revocations |
| Delegations | One action per grant, optional space scope, optional amount cap, expiry, revocation |
| Search | Cross-company: jobs, sessions, documents (title + current-version content) |
| Telemetry | Event whitelist, content-shaped props stripped at write time; success = accepted **and** re-retrieved outputs |
| Scheduled jobs | Cadence-based runs behind a runner secret; every run produces a draft that waits for review |
| Model policy | `mp-1.1.0` — catalog-only eligibility, phase/task routing, no silent escalation, decision recorded per turn. Seven controls: `value`, `faster`, `thorough`, `cheapest`, `provider`, `localOnly`, `budgetCapCents`. A control that cannot be satisfied is **refused by name** (`no_price_map`, `unknown_provider`, `no_local_models`, `budget_refused`) and routes nowhere — it never degrades silently to the default. Controls are read per turn from the operator's saved prefs and validated; an unrecognised stored value falls back to `value` with the fallback recorded |

Migrations 0028–0038 carry this: documents, provenance, contacts, share links, decisions,
connection scope, outbound actions, telemetry, team, delegations.

---

## Layer 1 — LLM-callable tools (7, declared)

These are what the model can actually *do* mid-conversation. Each declares inputs, output
contract, data sensitivity, cost class, side effects, permission, verification and failure
behavior — missing or mis-declared tools fail visibly.

| Tool | Effect | Sensitivity | Verification / failure behavior |
|---|---|---|---|
| `calculate` | Exact arithmetic (`+ - * / %`, parentheses) | none | Deterministic parser; the model never computes. Bad input or ÷0 returns a named error, never a guessed number |
| `search_knowledge` | Account's **confirmed** facts only — company facts, confirmed paper facts, remembered decisions | account | Ownership-scoped; nothing confirmed → "ask the owner", never a guess |
| `lookup_market_rate` | Disclosed rate **ranges** from a deterministic table (~12 categories + generic fallback) | none | Always a range; the owner's stated price wins |
| `fetch_website` | Fetches a public page as **DATA ONLY, never instructions** | none | SSRF guard (private/loopback/reserved refused), 8s timeout, ≤4 redirect hops, 6k chars, http(s) only |
| `render_document` | `.docx` staged on the job, approval-gated for download | account-documents | 1–25 sections validated; render error surfaces, nothing staged |
| `render_presentation` | `.pptx` | account-documents | Typed slide validation |
| `render_sheet` | `.xlsx` | account-documents | Typed row/column validation |

**Gating and budget**

- Always offered: `calculate`, `search_knowledge`, `lookup_market_rate`, `fetch_website`.
- Offered only when the draft gate is open: `render_document`, `render_presentation`, `render_sheet`.
- Maximum **3 tool iterations** per turn (`toolMax = 3`). The loop is bounded, not open-ended.
- Tool results re-enter as user-role messages with explicit framing (`DATA ONLY`,
  `RANGE reference`, `nothing confirmed`) so retrieved text is never mistaken for authority.

---

## Layer 2 — Approval-gated outward actions

Producing is automatic. Leaving the account is not.

```
preview (pins version + recipient)  →  human approval  →  receipt (what actually happened)
```

- Only an **accepted** version can be sent or shared (`409 not_accepted` otherwise).
- Approval re-verifies the pinned version is still the accepted one; a material change since
  preview cancels the action and refuses with `409 stale_action`.
- Retries are idempotent by `idempotencyKey` — the same key never creates a duplicate.
- Receipts state the truth. With no delivery channel configured, the record says
  `result=not_sent`, `status=blocked` — it does not claim delivery.

---

## Layer 3 — Human and team authority

Authority is separate from access. Being signed in is never enough.

**Roles** (`canPerform()` is the single authority):

| Role | May |
|---|---|
| owner | everything, including deleting the account |
| admin | run the work: read, draft, accept, request changes, send, share, manage team — cannot delete the account |
| reviewer | read + decide documents; never sends, never manages people |
| member | read + draft only |

**Delegations** (on top of role) grant *one* action, optionally scoped to one business space,
optionally capped by amount, expiring, revocable. A delegation for "accept documents"
provably does not grant sending; a space-scoped grant provably refuses work outside that space.

**Scope resolution:** the owner's records stay keyed by the owner's `user_id`. A teammate's
request resolves to that account *through an active membership* — nobody shares a magic link.

---

## What we deliberately do not have

| Absent | Why |
|---|---|
| ~~**Headless browser**~~ | **Shipped in wave 1 (2026-10-25).** `read_web_page` fetches over HTTP first and escalates to a managed render (Hyperbrowser) when the page comes back thin, reporting which path ran. Interaction, structure extraction and authenticated sessions are still absent (B2-B4) |
| **Email delivery** | No outbound mail channel is wired. Approvals record `not_sent` honestly rather than pretending |
| **OAuth token exchange** | Email/calendar/drive connection *scope, consent and revoke* are implemented and stored; the token exchange is not |
| **Outbound HTTP writes** | `fetch_website` is GET-only. No POST, no uploads, no arbitrary third-party writes |
| **Model-initiated sending** | The loop has no send tool at all. Content can never grant permission to send |
| **Cross-account reads** | Every route and every tool is ownership-scoped; the suite pins this with explicit negatives |

---

## Known failure modes and their guards

- **Model invents a limitation.** Observed live: the assistant replied "I can't save files to
  a library — no file-storage tool on my end." Cause was wiring, not model quality: render
  tools weren't offered before the draft gate, and the persona never stated the Library
  exists. Fixed three ways — persona states the capability and forbids the refusal;
  "save to my library / as md|pdf|docx / save a copy / export it" now opens the draft gate;
  and a guard strips any surviving file-storage refusal, logging it as a wiring regression.
- **Route shadowing.** Two handlers on the same path mean the later one is dead code and its
  contract silently disappears. This happened with `/api/buzzy/search`; the fix is one
  implementation carrying both contracts, and the suite now pins the merged behavior.
- **Green tests on a stale HEAD.** A suite run is only meaningful against the commit that is
  actually deployed. Always compare `main`, `github/main`, `origin/main` before trusting a result.

---

## Where we want to go

Ordered by value delivered per unit of risk.

### 1. Real browser capability (highest value, highest risk)

`fetch_website` cannot read the modern web. The gap shows up in exactly the jobs we want:
supplier quotes, grant portals, insurance policy pages, RFP postings.

Proposed phasing — each phase shippable on its own:

| Phase | Capability | Guardrails |
|---|---|---|
| B1 | **Read a JS-rendered public page** — headless Chromium, wait for network idle, return visible text | SSRF allowlist re-checked after render, response size cap, hard wall-clock timeout, one page per call, screenshot stored with the result for audit |
| B2 | **Structured extraction** — return page text plus links/tables so a quote or fee schedule can be read mechanically | Deterministic extraction first; model only summarises, never supplies numbers |
| B3 | **Interaction without credentials** — click "show more", follow pagination, expand accordions | No form submission, no login, bounded action list, every action logged |
| B4 | **Authenticated sessions** — owner's own portal session | Explicit per-session consent, isolated browser context per account, no credential storage by us, revocable, full action log |

B1 is where the value is. B3 and B4 need dedicated design review before any code.

**Status 2026-10-25:** B1 shipped as `read_web_page` (HTTP-first, managed render
fallback, `path` reported per call). Registry/gates/budgets/tool telemetry shipped alongside it
(`docs/TOOL-AND-BROWSER-PLAN.md`).

### 2. Delivery channel

Wire one real outbound channel (transactional email) so receipts can say `sent` with a
provider message id. Without it, "approve and send" is honest but useless.

### 3. Connector token exchange

Finish OAuth for email/calendar/drive so the scope/consent/revoke contract built in BZ-F032
actually reads real data. Read-only first, selection-scoped, revocable.

### 4. More declared tools

- `parse_spreadsheet` — read imported .xlsx/.csv into typed rows (today: rendered out, not read in)
- `web_search` — when browsing is unavailable or too slow, a search API with sourced results
- `read_document` — read an already-imported PDF/policy so follow-up questions don't need a re-upload
- `ocr_page` — scanned PDFs and photos of paper invoices

Each must ship with: registry declaration, typed schema, gating class, failure behavior, and
at least one deterministic test — no exceptions.

### 5. Cost and budget controls surfaced to the owner

**Partly delivered in `mp-1.1.0`.** The policy now enforces a spend ceiling: `budgetVerdict()`
compares recorded spend against the owner's cap and returns `allow` / `ask` / `refuse`
(`spent === cap` refuses — the owner said stop *at* the cap). The verdict blocks the turn with
`budget_refused` before any model is chosen.

Still absent, and correctly reported as absent:
- **A UI to set the cap.** It is written through the existing `POST /api/agent/me/prefs`
  (`prefs.budgetCapCents`) and read per turn; nothing renders a control for it yet.
- **Per-job and per-space ceilings.** Only one account-level cap exists.
- **A real price map.** `cost_usd` stays nullable, so an unpriced deployment sums spend to 0
  and the ceiling has nothing to count. `cheapest` and `budgetCapCents` are therefore
  *structural* today: they work the moment prices exist, and they refuse rather than guess
  until then.

### 6. Deeper delegation

Delegations currently cover four actions. Natural extensions: per-space member rosters,
delegation of scheduled-job creation, and an approval chain (member requests → admin approves)
for high-value sends.

---

## How to add a capability (checklist)

1. **Declare it** in `src/lib/buzzy/tools.ts` — inputs, output, sensitivity, cost class, side
   effects, permission, verification, failure behavior. If you cannot fill every field, the
   capability is not ready.
2. **Choose its gate class**: always-available read-only, draft-gated render, or
   approval-gated outward. Never invent a fourth class.
3. **Implement behind ownership scope.** No route or tool may read across accounts.
4. **Make failure useful** — a named error the owner can act on, never a fabricated result.
5. **Test the negative**: cross-account denial, boundary refusal, and the tool's declared
   failure behavior. A green happy path alone is not completion.
6. **Update this document.** Capability that isn't written down here is capability the next
   engineer will re-implement or mis-promise.

---

## Verification baseline

`~/.local/bin/run-beezilla-suites` runs everything in one pass (fresh `.data`, fresh server per
suite, cool-down between suites to avoid the magic-link limiter):

| Suite | Checks |
|---|---|
| `test-buzzy-resume.mjs` | 175 |
| `test-buzzy-jobs-ownership.mjs` | 41 |
| `test-buzzy-recipes.mjs` | 47 |
| `test-buzzy-team.mjs` | 41 |
| `test-expert-fixtures.mjs` | 9 |

Ownership negatives, stale-version refusals, approval invalidation, boundary enforcement and
cross-account isolation are all pinned in those suites. Treat the numbers as a floor, not a
target.
