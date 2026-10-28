/**
 * The tool contract — ONE place that decides what the model may call.
 *
 * Before this file, the offered set was assembled by hand inside `chatLoop`
 * while the schemas lived in five modules and the policy (gating, side effects)
 * lived in prose. Three failure modes followed: a tool could be declared and
 * never offered, offered without a budget, or refused with the useless string
 * "not available" while the model invented a limitation to explain it.
 *
 * Rules this file enforces:
 *   - `offeredTools(ctx)` is the ONLY way the loop learns what to offer.
 *   - Every tool carries a wall-clock budget and a byte cap, applied by
 *     `withToolBudget` — a slow tool is a named failure, never a hang.
 *   - A declared-but-not-offered tool returns a plain-language refusal naming
 *     why, so the reply can say "not yet, because …" instead of "can't".
 *   - Adding a tool means adding ONE entry here plus its executor branch.
 */

import { CALCULATE_TOOL } from "./calc";
import { RENDER_DOCUMENT_TOOL, RENDER_PRESENTATION_TOOL, RENDER_SHEET_TOOL } from "./artifact";
import { LOOKUP_MARKET_RATE_TOOL, FETCH_WEBSITE_TOOL, SEARCH_KNOWLEDGE_TOOL } from "./info";
import { WEB_SEARCH_TOOL } from "./search";
import { READ_WEB_PAGE_TOOL } from "./webpage";

export type ToolGate = "always" | "draft";
export type ToolCost = "free" | "metered";
export type ToolSideEffect = "read-only" | "render-to-memory";

export interface ToolPolicy {
  name: string;
  /** OpenAI-style tool declaration handed to the model. */
  schema: unknown;
  /** `draft` tools are invisible until the draft gate opens. */
  gate: ToolGate;
  /** false = declared for documentation/back-compat, never offered. */
  offered: boolean;
  timeoutMs: number;
  maxResultBytes: number;
  cost: ToolCost;
  sideEffects: ToolSideEffect;
  /** Plain-language reason used when the tool is declared but withheld. */
  withheldReason?: string;
}

export const TOOL_POLICIES: ToolPolicy[] = [
  // ── Read-only, always offered ────────────────────────────────────────
  {
    name: "web_search",
    schema: WEB_SEARCH_TOOL,
    gate: "always",
    offered: true,
    timeoutMs: 9000,
    maxResultBytes: 12_000,
    cost: "metered",
    sideEffects: "read-only",
  },
  {
    name: "read_web_page",
    schema: READ_WEB_PAGE_TOOL,
    gate: "always",
    offered: true,
    timeoutMs: 38_000,
    maxResultBytes: 120_000,
    cost: "metered",
    sideEffects: "read-only",
  },
  {
    name: "lookup_market_rate",
    schema: LOOKUP_MARKET_RATE_TOOL,
    gate: "always",
    offered: true,
    timeoutMs: 3000,
    maxResultBytes: 4_000,
    cost: "free",
    sideEffects: "read-only",
  },
  {
    name: "search_knowledge",
    schema: SEARCH_KNOWLEDGE_TOOL,
    gate: "always",
    offered: true,
    timeoutMs: 6000,
    maxResultBytes: 12_000,
    cost: "free",
    sideEffects: "read-only",
  },
  {
    name: "calculate",
    schema: CALCULATE_TOOL,
    gate: "always",
    offered: true,
    timeoutMs: 2000,
    maxResultBytes: 2_000,
    cost: "free",
    sideEffects: "read-only",
  },
  // ── Superseded: kept executable, never offered ───────────────────────
  {
    name: "fetch_website",
    schema: FETCH_WEBSITE_TOOL,
    gate: "always",
    offered: false,
    timeoutMs: 12_000,
    maxResultBytes: 30_000,
    cost: "free",
    sideEffects: "read-only",
    withheldReason: "read_web_page replaces it (it fetches first, then renders when the page needs JavaScript).",
  },
  // ── Draft-gated renderers ────────────────────────────────────────────
  {
    name: "render_document",
    schema: RENDER_DOCUMENT_TOOL,
    gate: "draft",
    offered: true,
    timeoutMs: 20_000,
    maxResultBytes: 8_000,
    cost: "free",
    sideEffects: "render-to-memory",
    withheldReason:
      "the deliverable is not ready yet — the brief still needs the four decisions, or the owner must ask for the draft.",
  },
  {
    name: "render_presentation",
    schema: RENDER_PRESENTATION_TOOL,
    gate: "draft",
    offered: true,
    timeoutMs: 20_000,
    maxResultBytes: 8_000,
    cost: "free",
    sideEffects: "render-to-memory",
    withheldReason: "the deliverable is not ready yet — same gate as the document.",
  },
  {
    name: "render_sheet",
    schema: RENDER_SHEET_TOOL,
    gate: "draft",
    offered: true,
    timeoutMs: 20_000,
    maxResultBytes: 8_000,
    cost: "free",
    sideEffects: "render-to-memory",
    withheldReason: "the deliverable is not ready yet — same gate as the document.",
  },
];

export interface ToolContext {
  /** True once the brief is complete or the owner asked for the deliverable. */
  draftGateOpen: boolean;
}

/** The schemas the model is allowed to see on this turn. */
export function offeredTools(ctx: ToolContext): unknown[] {
  return TOOL_POLICIES.filter((p) => p.offered && (p.gate === "always" || ctx.draftGateOpen)).map((p) => p.schema);
}

export function offeredToolNames(ctx: ToolContext): string[] {
  return TOOL_POLICIES.filter((p) => p.offered && (p.gate === "always" || ctx.draftGateOpen)).map((p) => p.name);
}

export function policyFor(name: string): ToolPolicy | undefined {
  return TOOL_POLICIES.find((p) => p.name === name);
}

/**
 * Why a tool the model asked for is not available — in words a civilian can
 * read. Returns null when the tool is actually allowed right now.
 */
export function refusalFor(name: string, ctx: ToolContext): string | null {
  const policy = policyFor(name);
  if (!policy) return `${name} is not a tool BeeZilla has.`;
  if (!policy.offered) {
    return `${name} is not available in this conversation — ${policy.withheldReason ?? "it has been retired."}`;
  }
  if (policy.gate === "draft" && !ctx.draftGateOpen) {
    return `${name} is not available yet — ${policy.withheldReason ?? "the brief is not complete."}`;
  }
  return null;
}

export interface BudgetedResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  ms: number;
}

/**
 * Run one tool inside its declared budget. The timer is the contract: a tool
 * that exceeds it fails BY NAME rather than stalling the turn. The underlying
 * promise keeps running (we cannot cancel every provider call), but the turn
 * moves on and the caller reports the timeout.
 */
export async function withToolBudget<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<BudgetedResult<T>> {
  const policy = policyFor(name);
  const limit = policy?.timeoutMs ?? 15_000;
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} took longer than ${Math.round(limit / 1000)}s`)), limit);
      }),
    ]);
    return { ok: true, value, ms: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : `${name} failed`,
      ms: Date.now() - started,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Clamp a tool result to its declared byte cap, marking the elision. */
export function clampResult(name: string, text: string): string {
  const cap = policyFor(name)?.maxResultBytes ?? 30_000;
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n[... trimmed at ${cap} characters ...]`;
}
