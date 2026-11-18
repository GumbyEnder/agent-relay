/**
 * The package surface: everything the console is allowed to ask BeeZilla for.
 *
 * Before this file the console imported four different internals directly
 * (`buzzy/inferenceToken`, `buzzy/entitlements`, `buzzy/music`,
 * `buzzy/modelPrefs`) from six files. That worked, but it meant the console knew
 * BeeZilla's internal layout — and stage 3 of the split copies this directory into
 * another repo, at which point every one of those imports is a broken path.
 *
 * Now there is one door. `scripts/check-buzzy-boundary.mjs` fails on any
 * console→buzzy import that is not `@/lib/buzzy/public`, so the cost of a new
 * dependency is a deliberate edit to this file rather than an import that happens
 * to resolve.
 *
 * What belongs here: the capability and entitlement contract — the things the
 * console's gateways must enforce on BeeZilla's behalf. What does not: anything
 * that reads or writes user content. If a console screen ever needs chat,
 * documents or memory, that is a product decision about the split, not a re-export.
 */

// Capability tokens — minted for a client, verified by the gateways.
export { inferenceEndpoint, mintInferenceToken, verifyInferenceToken } from "./inferenceToken";
export type { TokenScope } from "./inferenceToken";

// Plans and quotas — whose request is allowed which model, voice or minute.
export { checkQuota, getEntitlement, recordUsage } from "./entitlements";

// Music generation behind that entitlements gate.
export { gatedMusic, musicConfigured } from "./music";

// The operator's saved model controls, validated before the console stores them.
export { validateModelPrefsPatch } from "./modelPrefs";
