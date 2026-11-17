# Recipe Seal — Marketplace Protocol v1

**Protocol string:** `recipe-seal/1` · **Wire surface:** `/api/recipes*` · **Licence:** MIT (this document and the code it cites)
**Status:** live. Sealed bundles verify in production; publishing and paid runs are opt-in per deployment (see §11).

This is the contract, not the implementation. It says what a bundle is, what a licence
is, which doors exist, what they answer, what is charged, and what an integrator can
check for themselves. Any part of it a third party needs in order to trust the seal is
in this document or in the code it names.

The commercial half — how a sealed method becomes a prompt, how a method is derived
from finished work, how the money splits are decided — is deliberately absent. §12
lists what is withheld and why, so that a gap in this document is a stated boundary
rather than an oversight.

---

## 1. Open core: what you can verify, and what you can't

| Surface | Where | In this repo |
|---|---|---|
| `.srb` bundle format, deterministic zip, RFC 8785 canonicalisation | `src/lib/recipe-seal/{bundle,zip,jcs}.ts` | public, MIT |
| Ed25519 signing and `verifyBundle` | `src/lib/recipe-seal/bundle.ts` | public, MIT |
| Check DSL, compiler, fuel-bounded VM | `src/lib/recipe-checks/*` | public, MIT |
| Verify tier — runs with **no KEK** | `src/lib/recipe-seal/verify.ts` | public, MIT |
| Leak gate (manifest vs sealed half) and its stated floor | `docs/RECIPE-SEAL.md` | public, MIT |
| This wire contract | this file | public, MIT |
| Prompt assembly, open path, licensing internals, metering SQL, method derivation | private module (see `docs/PRIVATE-MODULES.md`) | not published |

**The verifier is public on purpose.** "Your prose never leaves the server" and "this
bundle was signed" are worth nothing if only we can check them. Closing `verify.ts`
would turn a protocol into a vendor promise.

---

## 2. The four objects

### 2.1 Bundle (`.srb`)

A deterministic ZIP with exactly three entries, sorted by name, stored (not deflated),
fixed epoch timestamp:

| Entry | Bytes | Visible to |
|---|---|---|
| `checks.wasm` | the compiled rule program | anyone who has the bundle |
| `manifest.json` | the public manifest (below) | anyone |
| `semantic.enc` | the sealed method, AES-256-GCM under a per-bundle DEK | nobody without the deployment KEK |

`manifest.semantic.aad` is the string `manifest-digest`; the AAD actually used is
`` `${protocol}|${id}|${version}|${checks.sha256}` `` (`semanticAad` in `bundle.ts`), so a
blob lifted from one bundle into another fails to open. The DEK is wrapped under the
deployment KEK with the fixed AAD `recipe-seal/dek/1`.

### 2.2 Digest and signature

```
digest = sha256( JCS( manifest without .signature ) )      // lowercase hex, 64 chars
signature = Ed25519( digest bytes, author.private_key )     // base64
```

`digest` is the bundle's identity (`hash`) everywhere on the wire. `verifyBundle` checks:
zip parses → both required entries present → `protocol` matches → structural schema →
signature over digest → `checks.sha256` and `semantic.sha256` match the entry bytes.
Its reasons are stable strings and are returned verbatim by `POST /api/recipes` on failure:
`NOT_ZIP`, `MISSING_ENTRY`, `NO_CHECKS`, `MANIFEST_SCHEMA`, `UNSUPPORTED_PROTOCOL`,
`BAD_SIGNATURE`, `HASH_MISMATCH_CHECKS`, `HASH_MISMATCH_SEMANTIC`.

**Bundles are self-signed.** "Verified" means *self-consistent and signed by the key the
manifest carries*. There is no key registry and no claim about who that key belongs to.
Hosted uploads are custodially signed with the platform key and ownership is by
`author.id` — see §5.6.

### 2.3 Manifest

Public in full, and served to anyone. Fields (all required unless noted):

