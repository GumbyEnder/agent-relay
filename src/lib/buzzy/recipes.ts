/**
 * BZ-J04…J11 — business playbook recipes.
 *
 * A recipe is a tested job recipe, not a prompt with a label (07-Business-Playbooks).
 * Every recipe carries: the four universal statements, an output/audience/success
 * checklist, permitted sources, permitted tools, an executable output contract,
 * domain checks and a hard boundary. Boundaries are enforced deterministically —
 * prose in a prompt cannot grant permission.
 *
 * Checks reuse the existing playbook implementations via `playbook` (a key in
 * TYPE_PLAYBOOKS) so there is exactly one check implementation per domain.
 */

export interface RecipeChecklist {
  output: string;
  audience: string;
  success: string;
}

export interface Recipe {
  id: string;
  name: string;
  outcome: string;
  /** Key into TYPE_PLAYBOOKS (src/lib/buzzy/playbooks.ts) for guidance + checks. */
  playbook: string;
  /** Extra discovery, asked AFTER the four universal statements. */
  discovery: string[];
  checklist: RecipeChecklist;
  /** Where facts may come from. Nothing outside this list may be treated as evidence. */
  permittedSources: string[];
  /** Executable tools this recipe may use. Send/submit/file are never permitted. */
  tools: string[];
  /** What the artifact must contain. */
  outputContract: string[];
  /** Deterministic domain checks (assertions over the produced draft). */
  domainChecks: string[];
  /** What this recipe never does. Enforced by forbiddenClaimCheck + tool whitelist. */
  boundary: string;
  /** Claims that indicate the boundary was crossed. */
  forbiddenClaims: RegExp[];
  firstQuestion: string;
}

/** The four universal statements every BeeZilla recipe starts from. */
export const UNIVERSAL_STATEMENTS = [
  "challenge — the situation in the owner's own words",
  "difficulties — what makes it awkward, uncertain or limited",
  "who_is_involved — the parties and their roles",
  "end_goal — the result the owner wants",
] as const;

/** Tools no recipe may ever include. Content can never grant permission. */
const FORBIDDEN_TOOLS = /\b(send|email|submit|file|publish|pay|sign|wire|transfer)\b/i;

