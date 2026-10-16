/**
 * Check a promise before approval.
 * The page script is the check. This wrapper only types it and refuses a rewritten draft.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

export interface PromiseItem {
  tone: "promise" | "accepted";
  kind: string;
  text: string;
  reason: string;
  accepted: boolean;
}

export interface PromiseCheck {
  items: PromiseItem[];
  blocksApproval: boolean;
  /** The draft the owner already has. The check does not add or soften a promise. */
  draft: string;
}

export interface PromiseInput {
  draft: string;
  accepted?: string[];
}

type CheckFn = (input: PromiseInput) => PromiseCheck;

let checkFn: CheckFn | null = null;

function loadCheck(): CheckFn {
  if (checkFn) return checkFn;
  const jsPath = join(dirname(fileURLToPath(import.meta.url)), "../../../public/buzzy/promise-check.js");
  const code = readFileSync(jsPath, "utf8");
  const sandbox: { checkPromise?: CheckFn } = {};
  runInNewContext(code, sandbox, { filename: "promise-check.js" });
  if (typeof sandbox.checkPromise !== "function") {
    throw new Error("promise check missing");
  }
  checkFn = sandbox.checkPromise;
  return checkFn;
}

export function checkPromise(input: PromiseInput): PromiseCheck {
  const draft = typeof input.draft === "string" ? input.draft : "";
  const accepted = Array.isArray(input.accepted)
    ? input.accepted.filter((row): row is string => typeof row === "string")
    : [];
  const out = loadCheck()({ draft, accepted });
  const items = Array.isArray(out.items) ? out.items : [];
  return {
    items,
    blocksApproval: items.some((item) => item.accepted !== true),
    draft,
  };
}
