/**
 * The document the Library stores must be the document the renderer produced.
 *
 * Gate 9423 caught the product handing the owner a 936-byte PDF containing the
 * assistant's one-sentence confirmation, while the real 10,487-byte scope of work
 * sat unread in `data.artifact`. These checks pin the transform that closes that
 * split — `documentToMarkdown`.
 *
 *   npx tsx scripts/test-document-text.ts
 *
 * This proves the transform. It does not prove the wiring end to end; that needs a
 * live turn with a rendering model and is what the SOW gate re-run covers.
 */
import { documentToMarkdown } from "../src/lib/buzzy/artifact";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const sow = {
  title: "Scope of Work — Fence Repair",
  sections: [
    { heading: "The Challenge", paragraphs: ["A leaning fence on the west boundary.", "Two panels are broken."] },
    { heading: "Work Required", paragraphs: ["Reset or replace four posts.", "Dig with care: the neighbour's sprinkler line runs under the fence line."] },
  ],
};

const out = documentToMarkdown(sow);
check("renders", out.ok === true, JSON.stringify(out).slice(0, 120));
if (out.ok) {
  check("keeps the renderer's title", out.title === "Scope of Work — Fence Repair", out.title);
  check("emits a markdown title", out.markdown.startsWith("# Scope of Work — Fence Repair"), out.markdown.slice(0, 40));
  check("emits section headings", out.markdown.includes("## The Challenge") && out.markdown.includes("## Work Required"));
  check("keeps every paragraph", out.markdown.includes("Two panels are broken.") && out.markdown.includes("sprinkler line"));
  check("is not the chat reply", !out.markdown.includes("Done —"), out.markdown.slice(0, 60));
  check("is larger than any single paragraph", out.markdown.length > 150, String(out.markdown.length));
  check("no runs of blank lines", !/\n{3,}/.test(out.markdown));
}

// A turn that produces no valid document must say so rather than inventing text.
check("rejects an empty document", documentToMarkdown({}).ok === false);
check("rejects non-object input", documentToMarkdown("just a sentence").ok === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
