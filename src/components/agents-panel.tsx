import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
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
import { useBoard } from "@/lib/store";
import { agentApi } from "@/lib/api-client";
import type { AgentStatus, HarnessKind } from "@/lib/types";
import { HARNESS_LABELS } from "@/lib/types";
import {
  CLIENT_AGENT_BLURB,
  DEFAULT_PUBLIC_BASE,
  clientAgentGuideMarkdown,
} from "@/lib/agent-client-guide";
import { cn } from "@/lib/utils";

const harnesses = Object.keys(HARNESS_LABELS) as HarnessKind[];
const statuses: AgentStatus[] = ["online", "busy", "idle", "offline", "error"];

type AgentsTab = "agents" | "create" | "guide";

const TABS: Array<{ id: AgentsTab; label: string }> = [
  { id: "agents", label: "Agents" },
  { id: "create", label: "Create" },
  { id: "guide", label: "Guide" },
];

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
    openAgentProfile,
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
    : (projects.find((p) => p.id === selectedProjectId)?.name ?? "This board");
  const writeBoardName =
    projects.find((p) => p.id === writeId)?.name ??
    (lastSingleProjectId
      ? projects.find((p) => p.id === lastSingleProjectId)?.name
      : null) ??
    "a board";

  const [tab, setTab] = useState<AgentsTab>("agents");
  const [name, setName] = useState("");
  const [role, setRole] = useState("client");
  const [harness, setHarness] = useState<HarnessKind>("hermes");
  const [skills, setSkills] = useState("");
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
  const [copiedGuide, setCopiedGuide] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{
    id: string;
    name: string;
    prefix: string;
  } | null>(null);
  const [revokeStep, setRevokeStep] = useState<1 | 2>(1);
  const [revokeBusy, setRevokeBusy] = useState(false);
  /** Expand key actions for one agent on the list tab */
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);

  const projectId = writeId;
  const publicBase =
    typeof window !== "undefined" ? window.location.origin : DEFAULT_PUBLIC_BASE;
  const clientGuide = useMemo(
    () => clientAgentGuideMarkdown(publicBase),
    [publicBase],
  );
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
      setTab("create");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "create failed");
    }
  }

  function goCreate() {
    if (!writeId) {
      toast.error("Select a board in the rail before registering");
      return;
    }
    setTab("create");
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-fg">Agents</h2>
            <p className="truncate text-xs text-fg-subtle">
              {allBoards ? (
                <>
                  Scope: <span className="font-medium text-fg">All boards</span>
                  {writeId ? (
                    <span className="text-fg-subtle"> · writes → {writeBoardName}</span>
                  ) : null}
                </>
              ) : (
                <>
                  Board: <span className="font-medium text-fg">{boardName}</span>
                </>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {tab === "agents" && (
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={goCreate}
                aria-label="Create agent"
                title="Create agent"
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={closePanel}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div
          className="mt-3 flex gap-0.5 rounded-[var(--radius-sm)] border border-border bg-bg-subtle p-0.5"
          role="tablist"
          aria-label="Agents sections"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex-1 rounded-[var(--radius-xs)] px-2 py-1.5 text-[11px] font-medium transition-colors",
                tab === t.id
                  ? "bg-accent text-accent-fg shadow-sm"
                  : "text-fg-muted hover:text-fg",
              )}
            >
              {t.label}
              {t.id === "agents" && roster.length > 0 ? (
                <span
                  className={cn(
                    "ml-1 tabular",
                    tab === t.id ? "text-accent-fg/80" : "text-fg-subtle",
                  )}
                >
                  {roster.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {tab === "agents" && (
          <AgentsListTab
            roster={roster}
            missions={missions}
            projects={projects}
            selectedProjectId={selectedProjectId}
            allBoards={allBoards}
            boardName={boardName}
            writeBoardName={writeBoardName}
            writeId={writeId}
            expandedAgentId={expandedAgentId}
            setExpandedAgentId={setExpandedAgentId}
            setAgentStatus={setAgentStatus}
            removeAgent={removeAgent}
            openPanel={openPanel}
            issueKey={(id) => void issueKey(id)}
            goCreate={goCreate}
            openAgentProfile={openAgentProfile}
          />
        )}

        {tab === "create" && (
          <CreateTab
            roster={roster}
            writeId={writeId}
            writeBoardName={writeBoardName}
            name={name}
            setName={setName}
            role={role}
            setRole={setRole}
            harness={harness}
            setHarness={setHarness}
            skills={skills}
            setSkills={setSkills}
            registerAgent={registerAgent}
            keyName={keyName}
            setKeyName={setKeyName}
            keyAgent={keyAgent}
            setKeyAgent={setKeyAgent}
            keys={keys}
            lastSecret={lastSecret}
            setLastSecret={setLastSecret}
            issueKey={issueKey}
            projectId={projectId}
            settings={settings}
            ghRepo={ghRepo}
            setGhRepo={setGhRepo}
            ghSecret={ghSecret}
            setGhSecret={setGhSecret}
            replyUrl={replyUrl}
            setReplyUrl={setReplyUrl}
            reloadSettings={reloadSettings}
            setRevokeTarget={setRevokeTarget}
            setRevokeStep={setRevokeStep}
            onRegistered={() => setTab("agents")}
          />
        )}

        {tab === "guide" && (
          <GuideTab
            publicBase={publicBase}
            clientGuide={clientGuide}
            copiedGuide={copiedGuide}
            setCopiedGuide={setCopiedGuide}
          />
        )}
      </div>

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
    </div>
  );
}

function AgentsListTab({
  roster,
  missions,
  projects,
  selectedProjectId,
  allBoards,
  boardName,
  writeBoardName,
  writeId,
  expandedAgentId,
  setExpandedAgentId,
  setAgentStatus,
  removeAgent,
  openPanel,
  issueKey,
  goCreate,
  openAgentProfile,
}: {
  roster: import("@/lib/types").Agent[];
  missions: import("@/lib/types").Mission[];
  projects: import("@/lib/types").Project[];
  selectedProjectId: string | null;
  allBoards: boolean;
  boardName: string;
  writeBoardName: string;
  writeId: string | null;
  expandedAgentId: string | null;
  setExpandedAgentId: (id: string | null) => void;
  setAgentStatus: (id: string, status: AgentStatus) => void;
  removeAgent: (id: string) => void;
  openPanel: (
    panel:
      | "mission"
      | "agents"
      | "agent"
      | "protocol"
      | "calls"
      | "help"
      | "none"
      | "new-mission"
      | "new-agent",
    missionId?: string | null,
  ) => void;
  issueKey: (id: string) => void;
  goCreate: () => void;
  openAgentProfile: (agentId: string) => void;
}) {
  const boardNameById = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  const onThisBoard = !allBoards && selectedProjectId
    ? roster.filter((a) => (a.boardIds ?? []).includes(selectedProjectId))
    : roster;
  const elsewhere =
    !allBoards && selectedProjectId
      ? roster.filter((a) => !(a.boardIds ?? []).includes(selectedProjectId))
      : [];

  function renderAgent(a: import("@/lib/types").Agent) {
    const active = missions.find((m) => m.id === a.currentMissionId);
    const open = expandedAgentId === a.id;
    const boards = (a.boardIds ?? [])
      .map((id) => boardNameById[id] ?? id)
      .filter(Boolean);
    const tip = a.keyTips?.[0];
    return (
      <li key={a.id} className="px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="font-mono text-sm text-fg underline-offset-2 hover:underline"
                title="Open agent profile"
                onClick={() => openAgentProfile(a.id)}
              >
                {a.name}
              </button>
              <Badge variant="default">
                {HARNESS_LABELS[a.harness] ?? a.harness}
              </Badge>
              <StatusDot status={a.status} />
            </div>
            <p className="mt-0.5 text-xs text-fg-muted">{a.role}</p>
            {tip ? (
              <p className="mt-0.5 font-mono text-[10px] text-fg-subtle">
                key …{tip.suffix}
                <span className="text-fg-subtle/80"> · {tip.prefix}…</span>
              </p>
            ) : (
              <p className="mt-0.5 text-[10px] text-fg-subtle">no key</p>
            )}
            {boards.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-1">
                {boards.map((bn) => (
                  <span
                    key={bn}
                    className="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-subtle"
                  >
                    {bn}
                  </span>
                ))}
              </p>
            )}
          </div>
          <span className="shrink-0 text-[11px] text-fg-subtle tabular">
            HB <RelativeTime ts={a.lastHeartbeat} />
          </span>
        </div>

        {a.skills.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {a.skills.map((s) => (
              <Badge key={s} variant="default">
                {s}
              </Badge>
            ))}
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
          {active ? (
            <button
              type="button"
              className="truncate text-left text-status-running hover:underline"
              onClick={() => openPanel("mission", active.id)}
            >
              {active.title}
            </button>
          ) : (
            <span className="text-fg-subtle">no active mission</span>
          )}
          <button
            type="button"
            className="shrink-0 text-fg-muted hover:text-fg"
            onClick={() => setExpandedAgentId(open ? null : a.id)}
          >
            {open ? "Less" : "Manage"}
          </button>
        </div>

        {open && (
          <div className="mt-3 space-y-2 rounded-[var(--radius-sm)] border border-border bg-bg-subtle/60 p-2.5">
            <div className="flex items-center gap-2">
              <select
                className="h-8 flex-1 rounded-[var(--radius-xs)] bg-bg px-2 text-xs text-fg shadow-[var(--shadow-border)]"
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
                onClick={() => issueKey(a.id)}
              >
                <KeyRound className="h-3.5 w-3.5" />
                Issue key
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-[11px]"
                onClick={() => {
                  removeAgent(a.id);
                  toast.message("Agent removed");
                  setExpandedAgentId(null);
                }}
              >
                Remove
              </Button>
            </div>
            <AgentKeyRevealList agentId={a.id} tips={a.keyTips} />
          </div>
        )}
      </li>
    );
  }

  return (
    <div>
      <div className="border-b border-border px-4 py-2.5">
        <p className="text-[11px] text-fg-muted">
          Your full agent fleet
          {roster.length > 0 ? (
            <span className="text-fg-subtle"> · {roster.length}</span>
          ) : null}
          {!allBoards ? (
            <span className="text-fg-subtle">
              {" "}
              · board rail is {boardName} (missions only)
            </span>
          ) : null}
        </p>
      </div>

      <ul className="divide-y divide-border">
        {roster.length === 0 && (
          <li className="px-4 py-12 text-center">
            <p className="text-sm text-fg-muted">No agents registered yet.</p>
            <p className="mt-1 text-xs text-fg-subtle">
              Register a client, then issue an API key so it can claim missions.
            </p>
            <Button size="sm" className="mt-4" onClick={goCreate}>
              <Plus className="h-3.5 w-3.5" />
              Create agent
              {writeId ? ` on ${writeBoardName}` : ""}
            </Button>
          </li>
        )}
        {!allBoards && onThisBoard.length > 0 && (
          <li className="bg-bg-subtle/40 px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
            On {boardName}
          </li>
        )}
        {(allBoards ? roster : onThisBoard).map(renderAgent)}
        {elsewhere.length > 0 && (
          <>
            <li className="bg-bg-subtle/40 px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
              On other boards
            </li>
            {elsewhere.map(renderAgent)}
          </>
        )}
      </ul>
    </div>
  );
}

/** Per-agent API key reveal under Manage / profile. */
export function AgentKeyRevealList({
  agentId,
  tips,
}: {
  agentId: string;
  tips?: import("@/lib/types").AgentKeyTip[];
}) {
  const [keys, setKeys] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void agentApi
      .listAgentKeys(agentId)
      .then((res) => {
        if (!cancelled) setKeys(res.keys ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          // Fall back to tip metadata from the fleet snapshot
          setKeys(
            (tips ?? []).map((t) => ({
              id: t.id,
              keyPrefix: t.prefix,
              keySuffix: t.suffix,
              revealable: false,
              revokedAt: t.revokedAt,
              name: "key",
            })),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, tips]);

  const active = keys.filter((k) => !k.revokedAt);

  if (loading) {
    return (
      <p className="text-[10px] text-fg-subtle">Loading keys…</p>
    );
  }

  if (active.length === 0) {
    return (
      <p className="text-[10px] text-fg-subtle">
        No API key yet — use Issue key above.
      </p>
    );
  }

  return (
    <div className="space-y-1.5 border-t border-border/60 pt-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
        API keys
      </p>
      {active.map((k) => {
        const id = String(k.id);
        const secret = revealed[id];
        const prefix = String(k.keyPrefix ?? "");
        const suffix = String(k.keySuffix ?? prefix.slice(-6));
        const revealable = k.revealable !== false;
        return (
          <div
            key={id}
            className="rounded-[var(--radius-xs)] border border-border/80 bg-bg px-2 py-1.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[11px] font-medium text-fg">
                  {String(k.name || "key")}
                </p>
                <p className="truncate font-mono text-[10px] text-fg-subtle">
                  {secret ? secret : `${prefix}…${suffix}`}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                {secret ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[10px]"
                      onClick={async () => {
                        await navigator.clipboard.writeText(secret);
                        toast.success("Key copied");
                      }}
                    >
                      <Copy className="h-3 w-3" />
                      Copy
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[10px]"
                      onClick={() =>
                        setRevealed((prev) => {
                          const next = { ...prev };
                          delete next[id];
                          return next;
                        })
                      }
                    >
                      <EyeOff className="h-3 w-3" />
                      Hide
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 text-[10px]"
                    disabled={busyId === id}
                    onClick={async () => {
                      setBusyId(id);
                      try {
                        const res = await agentApi.revealApiKey(id);
                        setRevealed((prev) => ({
                          ...prev,
                          [id]: res.key.secret,
                        }));
                      } catch (e) {
                        toast.error(
                          e instanceof Error
                            ? e.message
                            : revealable
                              ? "Reveal failed"
                              : "Not revealable — issue a new key",
                        );
                      } finally {
                        setBusyId(null);
                      }
                    }}
                  >
                    <Eye className="h-3 w-3" />
                    {busyId === id ? "…" : "Reveal"}
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatusDot({ status }: { status: AgentStatus }) {
  const color =
    status === "busy"
      ? "bg-status-running"
      : status === "online" || status === "idle"
        ? "bg-status-ready"
        : status === "error"
          ? "bg-status-blocked"
          : "bg-fg-subtle";
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-fg-subtle">
      <span className={cn("h-1.5 w-1.5 rounded-full", color)} />
      {status}
    </span>
  );
}

function CreateTab({
  roster,
  writeId,
  writeBoardName,
  name,
  setName,
  role,
  setRole,
  harness,
  setHarness,
  skills,
  setSkills,
  registerAgent,
  keyName,
  setKeyName,
  keyAgent,
  setKeyAgent,
  keys,
  lastSecret,
  setLastSecret,
  issueKey,
  projectId,
  settings,
  ghRepo,
  setGhRepo,
  ghSecret,
  setGhSecret,
  replyUrl,
  setReplyUrl,
  reloadSettings,
  setRevokeTarget,
  setRevokeStep,
  onRegistered,
}: {
  roster: import("@/lib/types").Agent[];
  writeId: string | null;
  writeBoardName: string;
  name: string;
  setName: (v: string) => void;
  role: string;
  setRole: (v: string) => void;
  harness: HarnessKind;
  setHarness: (v: HarnessKind) => void;
  skills: string;
  setSkills: (v: string) => void;
  registerAgent: (input: {
    name: string;
    harness: HarnessKind;
    role: string;
    skills: string[];
  }) => void;
  keyName: string;
  setKeyName: (v: string) => void;
  keyAgent: string;
  setKeyAgent: (v: string) => void;
  keys: Array<Record<string, unknown>>;
  lastSecret: string | null;
  setLastSecret: (v: string | null) => void;
  issueKey: (agentId: string, label?: string) => Promise<void>;
  projectId: string | null;
  settings: {
    githubRepo?: string | null;
    replyWebhookUrl?: string | null;
    hasGithubSecret?: boolean;
  };
  ghRepo: string;
  setGhRepo: (v: string) => void;
  ghSecret: string;
  setGhSecret: (v: string) => void;
  replyUrl: string;
  setReplyUrl: (v: string) => void;
  reloadSettings: () => Promise<void>;
  setRevokeTarget: (v: { id: string; name: string; prefix: string } | null) => void;
  setRevokeStep: (v: 1 | 2) => void;
  onRegistered: () => void;
}) {
  const [integrationsOpen, setIntegrationsOpen] = useState(true);
  const field =
    "flex h-8 w-full rounded-[var(--radius-sm)] bg-bg-subtle px-2.5 text-xs text-fg shadow-[var(--shadow-border)] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
  const labelCls =
    "mb-1 block text-[10px] font-medium uppercase tracking-wider text-fg-subtle";
  const webhookUrl =
    typeof window !== "undefined" && projectId
      ? `${window.location.origin}/api/agent/webhooks/github?project=${encodeURIComponent(projectId)}`
      : projectId
        ? `/api/agent/webhooks/github?project=${projectId}`
        : "";

  return (
    <div className="space-y-5 p-4">
      {/* Target board chip — not a full-width control */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
          Target board
        </span>
        {writeId ? (
          <span
            className="max-w-[14rem] truncate rounded-full bg-accent/15 px-2.5 py-0.5 text-[11px] font-medium text-fg"
            title={writeBoardName}
          >
            {writeBoardName}
          </span>
        ) : (
          <span className="rounded-full bg-status-human/15 px-2.5 py-0.5 text-[11px] text-status-human">
            pick a board in the rail
          </span>
        )}
      </div>

      <section className="rounded-[var(--radius-md)] border border-border bg-bg-subtle/30 p-3">
        <h3 className="text-xs font-medium text-fg">New agent</h3>
        <p className="mt-0.5 text-[11px] text-fg-muted">
          Register a client, then issue a key in the next section.
        </p>

        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!writeId) {
              toast.error("Select a board in the rail first");
              return;
            }
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
            toast.success(`Registered ${n.toLowerCase()} on ${writeBoardName}`);
            onRegistered();
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0">
              <label className={labelCls} htmlFor="create-agent-name">
                Name
              </label>
              <Input
                id="create-agent-name"
                placeholder="frodo"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="h-8 text-xs"
              />
            </div>
            <div className="min-w-0">
              <label className={labelCls} htmlFor="create-agent-role">
                Role
              </label>
              <Input
                id="create-agent-role"
                placeholder="client"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                required
                className="h-8 text-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0">
              <label className={labelCls} htmlFor="create-agent-harness">
                Harness
              </label>
              <select
                id="create-agent-harness"
                className={field}
                value={harness}
                onChange={(e) => setHarness(e.target.value as HarnessKind)}
              >
                {harnesses.map((h) => (
                  <option key={h} value={h}>
                    {HARNESS_LABELS[h]}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <label className={labelCls} htmlFor="create-agent-skills">
                Skills
              </label>
              <Input
                id="create-agent-skills"
                placeholder="optional, comma-sep"
                value={skills}
                onChange={(e) => setSkills(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-0.5">
            <Button type="submit" size="sm" disabled={!writeId}>
              <Plus className="h-3.5 w-3.5" />
              Register
            </Button>
          </div>
        </form>
      </section>

      <section className="rounded-[var(--radius-md)] border border-border bg-bg-subtle/30 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-xs font-medium text-fg">API key</h3>
            <p className="mt-0.5 text-[11px] text-fg-muted">
              Bind <code className="text-fg-subtle">ark_…</code> to an agent.
              Secret shown once.
            </p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-[1fr_minmax(0,7.5rem)_auto] items-end gap-2">
          <div className="min-w-0">
            <label className={labelCls} htmlFor="create-key-label">
              Label
            </label>
            <Input
              id="create-key-label"
              placeholder="optional"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="min-w-0">
            <label className={labelCls} htmlFor="create-key-agent">
              Agent
            </label>
            <select
              id="create-key-agent"
              className={field}
              value={keyAgent}
              onChange={(e) => setKeyAgent(e.target.value)}
            >
              <option value="">Select…</option>
              {roster.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            className="h-8 shrink-0"
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
            <KeyRound className="h-3.5 w-3.5" />
            Issue
          </Button>
        </div>

        {lastSecret && (
          <div className="mt-3 rounded-[var(--radius-sm)] border border-status-human/40 bg-status-human/10 p-2.5 text-[11px]">
            <p className="font-mono break-all text-fg">{lastSecret}</p>
            <p className="mt-1 text-[10px] text-fg-muted">
              Tip ends in …{lastSecret.slice(-6)}
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(lastSecret);
                  toast.success("Secret copied");
                }}
              >
                Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setLastSecret(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        <ul className="mt-3 space-y-1 border-t border-border/60 pt-2">
          {keys.map((k) => {
            const bound = roster.find((a) => a.id === k.agentId);
            const suffix =
              (k.keySuffix != null && String(k.keySuffix)) ||
              String(k.keyPrefix ?? "").slice(-6);
            return (
              <li
                key={String(k.id)}
                className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] px-1 py-1.5 text-[11px] hover:bg-bg-subtle"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-fg">
                    {String(k.name)}
                    {bound ? (
                      <span className="font-normal text-fg-subtle">
                        {" "}
                        · {bound.name}
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate font-mono text-[10px] text-fg-subtle">
                    {String(k.keyPrefix)}…{suffix}
                  </div>
                </div>
                {k.revokedAt ? (
                  <Badge variant="done">revoked</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 text-[11px] text-status-blocked hover:bg-status-blocked/10"
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
            <li className="px-1 py-2 text-[11px] text-fg-subtle">
              {projectId ? "No keys on this board yet." : "Select a board first."}
            </li>
          )}
        </ul>
      </section>

      <section className="rounded-[var(--radius-md)] border border-border">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-xs font-medium text-fg"
          onClick={() => setIntegrationsOpen((v) => !v)}
        >
          {integrationsOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-fg-subtle" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-fg-subtle" />
          )}
          GitHub connect
          <span className="ml-1 font-normal text-fg-subtle">
            {settings.hasGithubSecret ? "· linked" : "· setup"}
          </span>
        </button>
        {integrationsOpen && (
          <div className="space-y-3 border-t border-border px-3 pb-3 pt-2">
            {!projectId ? (
              <p className="text-[11px] text-fg-subtle">
                Select a board in the rail to configure.
              </p>
            ) : (
              <>
                <ol className="list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-fg-muted">
                  <li>Copy the payload URL below into a GitHub repo webhook (or App).</li>
                  <li>Generate a secret, paste the same value in GitHub and here, then Save.</li>
                  <li>Set content type to application/json. Events: issues, issue_comment, pull_request, check_run.</li>
                  <li>Open a test issue — one mission appears with external_id github:org/repo#n.</li>
                </ol>

                <ul className="space-y-1 rounded-[var(--radius-sm)] border border-border bg-bg-subtle/50 px-2.5 py-2 text-[11px]">
                  <li className="flex justify-between gap-2">
                    <span className="text-fg-subtle">Repo mapped</span>
                    <span className="font-mono text-fg">
                      {ghRepo.trim() || settings.githubRepo || "—"}
                    </span>
                  </li>
                  <li className="flex justify-between gap-2">
                    <span className="text-fg-subtle">Webhook secret</span>
                    <span className="text-fg">
                      {settings.hasGithubSecret ? "configured ✓" : "missing"}
                    </span>
                  </li>
                  <li className="flex justify-between gap-2">
                    <span className="text-fg-subtle">Board</span>
                    <span className="truncate text-fg">{writeBoardName}</span>
                  </li>
                </ul>

                <div className="min-w-0">
                  <label className={labelCls}>Payload URL</label>
                  <div className="flex gap-1.5">
                    <Input
                      readOnly
                      value={webhookUrl}
                      className="h-8 flex-1 font-mono text-[10px]"
                      onFocus={(e) => e.target.select()}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-8 shrink-0"
                      onClick={async () => {
                        await navigator.clipboard.writeText(webhookUrl);
                        toast.success("Webhook URL copied");
                      }}
                    >
                      Copy
                    </Button>
                  </div>
                </div>

                <div className="min-w-0">
                  <label className={labelCls} htmlFor="gh-repo">
                    GitHub repo
                  </label>
                  <Input
                    id="gh-repo"
                    placeholder="org/name"
                    value={ghRepo}
                    onChange={(e) => setGhRepo(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="min-w-0">
                  <label className={labelCls} htmlFor="gh-secret">
                    Webhook secret
                  </label>
                  <div className="flex gap-1.5">
                    <Input
                      id="gh-secret"
                      placeholder={
                        settings.hasGithubSecret ? "•••• saved — enter to replace" : "generate or paste"
                      }
                      value={ghSecret}
                      onChange={(e) => setGhSecret(e.target.value)}
                      className="h-8 flex-1 text-xs"
                      type="password"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-8 shrink-0"
                      type="button"
                      onClick={() => {
                        const bytes = new Uint8Array(24);
                        crypto.getRandomValues(bytes);
                        const s = Array.from(bytes, (b) =>
                          b.toString(16).padStart(2, "0"),
                        ).join("");
                        setGhSecret(s);
                        void navigator.clipboard.writeText(s).then(
                          () => toast.success("Secret generated + copied — paste into GitHub too"),
                          () => toast.success("Secret generated — copy it into GitHub"),
                        );
                      }}
                    >
                      Generate
                    </Button>
                  </div>
                </div>
                <div className="min-w-0">
                  <label className={labelCls} htmlFor="reply-url">
                    Reply webhook (optional)
                  </label>
                  <Input
                    id="reply-url"
                    placeholder="https://… on Call resolve"
                    value={replyUrl}
                    onChange={(e) => setReplyUrl(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={async () => {
                      try {
                        await agentApi.updateSettings(projectId, {
                          githubRepo: ghRepo || null,
                          githubWebhookSecret: ghSecret || undefined,
                          replyWebhookUrl: replyUrl || null,
                        });
                        setGhSecret("");
                        await reloadSettings();
                        toast.success("GitHub settings saved");
                      } catch (e) {
                        toast.error(
                          e instanceof Error ? e.message : "save failed",
                        );
                      }
                    }}
                  >
                    Save connection
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function downloadMarkdown(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function GuideTab({
  publicBase,
  clientGuide,
  copiedGuide,
  setCopiedGuide,
}: {
  publicBase: string;
  clientGuide: string;
  copiedGuide: boolean;
  setCopiedGuide: (v: boolean) => void;
}) {
  return (
    <div className="space-y-4 p-4">
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
          Client agent guide
        </h3>
        <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
          {CLIENT_AGENT_BLURB}
        </p>
      </div>
      <p className="break-all font-mono text-[10px] text-fg-subtle">{publicBase}</p>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          className="h-8 text-[11px]"
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
          Copy
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="h-8 text-[11px]"
          onClick={() => {
            downloadMarkdown("devboards-client-agent-guide.md", clientGuide);
            toast.success("Downloaded devboards-client-agent-guide.md");
          }}
        >
          <Download className="h-3.5 w-3.5" />
          Download .md
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-[11px]"
          onClick={async () => {
            await navigator.clipboard.writeText(publicBase);
            toast.success("Base URL copied");
          }}
        >
          Copy base URL
        </Button>
      </div>
      <pre className="max-h-[min(60vh,28rem)] overflow-auto rounded-[var(--radius-sm)] border border-border bg-bg-subtle p-3 text-[10px] leading-relaxed text-fg-muted whitespace-pre-wrap font-mono">
        {clientGuide}
      </pre>
    </div>
  );
}
