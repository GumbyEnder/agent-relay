/**
 * BZ-F041 — multi-user identity: invitations, membership, per-member access.
 *
 * Design constraints:
 *  - Members are REAL signed-in accounts (better-auth magic link). No parallel
 *    auth, no shared credentials, no sidecar.
 *  - The owner's records stay keyed by the owner's user_id. A member's request
 *    resolves to the owner's account THROUGH membership — never by rewriting
 *    data ownership.
 *  - Roles are enforced in code: `canPerform()` is the single authority for
 *    which role may take an owner-only action. Prose cannot grant permission.
 */

export type TeamRole = "owner" | "admin" | "member" | "reviewer";
export type MemberRole = Exclude<TeamRole, "owner">;
export type MemberStatus = "invited" | "active" | "revoked";

export interface Membership {
  id: string;
  ownerUserId: string;
  memberUserId: string | null;
  email: string;
  role: MemberRole;
  status: MemberStatus;
}

/** Actions that touch money, sends, deletion, or the team itself. */
export type TeamAction =
  | "read"
  | "draft"
  | "accept_document"
  | "request_changes"
  | "send_outbound"
  | "share_link"
  | "manage_team"
  | "delete_account";

const ALLOWED: Record<TeamRole, ReadonlySet<TeamAction>> = {
  owner: new Set([
    "read", "draft", "accept_document", "request_changes",
    "send_outbound", "share_link", "manage_team", "delete_account",
  ]),
  // Admin runs the work but never deletes the account.
  admin: new Set([
    "read", "draft", "accept_document", "request_changes",
    "send_outbound", "share_link", "manage_team",
  ]),
  // Reviewer may read and decide on documents — never send, never manage people.
  reviewer: new Set(["read", "accept_document", "request_changes"]),
  // Member drafts. Accepting or sending requires a human with authority.
  member: new Set(["read", "draft"]),
};

export const TEAM_ACTIONS: TeamAction[] = [
  "read", "draft", "accept_document", "request_changes",
  "send_outbound", "share_link", "manage_team", "delete_account",
];

export function canPerform(role: TeamRole, action: TeamAction): boolean {
  return ALLOWED[role]?.has(action) ?? false;
}

/** Plain-language refusal — never a bare 403 with no reason. */
export function denialReason(role: TeamRole, action: TeamAction): string {
  const restricted: Record<string, string> = {
    accept_document: "accepting a document is reserved for the owner, an admin, or a reviewer",
    request_changes: "requesting changes is reserved for the owner, an admin, or a reviewer",
    send_outbound: "sending or sharing outside the business needs the owner or an admin",
    share_link: "creating a share link needs the owner or an admin",
    manage_team: "managing teammates needs the owner or an admin",
    delete_account: "only the account owner can delete the account",
  };
  const why = restricted[action] ?? `your role (${role}) cannot ${action.replace(/_/g, " ")}`;
  return `Not allowed: ${why}.`;
}

export interface ActingAccount {
  /** The account whose data this request may touch. */
  accountId: string;
  /** The role the signed-in user holds on that account. */
  role: TeamRole;
  /** Membership row when acting as a teammate (null for the owner themself). */
  membershipId: string | null;
  email: string | null;
}

interface SqlLike {
  (strings: TemplateStringsArray, ...args: unknown[]): Promise<unknown>;
}

/**
 * Resolve who the signed-in user is acting as.
 *
 * The user's own account always wins (an owner never loses their own data by
 * accepting an invitation). Otherwise an ACTIVE membership scopes the request
 * to that owner's account.
 */