```jsonc
{
  "protocol": "recipe-seal/1",
  "id": "user.ab12cd34.weekly-recap",     // [a-z0-9._-], ≤64
  "version": "1.0.0",
  "created_at": "2026-11-17T00:00:00.000Z",
  "listing":    { "title": "…", "description": "…", "updated_at": "…", "price_honey_drops": 0 },
  "author":     { "id": "…", "name": "…", "key_id": "…", "public_key": "<SPKI DER, base64>" },
  "capability": { "inputs": [ { "name": "sources", "type": "file[]", "required": true } ],
                  "outputs": ["document"], "tools": ["render_document"],
                  "forbidden_tools": ["send", "submit"], "boundary_summary": "…" },
  "checks":     { "module": "checks.wasm", "sha256": "…", "rules": 24,
                  "codes": { "C01": "no invented figure" }, "engine": "recipe-checks/1" },
  "semantic":   { "blob": "semantic.enc", "sha256": "…", "alg": "AES-256-GCM",
                  "nonce": "…", "aad": "manifest-digest" },
  "dek_wrapped": "…",
  "evals":      { "corpus_sha256": null, "cases": 0, "pass_rate_bp": null },
  "pricing":    { "unit": "run", "amount_cents": 0, "quota_default": 500,
                  "split_bp": { "author": 7000, "platform": 3000 } },
  "chain":      { "hash_algo": "sha256", "commitment": null },
  "signature":  "…"                        // optional in schema, mandatory for a published bundle
}
```

Integers only. A signed document cannot carry floats without inviting canonicalisation
disputes; money is `amount_cents`, rates are basis points.

`checks.codes` is the public map from verdict code to the sentence a buyer reads. The
rule *expressions* are in `checks.wasm`; the *descriptions* ship in the manifest, which is
why a verdict can say what failed without shipping the method.

### 2.4 Licence and token

A licence grants execution rights **against one bundle hash**, never against the text.
A token is the bearer credential for the API lane; a signed-in account is the credential
for the person lane. A token secret is `rcp_<32 random bytes, base64url>` and is shown
exactly once, at issue. Only `sha256(token)` is stored, so a token cannot be recovered
from the database.

### 2.5 Run

One ledger row: licence, bundle hash, optional idempotency key, input hash, output hash,
verdict, cost, token counts, lane (`api` | `local`), duration. The run id (`run_…`) is
returned to the caller; the content of the sealed method never is.

---

## 3. Doors

| Door | Credential | Capability |
|---|---|---|
| **Shelf** | none | list, read a manifest |
| **Oracle** | none (IP-rate-limited) or token (scope `verify`) | score a draft against a bundle's checks |
| **API** | `Authorization: Bearer rcp_…` with scope `run` / `usage` | run a licensed bundle, read usage |
| **Person** | app session cookie + entitlement | run a recipe you own, rate it, upload your own |
| **Operator** | app session with role capability `manage_keys` | publish a signed bundle, issue/revoke licences |

Two rules that are load-bearing, and were both found by an independent review:

- **Presence of a session is not authorisation.** Publish and licence-issue gate on the
  `manage_keys` capability. A `viewer` used to be able to mint a million-run licence at
  price 0.
- **Open mode is opt-in.** `RECIPE_SEAL_ALLOW_OPEN=1` grants every operator capability to
  a deployment with no auth configured. It is never inferred from a missing environment
  variable.

---

## 4. Endpoints

All responses are JSON with the envelope

```jsonc
{ "ok": true,  "...": "…" }                          // success
{ "ok": false, "error": "human sentence", "code": "machine_code" }   // failure
```

`code` is the part to branch on. `error` is for humans and may change wording without a
protocol bump.

### 4.1 `GET /api/recipes` — the shelf

Public. One row per recipe id, newest published version only, with aggregated ratings.
**Not the manifest:** key material, checks codes and pricing internals are not a shelf's
business, and returning 1.5 KB of them per row makes the catalogue the most expensive
page on the site.

```jsonc
{ "ok": true, "recipes": [ {
  "hash": "<64 hex>", "id": "…", "version": "1.0.0",
  "title": "…", "description": "…",
  "author": { "id": "…", "name": "…" },
  "created_at": "…", "updated_at": "…", "published_at": "…",
  "price_honey_drops": 0, "is_free": true,
  "rating": { "average": 4.5, "count": 2 },
  "capability": { "inputs": [], "outputs": [], "tools": [], "forbidden_tools": [], "boundary_summary": "…" }
} ] }
```

`price_honey_drops: 0` means free. There is no half-free.

### 4.2 `GET /api/recipes/:hash/manifest` — the manifest

Public. `{ ok: true, manifest: { … } }`. `410 bundle_revoked` once withdrawn — a revoked
recipe stops serving immediately, including this door, because the manifest names the codes
and the price.

