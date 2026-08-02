import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  KeyRound,
  LogOut,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RelativeTime } from "@/components/relative-time";
import { authClient, authEnabled, signOut } from "@/lib/auth/client";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import { useOperatorMe } from "@/components/operator-gate";
import { useBoard } from "@/lib/store";
import { agentApi } from "@/lib/api-client";
import { applyTheme, isThemeId, THEME_IDS, THEME_LABELS } from "@/lib/theme";
import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";

export function UserProfilePanel() {
  const user = useCurrentUser();
  const { role } = useOperatorMe();
  const {
    closePanel,
    listAllBoards,
    archiveBoard,
    unarchiveBoard,
    deleteBoard,
    setSelectedProjectId,
    selectedProjectId,
  } = useBoard();

  const [boards, setBoards] = useState<Project[]>([]);
  const [loadingBoards, setLoadingBoards] = useState(true);
  const [boardFilter, setBoardFilter] = useState("");
  const [showArchived, setShowArchived] = useState(true);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [accountTheme, setAccountTheme] = useState<string | null>(null);

  const reloadBoards = useCallback(async () => {
    setLoadingBoards(true);
    try {
      const rows = await listAllBoards();
      setBoards(rows);
    } finally {
      setLoadingBoards(false);
    }
  }, [listAllBoards]);

  useEffect(() => {
    void reloadBoards();
  }, [reloadBoards]);

  useEffect(() => {
    void agentApi
      .getPrefs()
      .then((r) => setAccountTheme(r.theme))
      .catch(() => setAccountTheme(null));
  }, []);

  const active = useMemo(
    () => boards.filter((b) => !b.archivedAt),
    [boards],
  );
  const archived = useMemo(
    () => boards.filter((b) => !!b.archivedAt),
    [boards],
  );

  const q = boardFilter.trim().toLowerCase();
  const filterBoard = (b: Project) =>
    !q ||
    b.name.toLowerCase().includes(q) ||
    b.slug.toLowerCase().includes(q);

  const activeFiltered = active.filter(filterBoard);
  const archivedFiltered = archived.filter(filterBoard);

  const label = user?.displayName ?? user?.primaryEmail ?? "Account";
  const initial = label.charAt(0).toUpperCase();

  async function onChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match");
      return;
    }
    setPwBusy(true);
    try {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (error) throw new Error(error.message ?? "Password change failed");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Password change failed");
    } finally {
      setPwBusy(false);
    }
  }

  function canManage(b: Project) {
    if (!user) return false;
    if (role === "admin") return true;
    return b.ownerUserId === user.id;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            {user?.profileImageUrl ? (
              <img
                src={user.profileImageUrl}
                alt=""
                className="h-10 w-10 rounded-full object-cover"
              />
            ) : (
              <span className="grid h-10 w-10 place-items-center rounded-full bg-accent text-sm font-semibold text-accent-fg">
                {initial}
              </span>
            )}
            <div className="min-w-0">
              <h2 className="truncate text-sm font-medium text-fg">{label}</h2>
              <p className="truncate text-xs text-fg-muted">
                {user?.primaryEmail ?? "No email"}
                {role ? ` · ${role}` : ""}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 scrollbar-thin">
        <section className="rounded-[var(--radius-md)] border border-border bg-bg-subtle/30 p-3">
          <h3 className="text-xs font-medium text-fg">Account</h3>
          <dl className="mt-2 space-y-1.5 text-[11px]">
            <div className="flex justify-between gap-2">
              <dt className="text-fg-subtle">Name</dt>
              <dd className="truncate text-fg">{user?.displayName ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-fg-subtle">Email</dt>
              <dd className="truncate text-fg">{user?.primaryEmail ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-fg-subtle">User id</dt>
              <dd className="truncate font-mono text-fg-muted">{user?.id ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-fg-subtle">Role</dt>
              <dd className="text-fg">{role ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <dt className="text-fg-subtle">Theme</dt>
              <dd>
                <select
                  className="h-8 rounded-[var(--radius-sm)] bg-bg px-2 text-xs text-fg shadow-[var(--shadow-border)]"
                  value={accountTheme && isThemeId(accountTheme) ? accountTheme : ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!isThemeId(v)) return;
                    setAccountTheme(v);
                    applyTheme(v);
                    void agentApi
                      .setPrefs({ theme: v })
                      .then(() => toast.success(`Theme saved · ${THEME_LABELS[v]}`))
                      .catch((err) =>
                        toast.error(err instanceof Error ? err.message : "save failed"),
                      );
                  }}
                >
                  <option value="" disabled>
                    Select…
                  </option>
                  {THEME_IDS.map((id) => (
                    <option key={id} value={id}>
                      {THEME_LABELS[id]}
                    </option>
                  ))}
                </select>
              </dd>
            </div>
          </dl>
          {authEnabled && (
            <Button
              size="sm"
              variant="ghost"
              className="mt-3 h-8 w-full justify-start text-fg-muted"
              onClick={() => void signOut("/login")}
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </Button>
          )}
        </section>

        {authEnabled && !user?.isDevFallback && (
          <section className="rounded-[var(--radius-md)] border border-border bg-bg-subtle/30 p-3">
            <div className="flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5 text-fg-subtle" />
              <h3 className="text-xs font-medium text-fg">Change password</h3>
            </div>
            <p className="mt-0.5 text-[11px] text-fg-muted">
              Requires your current password. Other sessions are revoked.
            </p>
            <form className="mt-3 space-y-2" onSubmit={(e) => void onChangePassword(e)}>
              <Input
                type="password"
                autoComplete="current-password"
                placeholder="Current password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="h-8 text-xs"
                required
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder="New password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="h-8 text-xs"
                  required
                  minLength={8}
                />
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Confirm new"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="h-8 text-xs"
                  required
                  minLength={8}
                />
              </div>
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={pwBusy}>
                  {pwBusy ? "Updating…" : "Update password"}
                </Button>
              </div>
            </form>
          </section>
        )}

        <section className="rounded-[var(--radius-md)] border border-border bg-bg-subtle/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-medium text-fg">Boards</h3>
              <p className="mt-0.5 text-[11px] text-fg-muted">
                {active.length} active
                {archived.length ? ` · ${archived.length} archived` : ""}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              onClick={() => void reloadBoards()}
            >
              Refresh
            </Button>
          </div>

          <Input
            value={boardFilter}
            onChange={(e) => setBoardFilter(e.target.value)}
            placeholder="Filter boards…"
            className="mt-2 h-8 text-xs"
          />

          {loadingBoards ? (
            <p className="mt-3 text-[11px] text-fg-subtle">Loading boards…</p>
          ) : (
            <div className="mt-3 space-y-3">
              <BoardGroup
                title="Active"
                empty="No active boards"
                boards={activeFiltered}
                selectedProjectId={selectedProjectId}
                canManage={canManage}
                onOpen={(b) => {
                  setSelectedProjectId(b.id);
                  closePanel();
                }}
                onArchive={(b) => void archiveBoard(b.id).then(() => reloadBoards())}
                onDelete={(b) => {
                  setDeleteConfirm("");
                  setDeleteTarget(b);
                }}
              />

              <div>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 text-left text-[11px] font-medium uppercase tracking-wider text-fg-subtle"
                  onClick={() => setShowArchived((v) => !v)}
                >
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      !showArchived && "-rotate-90",
                    )}
                  />
                  Archive
                  <span className="font-normal normal-case tracking-normal">
                    · {archived.length}
                  </span>
                </button>
                {showArchived && (
                  <div className="mt-2">
                    <p className="mb-2 text-[11px] text-fg-muted">
                      Archived boards keep missions and history. Restore anytime,
                      or delete permanently.
                    </p>
                    <BoardGroup
                      title=""
                      empty="Archive is empty"
                      boards={archivedFiltered}
                      selectedProjectId={selectedProjectId}
                      canManage={canManage}
                      archived
                      onOpen={(b) => {
                        toast.message("Restore the board to open it on the rail");
                      }}
                      onRestore={(b) =>
                        void unarchiveBoard(b.id).then(() => reloadBoards())
                      }
                      onDelete={(b) => {
                        setDeleteConfirm("");
                        setDeleteTarget(b);
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(o) => {
          if (!o) {
            setDeleteTarget(null);
            setDeleteConfirm("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete board permanently?</DialogTitle>
            <DialogDescription>
              This removes{" "}
              <span className="font-medium text-fg">{deleteTarget?.name}</span>{" "}
              and its missions, history, keys, and settings. Prefer{" "}
              <strong>Archive</strong> if you only want it off the rail.
              <br />
              <br />
              Type <span className="font-mono text-fg">{deleteTarget?.name}</span>{" "}
              to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={deleteConfirm}
            onChange={(e) => setDeleteConfirm(e.target.value)}
            placeholder={deleteTarget?.name}
            className="mt-2 h-9"
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDeleteTarget(null);
                setDeleteConfirm("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={
                deleteBusy ||
                !deleteTarget ||
                deleteConfirm.trim() !== deleteTarget.name
              }
              onClick={async () => {
                if (!deleteTarget) return;
                setDeleteBusy(true);
                try {
                  const ok = await deleteBoard(deleteTarget.id);
                  if (ok) {
                    setDeleteTarget(null);
                    setDeleteConfirm("");
                    await reloadBoards();
                  }
                } finally {
                  setDeleteBusy(false);
                }
              }}
            >
              {deleteBusy ? "Deleting…" : "Delete forever"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BoardGroup({
  title,
  empty,
  boards,
  selectedProjectId,
  canManage,
  archived,
  onOpen,
  onArchive,
  onRestore,
  onDelete,
}: {
  title: string;
  empty: string;
  boards: Project[];
  selectedProjectId: string | null;
  canManage: (b: Project) => boolean;
  archived?: boolean;
  onOpen: (b: Project) => void;
  onArchive?: (b: Project) => void;
  onRestore?: (b: Project) => void;
  onDelete: (b: Project) => void;
}) {
  return (
    <div>
      {title ? (
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
          {title}
        </p>
      ) : null}
      {boards.length === 0 ? (
        <p className="text-[11px] text-fg-subtle">{empty}</p>
      ) : (
        <ul className="max-h-56 space-y-1 overflow-y-auto scrollbar-thin">
          {boards.map((b) => {
            const manage = canManage(b);
            const selected = selectedProjectId === b.id;
            return (
              <li
                key={b.id}
                className={cn(
                  "rounded-[var(--radius-sm)] border border-border px-2 py-2",
                  selected && "border-accent/40 bg-accent/5",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onOpen(b)}
                    disabled={archived}
                  >
                    <p className="truncate text-xs font-medium text-fg">{b.name}</p>
                    <p className="truncate font-mono text-[10px] text-fg-subtle">
                      {b.slug}
                      {b.ownerUserId ? " · yours" : " · shared"}
                      {b.archivedAt ? (
                        <>
                          {" · archived "}
                          <RelativeTime ts={b.archivedAt} />
                        </>
                      ) : null}
                    </p>
                  </button>
                  {archived ? (
                    <Badge variant="default">archived</Badge>
                  ) : selected ? (
                    <Badge variant="default">open</Badge>
                  ) : null}
                </div>
                {manage && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {!archived && onArchive && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-[11px]"
                        title="Archive — keep history, hide from rail"
                        onClick={() => onArchive(b)}
                      >
                        <Archive className="h-3 w-3" />
                        Archive
                      </Button>
                    )}
                    {archived && onRestore && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 text-[11px]"
                        onClick={() => onRestore(b)}
                      >
                        <ArchiveRestore className="h-3 w-3" />
                        Restore
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px] text-status-blocked hover:bg-status-blocked/10"
                      onClick={() => onDelete(b)}
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
