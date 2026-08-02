/**
 * Private-board isolation policy (shared/demo stay visible).
 */
import { canAccessBoardByOwner } from "../src/lib/board-tenancy";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

function main() {
  const owner = { authRequired: true, userId: "user_a", role: "operator" as const };
  const other = { authRequired: true, userId: "user_b", role: "operator" as const };
  const admin = { authRequired: true, userId: "user_c", role: "admin" as const };
  const signedOut = { authRequired: true, userId: null, role: null };
  const openMode = { authRequired: false, userId: null, role: null };

  // Private board owned by A
  assert(canAccessBoardByOwner(owner, "user_a"), "owner reads private");
  assert(!canAccessBoardByOwner(other, "user_a"), "peer denied private");
  assert(canAccessBoardByOwner(admin, "user_a"), "admin reads private");
  assert(!canAccessBoardByOwner(signedOut, "user_a"), "signed-out denied");

  // Shared / demo (null owner)
  assert(canAccessBoardByOwner(owner, null), "owner shared ok");
  assert(canAccessBoardByOwner(other, null), "peer shared ok");
  assert(canAccessBoardByOwner(admin, null), "admin shared ok");
  assert(!canAccessBoardByOwner(signedOut, null), "signed-out still denied when auth required");

  // Open local mode
  assert(canAccessBoardByOwner(openMode, "user_a"), "open mode private ok");
  assert(canAccessBoardByOwner(openMode, null), "open mode shared ok");

  console.log("✓ board-tenancy policy");
}

main();
