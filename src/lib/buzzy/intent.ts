/**
 * What the person is asking FOR — intent detection that opens the draft gate.
 *
 * This lives in its own module because it is policy, not plumbing: whether a
 * message counts as "make me a file" decides whether the render tools are
 * offered at all. When it is wrong, the model has nothing to call and improvises
 * a limitation ("I can't save files"), which is the failure this file exists to
 * prevent.
 *
 * The rule: a person asking to save, keep, export or write something to a file
 * means a deliverable — even when they never name a format. "Research this and
 * save it in the file" is the canonical phrasing and it used to fall through.
 */

/** Any request that should produce a file in the Library. */
export function isFileRequest(message: string): boolean {
  const m = String(message || "");
  return (
    // save/put/write/export … (within a clause) … file/doc/library/format
    /\b(save|store|put|add|write|export|download|keep)\b[^.\n]{0,48}\b(file|files|library|doc|docs|documents?|pdf|docx?|word|markdown|md|csv|sheet|spreadsheet)\b/i.test(m) ||
    // "save it", "export this", "save the summary"
    /\b(save|export)\s+(it|this|that|the\s+(note|summary|result|list|report|research))\b/i.test(m) ||
    // "make/create/give me a file/document/report"
    /\b(make|create|produce|give me|put (it|this) in)\b[^.\n]{0,24}\b(a\s+)?(file|document|doc|report)\b/i.test(m) ||
    // "as a PDF", "in a .docx" — a named format is a file request on its own
    /\b(as|in)\s+(an?\s+)?\.?(md|markdown|pdf|docx?|word|csv|xlsx?|sheet)\b/i.test(m) ||
    /\bsave (a )?copy\b/i.test(m)
  );
}

/**
 * "Stop asking and do it."
 *
 * A person who has to say this twice has already lost an argument with the
 * product. The failure it names is real: the scripted next question and the
 * plan-then-confirm step both outranked the owner's own instruction, so a
 * complete brief still produced "got a budget in mind?" and "does this plan
 * look right?".
 *
 * This is deliberately its own signal rather than more regex in isDraftRequest:
 * it must ALSO suppress the interview question and the plan-first step, not just
 * open the draft gate. Refusing to act on it is never the safer choice — a
 * half-brief with the unknowns marked beats a brief that never ships.
 */