export async function resolveActingAccount(
  sql: SqlLike,
  userId: string,
  userEmail: string | null,
  requestedOwnerId?: string | null,
): Promise<ActingAccount> {
  if (requestedOwnerId && requestedOwnerId === userId) {
    return { accountId: userId, role: "owner", membershipId: null, email: userEmail };
  }
  // Two explicit statements instead of a nested sql fragment: the custom
  // wrapper does not splice template fragments, and a silently-empty WHERE
  // would be a security bug here.
  const rows = (requestedOwnerId
    ? await sql`
        SELECT id, owner_user_id, role FROM buzzy_team_members
        WHERE member_user_id = ${userId} AND status = 'active'
          AND owner_user_id = ${requestedOwnerId}
        ORDER BY accepted_at DESC LIMIT 1
      `
    : await sql`
        SELECT id, owner_user_id, role FROM buzzy_team_members
        WHERE member_user_id = ${userId} AND status = 'active'
        ORDER BY accepted_at DESC LIMIT 1
      `) as Array<{ id: string; owner_user_id: string; role: MemberRole }>;
  if (rows.length) {
    return {
      accountId: rows[0].owner_user_id,
      role: rows[0].role as TeamRole,
      membershipId: rows[0].id,
      email: userEmail,
    };
  }
  return { accountId: userId, role: "owner", membershipId: null, email: userEmail };
}

/**
 * Guard for an owner-only action. Returns null when allowed, or the message to
 * return with a 403.
 */
export function guard(action: TeamAction, acting: ActingAccount): string | null {
  if (canPerform(acting.role, action)) return null;
  return denialReason(acting.role, action);
}

/** Delegatable actions — a member may be granted these explicitly, with caps. */
export const DELEGATABLE = [
  "accept_document", "request_changes", "send_outbound", "share_link",
] as const;
export type DelegatableAction = (typeof DELEGATABLE)[number];

export interface DelegationContext {
  /** Which space (company) the work belongs to, when it is scoped. */
  companyId?: string | null;
  /** Amount involved, in cents — compared against the delegation's cap. */
  amountCents?: number | null;
}

export interface DelegationDecision {
  allowed: boolean;
  /** "role" when the role itself permits; "delegation" when a grant applies. */
  via: "role" | "delegation" | "none";
  delegationId?: string;
  /** Why it was refused, in plain language. */
  reason?: string;
}

/**
 * BZ-F034: decide an action against role AND delegation.
 *
 * A role that already permits the action wins. Otherwise a live delegation for
 * that exact action may permit it — but only within its space and amount cap.
 * Expired and revoked delegations never apply, and a cap is a ceiling, not a
 * suggestion.
 */
export async function authorize(
  sql: SqlLike,
  acting: ActingAccount,
  action: TeamAction,
  ctx: DelegationContext = {},
): Promise<DelegationDecision> {
  if (canPerform(acting.role, action)) return { allowed: true, via: "role" };
  if (!acting.membershipId || !(DELEGATABLE as readonly string[]).includes(action)) {
    return { allowed: false, via: "none", reason: denialReason(acting.role, action) };
  }
  const rows = (await sql`
    SELECT id, scope_company_id, max_amount_cents, expires_at
    FROM buzzy_delegations
    WHERE member_id = ${acting.membershipId} AND action = ${action}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
  `) as Array<{
    id: string; scope_company_id: string | null; max_amount_cents: number | null; expires_at: string | null;
  }>;
  if (!rows.length) {
    return { allowed: false, via: "none", reason: denialReason(acting.role, action) };
  }
  // A space-scoped grant applies only inside that space; an unscoped grant
  // applies anywhere on the account.
  const spaceOk = rows.filter((r) =>
    r.scope_company_id == null || (ctx.companyId != null && r.scope_company_id === ctx.companyId),
  );
  if (!spaceOk.length) {
    const spaces = rows.map((r) => r.scope_company_id).filter(Boolean);
    return {
      allowed: false,
      via: "none",
      reason: `Not allowed: your delegation for this action covers ${spaces.length === 1 ? "a different business space" : "other business spaces"}, not this one.`,
    };
  }
  // Cap check: any grant whose ceiling covers the amount (or has no ceiling).
  const capOk = spaceOk.find((r) =>
    r.max_amount_cents == null ||
    (ctx.amountCents != null && ctx.amountCents <= r.max_amount_cents),
  );
  if (!capOk) {
    const ceiling = Math.max(...spaceOk.map((r) => r.max_amount_cents ?? 0));
    return {
      allowed: false,
      via: "none",
      reason: `Not allowed: this delegation is capped at ${(ceiling / 100).toFixed(2)} and the amount involved is higher. Ask the owner to raise the cap.`,
    };
  }
  return { allowed: true, via: "delegation", delegationId: capOk.id };
}
