# Tool-call reliability record (plan doc 23, open decision #3)

Run the fixture on any BZ_CHAT_MODELS addition or version bump:

    BZ_CHAT_KEY=... node scripts/tool-reliability-fixture.mjs

Decision rule: >=95% native (fallback dormant) / 80-95% native+fallback on malformed / <80% JSON-primary.

| Model | Date | Score | Decision |
|---|---|---|---|
| z-ai/glm-5.3-flash | 2026-10-16 | 20/20 (100%) | native tool_calls, fallback dormant |

Notes:
- Requires the Phase 1 fixes: 4096-token budget on tool turns (reasoning models
  truncate at 2048 before emitting tool_calls) and forced tool_choice on explicit
  document requests.
- Raw results: docs/tool-reliability-<model-slug>.json
