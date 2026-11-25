# Guardrails, not specifications

**Date:** 2026-11-23 · **Status:** decided

**Owner's words** (their write-up "The new way forward"): "Explain the guardrails not the
product." "A guardrail limits what is permissible. A specification dictates how to solve the
problem." "Rather than interrogating the user about features and technical decisions, ask
questions that reveal what they're really trying to accomplish and which constraints would
materially change the possibilities." "Give the AI the destination and the walls. Let it
discover everything in between." And: "A genuine guardrail must be enforced by the
environment, not just described in a prompt."

**Decision:**

- Every project starts from **why** the person wants it; what they asked for is their first
  idea, kept as a starting point, not a specification. If they didn't say why, the AI infers
  it and shows its guess as an assumption instead of asking.
- The person is asked only about the **why** and the **walls**: hard limits that change what's
  possible (time, money, who it's for, who must not see it, what must never happen). Never
  about features or technology.
- Walls that matter are **enforced in code**: the budget as a spending ceiling, permissions and
  sandboxes for access, authorization before anything that can't be undone, a test or lint rule
  for every correction — never only a sentence in a prompt.

**In the code:** the result card's `why` and `walls` and the brief in
`src/lib/buzzy/codeMonkey.ts`; one mode's questions (`src/lib/buzzy/oneMode.ts`).

**Refines:** [one mode](one-mode.md) ("questions are about the product, never the technology"
now reads: about the why and the walls, never the product's features or its technology).
