/**
 * Private-board isolation policy + matrix smoke (shared/demo stay visible).
 */
import { canAccessBoardByOwner, type TenancyActor } from "../src/lib/board-tenancy";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

type Cell = "allow" | "deny";

/** Encode the product matrix from the tenancy smoke ticket. */
function expectAccess(
  actor: TenancyActor,
  boardOwner: string | null,
  expected: Cell,
  label: string,
) {
  const got = canAccessBoardByOwner(actor, boardOwner);
  if (expected === "allow") assert(got, `${label}: expected allow`);
  else assert(!got, `${label}: expected deny`);
}

function main() {
  const A: TenancyActor = { authRequired: true, userId: "user_a", role: "operator" };
  const B: TenancyActor = { authRequired: true, userId: "user_b", role: "operator" };
  const admin: TenancyActor = { authRequired: true, userId: "user_c", role: "admin" };
  const signedOut: TenancyActor = { authRequired: true, userId: null, role: null };
  const openMode: TenancyActor = { authRequired: false, userId: null, role: null };

  const PA = "user_a"; // private board owner A
  const PB = "user_b";
  const S = null; // shared/demo

  // Private PA
  expectAccess(A, PA, "allow", "A on PA");
  expectAccess(B, PA, "deny", "B on PA");
  expectAccess(admin, PA, "allow", "admin on PA");
  expectAccess(signedOut, PA, "deny", "signed-out on PA");

  // Private PB
  expectAccess(B, PB, "allow", "B on PB");
  expectAccess(A, PB, "deny", "A on PB");

  // Shared S — both operators allowed (product policy)
  expectAccess(A, S, "allow", "A on shared");
  expectAccess(B, S, "allow", "B on shared");
  expectAccess(admin, S, "allow", "admin on shared");
  expectAccess(signedOut, S, "deny", "signed-out on shared");

  // Open local mode
  expectAccess(openMode, PA, "allow", "open private");
  expectAccess(openMode, S, "allow", "open shared");

  // Viewer role still owner-gated the same way (capability is separate)
  const viewerA: TenancyActor = { authRequired: true, userId: "user_a", role: "viewer" };
  expectAccess(viewerA, PA, "allow", "viewer owner PA");
  expectAccess(viewerA, PB, "deny", "viewer peer PB");

  console.log("✓ board-tenancy policy + smoke matrix");
}

main();
