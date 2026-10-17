/**
 * BZ-F028 — three fully working starter journeys.
 *
 * The owner starts from an OUTCOME, not an expert shelf or a taxonomy quiz.
 * Each starter declares its human outcome, the discovery questions that
 * actually change the work, the outputs that get retained, the checks that
 * must pass, and the boundary (what this never does by itself). Checks reuse
 * the existing playbook implementations (src/lib/buzzy/playbooks.ts) rather
 * than duplicating them.
 */

export interface Starter {
  id: string;
  name: string;
  outcome: string;
  /** Playbook type whose guidance/checks apply (see TYPE_PLAYBOOKS). */
  playbook: string;
  discovery: string[];
  outputs: string[];
  requiredChecks: string[];
  boundary: string;
  /** First question shown when the journey starts. */
  firstQuestion: string;
}

export const STARTERS: Starter[] = [
  {
    id: "overdue-reminder",
    name: "Polite overdue-payment reminder",
    outcome: "Recover the payment while keeping the customer relationship.",
    playbook: "invoice",
    discovery: [
      "The invoice facts: who it's from and to, amount, invoice date, due date",
      "Who will read the reminder (the customer, their bookkeeper, someone else)",
      "Any previous contact about this payment",
      "The tone you want — friendly nudge or firm final notice",
      "What you want them to do after reading it",
    ],
    outputs: [
      "Editable reminder text",
      "A PDF copy of the reminder",
      "A factual decision note: amount, date, parties, what was agreed",
    ],
    requiredChecks: [
      "Amount and date accuracy against the invoice you filed",
      "Parties named correctly",
      "No invented penalty, late fee, or promise",
    ],
    boundary: "Draft only — sending it is a separate, separately approved action. Not legal advice.",
    firstQuestion: "What's the invoice — who's it from and to, the amount, and when was it due?",
  },
  {
    id: "customer-proposal",
    name: "Customer proposal / scope of work",
    outcome: "Win or clarify the job without ambiguous commitments.",
    playbook: "proposal",
    discovery: [
      "Who's reading it and what they need to decide",
      "What's in scope — and explicitly what is not",
      "Your supplied price or assumptions (never invented)",
      "Timing: start, milestones, completion",
      "How acceptance happens",
    ],
    outputs: [
      "A proposal document",
      "A line-item table when there is pricing",
      "A scope + next-steps sheet",
    ],
    requiredChecks: [
      "Line items add up to the stated total (computed, not guessed)",
      "Supplied facts stay as supplied — no invented numbers",
      "Scope and exclusions agree with each other",
      "Unknowns are named, not fabricated",
    ],
    boundary: "Not legal advice. No fabricated offer or contract acceptance — you approve the final scope.",
    firstQuestion: "Who is this proposal for, and what do they need to decide?",
  },
  {
    id: "team-handover",
    name: "Team handover / operating checklist",
    outcome: "Make responsibilities and next steps clear to whoever picks this up.",
    playbook: "proposal",
    discovery: [
      "Who uses this handover and what they already know",
      "The work sequence: what happens, in what order",
      "Who owns each step",
      "Deadlines and dependencies",
      "Risks and what to escalate",
    ],
    outputs: [
      "A handover document",
      "An action checklist",
      "An open-questions list",
    ],
    requiredChecks: [
      "Every step has an owner",
      "Sequence is complete and consistent",
      "Unsafe or regulated guidance is excluded, not improvised",
    ],
    boundary: "No invented decisions, attendance, or safety procedures — anything unknown stays an open question.",
    firstQuestion: "Who is this handover for, and what are they taking over?",
  },
];

export function getStarter(id: string): Starter | undefined {
  return STARTERS.find((s) => s.id === id);
}
