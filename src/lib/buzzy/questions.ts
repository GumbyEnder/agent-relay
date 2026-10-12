/**
 * Buzzy — guided-question bank (ported from beezilla-adapter).
 *
 * Each question carries an id, civilian prompt, a skip-able default, and the
 * reason it matters (for the LLM system prompt, not the client).
 */

export interface BuzzyQuestion {
  id: string;
  prompt: string;
  default: string;
  why_it_changes_work: string;
  skip_if: string;
}

/** The full question bank in interview order. */
export const BUZZY_QUESTIONS: BuzzyQuestion[] = [
  {
    id: "what_happened",
    prompt:
      "What happened out there — which parts of the fence got damaged?",
    default: "Storm damage, full fence line affected.",
    why_it_changes_work:
      "The whole scope: a few sections vs. the full line is different work, different crew, different quote.",
    skip_if: "Customer says skip, doesn't know, or gives no answer.",
  },
  {
    id: "rough_size",
    prompt:
      "Roughly how much fence are we talking? Feet, or just 'about a backyard' is fine.",
    default: "Typical residential yard, single line.",
    why_it_changes_work:
      "Drives material quantities and whether one crew finishes in a day.",
    skip_if: "Customer says skip or can't estimate.",
  },
  {
    id: "material_supplier",
    prompt: "Who's getting the materials — you or the contractor?",
    default: "Contractor supplies.",
    why_it_changes_work:
      "Splits every quote into labor-only vs. labor-plus-materials; without it, quotes can't be compared.",
    skip_if: "Customer says skip or doesn't know.",
  },
  {
    id: "budget_range",
    prompt: "Got a budget range in mind? Ballpark is fine.",
    default: "No stated budget — quotes will define it.",
    why_it_changes_work:
      "A range steers the SOW away from work the customer won't pay for.",
    skip_if: "Customer says skip or prefers not to say.",
  },
  {
    id: "timing",
    prompt: "When do you need this done by?",
    default: "Flexible timing.",
    why_it_changes_work:
      "A hard deadline is the difference between a quote and a bid.",
    skip_if: "Customer says skip or whenever works.",
  },
  {
    id: "done_right_check",
    prompt:
      "How will you know when it's done right — what would you check?",
    default: "Fence straight, panels secure, gates work.",
    why_it_changes_work:
      "Acceptance criteria: the customer's own words go into the completion terms.",
    skip_if: "Customer says skip or shrugs.",
  },
  {
    id: "quote_count",
    prompt:
      "Getting quotes from a few contractors, or just this one?",
    default: "Comparing quotes — itemized.",
    why_it_changes_work:
      "Determines whether the SOW needs line-item granularity for apples-to-apples comparison.",
    skip_if: "Customer says skip or unsure.",
  },
  {
    id: "exclusions",
    prompt: "Anything you definitely don't want done?",
    default: "No exclusions.",
    why_it_changes_work:
      "Exclusions belong in the SOW, not in a dispute afterward.",
    skip_if: "Customer says skip or no.",
  },
];

// ── Decisions Made statements (structured problem breakdown) ──────────
// The four civilian statements every job definition must capture. Rides the
// same slot storage (buzzy_user_memory) and [slot: value] extraction as the
// question bank; each is explicitly skippable. Structure guides, never gates.
export interface BuzzyStatement {
  id: string;
  label: string;
  hint: string;
}

export const BUZZY_STATEMENTS: BuzzyStatement[] = [
  {
    id: "challenge",
    label: "The Challenge",
    hint: "What's wrong — one plain sentence.",
  },
  {
    id: "difficulties",
    label: "Difficulties",
    hint: "What makes it hard.",
  },
  {
    id: "who_involved",
    label: "Who is involved",
    hint: "People or parties affected.",
  },
  {
    id: "end_goal",
    label: "What is the end goal",
    hint: "The outcome you want.",
  },
];

/** The four statements appended to the question slots (required, skippable). */
export const STATEMENT_IDS = BUZZY_STATEMENTS.map((s) => s.id);

/** All slot ids in order. */
export const SLOT_IDS = [...BUZZY_QUESTIONS.map((q) => q.id), ...STATEMENT_IDS];

/** Required slot ids (all of them for Phase 1). */
export const REQUIRED_SLOTS = SLOT_IDS;
