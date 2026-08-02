/**
 * Board tenancy policy (private vs shared/demo).
 *
 * Product rule:
 * - Shared/demo boards (`ownerUserId == null`) are visible to any signed-in operator.
 * - Private boards (`ownerUserId` set) are owner-or-admin only.
 * - Open/local mode (`authRequired == false`) allows access (no multi-tenant gate).
 */

export type TenancyActor = {
  authRequired: boolean;
  userId: string | null | undefined;
  role: string | null | undefined;
};

/** True when the actor may read/write this board under product policy. */
export function canAccessBoardByOwner(
  actor: TenancyActor,
  boardOwnerUserId: string | null | undefined,
): boolean {
  if (!actor.authRequired) return true;
  if (!actor.userId) return false;
  if (actor.role === "admin") return true;
  if (boardOwnerUserId == null || boardOwnerUserId === "") return true;
  return boardOwnerUserId === actor.userId;
}
