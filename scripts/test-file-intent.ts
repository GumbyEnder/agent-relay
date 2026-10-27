/**
 * Intent tests for the save-to-file path.
 *
 * These are the sentences a real person types. The failure they pin is specific:
 * "research this and save it in the file" never opened the draft gate, so no
 * render tool was offered, so nothing was produced and nothing reached the
 * Library — while the product claimed it could save files.
 *
 * Run: npx tsx scripts/test-file-intent.ts
 */
import { isDraftRequest, isExplicitDocumentRequest, isFileRequest } from "../src/lib/buzzy/intent";

let failures = 0;
function expect(label: string, actual: boolean, want: boolean) {
  if (actual === want) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label} — got ${actual}, want ${want}`);
  }
}

console.log("counts as a file request:");
for (const m of [
  "Research the current USPS stamp price and save it in the file.",
  "Save it in the file",
  "save this to a file",
  "put this in a document for me",
  "make a file I can send",
  "write this up as a PDF",
  "export it as markdown",
  "save a copy",
  "keep a record of this in my library",
  "create a report from what you find",
  "save the summary",
]) expect(JSON.stringify(m), isFileRequest(m), true);

console.log("does NOT count as a file request:");
for (const m of [
  "what does a first class stamp cost?",
  "thanks, that saves me time",
  "how do I file a complaint with the county?",
  "summarize this in two sentences",
  "who should sign off on quotes?",
]) expect(JSON.stringify(m), isFileRequest(m), false);

console.log("draft request (file request OR the owner says enough):");
expect("write it up", isDraftRequest("ok, write it up"), true);
expect("that's enough", isDraftRequest("that's enough — go ahead"), true);
expect("plain question", isDraftRequest("what is a lien waiver?"), false);
expect("file phrasing", isDraftRequest("save it in the file"), true);

console.log("explicit document request (forces render_document):");
for (const m of [
  "give me the word document",
  "save it in the file",
  "put this in a doc",
  "as a .docx please",
  "produce the file",
]) expect(JSON.stringify(m), isExplicitDocumentRequest(m), true);
expect("plain question", isExplicitDocumentRequest("what does it cost?"), false);

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("file intent: all checks passed");