### 4.3 `POST /api/recipes/:hash/verify` — the free oracle

Body `{ "draft": { …Draft } }`. Draft is the schema in `src/lib/recipe-checks/types.ts`;
a non-object is `400 invalid_body`.

```jsonc
{ "ok": false,
  "codes": ["C02"],                       // failed BLOCK rules, sorted
  "warnings": ["C31"],                    // failed WARN rules, sorted
  "descriptions": { "C02": "…" },         // from the manifest, not the sealed text
  "engine": "recipe-checks/1",
  "ms_bucket": "<5" }                      // never the raw duration: timing is a rule oracle
```

`ok` is true when no `block`-severity rule failed. `C00` is emitted when the fuel budget is
exhausted — a check program that loops is refused, not allowed to run.

Rate limited per caller (token identity, else last hop of `X-Forwarded-For`) with
`429 rate_limited` and `Retry-After` seconds. Distinct-draft counts per caller per hour are
kept so that systematic probing is visible in the operator log; the count is never returned.

`422 invalid_checks` if the bundle's checks module will not evaluate, `404 unknown_bundle`,
`410 bundle_revoked` — revocation stops the oracle too, because verify reports exactly which
rules a draft violated.

### 4.4 `POST /api/recipes/:hash/verify/batch`

Body `{ "drafts": [ … up to 50 … ] }` → `{ ok, results: [ same shape as 4.3 ], error? }`.
Counted **per draft**, not per call, against the same budget as 4.3 — otherwise batch is a
way around an exhausted limit. `413 batch_too_large`, `400 invalid_body`.

### 4.5 `POST /api/recipes/:hash/run` — paid execution (token lane)

`Authorization: Bearer rcp_…` (scope `run`).

```jsonc
// request
{ "inputs": { "sources": ["…"] }, "idempotencyKey": "optional-stable-string" }
// response 200
{ "ok": true, "artifact": { …Draft | null }, "codes": [], "traceId": "…",
  "run": "run_…", "deduped": false }
```

The method is opened in the serving process, put into a prompt, and discarded. What comes
back is the document and the verdict.

Metering, in order, and each step is observable in the response or the ledger:

1. **Idempotency replay is checked first.** A known key returns the original run with
   `deduped: true, replay: true`, `artifact: null`, and no charge — no inference happens.
   (Replays carry `warnings`; a live run does not. Treat every field but `ok`, `run`,
   `deduped` as optional.)
2. **One unit is reserved** with a single atomic `UPDATE … WHERE used < quota` — never
   read-then-write, so concurrent callers cannot over-issue.
3. If the semantic half cannot be opened, the checks module cannot load, or the ledger row
   cannot be written, **the unit is released** and no charge stands.
4. If the pipeline throws **after the model was called**, the unit is charged and a ledger
   row with `C93` (`modelFailure`) is written. Release-on-throw would give a licensee
   unlimited free inference. This is consistent accounting; it is not proof of fairness —
   see §12.4.

Quota failures: `402 quota_exhausted`, `403 license_revoked`, `403 license_expired`,
`404 unknown_license`, `403 bundle_revoked`, `403 scope_missing`, `401 invalid_token`.
Configuration: `503 run_unavailable` (no model lane or no KEK), `502 run_failed`,
`500 semantic_unavailable`, `502 checks_unavailable`, `500 run_not_recorded`.

### 4.6 `GET /api/recipes/:hash/license/usage` (token, scope `usage`)

```jsonc
{ "ok": true, "usage": { "licenseId": "lic_…", "runs": 12, "used": 12, "quota": 500, "costCents": 0 } }
```

`runs` is ledger rows, `used` is the quota counter. They differ only while a request is in
flight or after a released unit.

### 4.7 `POST /api/recipes/:hash/license` — issue a licence (operator, `manage_keys`)

```jsonc
// request — licenceeKind: "account" | "agent" | "org", default "account"
{ "licenseeId": "…", "licenseeKind": "agent", "quota": 500, "scopes": ["run","verify","usage"],
  "expiresAt": "2027-01-01T00:00:00Z", "priceCents": 0 }
// response 201 — the secret appears once
{ "ok": true, "licenseId": "lic_…", "token": "rcp_…" }
```

