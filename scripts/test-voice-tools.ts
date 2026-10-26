/**
 * Spoken-lane web routing (the "I can't search the web" fix).
 *
 * The voice lane has no model-callable tools, so intent decides whether the
 * harness does a lookup before speaking. These cases pin that decision — a
 * false positive costs half a second of search, a false negative makes the
 * avatar claim it cannot browse, which is the bug this file prevents.
 *
 * Run: npx tsx scripts/test-voice-tools.ts
 */
import { needsWebLookup } from "../src/lib/buzzy/voiceTools";

let failures = 0;
function expect(label: string, actual: boolean, want: boolean) {
  if (actual === want) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label} — got ${actual}, want ${want}`);
  }
}

console.log("lookups this turn needs:");
for (const m of [
  "search the web for the current USPS stamp price",
  "look up who licenses fence contractors in Florida",
  "what's the current price of a first class stamp?",
  "check online whether the grant portal is open",
  "how much does a business licence cost right now",
  "read https://www.usps.com/ship/first-class-mail.htm and tell me the price",
]) expect(JSON.stringify(m), needsWebLookup(m), true);

console.log("ordinary conversation does not:");
for (const m of [
  "write a short letter to my landlord about the leak",
  "draft a scope of work for a fence install",
  "what are the four things you need from me?",
  "thanks, that's all for now",
]) expect(JSON.stringify(m), needsWebLookup(m), false);

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("voice tool routing: all checks passed");
