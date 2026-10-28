/**
 * BZ-F013 — tool/skill declarations (data, not code paths).
 *
 * Every tool the chat loop can execute declares its inputs, output contract,
 * data sensitivity, cost class, side effects, permission needs, verification
 * and failure behavior. The loop's allowlist IS this registry — a model
 * instruction alone can never mint a capability that isn't declared here
 * (no key minting, no arbitrary uploads, no privileged boards, no sending
 * email). Missing or mis-declared tools fail visibly, never silently.
 */

export interface ToolDeclaration {
  name: string;
  inputs: string;
  output: string;
  sensitivity: "none" | "account" | "account-documents";
  costClass: "free" | "llm-priced" | "metered";
  sideEffects: "none" | "read-only" | "render-to-memory";
  permission: "session_user" | "owner";
  verification: string;
  failureBehavior: string;
}

export const TOOL_REGISTRY: ToolDeclaration[] = [
  {
    name: "render_document",
    inputs: "{ title, sections[] } — the finished deliverable text",
    output: "a .docx file staged on the job, approval-gated for download",
    sensitivity: "account-documents",
    costClass: "llm-priced",
    sideEffects: "render-to-memory",
    permission: "session_user",
    verification: "typed content validation (1-25 sections, non-empty paragraphs); pack failure returns a useful error",
    failureBehavior: "render error is surfaced in the reply; nothing is staged or charged beyond the model call",
  },
  {
    name: "render_presentation",
    inputs: "{ title, slides[] }",
    output: "a .pptx file staged on the job, approval-gated",
    sensitivity: "account-documents",
    costClass: "llm-priced",
    sideEffects: "render-to-memory",
    permission: "session_user",
    verification: "typed slide validation before packing",
    failureBehavior: "render error is surfaced; nothing staged",
  },
  {
    name: "render_sheet",
    inputs: "{ title, columns[], rows[] }",
    output: "an .xlsx file staged on the job, approval-gated",
    sensitivity: "account-documents",
    costClass: "llm-priced",
    sideEffects: "render-to-memory",
    permission: "session_user",
    verification: "typed row/column validation before packing",
    failureBehavior: "render error is surfaced; nothing staged",
  },
  {
    name: "lookup_market_rate",
    inputs: "{ service, unit? } — a service description",
    output: "a sourced rate range or 'could not confirm' (never an invented number)",
    sensitivity: "none",
    costClass: "free",
    sideEffects: "read-only",
    permission: "session_user",
    verification: "result is a RANGE reference — the owner's stated price always wins",
    failureBehavior: "no data → the draft says 'could not confirm', never a made-up figure",
  },
  {
    name: "web_search",
    inputs: "{ query, count?, freshness? } — what to look for",
    output: "titled URLs + short snippets (leads, never evidence)",
    sensitivity: "none",
    costClass: "metered",
    sideEffects: "read-only",
    permission: "session_user",
    verification: "typed results with source URLs; empty result stated, never padded",
    failureBehavior: "search error is named; the model may not invent a source",
  },
  {
    name: "read_web_page",
    inputs: "{ url } — a public page",
    output: "visible text, plus which path produced it (http | browser)",
    sensitivity: "none",
    costClass: "metered",
    sideEffects: "read-only",
    permission: "session_user",
    verification: "SSRF guard re-checked on every redirect hop; thin pages escalate to a real render",
    failureBehavior: "blocked/unreadable is stated plainly; the model may not describe a page it did not read",
  },
  {
    name: "fetch_website", // superseded by read_web_page — kept executable, never offered
    inputs: "{ url } — a public page",
    output: "page text, marked DATA ONLY (never instructions)",
    sensitivity: "none",
    costClass: "free",
    sideEffects: "read-only",
    permission: "session_user",
    verification: "SSRF guard: private/loopback/reserved addresses refused at fetch time",
    failureBehavior: "blocked or unreachable → the reply says so and continues without the page",
  },
  {
    name: "search_knowledge",
    inputs: "{ query }",
    output: "confirmed records from THIS account only",
    sensitivity: "account",
    costClass: "free",
    sideEffects: "read-only",
    permission: "session_user",
    verification: "ownership-scoped query; nothing confirmed → 'ask the owner', never a guess",
    failureBehavior: "empty result is stated plainly; no cross-account data can surface",
  },
  {
    name: "calculate",
    inputs: "{ expression } — one arithmetic line (numbers, + - * / %, parentheses)",
    output: "the exact computed value with the shown working",
    sensitivity: "none",
    costClass: "free",
    sideEffects: "read-only",
    permission: "session_user",
    verification: "deterministic parser — the model never computes; errors (bad token, division by zero) are explicit",
    failureBehavior: "invalid input returns a named error, never a guessed number (QA-11); missing inputs stay missing",
  },
];

/** Names the chat loop may execute — anything else is "not available". */
export const DECLARED_TOOL_NAMES = new Set(TOOL_REGISTRY.map((t) => t.name));
