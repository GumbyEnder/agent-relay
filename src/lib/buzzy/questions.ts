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
  /** The concrete question to ask the client to surface this statement. */
  prompt: string;
}

export const BUZZY_STATEMENTS: BuzzyStatement[] = [
  {
    id: "challenge",
    label: "The Challenge",
    hint: "What's wrong — one plain sentence.",
    prompt: "What's the situation or problem you need solved, in one plain sentence?",
  },
  {
    id: "difficulties",
    label: "Difficulties",
    hint: "What makes it hard.",
    prompt: "What's making this hard or risky right now?",
  },
  {
    id: "who_involved",
    label: "Who is involved",
    hint: "People or parties affected.",
    prompt: "Who's involved — who does this affect, besides you?",
  },
  {
    id: "end_goal",
    label: "What is the end goal",
    hint: "The outcome you want.",
    prompt: "What does 'done right' look like — what outcome are you after?",
  },
];

/** The four statements appended to the question slots (required, skippable). */
export const STATEMENT_IDS = BUZZY_STATEMENTS.map((s) => s.id);

/** All slot ids in order. */
export const SLOT_IDS = [...BUZZY_QUESTIONS.map((q) => q.id), ...STATEMENT_IDS];

/** Required slot ids — the discovery statements every job must capture
 *  through conversation (challenge, difficulties, who, end goal). The
 *  Decisions Made box starts empty and fills as the agent extracts each. */
export const REQUIRED_SLOTS = STATEMENT_IDS;

/** Universal practical questions asked AFTER the four decisions are captured.
 *  Budget / timing / done-right / exclusions generalize to most jobs; the
 *  fence-specific ones (what_happened, rough_size, material_supplier,
 *  quote_count) do not, so they stay out of the guided flow. */
export const DEEPENING_IDS = ["budget_range", "timing", "done_right_check", "exclusions"];

// ── Job-type classification (draft guidance only, never a gate) ──────
export type JobType =
  | "legal"
  | "creative"
  | "technical"
  | "marketing"
  | "operations"
  | "general";

export function classifyJobType(text: string): JobType {
  const t = (text || "").toLowerCase();
  if (/\b(lawyer|legal|demand letter|cease and desist|lawsuit|court|contract|terms|liability|compliance|notice|agreement|tenant|landlord|settlement)\b/.test(t)) return "legal";
  if (/\b(copy|brand|logo|design|social media|post|content|slogan|name|story|video|flyer|creative|commercial)\b/.test(t)) return "creative";
  if (/\b(app|software|website|api|database|server|code|bug|integration|automation|data|spreadsheet|csv|script|technical|frontend|backend)\b/.test(t)) return "technical";
  if (/\b(campaign|advert|marketing|audience|launch|seo|funnel|lead gen|sales|newsletter|promotion|growth|blurb)\b/.test(t)) return "marketing";
  if (/\b(hire|staff|schedule|process|workflow|inventory|order|supplier|logistics|procedure|policy|training|onboard|operations)\b/.test(t)) return "operations";
  return "general";
}

/** Draft-shaping hint per job type, appended to the draft guidance only. */
export const TYPE_DRAFT_HINTS: Record<JobType, string> = {
  legal:
    "Identify the parties, the exact demand or obligation, the deadline, and any amount owed — and add a plain-language line that this is a draft, not legal advice.",
  creative:
    "Pin the tone and audience (voice, who reads it, where it lives) so the deliverable drops straight into the real medium.",
  technical:
    "State input, output, and constraints concretely (data, tools, success check) and flag anything an engineer must confirm.",
  marketing:
    "Name the audience, the channel, and the one metric that shows it worked — and tie scope to the budget.",
  operations:
    "Capture the current step, the exact thing that's broken, the owner, and the definition of done so the change is unambiguous.",
  general: "",
};

/**
 * BZ-F011 — expert suggestion from intent. Maps a confidently-classified job
 * type to a REAL entry in the Experts registry (public/buzzy/experts.html);
 * types without an honest domain mapping stay silent — a suggestion is only
 * ever surfaced when the registry actually has the specialty. The `reason`
 * is the plain-language "why" the handoff card shows the owner.
 */
export const EXPERT_SUGGESTIONS: Partial<Record<JobType, { id: string; name: string; reason: string }>> = {
  legal: {
    id: "legal",
    name: "Legal",
    reason: "A contracts review is useful before an agreement or letter like this is finalized.",
  },
  technical: {
    id: "software",
    name: "Software",
    reason: "A software specialist can sanity-check the approach, the risks, and the success criteria.",
  },
};
