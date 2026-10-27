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

/** A deliverable request in the owner's own words (not only "file" phrasing). */
export function isDraftRequest(message: string): boolean {
  if (isFileRequest(message)) return true;
  return /\b(write it up|just write|go ahead|draft it|that'?s enough|finalize|whenever you'?re ready)\b/i.test(
    String(message || ""),
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
