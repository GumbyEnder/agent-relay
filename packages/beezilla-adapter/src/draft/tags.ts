/**
 * BeeZilla — Draft tag prefixes
 *
 * Tag conventions for draft-holder missions and their events.
 * All tags are prefixed with `beezilla:` to avoid collisions.
 */

/** Prefix for all BeeZilla draft tags */
export const BEEZILLA_TAG_PREFIX = "beezilla:";

/** Draft holder mission tag — marks the DRAFT-HOLDER mission */
export const DRAFT_HOLDER_TAG = `${BEEZILLA_TAG_PREFIX}draft-holder`;

/** Draft version tag — e.g. `beezilla:version:v3` */
export const DRAFT_VERSION_TAG_PREFIX = `${BEEZILLA_TAG_PREFIX}version:`;

/** Draft status tag — e.g. `beezilla:draft:active` or `beezilla:draft:approved` */
export const DRAFT_STATUS_TAG_PREFIX = `${BEEZILLA_TAG_PREFIX}draft:`;

/** Tags the draft-holder mission always carries */
export const HOLDER_TAGS = [DRAFT_HOLDER_TAG, `${DRAFT_STATUS_TAG_PREFIX}active`];

/**
 * Build a version tag for a given version string.
 * @param version — e.g. "v1", "v2"
 * @returns e.g. "beezilla:version:v1"
 */
export function versionTag(version: string): string {
  return `${DRAFT_VERSION_TAG_PREFIX}${version}`;
}

/**
 * Build a status tag for a given draft status.
 * @param status — e.g. "active", "approved", "voided"
 * @returns e.g. "beezilla:draft:approved"
 */
export function statusTag(status: string): string {
  return `${DRAFT_STATUS_TAG_PREFIX}${status}`;
}
