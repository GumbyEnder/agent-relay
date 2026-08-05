import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Bot,
  LayoutDashboard,
  RefreshCw,
  Shield,
  Users,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import { Button } from "@/components/ui/button";
import { agentApi } from "@/lib/api-client";
import { UserButton } from "@/lib/auth/gates";
import { useOperatorMe } from "@/components/operator-gate";
import { adminPublicUrl } from "@/lib/surface";
import { cn, formatTime } from "@/lib/utils";

type AdminTab = "users" | "usage" | "boards" | "agents" | "hosting";

type PlatformUser = {
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  createdAt: number;
  role: string | null;
  boardCount: number;
  disabled?: boolean;
  disabledAt?: number | null;
  disabledReason?: string | null;
};

type UsagePayload = {
  rangeDays: number;
  since: number;
  totals: {
    missions: number;
    done: number;
    running: number;
    ready: number;
    needsHuman: number;
  };
  users: Array<{
    userId: string;
    name: string;
    email: string | null;
    boards: number;
    missions: number;
    done: number;
    running: number;
    ready: number;
    needsHuman: number;
    lastMissionAt: number | null;
  }>;
  agents: Array<{
    agentId: string;
    name: string;
    status: string;
    lastHeartbeat: number | null;
    boardCount: number;
    claims: number;
    heartbeats: number;
    deliveries: number;
    escalations: number;
    lastEventAt: number | null;
  }>;
};

const TABS: Array<{ id: AdminTab; label: string; icon: typeof Users }> = [
  { id: "users", label: "Users", icon: Users },
  { id: "usage", label: "Usage", icon: Activity },
  { id: "boards", label: "Boards", icon: LayoutDashboard },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "hosting", label: "Hosting", icon: Shield },
];

