/**
 * Buzzy per-type playbooks (plan doc 23, "per-type depth").
 *
 * DATA, not code paths: each job type declares its extra discovery questions,
 * preferred artifact shape, and built-in approval-time checks. Adding a type
 * is adding an entry — never a branch. No playbook can grow special-case
 * behavior that skips the approval gate.
 *
 * The four core decisions (challenge/difficulties/who_involved/end_goal)
 * stay universal and FIRST; playbook questions slot in after them.
 */

export interface PlaybookQuestion {
  /** Slot id for memory (extends REQUIRED/DEEPENING slots for this job only). */
  id: string;
  prompt: string;
}

export interface PlaybookCheck {
  /** Run at approval time; verdict surfaces in the "I checked" lines. */
  id: string;
  label: string;
  /** Deterministic check against the draft + owner text. */
  run: (draft: string, ownerText: string) => { verdict: "verified" | "stated" | "warning"; detail: string };
}

export interface Playbook {
  /** Civilian name the harness uses for this kind of work. */
  name: string;
  /** Extra discovery questions, asked after the core four. */
  extraQuestions: PlaybookQuestion[];
  /** Preferred artifact shape for render_document/render_sheet/render_presentation. */
  artifactHint: string;
  /** Mandatory draft language (e.g. the not-a-lawyer note). */
  requiredPhrases?: Array<{ phrase: RegExp; note: string }>;
  /** Optional per-type checks beyond the universal three. */
  checks?: PlaybookCheck[];
  /** Recipient register hint for the draft (artifact register, not harness register). */
  registerHint?: string;
}

/** Deterministic per-type checks — same standard as reviewDraft's universal three. */
function moneyMathCheck(draft: string): { verdict: "verified" | "stated" | "warning"; detail: string } {
  // Price math in the draft is renderer-computed when produced via render_sheet;
  // in plain drafts, flag amounts that look like totals the model may have summed.
  const totals = draft.match(/\btotal(?:ing)?[^.\n]*\$?\s?[0-9][0-9,]*(?:\.[0-9]{2})?/gi);
  return {
    verdict: totals && totals.length > 0 ? "warning" : "stated",
    detail: totals?.length
      ? "Draft states totals in prose — prefer the Excel renderer so the math is computed, not typed."
      : "No prose totals — price math is safe.",
  };
}

function clausesTracedCheck(draft: string, ownerText: string): { verdict: "verified" | "stated" | "warning"; detail: string } {
  // A contract clause is 'traced' when its key nouns appear in what the owner said.
  const clauseWords = draft.match(/\b([A-Z][a-z]+(?:ty|ment|nce|tion))\b/g) ?? [];
  const owner = ownerText.toLowerCase();
  const untraced = clauseWords.filter((w) => !owner.includes(w.toLowerCase()));
  return {
    verdict: untraced.length > 6 ? "warning" : "verified",
    detail:
      untraced.length > 6
        ? "Several terms don't trace to anything you said — review each before signing anything."
        : "Clauses trace to your statements.",
  };
}

function payRangeCheck(draft: string, ownerText: string): { verdict: "verified" | "stated" | "warning"; detail: string } {
  const hasPay = /\$\s?[0-9]|[0-9]+k\b/i.test(draft);
  const ownerStated = /\$\s?[0-9]|[0-9]+k\b|salary|pay range|hourly/i.test(ownerText);
  return {
    verdict: !hasPay ? "stated" : ownerStated ? "verified" : "warning",
    detail: !hasPay
      ? "No pay figures included."
      : ownerStated
        ? "Pay figures came from you."
        : "Pay figures appear without you stating them — remove or confirm them.",
  };
}

function lengthCheck(maxWords: number) {
  return (draft: string): { verdict: "verified" | "stated" | "warning"; detail: string } => {
    const words = draft.split(/\s+/).filter(Boolean).length;
    return {
      verdict: words <= maxWords ? "verified" : "warning",
      detail:
        words <= maxWords
          ? `Length is fine (${words} words).`
          : `This runs ${words} words — letters that go on are letters that get skimmed. Tighten it.`,
    };
  };
}

