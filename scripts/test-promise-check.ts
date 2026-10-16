/**
 * Check the promise: a refund sentence is marked, and approval without
 * accepting that sentence is refused. The draft is not rewritten. Nothing is sent.
 */
import { checkPromise } from "../src/lib/buzzy/promise";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

const REFUND = "We will refund the $420.00 if the glass is wrong.";
const DRAFT = [
  "Thanks for the note about the patio door.",
  REFUND,
  "Please call the shop if you have a question.",
].join("\n");

function main() {
  const marked = checkPromise({ draft: DRAFT });
  assert(marked.blocksApproval, "a refund sentence blocks approval until it is accepted");
  assert(marked.draft === DRAFT, "the draft is not rewritten");
  assert(marked.draft.includes(REFUND), "a refund the owner wrote is not softened away");
  assert(!marked.draft.includes("we can discuss"), "the check does not add softer wording");
  assert(marked.items.length === 1, "only the committing sentence is marked");
  assert(marked.items[0].text === REFUND, marked.items.map((item) => item.text).join(" | "));
  assert(marked.items[0].reason === "This offers a refund.", marked.items[0].reason);
  assert(marked.items[0].accepted === false, "the sentence starts unaccepted");
  assert(marked.items[0].kind === "refund", "the refund is the reason shown");
  assert(!("sent" in marked), "nothing is sent");

  const wrongAccept = checkPromise({ draft: DRAFT, accepted: ["We will refund something else."] });
  assert(wrongAccept.blocksApproval, "accepting different words does not accept this sentence");
  assert(wrongAccept.draft === DRAFT, "a refused acceptance does not change the draft");

  const accepted = checkPromise({ draft: DRAFT, accepted: [REFUND] });
  assert(!accepted.blocksApproval, "accepting that exact sentence lets the draft be approved");
  assert(accepted.items[0].accepted === true, "the accepted sentence is recorded");
  assert(accepted.draft === DRAFT, "accepting does not remove the refund");

  const edited = "We will refund the $420.00 in full if the glass is wrong.";
  const editedCheck = checkPromise({ draft: edited, accepted: [REFUND] });
  assert(editedCheck.blocksApproval, "editing the sentence clears that acceptance");
  assert(editedCheck.items[0].text === edited, "the edited sentence is the one that must be accepted");
  assert(editedCheck.draft === edited, "the edit is kept as the owner wrote it");

  const both = checkPromise({
    draft: `${REFUND}\nWe will have the glass installed by April 2, 2026.`,
    accepted: [REFUND],
  });
  assert(both.blocksApproval, "one accepted sentence does not cover a second promise");
  assert(both.items.length === 2, "each committing sentence is listed");

  const deadline = checkPromise({ draft: "We will have the glass installed by April 2, 2026." });
  assert(deadline.blocksApproval, "a deadline is marked");
  assert(deadline.items[0].reason === "This sets a deadline the company would have to meet.", deadline.items[0].reason);

  const ask = checkPromise({ draft: "Please pay by April 2, 2026." });
  assert(!ask.blocksApproval && ask.items.length === 0, "asking them to pay by a date is not a promise from the company");
  assert(ask.draft === "Please pay by April 2, 2026.", "that sentence is not rewritten");

  const discount = checkPromise({ draft: "We can take 10% off the invoice." });
  assert(discount.items[0]?.reason === "This offers a discount.", discount.items.map((item) => item.reason).join(" | "));

  const penalty = checkPromise({ draft: "We will charge a late fee if this sits unpaid." });
  assert(penalty.items[0]?.reason === "This names a penalty.", penalty.items.map((item) => item.reason).join(" | "));

  const admission = checkPromise({ draft: "We admit the install was our mistake." });
  assert(admission.items[0]?.reason === "This admits fault.", admission.items.map((item) => item.reason).join(" | "));

  const legal = checkPromise({ draft: "We accept liability for the cracked pane." });
  assert(legal.items[0]?.reason === "This takes a legal position.", legal.items.map((item) => item.reason).join(" | "));

  const plain = "Thanks for coming by the shop.";
  const none = checkPromise({ draft: plain });
  assert(!none.blocksApproval && none.items.length === 0, "a draft with no promise is left alone");
  assert(none.draft === plain, "the check does not add a promise the owner did not make");
  assert(!/refund|discount|penalty|liable/i.test(none.draft), "no promise was written in");

  const fine = checkPromise({ draft: "The glass is fine. Feel free to call the shop." });
  assert(fine.items.length === 0, "ordinary words are not treated as a penalty or a discount");

  const received = checkPromise({ draft: "We received your invoice dated March 3, 2026." });
  assert(received.items.length === 0, "a date on the paper is not a deadline the company just set");

  console.log("promise check ok");
}

main();