export function PlatformAdminShell() {
  const { role, can, me } = useOperatorMe();
  const [tab, setTab] = useState<AdminTab>("users");
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [boards, setBoards] = useState<Array<Record<string, unknown>>>([]);
  const [agents, setAgents] = useState<Array<Record<string, unknown>>>([]);
  const [boardQ, setBoardQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [range, setRange] = useState<"7d" | "30d">("7d");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = role === "admin" || can("manage_roles");

  const loadUsers = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await agentApi.adminListUsers();
      setUsers(res.users as PlatformUser[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const loadUsage = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await agentApi.adminUsage(range);
      setUsage(res as UsagePayload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [range]);

  const loadBoards = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await agentApi.adminListBoards({ includeArchived: showArchived });
      setBoards(res.boards ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [showArchived]);

  const loadAgents = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await agentApi.adminListAgents();
      setAgents(res.agents ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    if (tab === "users") void loadUsers();
    if (tab === "usage") void loadUsage();
    if (tab === "boards") void loadBoards();
    if (tab === "agents") void loadAgents();
  }, [tab, isAdmin, loadUsers, loadUsage, loadBoards, loadAgents]);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [invitePassword, setInvitePassword] = useState("");
  const [inviteRole, setInviteRole] = useState<"viewer" | "operator" | "admin">("operator");
  const [inviteBusy, setInviteBusy] = useState(false);

  const setRole = async (userId: string, email: string | null, next: string) => {
    try {
      await agentApi.setRole({ userId, email, role: next as "viewer" | "operator" | "admin" });
      toast.message(`Role · ${next}`);
      await loadUsers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleDisabled = async (u: PlatformUser) => {
    try {
      if (u.disabled) {
        await agentApi.adminEnableUser(u.id);
        toast.success(`Enabled ${u.email ?? u.name}`);
      } else {
        const reason = window.prompt("Disable reason (optional)") ?? undefined;
        await agentApi.adminDisableUser(u.id, reason || undefined);
        toast.success(`Disabled ${u.email ?? u.name}`);
      }
      await loadUsers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const resetPassword = async (u: PlatformUser) => {
    const password = window.prompt(
      `New password for ${u.email ?? u.name} (min 8 chars)`,
    );
    if (!password) return;
    try {
      await agentApi.adminResetUserPassword(u.id, password);
      toast.success("Password reset — user must sign in again");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const inviteUser = async () => {
    if (!inviteEmail.trim() || !invitePassword) {
      toast.error("Email and password required");
      return;
    }
    setInviteBusy(true);
    try {
      const res = await agentApi.adminCreateUser({
        email: inviteEmail.trim(),
        password: invitePassword,
        name: inviteName.trim() || undefined,
        role: inviteRole,
      });
      toast.success(`Created ${res.user.email}`);
      setInviteEmail("");
      setInviteName("");
      setInvitePassword("");
      setInviteRole("operator");
      await loadUsers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setInviteBusy(false);
    }
  };

  const appUrl =
    (typeof window !== "undefined" &&
      (import.meta as { env?: Record<string, string> }).env?.VITE_APP_PUBLIC_URL) ||
    "https://app.devboards.ai";

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <Toaster theme="dark" position="bottom-right" richColors />
      <header className="flex items-center justify-between gap-3 border-b border-border bg-bg-elevated px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] bg-accent text-accent-fg">
            <Shield className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight">Dev Boards Admin</p>
            <p className="text-[11px] text-fg-subtle">
              Platform · {typeof window !== "undefined" ? window.location.host : "admin"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={appUrl}
            className="hidden text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline sm:inline"
          >
            Open operator app
          </a>
          <UserButton />
        </div>
      </header>

      {!isAdmin ? (
        <div className="mx-auto max-w-lg px-4 py-16 text-center">
          <Shield className="mx-auto h-10 w-10 text-fg-subtle" />
          <h1 className="mt-4 text-lg font-semibold">Admin access required</h1>
          <p className="mt-2 text-sm text-fg-muted">
            Signed in as {me?.user?.email ?? "unknown"} with role{" "}
            <span className="font-mono">{role ?? "none"}</span>. Ask a platform admin to grant the
            admin role.
          </p>
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-4 md:flex-row">
          <nav className="flex shrink-0 gap-1 md:w-44 md:flex-col">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-left text-sm transition-colors",
                    tab === t.id
                      ? "bg-accent text-accent-fg"
                      : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {t.label}
                </button>
              );
            })}
          </nav>

          <main className="min-w-0 flex-1 rounded-[var(--radius-lg)] border border-border bg-bg-elevated/40 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold capitalize">{tab}</h2>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || tab === "hosting"}
                onClick={() => {
                  if (tab === "users") void loadUsers();
                  if (tab === "usage") void loadUsage();
                  if (tab === "boards") void loadBoards();
                  if (tab === "agents") void loadAgents();
                }}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
                Refresh
              </Button>
            </div>

            {error ? (
              <p className="mb-3 rounded-[var(--radius-sm)] border border-status-blocked/40 bg-status-blocked/10 px-3 py-2 text-sm text-status-blocked">
                {error}
              </p>
            ) : null}

            {tab === "users" && (
              <div className="space-y-4">
                <section className="rounded-[var(--radius-md)] border border-border bg-bg-subtle/30 p-3">
                  <h3 className="text-xs font-medium text-fg">Invite / create user</h3>
                  <p className="mt-0.5 text-[11px] text-fg-muted">
                    Creates an email/password account and assigns a platform role.
                  </p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                    <input
                      className="h-8 rounded-[var(--radius-xs)] bg-bg px-2 text-xs text-fg shadow-[var(--shadow-border)]"
                      placeholder="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      autoComplete="off"
                    />
                    <input
                      className="h-8 rounded-[var(--radius-xs)] bg-bg px-2 text-xs text-fg shadow-[var(--shadow-border)]"
                      placeholder="name (optional)"
                      value={inviteName}
                      onChange={(e) => setInviteName(e.target.value)}
                    />
                    <input
                      type="password"
                      className="h-8 rounded-[var(--radius-xs)] bg-bg px-2 text-xs text-fg shadow-[var(--shadow-border)]"
                      placeholder="temp password (min 8)"
                      value={invitePassword}
                      onChange={(e) => setInvitePassword(e.target.value)}
                      autoComplete="new-password"
                    />
                    <select
                      className="h-8 rounded-[var(--radius-xs)] bg-bg px-2 text-xs text-fg shadow-[var(--shadow-border)]"
                      value={inviteRole}
                      onChange={(e) =>
                        setInviteRole(e.target.value as "viewer" | "operator" | "admin")
                      }
                    >
                      <option value="viewer">viewer</option>
                      <option value="operator">operator</option>
                      <option value="admin">admin</option>
                    </select>
                    <Button
                      size="sm"
                      className="h-8"
                      disabled={inviteBusy}
                      onClick={() => void inviteUser()}
                    >
                      {inviteBusy ? "Creating…" : "Create user"}
                    </Button>
                  </div>
                </section>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="text-[11px] uppercase tracking-wider text-fg-subtle">
                      <tr className="border-b border-border">
                        <th className="px-2 py-2 font-medium">User</th>
                        <th className="px-2 py-2 font-medium">Role</th>
                        <th className="px-2 py-2 font-medium">Status</th>
                        <th className="px-2 py-2 font-medium">Boards</th>
                        <th className="px-2 py-2 font-medium">Joined</th>
                        <th className="px-2 py-2 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {users.map((u) => (
                        <tr key={u.id} className="hover:bg-bg-subtle/50">
                          <td className="px-2 py-2">
                            <p className="font-medium text-fg">{u.name || "—"}</p>
                            <p className="font-mono text-[11px] text-fg-subtle">{u.email}</p>
                            {!u.emailVerified ? (
                              <span className="text-[10px] text-status-human">unverified</span>
                            ) : null}
                          </td>
                          <td className="px-2 py-2">
                            <select
                              className="h-8 rounded-[var(--radius-xs)] bg-bg-subtle px-2 text-xs text-fg shadow-[var(--shadow-border)]"
                              value={u.role ?? "operator"}
                              onChange={(e) => void setRole(u.id, u.email, e.target.value)}
                            >
                              <option value="viewer">viewer</option>
                              <option value="operator">operator</option>
                              <option value="admin">admin</option>
                            </select>
                          </td>
                          <td className="px-2 py-2">
                            {u.disabled ? (
                              <span className="rounded-full bg-status-blocked/15 px-2 py-0.5 text-[10px] font-medium text-status-blocked">
                                disabled
                              </span>
                            ) : (
                              <span className="rounded-full bg-status-ready/15 px-2 py-0.5 text-[10px] font-medium text-status-ready">
                                active
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2 font-mono tabular text-fg-muted">
                            {u.boardCount}
                          </td>
                          <td className="px-2 py-2 text-xs text-fg-subtle">
                            {formatTime(u.createdAt)}
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex flex-wrap gap-1">
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-7 text-[11px]"
                                onClick={() => void toggleDisabled(u)}
                              >
                                {u.disabled ? "Enable" : "Disable"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 text-[11px]"
                                onClick={() => void resetPassword(u)}
                              >
                                Reset pw
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {users.length === 0 && !busy ? (
                        <tr>
                          <td colSpan={6} className="px-2 py-8 text-center text-fg-subtle">
                            No users found
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {tab === "usage" && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  {(["7d", "30d"] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRange(r)}
                      className={cn(
                        "rounded-full px-3 py-1 text-xs font-medium",
                        range === r
                          ? "bg-accent text-accent-fg"
                          : "bg-bg-subtle text-fg-muted hover:text-fg",
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                {usage ? (
                  <>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                      {(
                        [
                          ["Missions", usage.totals.missions],
                          ["Ready", usage.totals.ready],
                          ["Running", usage.totals.running],
                          ["Needs human", usage.totals.needsHuman],
                          ["Done", usage.totals.done],
                        ] as const
                      ).map(([label, n]) => (
                        <div
                          key={label}
                          className="rounded-[var(--radius-sm)] border border-border bg-bg-subtle/40 px-3 py-2"
                        >
                          <p className="text-[10px] uppercase tracking-wider text-fg-subtle">
                            {label}
                          </p>
                          <p className="font-mono text-lg tabular">{n}</p>
                        </div>
                      ))}
                    </div>

                    <section>
                      <h3 className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
                        <Users className="h-3.5 w-3.5" /> By operator (owned boards)
                      </h3>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[560px] text-left text-sm">
                          <thead className="text-[11px] uppercase tracking-wider text-fg-subtle">
                            <tr className="border-b border-border">
                              <th className="px-2 py-2">User</th>
                              <th className="px-2 py-2">Boards</th>
                              <th className="px-2 py-2">Missions</th>
                              <th className="px-2 py-2">Done</th>
                              <th className="px-2 py-2">Running</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {usage.users.map((u) => (
                              <tr key={u.userId}>
                                <td className="px-2 py-2">
                                  <p className="font-medium">{u.name || "—"}</p>
                                  <p className="font-mono text-[11px] text-fg-subtle">{u.email}</p>
                                </td>
                                <td className="px-2 py-2 font-mono tabular">{u.boards}</td>
                                <td className="px-2 py-2 font-mono tabular">{u.missions}</td>
                                <td className="px-2 py-2 font-mono tabular">{u.done}</td>
                                <td className="px-2 py-2 font-mono tabular">{u.running}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="mt-2 text-[11px] text-fg-subtle">
                        Aggregates only — private mission titles are not shown here.
                      </p>
                    </section>

                    <section>
                      <h3 className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
                        <Bot className="h-3.5 w-3.5" /> By agent
                      </h3>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[560px] text-left text-sm">
                          <thead className="text-[11px] uppercase tracking-wider text-fg-subtle">
                            <tr className="border-b border-border">
                              <th className="px-2 py-2">Agent</th>
                              <th className="px-2 py-2">Boards</th>
                              <th className="px-2 py-2">Claims</th>
                              <th className="px-2 py-2">Delivers</th>
                              <th className="px-2 py-2">HB</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {usage.agents.map((a) => (
                              <tr key={a.agentId}>
                                <td className="px-2 py-2 font-mono">{a.name}</td>
                                <td className="px-2 py-2 font-mono tabular">{a.boardCount}</td>
                                <td className="px-2 py-2 font-mono tabular">{a.claims}</td>
                                <td className="px-2 py-2 font-mono tabular">{a.deliveries}</td>
                                <td className="px-2 py-2 font-mono tabular">{a.heartbeats}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  </>
                ) : (
                  <p className="text-sm text-fg-subtle">{busy ? "Loading…" : "No usage data"}</p>
                )}
              </div>
            )}

            {tab === "boards" && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="h-8 min-w-[12rem] flex-1 rounded-[var(--radius-xs)] bg-bg-subtle px-2 text-xs text-fg shadow-[var(--shadow-border)]"
                    placeholder="Search name, slug, owner…"
                    value={boardQ}
                    onChange={(e) => setBoardQ(e.target.value)}
                  />
                  <label className="flex items-center gap-1.5 text-xs text-fg-muted">
                    <input
                      type="checkbox"
                      checked={showArchived}
                      onChange={(e) => setShowArchived(e.target.checked)}
                    />
                    Archived
                  </label>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="text-[11px] uppercase tracking-wider text-fg-subtle">
                      <tr className="border-b border-border">
                        <th className="px-2 py-2">Board</th>
                        <th className="px-2 py-2">Owner</th>
                        <th className="px-2 py-2">Missions</th>
                        <th className="px-2 py-2">Agents</th>
                        <th className="px-2 py-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {boards
                        .filter((b) => {
                          const q = boardQ.trim().toLowerCase();
                          if (!q) return true;
                          const blob = [
                            b.name,
                            b.slug,
                            b.ownerEmail,
                            b.ownerName,
                            b.id,
                          ]
                            .map((x) => String(x ?? "").toLowerCase())
                            .join(" ");
                          return blob.includes(q);
                        })
                        .map((b) => (
                          <tr key={String(b.id)}>
                            <td className="px-2 py-2">
                              <p className="font-medium">{String(b.name)}</p>
                              <p className="font-mono text-[11px] text-fg-subtle">
                                {String(b.slug)} · {String(b.id)}
                              </p>
                              {b.shared ? (
                                <span className="text-[10px] text-fg-subtle">shared</span>
                              ) : null}
                              {b.archivedAt ? (
                                <span className="ml-1 text-[10px] text-status-human">archived</span>
                              ) : null}
                            </td>
                            <td className="px-2 py-2 text-xs">
                              <p>{String(b.ownerName || "—")}</p>
                              <p className="font-mono text-fg-subtle">
                                {String(b.ownerEmail || "null owner")}
                              </p>
                            </td>
                            <td className="px-2 py-2 font-mono tabular text-xs">
                              {Number(b.missionCount ?? 0)}
                              <span className="text-fg-subtle">
                                {" "}
                                · r{Number(b.readyCount ?? 0)}/run{Number(b.runningCount ?? 0)}
                              </span>
                            </td>
                            <td className="px-2 py-2 font-mono tabular">
                              {Number(b.agentCount ?? 0)}
                            </td>
                            <td className="px-2 py-2">
                              <div className="flex flex-wrap gap-1">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-[10px]"
                                  onClick={() => {
                                    void (async () => {
                                      try {
                                        if (b.archivedAt) {
                                          await agentApi.unarchiveBoard(String(b.id));
                                        } else {
                                          await agentApi.archiveBoard(String(b.id));
                                        }
                                        toast.message(b.archivedAt ? "Unarchived" : "Archived");
                                        await loadBoards();
                                      } catch (e) {
                                        toast.error(
                                          e instanceof Error ? e.message : "Archive failed",
                                        );
                                      }
                                    })();
                                  }}
                                >
                                  {b.archivedAt ? "Unarchive" : "Archive"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-[10px]"
                                  onClick={() => {
                                    const email = window.prompt(
                                      "Transfer ownership to email (empty = shared/demo):",
                                      String(b.ownerEmail ?? ""),
                                    );
                                    if (email === null) return;
                                    void (async () => {
                                      try {
                                        if (!email.trim()) {
                                          await agentApi.adminTransferBoard(String(b.id), {
                                            shared: true,
                                          });
                                        } else {
                                          await agentApi.adminTransferBoard(String(b.id), {
                                            email: email.trim(),
                                          });
                                        }
                                        toast.success("Ownership updated");
                                        await loadBoards();
                                      } catch (e) {
                                        toast.error(
                                          e instanceof Error ? e.message : "Transfer failed",
                                        );
                                      }
                                    })();
                                  }}
                                >
                                  Transfer
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-fg-subtle">
                  Metadata only — mission bodies are not listed here.
                </p>
              </div>
            )}

            {tab === "agents" && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="text-[11px] uppercase tracking-wider text-fg-subtle">
                    <tr className="border-b border-border">
                      <th className="px-2 py-2">Agent</th>
                      <th className="px-2 py-2">Status</th>
                      <th className="px-2 py-2">Boards</th>
                      <th className="px-2 py-2">Keys</th>
                      <th className="px-2 py-2">Flags</th>
                      <th className="px-2 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {agents.map((a) => (
                      <tr key={String(a.id)}>
                        <td className="px-2 py-2">
                          <p className="font-mono font-medium">{String(a.name)}</p>
                          <p className="text-[11px] text-fg-subtle">
                            {String(a.harness)} · {String(a.id)}
                          </p>
                        </td>
                        <td className="px-2 py-2 text-xs">{String(a.status)}</td>
                        <td className="px-2 py-2 font-mono tabular">
                          {Number(a.boardCount ?? 0)}
                        </td>
                        <td className="px-2 py-2 font-mono tabular text-xs">
                          {Number(a.activeKeyCount ?? 0)} active
                          <span className="text-fg-subtle">
                            {" "}
                            / {Number(a.revealableKeyCount ?? 0)} revealable
                          </span>
                        </td>
                        <td className="px-2 py-2 text-[10px]">
                          {a.orphan ? (
                            <span className="rounded bg-status-human/20 px-1.5 py-0.5 text-status-human">
                              orphan
                            </span>
                          ) : (
                            <span className="text-fg-subtle">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex flex-wrap gap-1">
                            {((a.keys as Array<Record<string, unknown>>) ?? [])
                              .slice(0, 2)
                              .map((k) => (
                                <Button
                                  key={String(k.id)}
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-[10px]"
                                  title={`Revoke ${k.keyPrefix}…`}
                                  onClick={() => {
                                    if (
                                      !window.confirm(
                                        `Revoke key ${String(k.keyPrefix)}…${String(k.keySuffix)}?`,
                                      )
                                    ) {
                                      return;
                                    }
                                    void (async () => {
                                      try {
                                        await agentApi.revokeApiKey(String(k.id));
                                        toast.message("Key revoked");
                                        await loadAgents();
                                      } catch (e) {
                                        toast.error(
                                          e instanceof Error ? e.message : "Revoke failed",
                                        );
                                      }
                                    })();
                                  }}
                                >
                                  Revoke key
                                </Button>
                              ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[11px] text-fg-subtle">
                  Prefix/suffix only — full secrets stay on owner reveal paths.
                </p>
              </div>
            )}

            {tab === "hosting" && (
              <div className="space-y-3 text-sm text-fg-muted">
                <p>
                  This Admin surface is meant to run on a <strong className="text-fg">separate Railway
                  service</strong> and hostname (e.g.{" "}
                  <code className="font-mono text-fg">admin.devboards.ai</code>).
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    Set <code className="font-mono text-xs">DEVBOARDS_SURFACE=admin</code> on the admin
                    service.
                  </li>
                  <li>
                    Operator app keeps default surface{" "}
                    <code className="font-mono text-xs">app</code> at app.devboards.ai.
                  </li>
                  <li>Share DATABASE_URL and BETTER_AUTH_SECRET; set BETTER_AUTH_URL to the admin host.</li>
                  <li>
                    ADMIN_PUBLIC_URL on the app service ={" "}
                    {adminPublicUrl() ?? "https://admin.devboards.ai"}
                  </li>
                </ul>
                <p className="text-xs text-fg-subtle">
                  See docs/ADMIN_HOST.md and docs/TEAM_TENANCY_SKETCH.md.
                </p>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