export const TYPE_PLAYBOOKS: Record<string, Playbook> = {
  quote: {
    name: "a quote",
    extraQuestions: [
      { id: "scope_exclusions", prompt: "What is NOT included in this price?" },
      { id: "payment_schedule", prompt: "How do you want to be paid — deposit, milestones, on completion?" },
      { id: "price_holds", prompt: "How long does this price hold?" },
    ],
    artifactHint: "One-page .docx plus a line-item .xlsx — use render_sheet for the numbers so the math is computed.",
    checks: [{ id: "price_math", label: "Price math", run: moneyMathCheck }],
  },
  contract: {
    name: "an agreement",
    extraQuestions: [
      { id: "signing_parties", prompt: "Who signs this — you, and who on their side?" },
      { id: "cancellation", prompt: "What happens if either side cancels?" },
    ],
    artifactHint: "Formal .docx in the recipient's register — this document speaks to a lawyer, not to you.",
    requiredPhrases: [{ phrase: /not a lawyer|not legal advice/i, note: "The 'I'm not a lawyer' note is mandatory on agreements." }],
    checks: [{ id: "clauses_traced", label: "Clauses", run: clausesTracedCheck }],
    registerHint: "Formal, precise, recipient-facing.",
  },
  proposal: {
    name: "a proposal",
    extraQuestions: [
      { id: "decision_maker", prompt: "Who makes the final call on this?" },
      { id: "deadline", prompt: "When do they need to decide by?" },
      { id: "alternatives", prompt: "What else are they considering, if you know?" },
    ],
    artifactHint: "Multi-section .docx; offer a .pptx summary when the audience will present it.",
    checks: [],
  },
  invoice: {
    name: "an invoice",
    extraQuestions: [
      { id: "tax_treatment", prompt: "How do you handle tax on this — rate and what it applies to?" },
      { id: "due_date", prompt: "When is payment due?" },
      { id: "late_fee", prompt: "Any late-fee policy to state?" },
    ],
    artifactHint: ".xlsx primary via render_sheet (the renderer computes tax and totals — never type totals in prose), .docx cover note optional.",
    checks: [{ id: "price_math", label: "Price math", run: moneyMathCheck }],
  },
  letter: {
    name: "a letter",
    extraQuestions: [
      { id: "recipient_relationship", prompt: "How well do you know the recipient?" },
      { id: "desired_outcome", prompt: "What should they do after reading it?" },
    ],
    artifactHint: "Plain .docx — short enough to read on a phone.",
    checks: [{ id: "length", label: "Length", run: lengthCheck(350) }],
  },
  job_posting: {
    name: "a job description",
    extraQuestions: [
      { id: "posting_venue", prompt: "Where will this be posted?" },
      { id: "must_haves", prompt: "Must-haves versus nice-to-haves?" },
    ],
    artifactHint: ".docx with clear sections.",
    checks: [{ id: "pay_range", label: "Pay range", run: payRangeCheck }],
  },
  presentation: {
    name: "a presentation",
    extraQuestions: [
      { id: "audience", prompt: "Who will see this?" },
      { id: "occasion", prompt: "What's the occasion?" },
      { id: "length", prompt: "How long should it run — how many slides or minutes?" },
      { id: "decision", prompt: "What must the audience decide or do after?" },
    ],
    artifactHint: ".pptx via render_presentation — respect the stated slide count (hard cap 30).",
    checks: [],
  },
};

/** Civilian guidance block appended to the system prompt for this job type. */
export function playbookGuidance(jobType: string): string {
  const pb = TYPE_PLAYBOOKS[jobType];
  if (!pb) return "";
  let out = `\n\nThis is ${pb.name} work.`;
  if (pb.extraQuestions.length) {
    out += ` After the four core decisions, also find out: ${pb.extraQuestions.map((q) => q.prompt).join(" ")}`;
  }
  out += ` Deliverable shape: ${pb.artifactHint}`;
  if (pb.registerHint) out += `. Register: ${pb.registerHint}`;
  for (const rp of pb.requiredPhrases ?? []) {
    out += ` REQUIRED in the draft: ${rp.note}`;
  }
  return out;
}

/** Extra approval-time checks for this type, run alongside the universal three. */
export function playbookChecks(jobType: string): PlaybookCheck[] {
  return TYPE_PLAYBOOKS[jobType]?.checks ?? [];
}

/** Extra slot ids this playbook wants captured (for memory keying). */
export function playbookSlotIds(jobType: string): string[] {
  return (TYPE_PLAYBOOKS[jobType]?.extraQuestions ?? []).map((q) => q.id);
}
