/**
 * Check the money before approval.
 * The page script is the check. This wrapper only types it and refuses a rewritten draft.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

export interface MoneyFact {
  key: string;
  label?: string;
  value: string;
  status: string;
  place?: string;
  source?: string;
}

export interface MoneyBriefLine {
  label?: string;
  value: string;
  status: "confirmed" | "skipped" | "open" | "proposed";
}

export interface MoneyCheckItem {
  tone: "match" | "blank" | "unconfirmed" | "wrong";
  text: string;
}

export interface MoneyCheck {
  items: MoneyCheckItem[];
  blocksApproval: boolean;
  /** The draft the owner already has. The check does not fill a blank. */
  draft: string;
}

export interface MoneyInput {
  draft: string;
  facts?: MoneyFact[];
  brief?: MoneyBriefLine[];
  kind?: string;
}

type CheckFn = (input: MoneyInput) => MoneyCheck;

let checkFn: CheckFn | null = null;

function loadCheck(): CheckFn {
  if (checkFn) return checkFn;
  const jsPath = join(dirname(fileURLToPath(import.meta.url)), "../../../public/buzzy/money-check.js");
  const code = readFileSync(jsPath, "utf8");
  const sandbox: { checkMoney?: CheckFn } = {};
  runInNewContext(code, sandbox, { filename: "money-check.js" });
  if (typeof sandbox.checkMoney !== "function") {
    throw new Error("money check missing");
  }
  checkFn = sandbox.checkMoney;
  return checkFn;
}

export function checkMoney(input: MoneyInput): MoneyCheck {
  const draft = typeof input.draft === "string" ? input.draft : "";
  const out = loadCheck()({ ...input, draft });
  const items = Array.isArray(out.items) ? out.items : [];
  return {
    items,
    blocksApproval: items.some((item) => item.tone === "wrong"),
    draft,
  };
}