Defaults: `quota` = `pricing.quota_default` (else 500), `priceCents` = `pricing.amount_cents`,
`scopes` = all three. Refusals, all of them input errors rather than 500s:
`400 invalid_quota`, `400 quota_exceeds_recipe`, `400 invalid_price`, `409 price_mismatch`,
`400 invalid_scope`, `400 invalid_expiry`, `400 invalid_licensee_kind`, `409 bundle_revoked`,
`404 unknown_bundle`, `500 license_failed`.

A licence **may not exceed the recipe's own `quota_default`** and **may not be priced other
than the recipe's `amount_cents`**. That is the anti-forgery rule on the money path.

### 4.8 `POST /api/recipes` — publish a signed bundle (operator, `manage_keys`)

Body `{ "bundle": "<base64 of .srb>" }` → `201 { ok: true, hash, id, version }`.

Refusals: `400 <verifyBundle reason>`, `503 publish_unavailable` (no KEK),
`422 sealed_unreadable`, `422 invalid_manifest` (producer leak gate — the manifest
reproduces the sealed half), `422 invalid_checks`, `409 bundle_collision`,
`409 version_exists` (republishing changed content under an existing version),
`422 invalid_manifest` from a DB constraint, `503 storage_unavailable`.

### 4.9 `POST /api/recipes/upload` — publish your own (session)

The one path a normal account may take. The server seals it, signs it with the platform
key, and records the caller as `author.id` and therefore the seller.

```jsonc
// request
{ "basis": "<recipe template id>", "title": "…", "description": "…",
  "priceHoneyDrops": 0,
  "method": { "discovery": ["…","…"], "boundary": "…",
              "checklist": { "output": "…", "audience": "…", "success": "…" },
              "outputContract": ["…"] } }
// response 201
{ "ok": true, "hash": "…", "id": "user.ab12cd34.weekly-recap", "version": "1.0.0",
  "title": "…", "price_honey_drops": 0 }
```

`method` is required: `boundary` non-empty and `discovery` with ≥2 entries. Without it the
template's own demo method is sealed, which is how every seeded recipe of a kind ended up
sharing one method.

The **leak gate applies to the shelf copy**. Title and description are compared against the
method being sealed; if they reproduce it, the answer is `422 shelf_copy_collides` with the
colliding runs named so the author can fix them. Paraphrasing the method into the
description is refused even when innocent — write what the buyer gets, not what the recipe
says.

`400 title_required`, `400 invalid_price` (whole Drops, 0–100000), `400 unknown_basis`,
`422 refused`, `400 bad_bundle`, `409 duplicate`, `500 publish_failed`,
`503 publish_unavailable`, `401 signed_out`.

### 4.10 `POST /api/recipes/:hash/use` — run one you own (session)

```jsonc
{ "input": "what you need" }
// 200
{ "hash": "…", "ok": true,
  "artifact": { "title": "…", "sections": [ { "id": "s1", "title": "…", "body": "…" } ] },
  "codes": [], "warnings": [] }
```

The door is entitlement plus session, not a bearer token: a person who paid already has a
session, and minting a secret to hand back to the same browser is a leak surface for
nothing. Entitlement is checked against the licence rows for that account; `402 not_owned`
otherwise. `400 input_required`, `503 run_unavailable`, `502 run_failed`.

If the model drops a section the method's output contract asked for, the section is
returned as `[not produced — the owner must fill this in]` rather than the document being
presented as complete.

### 4.11 `POST /api/recipes/:hash/rate` — score one you own (session)

`{ "stars": 1..5 }` → `{ ok, your_stars, average, count }`. Only an owner may rate: a score
from someone who never ran it is a review of the description. The rater id is stored to
prevent double voting and is never returned. `403 not_owned`, `400 invalid_stars`,
`401 signed_out`.

---

## 5. Verdict codes

| Range | Meaning |
|---|---|
| `C01`–`C24` | house rules, generic across recipes (invented figure, unsourced claim, uncategorised value, …) |
| `C30`–`C37` | boundary rules, one per recipe family (commitments, complaints, meetings, bookkeeping, campaigns, people, grants, disputes) |
| `C00` | fuel budget exhausted — the check program was refused |
| `C90` | the model's output did not match the Draft schema |
| `C91` | disclosure risk — the draft reproduces the sealed method |
| `C92` | meta-refusal — the model answered about the instructions instead of the work |
| `C93` | model failure (no content, provider error, or a throw after the unit was reserved) |

