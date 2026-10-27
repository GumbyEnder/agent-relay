# Sealed Recipes — the promise, and its edges

**Status:** shipped behind `feat/recipe-seal`, PR #220.
**Audience:** anyone deciding whether to publish or buy a sealed recipe, and anyone about to
extend the leak gate.

This document exists because a security claim that is only in a pull-request thread is not a
claim. It states exactly what the seal guarantees, exactly what it does not, and why the
boundary sits where it does.

---

## What a sealed recipe is

A recipe is a `.srb` bundle: `manifest.json` (public), `checks.wasm` (the executable rule
program), and `semantic.enc` (the prose — the author's actual reasoning — encrypted under a
per-bundle DEK, itself wrapped under the deployment KEK). The manifest is served to anyone who
asks; the prose is not.

The commercial point: a purchaser can run the author's checks and read the author's capability
description without ever receiving the author's text. The verify tier runs in a process that
never has the KEK, so "no plaintext on this path" is structural, not a policy.

---

## The claim

> A published manifest does not reproduce the sealed half. The comparison is made against the
> sealed text as **a run of words**, and within a word as **a run of characters**. A word-run, a
> character-run, or the same content words in any order are refused. Exemptions are drawn only
> from vocabulary fixed in code (manifest schema key names, and the declared output/tool
> vocabulary), never from the document being judged.

Enforced at two places, because a library check with no call site proves nothing: at seal time
(`sealBundle`) and again at publish time (`POST /api/recipes`, which decrypts the semantic half
it is about to store and refuses any manifest reproducing it).

### What this means in practice

- An author who copies their boundary or checklist into `capability.boundary_summary` is refused.
- An author who stores the prose one word per field is refused.
- An author who splits a clause across two fields is refused.
- A manifest declaring `"comparison-table"` while the sealed half says "comparison table" is
  **allowed** — the shared text is a public identifier, excused only because the sealed half
  carries that term as a token-aligned run.
- A sealed payload too short to compare is refused outright (`semantic_payload:empty`,
  `semantic_payload:unsearchable`) rather than published with an unproven promise.

---

## What it does not claim

These are deliberate boundaries, not open bugs. Each is a different family of problem and would
be its own piece of work.

| Not covered | Why it is outside |
|---|---|
| **De-spaced fragments** — fewer characters than one field | a whole sealed field with spacing removed is refused (`<despaced>`); fragments and runs spanning two fields are not |
| ~~Homoglyph substitution~~ | **now covered** — Unicode confusables (UTS #39) are folded before any pass runs |
| **Sub-window fragments** — fewer characters than one window | below the floor there is not enough signal to distinguish a leak from ordinary vocabulary |
| **Paraphrase, translation, transliteration** | a copy detector cannot see meaning |
| **What the model emits at run time** | the gate compares manifest against semantic; the execution path is a separate surface |
| **Producer-side sharding across bundles** | each bundle is judged on its own manifest |

**Sub-window fragments — decision recorded.** A sealed fragment shorter than one window (10
latin / 6 CJK normalised characters) is outside the guarantee. The floor is kept rather than
raising it: below it there is not enough signal to tell a leak from ordinary vocabulary, and
refusing every short recipe would reject legitimate work to buy a promise we cannot keep.
Short sealed fields are the author's risk, and the floor is stated here rather than hidden.

**The honest summary:** this is a copy detector with a stated floor, not a proof that the prose
is secret. It raises the cost of accidental leakage substantially. It does not bound a
determined publisher who owns the text and wants to publish it — and it was never able to,
because the publisher holds the plaintext.

---

## Why the gate looks the way it does

Thirteen adversarial review rounds shaped it. Every defect was the same family: **a boundary of
the comparison that the payload got to choose** — values, then keys, then scripts, then token
counts, then field granularity, then the source of the exemption list.

Twelve rounds of patching predicates did not converge. Deleting the predicates did. The current
design has no switch that asks "is this payload the shape I expected?" — it joins the values
unconditionally and compares token-aligned, which is safe precisely because words are discrete.

If you extend this gate, the rule to keep is: **never let the document under judgement select
the scope, the unit, or the exemptions of the comparison.** Every round above is an instance of
that one rule being broken.

---

## Residual risk, stated for a customer

- `checks.wasm` is **obfuscation, not cryptography**. It is a folded data section with no
  imports; it deters casual reading and will not survive a determined analyst.
- Bundles are **self-signed**. "Verified" means *self-consistent*, not *authored by a known
  party*. There is no key registry.
- Charge-on-throw bills a licensee for a 502 from a broken published recipe. Consistent
  accounting; unproven fairness.
- No third party has audited the AES-GCM usage, AAD construction or KEK handling beyond the
  tamper matrix in the suite. No fuzzing, no load test on the storage layer.
