/**
 * Human operator roles for the UI and same-origin write paths.
 * Agents never use these — they authenticate with Bearer API keys only.
 */

export type OperatorRole = "viewer" | "operator" | "admin";

export const OPERATOR_ROLES: readonly OperatorRole[] = [
  "viewer",
  "operator",
  "admin",
] as const;

const RANK: Record<OperatorRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

/** Capabilities used by UI gates and server write checks. */
export type OperatorCapability =
  | "read"
  | "write_board"
  | "reply_call"
  | "manage_keys"
  | "manage_settings"
  | "manage_roles"
  | "reset_demo";

const CAP_MIN: Record<OperatorCapability, OperatorRole> = {
  read: "viewer",
  write_board: "operator",
  reply_call: "operator",
  manage_keys: "admin",
  manage_settings: "admin",
  manage_roles: "admin",
  reset_demo: "admin",
};

export function isOperatorRole(v: unknown): v is OperatorRole {
  return typeof v === "string" && (OPERATOR_ROLES as readonly string[]).includes(v);
}

export function roleAtLeast(role: OperatorRole, min: OperatorRole): boolean {
  return RANK[role] >= RANK[min];
}

export function roleCan(role: OperatorRole, cap: OperatorCapability): boolean {
  return roleAtLeast(role, CAP_MIN[cap]);
}

/** Parse comma/space-separated email lists from env. */
export function parseEmailList(raw: string | null | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface RoleResolveInput {
  userId: string;
  email: string | null | undefined;
  /** DB-assigned role if any */
  dbRole?: OperatorRole | null;
  adminEmails?: Iterable<string>;
  operatorEmails?: Iterable<string>;
  viewerEmails?: Iterable<string>;
  /** When no list match and no db role */
  defaultRole?: OperatorRole;
}

/**
 * Resolve operator role for a signed-in human.
 * Precedence: db role → admin email list → operator list → viewer list → default.
 */
export function resolveOperatorRole(input: RoleResolveInput): OperatorRole {
  if (input.dbRole && isOperatorRole(input.dbRole)) return input.dbRole;

  const email = (input.email ?? "").trim().toLowerCase();
  const admins = new Set(
    [...(input.adminEmails ?? [])].map((e) => e.toLowerCase()),
  );
  const operators = new Set(
    [...(input.operatorEmails ?? [])].map((e) => e.toLowerCase()),
  );
  const viewers = new Set(
    [...(input.viewerEmails ?? [])].map((e) => e.toLowerCase()),
  );

  if (email && admins.has(email)) return "admin";
  if (email && operators.has(email)) return "operator";
  if (email && viewers.has(email)) return "viewer";

  const def = input.defaultRole ?? "operator";
  return isOperatorRole(def) ? def : "operator";
}

/** Env-backed resolve for production deploys. */
export function resolveOperatorRoleFromEnv(
  user: { id: string; email?: string | null },
  dbRole?: OperatorRole | null,
  env: NodeJS.ProcessEnv = typeof process !== "undefined" ? process.env : {},
): OperatorRole {
  return resolveOperatorRole({
    userId: user.id,
    email: user.email,
    dbRole,
    adminEmails: parseEmailList(env.AGENT_RELAY_ADMIN_EMAILS),
    operatorEmails: parseEmailList(env.AGENT_RELAY_OPERATOR_EMAILS),
    viewerEmails: parseEmailList(env.AGENT_RELAY_VIEWER_EMAILS),
    defaultRole: isOperatorRole(env.AGENT_RELAY_DEFAULT_ROLE)
      ? env.AGENT_RELAY_DEFAULT_ROLE
      : "operator",
  });
}

export interface RoleGateResult {
  ok: boolean;
  role: OperatorRole | null;
  reason?: string;
}

/**
 * Pure gate: given a resolved role (or null if signed out), can they do `cap`?
 * When `authRequired` is false, missing session is treated as admin (local open UI).
 */
export function gateCapability(
  role: OperatorRole | null,
  cap: OperatorCapability,
  opts: { authRequired: boolean } = { authRequired: true },
): RoleGateResult {
  if (!opts.authRequired) {
    return { ok: true, role: role ?? "admin" };
  }
  if (!role) {
    return { ok: false, role: null, reason: "signed_out" };
  }
  if (!roleCan(role, cap)) {
    return { ok: false, role, reason: "forbidden" };
  }
  return { ok: true, role };
}
