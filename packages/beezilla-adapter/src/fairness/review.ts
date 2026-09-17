/**
 * BeeZilla — Fairness review helpers
 *
 * Pure functions for civilian-facing review of SOW drafts and
 * escalation policy when reviews keep failing.
 */

// ---------------------------------------------------------------------------
// fairnessNotes
// ---------------------------------------------------------------------------

/**
 * Generate 2–3 civilian-friendly review bullets from SOW text.
 * Always returns a non-empty array.
 */
export function fairnessNotes(sowText: string): string[] {
  const bullets: string[] = [];

  const lower = sowText.toLowerCase();

  // Check for jargon-heavy language
  const jargonTerms = [
    "synergy",
    "paradigm",
    "leverage",
    "deep-dive",
    "circle back",
    "low-hanging fruit",
    "best-in-class",
    "cutting-edge",
    "robust",
    "scalable",
  ];
  const foundJargon = jargonTerms.filter((t) => lower.includes(t));
  if (foundJargon.length > 0) {
    bullets.push(
      `Tone down jargon — words like "${foundJargon[0]}" may confuse non-technical readers.`
    );
  }

  // Check for unclear scope
  if (
    lower.includes("tbd") ||
    lower.includes("to be determined") ||
    lower.includes("待定")
  ) {
    bullets.push(
      "Replace TBD sections with concrete deliverables before sharing."
    );
  }

  // Check for missing timeline
  if (!/\d+\s*(week|month|day|hour)/.test(lower)) {
    bullets.push("Add a timeline or milestone range so clients know when to expect results.");
  }

  // Check for missing pricing or budget
  if (
    !/\$[\d,]+/.test(sowText) &&
    !lower.includes("budget") &&
    !lower.includes("cost") &&
    !lower.includes("price")
  ) {
    bullets.push("Include a price range or budget note so clients aren't surprised.");
  }

  // If no issues found, give a positive but still useful note
  if (bullets.length === 0) {
    bullets.push(
      "SOW reads clearly — consider adding a brief summary of success criteria."
    );
    bullets.push(
      "Good tone and structure; a client-facing glossary would help further."
    );
  }

  // Guarantee 2–3 bullets
  return bullets.slice(0, 3);
}

// ---------------------------------------------------------------------------
// escalateOnce
// ---------------------------------------------------------------------------

/**
 * Escalation policy for repeated review failures.
 *
 * - fails === 1 → "retry"   (give the author one more chance)
 * - fails >= 2  → "pause"   (stop and escalate)
 */
export function escalateOnce(fails: number): "retry" | "pause" {
  if (fails >= 2) {
    return "pause";
  }
  return "retry";
}
