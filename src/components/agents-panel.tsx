import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Plus, X } from "lucide-react";
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
import { useBoard } from "@/lib/store";
import { agentApi } from "@/lib/api-client";
import type { AgentStatus, HarnessKind } from "@/lib/types";
import { HARNESS_LABELS } from "@/lib/types";
import {
  CLIENT_AGENT_BLURB,
  DEFAULT_PUBLIC_BASE,
  clientAgentGuideMarkdown,
} from "@/lib/agent-client-guide";

const harnesses = Object.keys(HARNESS_LABELS) as HarnessKind[];
const statuses: AgentStatus[] = ["online", "busy", "idle", "offline", "error"];

export function AgentsPanel() {
  const {
    agents,
    missions,
    projects,
    closePanel,
    registerAgent,
    setAgentStatus,
    removeAgent,
    openPanel,
    selectedProjectId,
    lastSingleProjectId,
    writeProjectId,
    refresh,
  } = useBoard();
  const allBoards =
    selectedProjectId === "__all__" ||
    selectedProjectId === "all" ||
    selectedProjectId === "*";
  const writeId = writeProjectId();
  const boardName = allBoards
    ? "All boards"
    : projects.find((p) => p.id === selectedProjectId)?.name ?? "This board";
  const writeBoardName =
    projects.find((p) => p.id === writeId)?.name ??
    (lastSingleProjectId
      ? projects.find((p) => p.id === lastSingleProjectId)?.name
      : null) ??
    "a board";
  const [name, setName] = useState("");
  const [role, setRole] = useState("client");
  const [harness, setHarness] = useState<HarnessKind>("hermes");
  const [skills, setSkills] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [keys, setKeys] = useState<Array<Record<string, unknown>>>([]);
  const [lastSecret, setLastSecret] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");
  const [keyAgent, setKeyAgent] = useState("");
  const [settings, setSettings] = useState<{
    githubRepo?: string | null;
    replyWebhookUrl?: string | null;
    hasGithubSecret?: boolean;
  }>({});
  const [ghSecret, setGhSecret] = useState("");
  const [ghRepo, setGhRepo] = useState("");
  const [replyUrl, setReplyUrl] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [copiedGuide, setCopiedGuide] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{
    id: string;
    name: string;
    prefix: string;
  } | null>(null);
  const [revokeStep, setRevokeStep] = useState<1 | 2>(1);
  const [revokeBusy, setRevokeBusy] = useState(false);

  // Keys/settings need a concrete board; fall back to last single board.
  const projectId = writeId;
  const publicBase =
    typeof window !== "undefined" ? window.location.origin : DEFAULT_PUBLIC_BASE;
  const clientGuide = useMemo(
    () => clientAgentGuideMarkdown(publicBase),
    [publicBase],
  );
  // Snapshot is already scoped (single board or all boards the user can access).
  const roster = useMemo(() => agents.filter((a) => !a.isDemo), [agents]);

  const reloadKeys = useCallback(async () => {
    if (!projectId) {
      setKeys([]);
      return;
    }
    try {
      const res = await agentApi.listKeys(projectId);
      setKeys(res.keys ?? []);
    } catch {
      setKeys([]);
    }
  }, [projectId]);

  const reloadSettings = useCallback(async () => {
    if (!projectId) {
      setSettings({});
      return;
    }
    try {
      const res = await agentApi.getSettings(projectId);
      setSettings(res.settings ?? {});
      setGhRepo(String(res.settings?.githubRepo ?? ""));
      setReplyUrl(String(res.settings?.replyWebhookUrl ?? ""));
    } catch {
      /* ignore */
    }
  }, [projectId]);

  useEffect(() => {
    void reloadKeys();
    void reloadSettings();
  }, [reloadKeys, reloadSettings]);

  async function issueKey(agentId: string, label?: string) {
    if (!projectId) {
      toast.error("Select a board in the rail before issuing a key");
      return;
    }
    const ag = roster.find((a) => a.id === agentId);
    try {
      const res = await agentApi.createApiKey({
        projectId,
        name: label || `${ag?.name ?? "agent"}-key`,
        agentId,
      });
      setLastSecret(String(res.key.secret ?? ""));
      setKeyAgent(agentId);
      setKeyName("");
      await reloadKeys();
      await refresh();
      toast.success(`Key for ${ag?.name ?? "agent"} — copy secret now`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "create failed");
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium text-fg">Agent roster</h2>
          <p className="text-xs text-fg-subtle">
            {allBoards ? (
              <>
                Scope: <span className="font-medium text-fg">All boards</span>
                {writeId ? (
                  <span className="text-fg-subtle">
                    {" "}
                    · writes → {writeBoardName}
                  </span>
                ) : null}
              </>
            ) : (
              <>
                Selected board:{" "}
                <span className="font-medium text-fg">{boardName}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => {
              if (!writeId) {
                toast.error("Select a board in the rail before registering");
                return;
              }
              setShowForm((v) => !v);
            }}
            aria-label="Register agent"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {showForm && (
          <form
            className="space-y-2 border-b border-border p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) {
                toast.error("Name is required");
                return;
              }
              const n = name.trim();
              registerAgent({
                name: n,
                role: role.trim() || "client",
                harness,
                skills: skills
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              });
              setName("");
              setRole("client");
              setSkills("");
              setShowForm(false);
              toast.success(
                `Registering ${n.toLowerCase()} on ${writeBoardName}…`,
              );
            }}
          >
            <p className="text-[11px] text-fg-muted">
              Adds the agent to{" "}
              <span className="text-fg">{writeBoardName}</span>, then issue a key
              below.
            </p>
            <Input
              placeholder="name (e.g. forge)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Input
              placeholder="role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              required
            />
            <select
              className="h-10 w-full rounded-[var(--radius-sm)] bg-bg-subtle px-3 text-sm text-fg shadow-[var(--shadow-border)]"
              value={harness}
              onChange={(e) => setHarness(e.target.value as HarnessKind)}
            >
              {harnesses.map((h) => (
                <option key={h} value={h}>
                  {HARNESS_LABELS[h]}
                </option>
              ))}
            </select>
            <Input
              placeholder="skills (comma-separated)"
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
            />
            <Button type="submit" size="sm" className="w-full">
              Register on {writeBoardName}
            </Button>
          </form>
        )}

        <div className="border-b border-border px-4 py-2.5">
          <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            {allBoards ? "All-boards roster" : "Board roster"}
          </h3>
          <p className="mt-0.5 text-[11px] text-fg-muted">
            {allBoards ? (
              <>
                Agents across boards you can access
                {roster.length > 0 ? (
                  <span className="text-fg-subtle"> · {roster.length}</span>
                ) : null}
              </>
            ) : (
              <>
                Agents on <span className="text-fg">{boardName}</span>
                {roster.length > 0 ? (
                  <span className="text-fg-subtle"> · {roster.length}</span>
                ) : null}
              </>
            )}
          </p>
        </div>

        <ul className="divide-y divide-border">
          {roster.length === 0 && (
            <li className="px-4 py-8 text-center text-xs text-fg-subtle">
              {allBoards
                ? "No agents on any board yet."
                : "No agents on this board yet."}
              <br />
              <button
                type="button"
                className="mt-2 text-fg underline-offset-2 hover:underline"
                onClick={() => {
                  if (!writeId) {
                    toast.error("Select a board in the rail first");
                    return;
                  }
                  setShowForm(true);
                }}
              >
                Register one{writeId ? ` for ${writeBoardName}` : ""}
              </button>
            </li>
          )}
          {roster.map((a) => {
            const active = missions.find((m) => m.id === a.currentMissionId);
            return (
              <li key={a.id} className="space-y-2 px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-mono text-sm text-fg">{a.name}</p>
                    <p className="text-xs text-fg-muted">{a.role}</p>
                  </div>
                  <Badge variant="default">{HARNESS_LABELS[a.harness] ?? a.harness}</Badge>
                </div>
                {a.skills.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {a.skills.map((s) => (
                      <Badge key={s} variant="default">
                        {s}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 text-[11px] text-fg-subtle">
                  <span className="tabular">
                    HB <RelativeTime ts={a.lastHeartbeat} />
                  </span>
                  {active ? (
                    <button
                      type="button"
                      className="truncate text-left text-status-running hover:underline"
                      onClick={() => openPanel("mission", active.id)}
                    >
                      {active.title}
                    </button>
                  ) : (
                    <span>no mission</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <select
                    className="h-8 flex-1 rounded-[var(--radius-xs)] bg-bg-subtle px-2 text-xs text-fg shadow-[var(--shadow-border)]"
                    value={a.status}
                    onChange={(e) =>
                      setAgentStatus(a.id, e.target.value as AgentStatus)
                    }
                  >
                    {statuses.map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 text-[11px]"
                    onClick={() => void issueKey(a.id)}
                  >
                    Issue key
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      removeAgent(a.id);
                      toast.message("Agent removed");
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-border p-4 space-y-3">
          <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            API keys · {projectId ? writeBoardName : "select a board"}
          </h3>
          <p className="text-[11px] text-fg-muted leading-relaxed">
            {allBoards && !projectId
              ? "Pick a board in the rail to issue or manage keys."
              : allBoards
                ? `Keys for ${writeBoardName} (last selected board). Register → issue key → paste ark_… into the client.`
                : "Register above → issue a key bound to that agent → paste "}
            {!allBoards || projectId ? (
              <>
                {!allBoards ? (
                  <>
                    <code className="text-fg-subtle">ark_…</code> into the
                    client. Secret shown once.
                  </>
                ) : (
                  <> Secret shown once.</>
                )}
              </>
            ) : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="key label (optional)"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              className="h-8 flex-1 min-w-[6rem]"
            />
            <select
              className="h-8 rounded-[var(--radius-sm)] bg-bg-subtle px-2 text-xs shadow-[var(--shadow-border)]"
              value={keyAgent}
              onChange={(e) => setKeyAgent(e.target.value)}
            >
              <option value="">Select agent…</option>
              {roster.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!keyAgent || !projectId}
              onClick={() => {
                if (!projectId) {
                  toast.error("Select a board in the rail first");
                  return;
                }
                if (!keyAgent) {
                  toast.error("Select a registered agent first");
                  return;
                }
                void issueKey(keyAgent, keyName || undefined);
              }}
            >
              Create key
            </Button>
          </div>
          {lastSecret && (
            <div className="rounded-[var(--radius-sm)] border border-status-human/40 bg-status-human/10 p-2 text-[11px] font-mono break-all">
              {lastSecret}
              <Button
                size="sm"
                variant="secondary"
                className="mt-2 w-full"
                onClick={async () => {
                  await navigator.clipboard.writeText(lastSecret);
                  toast.success("Secret copied");
                }}
              >
                Copy secret
              </Button>
            </div>
          )}
          <ul className="space-y-1.5">
            {keys.map((k) => {
              const bound = roster.find((a) => a.id === k.agentId);
              return (
                <li
                  key={String(k.id)}
                  className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1.5 text-[11px]"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{String(k.name)}</div>
                    <div className="font-mono text-fg-subtle">
                      {String(k.keyPrefix)}…
                      {bound ? ` · ${bound.name}` : k.agentId ? " · bound" : " · shared"}
                    </div>
                  </div>
                  {k.revokedAt ? (
                    <Badge variant="done">revoked</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="danger"
                      className="h-7 text-[11px]"
                      onClick={() => {
                        setRevokeStep(1);
                        setRevokeTarget({
                          id: String(k.id),
                          name: String(k.name),
                          prefix: String(k.keyPrefix ?? ""),
                        });
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              );
            })}
            {keys.length === 0 && (
              <li className="text-[11px] text-fg-subtle">
                {projectId
                  ? "No keys on this board yet."
                  : "Select a board to list keys."}
              </li>
            )}
          </ul>

          <Dialog
            open={Boolean(revokeTarget)}
            onOpenChange={(o) => {
              if (!o) {
                setRevokeTarget(null);
                setRevokeStep(1);
              }
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {revokeStep === 1 ? "Revoke API key?" : "Confirm revoke"}
                </DialogTitle>
                <DialogDescription>
                  {revokeStep === 1 ? (
                    <>
                      This disables{" "}
                      <span className="font-mono text-fg">
                        {revokeTarget?.prefix}…
                      </span>{" "}
                      ({revokeTarget?.name}). The client agent will get 401 until you
                      issue a new key.
                    </>
                  ) : (
                    <>
                      Last chance. Revoke is permanent for this secret. You cannot
                      undo — only create a new key.
                    </>
                  )}
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRevokeTarget(null);
                    setRevokeStep(1);
                  }}
                >
                  Cancel
                </Button>
                {revokeStep === 1 ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setRevokeStep(2)}
                  >
                    Continue
                  </Button>
                ) : (
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={revokeBusy}
                    onClick={async () => {
                      if (!revokeTarget) return;
                      setRevokeBusy(true);
                      try {
                        await agentApi.revokeApiKey(revokeTarget.id);
                        await reloadKeys();
                        toast.success("Key revoked");
                        setRevokeTarget(null);
                        setRevokeStep(1);
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "revoke failed");
                      } finally {
                        setRevokeBusy(false);
                      }
                    }}
                  >
                    {revokeBusy ? "Revoking…" : "Yes, revoke permanently"}
                  </Button>
                )}
              </div>
            </DialogContent>
          </Dialog>

          <button
            type="button"
            className="flex w-full items-center gap-1.5 pt-2 text-left text-xs font-medium uppercase tracking-wider text-fg-subtle"
            onClick={() => setGuideOpen((v) => !v)}
          >
            {guideOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Client agent guide
          </button>
          {guideOpen && (
            <div className="space-y-2">
              <p className="text-[11px] leading-relaxed text-fg-muted">
                {CLIENT_AGENT_BLURB}
              </p>
              <p className="font-mono text-[10px] text-fg-subtle break-all">
                {publicBase}
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 text-[11px]"
                  onClick={async () => {
                    await navigator.clipboard.writeText(clientGuide);
                    setCopiedGuide(true);
                    toast.success("Client guide copied — paste into your agent");
                    setTimeout(() => setCopiedGuide(false), 1500);
                  }}
                >
                  {copiedGuide ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  Copy guide for agent
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px]"
                  onClick={async () => {
                    await navigator.clipboard.writeText(publicBase);
                    toast.success("Base URL copied");
                  }}
                >
                  Copy base URL
                </Button>
              </div>
              <pre className="max-h-40 overflow-auto rounded-[var(--radius-sm)] border border-border bg-bg-subtle p-2 text-[10px] leading-relaxed text-fg-muted whitespace-pre-wrap font-mono">
                {clientGuide}
              </pre>
            </div>
          )}

          <button
            type="button"
            className="flex w-full items-center gap-1.5 pt-1 text-left text-xs font-medium uppercase tracking-wider text-fg-subtle"
            onClick={() => setIntegrationsOpen((v) => !v)}
          >
            {integrationsOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Integrations
          </button>
          {integrationsOpen && (
            <div className="space-y-2">
              {!projectId ? (
                <p className="text-[11px] text-fg-muted leading-relaxed">
                  Select a board in the rail to configure GitHub / webhooks for
                  that board.
                </p>
              ) : (
                <>
                  <p className="text-[11px] text-fg-muted leading-relaxed">
                    Map a repo to {writeBoardName}, set the webhook secret, then
                    point GitHub at the URL below. Issues create one mission with
                    stable <code className="text-fg-subtle">external_id</code>{" "}
                    <code className="text-fg-subtle">github:owner/repo#n</code>.
                  </p>
                  <Input
                    placeholder="GitHub repo org/name"
                    value={ghRepo}
                    onChange={(e) => setGhRepo(e.target.value)}
                    className="h-8"
                  />
                  <Input
                    placeholder="GitHub webhook secret"
                    value={ghSecret}
                    onChange={(e) => setGhSecret(e.target.value)}
                    className="h-8"
                    type="password"
                  />
                  <Input
                    placeholder="Reply webhook URL (on Call resolve)"
                    value={replyUrl}
                    onChange={(e) => setReplyUrl(e.target.value)}
                    className="h-8"
                  />
                  <p className="text-[10px] text-fg-subtle break-all">
                    Payload URL: POST /api/agent/webhooks/github?project=
                    {projectId}
                    <br />
                    Events: issues, issue_comment, pull_request, check_run (JSON)
                    <br />
                    {settings.hasGithubSecret
                      ? "Secret configured ✓"
                      : "No secret yet — webhooks accepted unsigned (dev only)"}
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-full"
                    onClick={async () => {
                      try {
                        await agentApi.updateSettings(projectId, {
                          githubRepo: ghRepo || null,
                          githubWebhookSecret: ghSecret || undefined,
                          replyWebhookUrl: replyUrl || null,
                        });
                        setGhSecret("");
                        await reloadSettings();
                        toast.success("Settings saved");
                      } catch (e) {
                        toast.error(
                          e instanceof Error ? e.message : "save failed",
                        );
                      }
                    }}
                  >
                    Save integration settings
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