export function isExecuteCommand(message: string): boolean {
  const m = String(message || "");
  return (
    /\b(no more (questions|confirmations?)|stop asking|quit asking|don'?t ask (me )?(any ?more|again)|no (further )?questions)\b/i.test(m) ||
    /\b(just do it|just do the work|do the work|get on with it|start (now|working|generating|building)|begin (now|working)|go ahead and (do|start|build|make))\b/i.test(m) ||
    /\b(i (already )?(told|gave|answered)|already (answered|provided|gave|done the planning)|as i (said|mentioned))\b/i.test(m) ||
    /\b(skip the (questions|interview|plan)|enough (questions|planning)|stop (planning|confirming))\b/i.test(m)
  );
}

/**
 * A request to actually MAKE audio — not to talk about it.
 *
 * Strict on purpose: the verb and the audio noun have to be in the same clause, so
 * "what tempo should a pad be?" asks a question while "make me a pad at 60 BPM"
 * asks for a file. The model cannot be trusted to notice the difference often
 * enough: it answered "the player is attached below" twice with nothing generated.
 */
export function isMusicRequest(message: string): boolean {
  const m = String(message || "");
  // The noun list is deliberately wide: "just make me a lullaby about ducks"
  // matched nothing, so the music pre-pass never ran and the model answered
  // "I can't save audio files directly here" — a denial of a capability we sell.
  const NOUN = "(song|track|music|jingle|score|beat|soundtrack|instrumental|pad|loop|soundscape|melody|lullaby|tune|ballad|hymn|anthem|serenade|ditty|sting|underscore|theme|ambient|drone|remix|rap|chorus|riff)";
  if (new RegExp(`\\b(make|create|generate|produce|compose|write|build|give me|sing)\\b[^.\\n]{0,60}\\b${NOUN}\\b`, "i").test(m)) return true;
  // "let's start now the lyrics should be about a sad little duck" — the request was
  // in the previous turn; this one only says "begin". A start verb plus a music noun
  // in the same sentence is the same instruction in fewer words.
  if (new RegExp(`\\b(let'?s (start|begin|do it|go)|start now|go ahead|do it now|make it now)\\b[^.\\n]{0,80}\\b${NOUN}\\b`, "i").test(m)) return true;
  return false;
}

/** A deliverable request in the owner's own words (not only "file" phrasing). */
export function isDraftRequest(message: string): boolean {
  if (isFileRequest(message)) return true;
  // "stop asking, just do it" is a request to execute, not a question to answer.
  if (isExecuteCommand(message)) return true;
  const m = String(message || "");
  // A song is a thing to make, not a question to answer: without this the draft
  // gate stayed shut, the music tool was never offered, and the model filled the
  // silence with "the track is in your Library".
  if (/\b(make|create|generate|produce|compose|write|build)\b[^.\n]{0,40}\b(song|track|music|jingle|score|beat|soundtrack|instrumental)\b/i.test(m)) {
    return true;
  }
  return /\b(write it up|just write|go ahead|draft it|that'?s enough|finalize|whenever you'?re ready)\b/i.test(m);
}

/**
 * An EDIT to the document already on file — as opposed to a question asked
 * while a document happens to be on file.
 *
 * This exists because "is this a draft conversation" and "did this turn touch
 * the deliverable" are different questions. A conversation that produced a
 * draft keeps its draft for every later turn; without a separate signal, every
 * later turn — including "what is a fence quote?" — was materialised as a new
 * version of that document.
 *
 * The bar is two things at once: an edit verb AND a reference to the artifact.
 * Bare "make it shorter" is enough (the artifact is the only "it" in the room);
 * "what does it cost?" is not, because there is no edit verb. It is only ever
 * consulted when a draft already exists, so a false positive can cost one
 * version, never a document in a fresh chat.
 */
export function isRevisionRequest(message: string): boolean {
  const m = String(message || "");
  if (isDraftRequest(m)) return false; // already covered by the request gate
  // A question ABOUT the work ("what should I add to the quote?") is not an
  // edit to it. A polite request ("can you make the intro shorter?") is.
  if (/^\s*(what|why|how|who|when|where|which|is|are|does|do|did|should)\b/i.test(m)) return false;
  const EDIT =
    /\b(make|change|shorten|lengthen|add|remove|delete|cut|trim|replace|rewrite|reword|edit|update|fix|tweak|adjust|expand|tighten|soften|simplify|reorder|split|merge|reformat|swap|drop|keep|turn)\b/i;
  const ARTIFACT =
    /\b(it|this|that|(?:the|a|an|my|our|your)\s+(?:\w+\s+){0,2}(?:draft|document|doc|letter|email|note|quote|proposal|report|memo|version|wording|opening|intro|introduction|body|copy|text|section|paragraph|line|sentence|heading|title|list|closing|sign-?off|price|amount)s?)\b/i;
  return EDIT.test(m) && ARTIFACT.test(m);
}

/**
 * Did THIS turn deliver a document?
 *
 * The draft gate ("may this conversation produce a document?") is deliberately
 * separate from this question. The gate opens on state the conversation already
 * carries — all four decisions captured (possibly inherited from memory that is
 * not this conversation's), or a job that already holds a draft — and it stays
 * open for every later turn. Materialising off the gate is what put a Download
 * card under "Reply with exactly: pong" and grew one Library folder to eleven
 * versions, one per chat message.
 *
 * Every case below is a turn that actually produced the deliverable:
 *   - the render tool ran  → the owner has a file, the card is how he gets it;
 *   - the owner asked for it now ("save it in the file", "write it up");
 *   - Work mode with the gate open → the brief IS the product, each turn revises;
 *   - an edit to the draft on file ("make the second paragraph shorter").
 * Nothing else. A conversational answer is answerable in chat and is not a file.
 */
export function producesDeliverable(input: {
  renderedDocText: string | null;
  requestedDraft: boolean;
  mode: "chat" | "work";
  draftGateOpen: boolean;
  hasExistingDraft: boolean;
  message: string;
}): boolean {
  return (
    !!input.renderedDocText ||
    input.requestedDraft ||
    (input.mode === "work" && input.draftGateOpen) ||
    (input.hasExistingDraft && isRevisionRequest(input.message))
  );
}

/**
 * When the file is named explicitly, the harness forces `render_document`
 * rather than hoping the model chooses it. glm-class models treat an optional
 * tool as optional.
 */
export function isExplicitDocumentRequest(message: string): boolean {
  const m = String(message || "");
  return (
    /\b(word document|\.docx|actual document|make the (file|document)|produce the (file|document)|as a (file|document|word)|download(able)? (file|document))\b/i.test(m) ||
    /\b(save|put|write|export)\b[^.\n]{0,40}\b(file|document|doc)\b/i.test(m) ||
    // "as a .docx", "in a PDF" — the format itself is the explicit request.
    /\b(as|in)\s+(an?\s+)?\.?(md|markdown|pdf|docx?|word|csv|xlsx?)\b/i.test(m)
  );
}

/**
 * Is this a request to DRAW something?
 *
 * Same discipline as music: a verb of making plus an image noun in the same clause.
 * "how do I draw a circle in CSS" asks a question; "draw me a duck in a pond" asks
 * for a file. The harness performs the render — the model cannot be relied on to
 * choose a tool, which is how the music lane produced four turns of promises.
 */
export function isImageRequest(message: string): boolean {
  const m = String(message || "");
  const NOUN = "(image|picture|illustration|drawing|logo|poster|artwork|art|thumbnail|icon|banner|mockup|render|scene)";
  if (new RegExp(`\\b(draw|paint|sketch|illustrate|render|generate|make|create|design)\\b[^.\\n]{0,40}\\b${NOUN}\\b`, "i").test(m)) return true;
  // "draw me a duck" — the noun is the subject, not the object of "of".
  return /\b(draw|paint|sketch|illustrate)\s+(me\s+)?(a|an|the|some)\b[^.\n]{0,60}/i.test(m);
}
