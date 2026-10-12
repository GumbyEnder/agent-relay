# BeeZilla worker token/cost accounting — `beezilla-token-tally.py`

Read-only CLI that tallies BeeZilla worker token/cost usage from Hermes profile
`state.db` files. Replaces the legacy worker tally utility's
behaviour (which only handled GLM + B70, silently treated missing records as
zero, replaced the historical ledger, and re-priced old GLM calls at present
promo rates).

Python stdlib only. No pip install. Real Hermes state DBs are opened READ-ONLY
(`mode=ro`) and are never mutated.

## Usage

```
python3 scripts/beezilla-token-tally.py [--profile-root DIR] [--profile NAME ...]
    [--source VALUE ...] [--sessions ID ...] [--root-session ID]
    [--receipts FILE] [--json] [--markdown] [--ledger FILE]
```

- Default profile root is `~/.hermes/profiles` (dynamic home path). Pass
  `--profile-root` to a synthetic tree for tests.
- Default profiles inspected: the known worker profiles (`coder-b70`, `aragorn`,
  `gollum`, `business-docs`, `utility-worker`, `pippin`) plus the coordinator
  profile `frodo`. Override with `--profile`.
- Scope selection (project attribution):
  - `--source beezilla-route-validation` — only usage whose session
    `created_source`/`source` equals the value (repeatable).
  - `--sessions ID ...` / `--root-session ID` — exact session ids.
  - No scope flag = profile-wide report, explicitly labeled NOT project/task
    exact.
- Output: `--json` and/or `--markdown` to stdout. With neither, a concise bucket
  summary is printed.
- `--ledger FILE` appends a dated snapshot to a ledger file. Append-only and
  idempotent; prior ledger history is preserved. Dry-run unless `--ledger` is
  given.
- `--receipts FILE` ingests a JSON array or JSONL of attempt receipts (see
  Receipts below).

## Native schema / recognition semantics

`session_model_usage` rows are **cumulative per identity**, not per-call
records. The composite identity is:

```
(session_id, model, billing_provider, billing_base_url, billing_mode, task)
```

- Distinct `task` rows (e.g. `title_generation`, `compression`,
  `background_review`) are kept separate and are NOT collapsed.
- Session-level totals in `sessions` are NOT summed again on top of
  `session_model_usage` rows (that would double count).
- `input_tokens` and `cache_read_tokens` are separate counters. Reported total
  = input + output + cache_read + cache_write.
- `reasoning_tokens` is reported separately and is NOT blindly added to billed
  totals (reasoning may overlap output).
- Mirrored / symlinked / duplicated identities are counted once. A repeated
  identity in a second profile is recorded as a mirror-duplicate and ignored to
  avoid double counting. Conflicting copies are surfaced as warnings rather than
  silently summed.

## Cost provenance

- Prefer explicit measured `actual_cost_usd` when present; otherwise preserve
  the STORED `estimated_cost_usd`. Actual and estimate are never added for the
  same usage.
- A default `actual_cost_usd == 0.0` with `cost_status`/`cost_source` unknown or
  null is reported as **UNKNOWN cost**, not measured free work.
- A `title_generation` row with a nonzero stored `estimated_cost_usd` and null
  `cost_status`/`cost_source` is preserved as a legacy/unknown estimate, not
  re-priced at today's rates.

## Role / lane classification

- Role comes from profile + session lineage, not model-name heuristics alone:
  - `frodo` root sessions (no `parent_session_id`) → coordinator.
  - `frodo` delegate descendants (with a parent) → worker.
  - Known worker profiles → worker.
  - Insufficient metadata → `unknown`.
- Lane: `local-b70` (Qwen on localhost:18081), `legacy` (GLM dated history),
  `cloud` (everything else remote).
- The operational worker-token share preference is cloud vs local-B70 over
  worker-role rows only; coordinator and legacy/unclassified are excluded and
  reported separately.

## Receipts

Optional JSON array or JSONL of attempt receipts with fields such as
`attempt_id`, `mission`, `task`, `role`, `profile`, `model`, `provider`,
`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
`reasoning_tokens`, `duration_s`, `success`, `retry`, `actual_cost_usd`,
`estimated_cost_usd`, `cost_provenance`.

- Receipts are deduped by `attempt_id`.
- A receipt whose `(model, provider, task)` matches a native usage identity is
  marked `covered_by_native` and is NOT summed again (avoids double counting
  the native cumulative rows).
- Uncovered receipts (which can carry per-attempt success/retry/duration) are
  summed as extra attempt-level evidence.

## Sanitization

Outward metadata is allowlisted. `billing_base_url` has query strings /
fragments stripped. Host-relative paths (`/home/`, `/mnt/`, `/Users/`, `C:\`)
are redacted. Raw prompts, conversations, system messages and response bodies
are never emitted.

## Tests

```
python3 -m py_compile scripts/beezilla-token-tally.py scripts/test_beezilla_token_tally.py
cd scripts && python3 -m unittest test_beezilla_token_tally -v
```

All fixtures in `test_beezilla_token_tally.py` are SYNTHETIC test inputs, never
runtime usage. They cover: the five exact cloud IDs, local B70, legacy GLM,
coordinator root vs worker child lineage, unknown role, missing
profile/DB/table/columns/counts/costs, mirror/duplicate dedup, divergent
duplicate conflict, receipt dedup + native coverage, historical cost provenance,
reasoning/cache accounting, no double-count of native+receipt, secret-bearing
metadata sanitization, read-only sources, and append preserving an existing
ledger.

## Known limitations

- Native `session_model_usage` is cumulative, not per-call; failed/retried
  attempts are not broken out natively, so per-attempt breakdown is reported as
  unknown unless covered by receipts.
- A profile-wide report is not a BeeZilla project/task-exact attribution; use
  `--source`/`--sessions`/`--root-session` for project attribution.
- Identity includes `billing_base_url` verbatim, so a trailing-slash variant is
  treated as a distinct identity (conservative; never double counts identical
  identities).