export const RECIPES: Recipe[] = [
  {
    id: "quote-comparison",
    name: "Supplier / vendor quote comparison",
    outcome: "Choose between quotes on comparable terms, with the gaps named.",
    playbook: "quote",
    discovery: [
      "Which quotes are in play, and what does each one cover",
      "Quantities and units you need them compared on",
      "What matters most: price, delivery time, warranty, or something else",
      "Any terms one supplier offered that another didn't",
    ],
    checklist: {
      output: "Sourced comparison table, missing-terms list, reasoned recommendation",
      audience: "The owner deciding which supplier to use",
      success: "Every number traceable to a quote, every gap labelled, recommendation justified",
    },
    permittedSources: ["quotes the owner supplied or imported", "the owner's stated selection criteria"],
    tools: ["calculator", "render_sheet", "render_document"],
    outputContract: ["comparison table with source column", "missing terms section", "recommendation with stated basis"],
    domainChecks: ["totals computed by the calculator, never typed", "units normalised across quotes", "unknowns marked, not filled"],
    boundary: "Never invents a price or a term. No supplier is contacted and nothing is ordered.",
    forbiddenClaims: [/\b(guaranteed lowest|we will order|placed the order|supplier confirmed)\b/i],
    firstQuestion: "Which quotes are you comparing, and what do you need them judged on?",
  },
  {
    id: "complaint-resolution",
    name: "Customer complaint resolution",
    outcome: "Answer the complaint with facts, options and no invented commitments.",
    playbook: "letter",
    discovery: [
      "What the customer actually said or wrote",
      "What happened, as far as you know it",
      "What your policy or authority allows you to offer",
      "What outcome you want: keep the customer, close it cleanly, or both",
    ],
    checklist: {
      output: "Response draft, issue timeline, proposed options",
      audience: "The customer, in your voice",
      success: "Facts separated from suggestions, no promise you haven't authorised",
    },
    permittedSources: ["the complaint text", "the owner's account of events", "the owner's policy/refund authority"],
    tools: ["render_document", "render_text_pdf"],
    outputContract: ["response draft", "issue timeline with dates sourced", "options list with what each requires"],
    domainChecks: ["facts vs suggestions labelled", "refund/credit amounts trace to stated authority", "dates trace to the supplied history"],
    boundary: "No invented admission, promise, refund or compensation. Sending needs separate approval.",
    forbiddenClaims: [/\b(we (apologise|apologize) and (will|shall) (refund|compensate)|guaranteed refund|on behalf of legal)\b/i],
    firstQuestion: "What did the customer say, and what are you willing to offer?",
  },
  {
    id: "meeting-action-pack",
    name: "Weekly operations / meeting action pack",
    outcome: "Turn notes into decisions, owners and a follow-up agenda.",
    playbook: "presentation",
    discovery: [
      "Which notes or transcript this comes from",
      "Who attended — only if actually recorded",
      "What decisions were actually made",
      "What needs to happen before the next meeting",
    ],
    checklist: {
      output: "Summary, decision list, owner/action list, follow-up agenda",
      audience: "The people who were in the room and those who weren't",
      success: "Recorded decisions distinct from proposed actions; every action has a name against it",
    },
    permittedSources: ["the supplied notes/transcript", "the owner's confirmations"],
    tools: ["render_document", "render_sheet"],
    outputContract: ["summary", "decisions (recorded vs proposed)", "actions with owners and dates", "next agenda"],
    domainChecks: ["every action has an owner", "no attendance asserted absent from the source", "privacy: names only from the source"],
    boundary: "Never infers who attended, and never invents a decision nobody recorded.",
    forbiddenClaims: [/\b(all attendees agreed|everyone present|unanimously approved)\b/i],
    firstQuestion: "Whose notes are these, and what was decided?",
  },
  {
    id: "bookkeeping-prep",
    name: "Bookkeeping preparation",
    outcome: "Hand the bookkeeper a clean, categorised worksheet with the gaps named.",
    playbook: "invoice",
    discovery: [
      "The period and the transaction data you have",
      "Your approved category rules",
      "Any instructions from your accountant",
      "What's missing: receipts, statements, or explanations",
    ],
    checklist: {
      output: "Categorised worksheet, missing-receipt checklist, questions for the bookkeeper",
      audience: "The bookkeeper or accountant",
      success: "Totals calculated and reconciled, every uncategorised item flagged",
    },
    permittedSources: ["supplied transactions", "the owner's category rules", "accountant instructions"],
    tools: ["calculator", "render_sheet"],
    outputContract: ["categorised worksheet", "reconciliation line", "missing-items checklist", "open questions"],
    domainChecks: ["totals computed and reconciled to the supplied source", "uncategorised items counted, not guessed", "no tax treatment asserted"],
    boundary: "No tax treatment guarantee and no filing. Needs qualified review before it's final.",
    forbiddenClaims: [/\b(tax (deductible|compliant)|guaranteed deduction|ready to file|filed)\b/i],
    firstQuestion: "What period is this for, and which transactions are we working with?",
  },
  {
    id: "campaign-brief",
    name: "Marketing campaign brief",
    outcome: "Brief the campaign with claims you can actually substantiate.",
    playbook: "proposal",
    discovery: [
      "The product or offer, exactly as it is",
      "Which claims you can evidence",
      "Who the audience is",
      "Which channels and what success looks like",
    ],
    checklist: {
      output: "Audience/message brief, channel drafts, asset checklist",
      audience: "Whoever produces the campaign",
      success: "Every claim traceable to supplied evidence; publishing clearly separate",
    },
    permittedSources: ["supplied product facts", "evidence the owner provided", "approved brand guidance"],
    tools: ["render_document"],
    outputContract: ["audience + message brief", "channel drafts", "asset checklist", "claims table with evidence"],
    domainChecks: ["each claim has an evidence row", "no testimonial or price not supplied", "publishing gate stated"],
    boundary: "No invented testimonials, prices or promises. Publishing is a later approval gate.",
    forbiddenClaims: [/\b(\"[^\"]{0,60}\" — (?:happy|satisfied) customer|best in the world|#1 rated|customers say)\b/i],
    firstQuestion: "What's the offer, and which claims can you actually prove?",
  },
  {
    id: "people-ops-paperwork",
    name: "People operations paperwork",
    outcome: "Produce onboarding/role/policy paperwork grounded in approved policy.",
    playbook: "letter",
    discovery: [
      "The role and what it's responsible for",
      "The policy that already exists and is approved",
      "The jurisdiction facts you actually know",
      "Which output is needed: onboarding checklist, role outline, or policy draft",
    ],
    checklist: {
      output: "Onboarding checklist, role outline or policy draft — per the agreed contract",
      audience: "The new hire or the manager responsible",
      success: "Nothing asserted beyond approved policy; legal questions escalated, not answered",
    },
    permittedSources: ["approved policy text", "the role description", "jurisdiction facts the owner supplied"],
    tools: ["render_document"],
    outputContract: ["chosen artifact", "policy traceability notes", "escalation list for legal questions"],
    domainChecks: ["every policy statement traced to approved text", "employment terms never fabricated", "legal questions listed as open"],
    boundary: "Never hires or fires anyone, never fabricates employment terms, never gives legal assurance.",
    forbiddenClaims: [/\b(you are (terminated|dismissed)|we have decided to (hire|fire)|legally (binding|compliant|safe))\b/i],
    firstQuestion: "What role or policy is this about, and what's already approved?",
  },
  {
    id: "grants-rfp",
    name: "Forms / grants / RFP assistance",
    outcome: "Answer the actual form, with every eligibility claim sourced or flagged.",
    playbook: "proposal",
    discovery: [
      "The form, RFP or grant you're responding to",
      "Eligibility facts you can point to",
      "Deadlines and who must sign",
      "Evidence you already have versus what's missing",
    ],
    checklist: {
      output: "Requirements checklist, draft responses, evidence-gap list",
      audience: "The funder, grant officer or procurement contact",
      success: "Every requirement answered or explicitly flagged; no qualification invented",
    },
    permittedSources: ["the supplied form/RFP", "the owner's evidence documents", "stated eligibility facts"],
    tools: ["render_document", "render_text_pdf"],
    outputContract: ["requirements checklist mapped to the form", "draft responses per requirement", "evidence gaps", "signature/deadline list"],
    domainChecks: ["each eligibility claim traced to a source or listed as a gap", "word/format limits respected", "no auto-submission"],
    boundary: "Never invents qualifications and never submits the form.",
    forbiddenClaims: [/\b(we (?:certify|confirm) (?:that )?we (?:meet|qualify)|submitted (?:the )?application|guaranteed (?:award|funding))\b/i],
    firstQuestion: "Which form or RFP is this, and what's the deadline?",
  },
  {
    id: "dispute-paperwork",
    name: "Insurance / service dispute paperwork",
    outcome: "Build a sourced appeal with a clear timeline and evidence list.",
    playbook: "letter",
    discovery: [
      "The policy, notice or decision you're disputing",
      "What the timeline shows, with dates",
      "The coverage or service facts you can point to",
      "The remedy you're asking for",
    ],
    checklist: {
      output: "Timeline, appeal draft, evidence list",
      audience: "The insurer or service provider's review team",
      success: "Every assertion sourced; sensitive data limited to what's needed",
    },
    permittedSources: ["the policy/notice text", "the owner's dated records", "stated coverage facts"],
    tools: ["render_document", "render_text_pdf"],
    outputContract: ["dated timeline", "appeal draft with sourced assertions", "evidence list", "what to redact"],
    domainChecks: ["each assertion has a source row", "sensitive identifiers minimised", "no outcome promised"],
    boundary: "No promised coverage or legal outcome, and no automatic filing.",
    forbiddenClaims: [/\b(coverage is (?:guaranteed|approved)|you will (?:win|be reimbursed)|we have filed)\b/i],
    firstQuestion: "What decision are you disputing, and what does the policy say?",
  },
];

export function getRecipe(id: string): Recipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

export interface RecipeViolation {
  recipeId: string;
  problem: string;
}

/** Structural validation — a recipe missing any required part is not configured. */
export function validateRecipe(r: Recipe): string[] {
  const problems: string[] = [];
  if (!r.id || !r.name || !r.outcome) problems.push("missing identity or outcome");
  if (!r.discovery?.length) problems.push("no discovery questions");
  if (!r.checklist?.output || !r.checklist?.audience || !r.checklist?.success) problems.push("checklist incomplete");
  if (!r.permittedSources?.length) problems.push("no permitted sources");
  if (!r.tools?.length) problems.push("no permitted tools");
  if (!r.outputContract?.length) problems.push("no output contract");
  if (!r.domainChecks?.length) problems.push("no domain checks");
  if (!r.boundary) problems.push("no boundary");
  if (!r.forbiddenClaims?.length) problems.push("no boundary enforcement");
  for (const t of r.tools ?? []) {
    if (FORBIDDEN_TOOLS.test(t)) problems.push(`tool outside boundary: ${t}`);
  }
  return problems;
}

/**
 * Boundary enforcement: does this draft cross the recipe's line? Returns the
 * matched claims so the refusal can quote what it caught.
 */
export function boundaryViolations(recipe: Recipe, draft: string): string[] {
  const hits: string[] = [];
  for (const re of recipe.forbiddenClaims) {
    const m = draft.match(re);
    if (m?.[0]) hits.push(m[0].slice(0, 120));
  }
  return hits;
}
