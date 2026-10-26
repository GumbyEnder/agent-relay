# BeeZilla — Tool harness hardening + browser capability

**Status:** proposed plan (not started)
**Owner:** Frodo (PM/integration); implementation via coder-b70 → Aragorn fallback
**Date:** 2026-10-25
**Extends:** `docs/BEEZILLA-CAPABILITIES.md` (layers + "where we want to go"), `docs/tool-reliability.md`
**Doctrine (unchanged):** a model instruction can never mint a capability. Capability is declared
in code, gated by state, and approved by a human before anything leaves the account.

---

## 1. Where we actually are (measured today)

| Fact | Evidence |
|---|---|
| 7 declared tools | `TOOL_REGISTRY` in `src/lib/buzzy/tools.ts` |
| 4 always offered: `lookup_market_rate`, `fetch_website`, `search_knowledge`, `calculate` | `loopTools` in `server.ts` |
| 3 draft-gated: `render_document`, `render_presentation`, `render_sheet` | same |
| Tool loop cap = 3 iterations, 4096-token budget on tool turns | `toolMax`, `chatLoop` |
| **`fill_template` is dead** | schema exists in `customer.ts`, never imported by the loop |
| **No tool telemetry** | no table, no event, no per-tool timing anywhere |
| **No per-tool timeout, size cap, or abort** | a slow tool blocks the turn |
| **Registry is metadata only** | the JSON schemas live in 5 separate modules → drift is unavoidable |
| `fetch_website` is a bare HTTP GET | no JS; SPAs return an empty shell |
| Voice lane is tool-free by design | audio + tool calls don't mix; deliverables drop to the text lane |

The registry gives us the *allowlist*, but not the *contract*. That is the gap this plan closes
before adding anything new.

---

## 2. Decisions to lock before code

| # | Decision | Why |
|---|---|---|
| **D1** | `toolRegistry.ts` becomes the single source of truth: name, JSON schema, gate class, side-effect class, time budget, byte cap, telemetry key, docs blurb. The loop derives `offeredTools(ctx)` from it. | Schemas in 5 files is how a tool silently stops matching its declaration |
| **D2** | Every tool has a **gate function** returning `{allowed, reason}`, not an inline boolean. A refusal reaches the model as `tool_refused: {tool, reason}` and the reply explains it in plain language. | "not available" produces the invented-limitation failure we already fixed once |
| **D3** | **Browser runs on Hyperbrowser** (managed, job-based), not Chromium inside the app image. All guards are enforced in the tool wrapper, not trusted to the provider. | No 600MB browser in the request path, no image change, and the provider's job model gives us a cheap seam for B3/B4 |
| **D8** | **One `read_web_page` tool, routing HTTP-first with a browser fallback** — not two tools the model must choose between. Plain GET first; if the extracted text is thin, re-render through the browser and say which path ran. | Measured: raw HTTP 1.6s vs browser 6.1s on the same page. A model choosing wrong costs 4.5s per turn for nothing |
| **D4** | **Off-account side effects are never raw tool calls.** `browse_act` emits an action *preview* that must clear the existing outbound approval. No send tool until a real delivery channel exists. | Keeps "approve before work leaves the account" true as the surface grows |
| **D5** | External payloads (pages, search results, documents) are **DATA, never instructions**. One normalizer wraps and strips imperative content; no tool call may originate from page text alone. | Prompt injection is the #1 risk the moment we render arbitrary pages |
| **D6** | Budgets: per-tool wall clock, response byte cap, per-turn tool budget. Exceeding is a **named failure**, never a hang. | Today one slow tool eats the whole turn |
| **D7** | Every new tool ships with registry entry + typed schema + gate + failure text + 1 deterministic test + 1 injection/negative test. No exceptions. | Otherwise the registry becomes a wish list |

---

## 3. Workstream A — shore up the harness (no new capability, ship first)

**A1 — Registry as contract** (`src/lib/buzzy/toolRegistry.ts`)
Move `TOOL_REGISTRY` here; each entry carries `{name, description, schema, gate, sideEffects,
timeoutMs, maxBytes, costClass, telemetry}`. Export `offeredTools(ctx)` and `DECLARED_TOOL_NAMES`
derived from it. `server.ts` stops hand-assembling `loopTools`.
*Accept:* adding a tool requires touching exactly one file; a test asserts the loop's offered set
equals `offeredTools(ctx)` for each gate state.

