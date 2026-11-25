/**
 * The sentence a picture turn is allowed to end on.
 *
 * Measured live on 2026-11-17 (production 4bf4ec26, beezilla.net):
 *
 *   "draw me a lighthouse at dusk"  →  GET image asset 8283 was stored and
 *   returned in the envelope, and the model answered
 *   "I can't draw or create images directly here."
 *
 *   "draw me a duck"                →  asset 8282 stored, and the text lane
 *   answered with a fabricated tool call:
 *   {"action":"dalle.text2im","action_input":"…","thought":"…"}
 *
 * Both lanes had the pre-pass note in the SYSTEM message ("An image has ALREADY
 * been rendered this turn"). It was there and it was ignored — a note in the
 * oldest part of the context loses to the model's own idea of itself. A note
 * pushed AFTER the owner's message was obeyed by both models in isolation, so
 * server.ts now does that too; these checks are the guarantee underneath it,
 * because a capability the product sells cannot depend on the model agreeing.
 *
 * A picture that exists is a fact. The reply does not get to deny it, and a
 * blob of JSON is not a sentence a person can read.
 */

/** "I can't create images", "I'm unable to generate pictures" — a denial. */
const DENIAL =
  /\b(can(?:'|no)?t|cannot|can not|unable|not able)\b[^.!?\n]{0,70}\b(draw|create|generate|make|produce|render|do)\b[^.!?\n]{0,40}\b(images?|pictures?|illustrations?|artwork|graphics?|drawings?)\b/i;

/** "I don't have the ability to make images" — the same denial, one step back. */
const NO_ABILITY =
  /\b(no|don(?:'|o)?t have (?:any )?)(?:the )?(ability|capability|tool|way)\b[^.!?\n]{0,40}\b(draw|create|generate|make|images?|pictures?)\b/i;

/**
 * A raw pseudo tool call the model invented because it decided it had to go
 * and make the picture itself. `generate_image` is not a tool; nothing in the
 * registry answers to `dalle.*`.
 */
const FAKE_ACTION = /\{\s*"(?:action|action_input|tool|tool_input|function)"\s*:/;

/** What to say instead. True for every picture turn this harness rendered. */
export const IMAGE_TURN_SENTENCE =
  "Here's the picture you asked for — it's below in this reply, and a copy is saved in your Library.";

/** True when the reply denies a capability this turn actually exercised. */
export function deniesImageCapability(reply: string): boolean {
  return DENIAL.test(reply) || NO_ABILITY.test(reply);
}

/** True when the reply is a machine blob rather than prose. */
export function fakesImageAction(reply: string): boolean {
  return FAKE_ACTION.test(reply.trim());
}

/**
 * The replacement sentence, or null when the reply is already honest about a
 * rendered picture. Callers only apply this when `renderedImage` is set.
 */
export function repairImageReply(reply: string): string | null {
  if (!reply.trim()) return IMAGE_TURN_SENTENCE;
  return deniesImageCapability(reply) || fakesImageAction(reply) ? IMAGE_TURN_SENTENCE : null;
}

/**
 * True only when a "it's saved in your Library" sentence has nothing behind it.
 *
 * `producesDeliverable()` answers "did this turn produce a *document*", so an
 * image-only or audio-only turn reads as no delivery — and the guard that
 * replaces a false claim then replaced a true one. Measured on production
 * e0d388b (2026-11-18, beezilla.net): "draw me a duck" stored a 1408×768 PNG and
 * returned it in the envelope, and the bubble under the very same picture said
 * "I did not actually produce anything that turn, so nothing was saved to your
 * Library." A track or a picture is a delivery; only a turn with no artifact at
 * all is allowed to be told it produced nothing.
 */
export function deliveryClaimIsFalse(turn: {
  document: boolean;
  audio: boolean;
  image: boolean;
}): boolean {
  return !turn.document && !turn.audio && !turn.image;
}

/**
 * "I have created an image and attached it below" with no image in the envelope.
 * Image nouns are stricter than audio ones because "art" and "picture" appear in
 * ordinary sentences; a sentence that says "can't" or "failed" is not a claim.
 */
const IMAGE_NOUN = /\b(image|picture|illustration|drawing|poster|logo|artwork|thumbnail|banner|mockup)\b/i;
const IMAGE_CLAIM = /\b(created|made|generated|drew|drawn|attached|rendered|here is|here's|ready|saved)\b/i;
const SENTENCE = /[^.!?\n]*[.!?]?/g;

/** True when some sentence of the reply claims a picture was made. */
export function claimsImage(text: string): boolean {
  return (String(text || "").match(SENTENCE) ?? []).some(
    (sentence) => IMAGE_NOUN.test(sentence) && IMAGE_CLAIM.test(sentence) && !/\b(can'?t|cannot|unable|failed|didn'?t)\b/i.test(sentence),
  );
}

/**
 * The reply without its picture claims, every other line kept as it was.
 *
 * For a turn that delivered a document: "I've created your site plan with a banner
 * and your logo up top" is the document's content, not a picture claim, and replacing
 * the whole reply threw away the work's summary and the list of what BeeZilla assumed
 * (seen 2026-11-23 on a one-mode "just go" turn). Only the claiming sentences go.
 */
export function withoutImageClaims(text: string): string {
  return String(text || "")
    .replace(SENTENCE, (sentence) => (claimsImage(sentence) ? "" : sentence))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