The authoritative list, with the sentence a buyer reads for each code, is
`manifest.checks.codes` in the bundle's own manifest — it is served with 4.2 and is what
`descriptions` in a verify response is drawn from.

---

## 6. Conformance: how to check this without our keys

A deployment with no credentials is a supported state, not a broken one:

- No KEK → verify and the shelf work; publish answers `503 publish_unavailable`, run answers
  `503 run_unavailable`. The seal is **read-only** in that deployment. This is the default
  state of a fresh install: enrolling a recipe is a deliberate act (set the KEK, grant the
  operator), not something that happens by accident.
- No private recipe modules (public build) → `/api/recipes*` answers `503 marketplace_disabled`.

Local checked run, the way the suite does it:

```
npm run build
export DATABASE_URL=<postgres> RECIPE_SEAL_ALLOW_OPEN=1 \
       RECIPE_SEAL_KEK=$(python3 -c 'import base64;print(base64.b64encode(bytes([9]*32)).decode())') \
       RECIPE_SEAL_STORAGE_DIR=/tmp/seal-probe-store PORT=4187
node .output/server/index.mjs
```

Then `POST /api/recipes` a bundle you sealed with `sealBundle`, `GET` its manifest, and
`POST …/verify` a draft. The probe suite (`scripts/seal-http-probe.ts`) does exactly this,
including five forged-but-validly-signed manifests the door must refuse.

---

## 7. Versioning

`protocol` is a hard gate: `verifyBundle` refuses anything that is not `recipe-seal/1`
with `UNSUPPORTED_PROTOCOL`. A breaking change to the bundle is a new protocol string and a
verifier that can read both. Additive changes to responses (new fields, new codes) are not a
version bump; clients must ignore unknown fields and unknown codes.

---

## 8. What is deliberately not in this document

Every item below is a real part of the shipped system. None of it is needed to verify a
bundle, run one you licensed, or decide whether to trust the seal — so publishing it would
only move an attacker's starting point closer.

| Withheld | Why |
|---|---|
| KEK custody: where the key material lives, how it is provisioned, rotated and escrowed | the KEK is the only thing between `semantic.enc` and plaintext; a published custody procedure is a published target list |
| Prompt assembly (the system framing, how the method block is laid out, per-run temperature) | how a method becomes a prompt is the product, and it is where a competing marketplace would copy from |
| Leak-filter thresholds in the run path (shingle width, ratio, withhold ratio, output ceiling) | these decide whether a licensed answer leaks; the leak *gate* on manifests is published in `docs/RECIPE-SEAL.md`, the run-path filter is not |
| Method derivation from a finished job (evidence gathering, the schema hint, clip limits) | it is an authoring feature, not a wire contract; its output is a draft for the author, never a publish |
| Licensing/metering SQL, table names, index and lock strategy | the contract is §4.5's observable order of effects; the schema is an implementation detail and the migrations ship in the deployed tree only |
| Cost-split arithmetic in code (rounding and remainder assignment) | `split_bp` is public and signed in the manifest; the ledger arithmetic is accounting, and §4.5 states the one behaviour that matters |
| Rate-limit numbers, probes thresholds, alert routing | a client should obey `Retry-After`, not hard-code our limits |
| Admin/operator UI and role assignment | not a protocol surface |

---

## 9. Why publishing this does not weaken the seal

Three arguments, each checkable against the code named in §1.

1. **The seal is cryptographic, not obscured.** The bundle format, AAD construction and
   signature scheme are already in `bundle.ts`. Publishing the wire contract adds nothing an
   attacker could not read in that file; keeping the *contract* secret would only have made
   it harder for an honest integrator.
2. **The secret is a key, not a format.** `semantic.enc` is AES-256-GCM under a per-bundle
   DEK, wrapped under the deployment KEK. No amount of protocol documentation substitutes for
   the key. What a reader of this document learns is *where the lock is*, which they already
   knew from the shipped client.
3. **The attack surface that matters is the run path, and it stays closed.** The interesting
   question for an attacker is not "what are the endpoints" — they are in the desktop build —
   but "how do I get prose out of a licensed run". That is the leak filter in §8, and it is
   not here.

What is honestly *not* protected by any of this: `checks.wasm` is obfuscation, not
cryptography; bundles are self-signed with no key registry; and a determined person can read
the compiled private modules out of the desktop installer (`asar` is unpackable). Repository
privacy buys readability, not secrecy — `README.md` in the private repo says so in the same
words.