**A2 — Gate reasons replace booleans**
`draftGateOpen` becomes `gate.draft(ctx)`. Refusal text is generated from the reason
("I can produce the file once the brief is complete — currently missing: end goal").
*Accept:* negative test per gate; no reply contains "not available" for a declared tool.

**A3 — Resolve `fill_template`**
Either wire it (recommended: drafts in the client's own format — highest value for repeat clients)
or delete it. Dead schema is worse than absent.
*Accept:* either a registry entry + test, or the file removed.

**A4 — Executor with budget**
One `runTool(call, ctx)` wrapper: `AbortSignal.timeout`, byte cap on results, normalize, log,
return a typed `ToolResult {ok, data|error}`. Loop cap stays 3; per-tool budget is independent.
*Accept:* a tool that sleeps past its budget fails the turn by name in <1s overhead.

**A5 — Tool telemetry** (migration `0040_buzzy_tool_calls.sql`)
`{user_id, job_id, session_id, turn_id, tool, gate, ms, ok, error_code, bytes, cost_usd}`.
Surface in the voice stage line and the weekly digest ("14 lookups, 2 refused — refusals were the
draft gate"). No content stored.
*Accept:* one row per tool call; a refused call is recorded with its reason.

**A6 — Injection guard**
Extend `normalizeToolResult()`: strip `ignore previous instructions`-class patterns, wrap payloads
in a `<<<DATA>>>` envelope, and refuse to execute any tool whose arguments were derived from page
text without an owner-restated intent.
*Accept:* poisoned-page fixture cannot cause a second tool call; test pinned.

**A7 — Contracts and negatives**
Per tool: happy path + failure path. Per gate: refused when closed, allowed when open. Plus
"undeclared tool is refused" and "declared but gated tool is not offered".
*Accept:* suite green; counts in the capability doc regenerated from code, not hand-written.

**A8 — Docs generated from the registry**
`BEEZILLA-CAPABILITIES.md` tool table is emitted by a script (`scripts/gen-tool-table.mjs`) and
diffed in CI so docs cannot drift.
*Accept:* a stale table fails the check.

---

## 4. Workstream B — real browser

### B1 — Read a real page (the value)

Transport: **Hyperbrowser** (managed). Verified 2026-10-25:

```
POST https://api.hyperbrowser.ai/api/scrape  {"url": …}   → {"jobId": …}
GET  https://api.hyperbrowser.ai/api/scrape/<jobId>        → {"status":"completed","data":{markdown, metadata}}
```

Measured: `example.com` completed in ~2s; `stripe.com/pricing` returned **36KB of clean markdown
from 985KB of raw HTML in 6.1s** (raw HTTP fetch of the same page: 1.6s, but unusable markup).
That gap is exactly why D8 exists: HTTP first, browser only when the page needs JS.

Tool surface — **one** tool, not two:

```
read_web_page(url, want?)  → {finalUrl, title, text, links[], tables[], path:"http"|"browser",
                              renderedAt, robots, timings}
```

Routing rule (deterministic, not model-chosen):
1. Plain GET via the existing `fetchWebsitePage` (SSRF guard, 8s).
2. If visible text < 1,200 chars, or prose/text ratio looks like a shell, or the owner's intent
   names a portal/app → re-render through Hyperbrowser.
3. Return `path` so the reply can say "I had to render this page" and the telemetry records it.

Guards, enforced in our wrapper:
- SSRF check on the URL **and on `finalUrl` after redirects** (reuse `website.ts` `isPrivateIp`).
- No cookies or credentials sent to the provider; one URL per call; 25s wall clock; 2MB text cap.
- `robots.txt` fetched separately and reported (`allow|disallow|unknown`) so the product states
  what it did rather than implying permission.
- Page content passes through the D5 normalizer before the model ever sees it.
- Provider failure degrades to the HTTP path and says so — never silently pretends.

*Accept:* a JS-rendered page returns usable text where `fetch_website` returns a shell; the same
static page takes the HTTP path (no browser spend); a private address is refused after redirect;
a slow page fails by name inside budget; telemetry shows `path` per call.

### B2 — Structured extraction
`browse_extract(url, want: "tables"|"prices"|"links"|"fees")` → typed rows.
Deterministic parser first (table/heading heuristics); the model may label fields but **never
supplies a number**. Same rule as `lookup_market_rate`: unreadable → "could not confirm".

### B3 — Bounded interaction, **forms allowed** (owner decision 2026-10-25)
`browse_act(url, steps[])` with a closed verb set: `click`, `scroll`, `expand`, `paginate`,
`wait_for`, **`fill`** (type into a named field). Max 12 steps, every step logged, field values
must trace to the brief (never invented). **Submission is not a step**: reaching a submit control
ends the run with `awaiting_approval` and a filled-form preview, which must clear the existing
outbound gate (D4) before a single submit call is made.

Rationale: filling a form is reversible and useful; submitting is not. The owner said forms may be
filled — that is honoured here without handing the model an irreversible button.

### B4 — Authenticated sessions — **all accounts** (owner decision 2026-10-25)
Every account may connect a portal session, consumer or business. Non-negotiables before code:
per-account isolated browser context, explicit per-session consent naming the site, revocable from
the account page, full action log (URL, verb, field names — never field values beyond a redacted
preview), no credential storage by us, and a hard rate limit per account. Consumer accounts get the
same audit trail as business spaces; the difference is only who pays.
This is the phase with the most damage potential — the consent + audit model ships *with* it, not
after it.

---

## 5. Workstream C — the other tools to add now

Ranked by value ÷ risk. All follow D7.

| # | Tool | Gate | Why now |
|---|---|---|---|
| C1 | `web_search(query, recency?)` — **Brave Search API** (`BZ_BRAVE_KEY`) | always, free-ish | Browsing without search is guessing. Verified: 200 in ~1.0s. Return URL + title + snippet + age; the draft cites them. `read_web_page` then opens the one that matters |
| C2 | `read_document(docId, question?)` | always, account-scoped | Papers are already imported (`buzzy_papers`) but unreadable — follow-ups force a re-upload today |
| C3 | `parse_spreadsheet(fileId)` | always, account-scoped | We render .xlsx out and cannot read one in; accounting jobs need rows as data |
| C4 | `ocr_page(fileId)` — cloud OCR service on Railway | always, account-scoped | Scanned invoices/quotes are the most common civilian document; owner chose cloud over the local rig |
| C5 | `read_email_thread` / `draft_email` | read always; draft = draft gate | The inbox is where office work starts. **No send tool** until a delivery channel exists |
| C6 | `fill_template(clientTemplateId, values)` | draft gate | Wire the dead schema; repeat clients work in their own branded format |
| C7 | `lookup_public_record(kind, query)` | always | Company registry / licence / permit lookups — source-dependent, phase last |

Deliberately **not** now: payments, e-sign, calendar writes, social posting. Each is a separate
approval surface with its own liability, and none is blocking a real job today.

---

## 6. Sequencing

| Wave | Contents | Rationale |
|---|---|---|
| **1** | A1–A5, C1 (`web_search` → Brave), B1 (`read_web_page`, HTTP-first with Hyperbrowser fallback) | Makes the harness trustworthy and closes the two biggest capability holes. No new infrastructure: both providers are managed |
| **2** | A6–A8, C2, C3, B2 | Injection defense + documents as data + structured page extraction |
| **3** | B3, C4, C5 (read/draft), C6 | Interaction, OCR, inbox, client formats |
| **4** | B4, outbound email send, C7 | Needs consent/audit design + a real delivery channel |

Each wave is independently shippable and independently revertable (`BZ_BROWSER_*` / per-tool flags).

---

## 7. Acceptance gate per wave

1. Contract tests + negative tests green **on the deployed commit**, not a stale HEAD.
2. Tool telemetry rows present for every call, refusals included.
3. Cost recorded per call (or explicitly `null` with the price map gap stated).
4. Capability doc regenerated from the registry.
5. One live end-to-end run through the real UI (not just an endpoint): typed turn **and** voice turn.
6. The reply names which path ran when a fallback occurred.

---

## 8. Decisions — resolved 2026-10-25 (owner)

| Question | Decision |
|---|---|
| Browser hosting | **Hyperbrowser** (managed). Key set as `BZ_HYPERBROWSER_KEY` on `agent-relay` + `beezilla`; verified end-to-end |
| Search provider | **Brave** (`BZ_BRAVE_KEY`), verified 200 in ~1.0s |
| B4 authenticated browsing | **All accounts** — consumer and business, same audit trail |
| OCR | **Cloud, on Railway** — a service in the same project, not a local rig |
| Forms | **May fill** named fields; **submission stays behind the outbound approval** (see B3) |

Consequence to accept: Hyperbrowser means client page URLs leave our infrastructure. Recorded
here deliberately; the no-credentials rule is what keeps that acceptable.

---

## 9. Out of scope

- Multi-page crawling / site maps (one page per call, deliberately).
- Anti-bot circumvention. If a site blocks us, the product says so; we do not defeat it.
- Storing third-party credentials, ever.
