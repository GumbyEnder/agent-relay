/**
 * HTTP surface for the five agent verbs (+ operator helpers).
 *
 * Routes (all under /api/agent):
 *   GET  /health
 *   GET  /missions?column=ready&limit=5&agent=forge&tags=docs,ops
 *   GET  /missions/:id
 *   POST /missions/:id/claim      { agent }
 *   POST /missions/:id/heartbeat  { agent, note? }
 *   POST /missions/:id/escalate   { agent, question }
 *   POST /missions/:id/deliver    { agent, summary, artifacts? }
 *   POST /v1                      { action: poll|claim|heartbeat|escalate|deliver, ... }
 *   GET  /agents
 *   POST /agents                  { name, harness, role?, skills? }
 *   GET  /calls
 *   POST /calls/:id/reply         { reply }   — operator
 *   GET  /export
 *   POST /reset                   — demo only
 *
 * Auth: if AGENT_RELAY_API_KEY is set, require
 *   Authorization: Bearer <key>  OR  X-Agent-Key: <key>
 * If unset, open access (local demo).
 */
import type { HarnessKind } from "./types";
import { boardOps, ensureBoardReady } from "./board-server";
import type { EngineResult } from "./board-engine";
import type { MissionColumn } from "./types";
import { verifyGitHubSignature } from "./github-webhook";
import { extractArtifactFromGitHubPayload } from "./github-ingest";

const HARNESSES = new Set<HarnessKind>([
  "claude_code",
  "codex",
  "cursor",
  "opencode",
  "gemini_cli",
  "copilot",
  "amp",
  "mcp",
  "custom",
]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization, x-agent-key",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });
}

function err(status: number, error: string, code?: string): Response {
  return json({ ok: false, error, code }, status);
}

function fromEngine<T>(result: EngineResult<T>): Response {
  if (!result.ok) return err(result.status, result.error, result.code);
  return json({ ok: true, ...result.data });
}

function isSameOriginBrowser(req: Request): boolean {
  const site = (req.headers.get("sec-fetch-site") ?? "").toLowerCase();
  if (site === "same-origin") return true;
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  if (origin && host) {
    try {
      if (new URL(origin).host === host.split(",")[0]!.trim()) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function presentedKey(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-agent-key")?.trim() ?? "";
}

async function requireApiKey(req: Request): Promise<Response | null> {
  // Browser operator UI is same-origin — never require agent keys in the SPA.
  if (isSameOriginBrowser(req)) return null;

  const key = presentedKey(req);
  const globalKey = process.env.AGENT_RELAY_API_KEY?.trim();

  if (key) {
    if (globalKey && key === globalKey) return null;
    if (key.startsWith("ark_")) {
      const hit = await boardOps.verifyPresentedApiKey(key);
      if (hit) return null;
    }
    if (globalKey) return err(401, "Invalid or missing API key", "unauthorized");
    // scoped keys exist path failed
    const hit = key.startsWith("ark_") ? null : null;
    if (key.startsWith("ark_")) return err(401, "Invalid or revoked API key", "unauthorized");
  }

  // No key presented: require auth if global key OR any scoped keys might exist.
  // Enforce when global is set; also when Authorization required by presence of ark attempt only.
  if (globalKey) return err(401, "Invalid or missing API key", "unauthorized");
  return null;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "HEAD") return {};
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    throw new Error("invalid_json");
  }
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

function projectRef(
  url: URL,
  body?: Record<string, unknown>,
): string | undefined {
  const q = url.searchParams.get("project") ?? url.searchParams.get("project_id");
  if (q?.trim()) return q.trim();
  if (body) {
    const b = str(body.project) ?? str(body.project_id);
    if (b?.trim()) return b.trim();
  }
  return undefined;
}

function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Handle a full Request whose pathname starts with /api/agent.
 */
export async function handleAgentApiRequest(req: Request): Promise<Response> {
  await ensureBoardReady();
  const url = new URL(req.url);
  let path = url.pathname;
  // Normalize trailing slash
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, authorization, x-agent-key",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      },
    });
  }

  const authFail = await requireApiKey(req);
  if (authFail) return authFail;

  const prefix = "/api/agent";
  if (!path.startsWith(prefix)) {
    return err(404, "Not found");
  }
  const rest = path.slice(prefix.length) || "/";
  const parts = rest.split("/").filter(Boolean);
  // parts e.g. ["missions", "msn_x", "claim"]

  try {
    let body: Record<string, unknown> = {};
    let rawBody = "";
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        rawBody = await req.text();
        if (rawBody.trim()) {
          const parsed = JSON.parse(rawBody) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            body = parsed as Record<string, unknown>;
          }
        }
      }
    } catch {
      return err(400, "Invalid JSON body", "invalid_json");
    }

    // GET /health
    if (parts.length === 1 && parts[0] === "health" && req.method === "GET") {
      const snap = await boardOps.snapshot();
      return json({
        ok: true,
        service: "agent-relay",
        version: "0.2.0",
        verbs: ["poll", "claim", "heartbeat", "escalate", "deliver"],
        missions: snap.missions.length,
        agents: snap.agents.length,
        open_calls: snap.calls.filter((c) => !c.resolvedAt).length,
        api_key_required: Boolean(process.env.AGENT_RELAY_API_KEY?.trim()),
        store: "durable",
      });
    }

    // POST /v1  — action dispatcher matching PROTOCOL.md
    if (parts.length === 1 && parts[0] === "v1" && req.method === "POST") {
      return handleAction(body);
    }

    // GET /missions
    if (parts.length === 1 && parts[0] === "missions" && req.method === "GET") {
      const column = (url.searchParams.get("column") ?? "ready") as MissionColumn;
      const limit = Number(url.searchParams.get("limit") ?? "5");
      const agent = url.searchParams.get("agent") ?? undefined;
      const tags = url.searchParams.get("tags")?.split(",").filter(Boolean);
      const result = await boardOps.poll({
        column,
        limit: Number.isFinite(limit) ? limit : 5,
        agent,
        tags,
        projectId: projectRef(url),
      });
      return fromEngine(result);
    }

    // GET /missions/:id
    if (parts.length === 2 && parts[0] === "missions" && req.method === "GET") {
      const id = parts[1]!;
      const snap = await boardOps.snapshot();
      const m = snap.missions.find((x) => x.id === id);
      if (!m) return err(404, `Unknown mission: ${id}`, "mission_not_found");
      return json({ ok: true, mission: m });
    }

    // POST /missions/:id/claim|heartbeat|escalate|deliver|move|artifacts
    if (parts.length === 3 && parts[0] === "missions" && req.method === "POST") {
      const id = parts[1]!;
      const verb = parts[2]!;

      if (verb === "artifacts") {
        const urlA = str(body.url) ?? str(body.html_url);
        if (!urlA) return err(400, "url required", "bad_request");
        const m = await boardOps.attachMissionArtifact(id, urlA, str(body.note));
        if (!m) return err(404, "mission not found", "mission_not_found");
        return json({ ok: true, mission: m });
      }

      if (verb === "move") {
        const column = str(body.column) as import("./types").MissionColumn | undefined;
        if (!column) return err(400, "column is required", "bad_request");
        const actor = str(body.actor) ?? "operator";
        return fromEngine(await boardOps.moveMission(id, column, actor));
      }

      const agent = str(body.agent) ?? str(body.agent_id);
      if (!agent) return err(400, "agent is required", "bad_request");

      if (verb === "claim") {
        return fromEngine(await boardOps.claim(id, agent));
      }
      if (verb === "heartbeat") {
        return fromEngine(await boardOps.heartbeat(id, agent, str(body.note)));
      }
      if (verb === "escalate") {
        const question = str(body.question);
        if (!question) return err(400, "question is required", "bad_request");
        return fromEngine(await boardOps.escalate(id, agent, question));
      }
      if (verb === "deliver") {
        const summary = str(body.summary) ?? str(body.delivery) ?? "";
        return fromEngine(
          await boardOps.deliver(id, agent, summary, strArr(body.artifacts) ?? []),
        );
      }
      return err(404, `Unknown verb: ${verb}`);
    }

    // GET /agents
    if (parts.length === 1 && parts[0] === "agents" && req.method === "GET") {
      const snap = await boardOps.snapshot();
      return json({ ok: true, agents: snap.agents });
    }

    // POST /agents
    if (parts.length === 1 && parts[0] === "agents" && req.method === "POST") {
      const name = str(body.name);
      const harness = str(body.harness) as HarnessKind | undefined;
      if (!name || !harness) return err(400, "name and harness are required", "bad_request");
      if (!HARNESSES.has(harness)) {
        return err(400, `Invalid harness. One of: ${[...HARNESSES].join(", ")}`, "bad_request");
      }
      return fromEngine(
        await boardOps.registerAgent({
          name,
          harness,
          role: str(body.role),
          skills: strArr(body.skills),
        }),
      );
    }

    // GET /calls
    if (parts.length === 1 && parts[0] === "calls" && req.method === "GET") {
      const snap = await boardOps.snapshot();
      const openOnly = url.searchParams.get("open") !== "0";
      const calls = openOnly ? snap.calls.filter((c) => !c.resolvedAt) : snap.calls;
      return json({ ok: true, calls });
    }

    // POST /calls/:id/reply
    if (parts.length === 3 && parts[0] === "calls" && parts[2] === "reply" && req.method === "POST") {
      const reply = str(body.reply);
      if (!reply) return err(400, "reply is required", "bad_request");
      const { result, webhook } = await boardOps.replyToCallWithWebhook(parts[1]!, reply);
      if (!result.ok) return fromEngine(result);
      return json({ ok: true, ...result.data, webhook });
    }

    // GET /export
    if (parts.length === 1 && parts[0] === "export" && req.method === "GET") {
      return json({ ok: true, ...(await boardOps.exportActive()) });
    }

    // POST /reset
    if (parts.length === 1 && parts[0] === "reset" && req.method === "POST") {
      const board = await boardOps.reset();
      return json({
        ok: true,
        message: "Demo board reset",
        missions: board.missions.length,
        agents: board.agents.length,
      });
    }


    // GET /admin — operator live dashboard payload (events + history + board)
    if (parts.length === 1 && parts[0] === "admin" && req.method === "GET") {
      const snap = await boardOps.adminSnapshot(projectRef(url));
      return json({ ok: true, projectId: projectRef(url) ?? null, ...snap });
    }

    // GET|POST /projects
    if (parts.length === 1 && parts[0] === "projects" && req.method === "GET") {
      const projects = await boardOps.listProjects();
      return json({ ok: true, projects });
    }
    if (parts.length === 1 && parts[0] === "projects" && req.method === "POST") {
      const name = str(body.name);
      if (!name) return err(400, "name is required", "bad_request");
      const project = await boardOps.createProject({
        name,
        slug: str(body.slug),
        description: str(body.description),
      });
      return json({ ok: true, project });
    }

    // POST /webhooks/github — signed issue/PR ingest
    if (
      parts.length === 2 &&
      parts[0] === "webhooks" &&
      parts[1] === "github" &&
      req.method === "POST"
    ) {
      const projectId = projectRef(url, body) ?? str(body.projectId) ?? "proj_default";
      const settings = await boardOps.getProjectSettings(projectId);
      const envSecret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
      const secret = settings.githubWebhookSecret?.trim() || envSecret || "";
      if (secret) {
        const sig = req.headers.get("x-hub-signature-256");
        if (!verifyGitHubSignature(rawBody, sig, secret)) {
          return err(401, "Invalid GitHub webhook signature", "unauthorized");
        }
      }
      try {
        const eventName = (req.headers.get("x-github-event") ?? str(body.action) ?? "").toLowerCase();
        // PR / check / workflow artifact attach
        if (eventName.includes("pull_request") || eventName.includes("check_run") || eventName.includes("workflow_run") || body.pull_request || body.check_run || body.workflow_run) {
          const art = extractArtifactFromGitHubPayload(body);
          if (art) {
            let missionId: string | null = null;
            if (art.externalId) {
              const snap = await boardOps.snapshot(projectId);
              const m = snap.missions.find((x) => x.externalId === art.externalId);
              missionId = m?.id ?? null;
            }
            if (!missionId && str(body.mission_id)) missionId = str(body.mission_id)!;
            if (missionId) {
              const m = await boardOps.attachMissionArtifact(missionId, art.url, art.note);
              return json({ ok: true, attached: true, mission: m, artifact: art });
            }
            return json({ ok: true, attached: false, reason: "no_linked_mission", artifact: art });
          }
        }
        if (body.issue) {
          const result = await boardOps.ingestGitHubIssue({
            action: str(body.action),
            issue: body.issue as any,
            repository: body.repository as any,
            projectId,
          });
          return json({ ok: true, ...result });
        }
        return json({ ok: true, ignored: true, event: eventName });
      } catch (e) {
        return err(400, e instanceof Error ? e.message : "ingest failed", "bad_request");
      }
    }

    // POST /ingest/github/artifact — attach PR/check URL to mission
    if (parts.length === 3 && parts[0] === "ingest" && parts[1] === "github" && parts[2] === "artifact" && req.method === "POST") {
      const art = extractArtifactFromGitHubPayload(body);
      const missionId = str(body.mission_id) ?? str(body.missionId);
      const urlA = str(body.url) ?? art?.url;
      if (!missionId || !urlA) return err(400, "mission_id and url required", "bad_request");
      const m = await boardOps.attachMissionArtifact(missionId, urlA, str(body.note) ?? art?.note);
      if (!m) return err(404, "mission not found", "mission_not_found");
      return json({ ok: true, mission: m });
    }

    // POST /ingest/github — same as webhook (testable without GH)
    if (parts.length === 2 && parts[0] === "ingest" && parts[1] === "github" && req.method === "POST") {
      try {
        const result = await boardOps.ingestGitHubIssue({
          action: str(body.action),
          issue: (body.issue ?? body) as any,
          repository: body.repository as any,
          projectId: str(body.projectId) ?? str(body.project) ?? projectRef(url, body),
        });
        return json({ ok: true, ...result });
      } catch (e) {
        return err(400, e instanceof Error ? e.message : "ingest failed", "bad_request");
      }
    }

    // GET /missions/:id/journal.md
    if (
      parts.length === 3 &&
      parts[0] === "missions" &&
      parts[2] === "journal.md" &&
      req.method === "GET"
    ) {
      const md = await boardOps.journalMarkdown(parts[1]!);
      if (!md) return err(404, "mission not found", "mission_not_found");
      return new Response(md, {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    // GET /missions/:id/journal (json wrapper)
    if (
      parts.length === 3 &&
      parts[0] === "missions" &&
      parts[2] === "journal" &&
      req.method === "GET"
    ) {
      const md = await boardOps.journalMarkdown(parts[1]!);
      if (!md) return err(404, "mission not found", "mission_not_found");
      return json({ ok: true, mission_id: parts[1], markdown: md });
    }

    // GET /board — full snapshot for UI
    if (parts.length === 1 && parts[0] === "board" && req.method === "GET") {
      const snap = await boardOps.snapshot(projectRef(url));
      return json({ ok: true, projectId: projectRef(url) ?? null, ...snap });
    }

    // GET /missions/:id/history
    if (parts.length === 3 && parts[0] === "missions" && parts[2] === "history" && req.method === "GET") {
      const hist = await boardOps.history(parts[1]!);
      return json({ ok: true, mission_id: parts[1], history: hist });
    }

    // POST /missions/:id/move  { column, actor? }
    if (parts.length === 3 && parts[0] === "missions" && parts[2] === "move" && req.method === "POST") {
      const column = str(body.column) as MissionColumn | undefined;
      if (!column) return err(400, "column is required", "bad_request");
      const actor = str(body.actor) ?? "operator";
      return fromEngine(await boardOps.moveMission(parts[1]!, column, actor));
    }

    // POST /missions  create
    if (parts.length === 1 && parts[0] === "missions" && req.method === "POST") {
      const title = str(body.title);
      const objective = str(body.objective);
      if (!title || !objective) return err(400, "title and objective required", "bad_request");
      return fromEngine(
        await boardOps.createMission({
          title,
          objective,
          context: str(body.context),
          constraints: str(body.constraints),
          acceptance: str(body.acceptance),
          priority: str(body.priority) as any,
          tags: strArr(body.tags),
          column: str(body.column) as any,
          projectId: str(body.projectId) ?? str(body.project) ?? projectRef(url, body),
        }),
      );
    }


    // --- API keys ---
    if (parts.length === 1 && parts[0] === "keys" && req.method === "GET") {
      const projectId = projectRef(url, body) ?? "proj_default";
      const keys = await boardOps.listApiKeys(projectId);
      return json({ ok: true, keys });
    }
    if (parts.length === 1 && parts[0] === "keys" && req.method === "POST") {
      const projectId = str(body.projectId) ?? str(body.project) ?? projectRef(url, body) ?? "proj_default";
      const created = await boardOps.createApiKey({
        projectId,
        agentId: str(body.agentId) ?? str(body.agent) ?? null,
        name: str(body.name),
      });
      return json({ ok: true, key: created });
    }
    if (parts.length === 2 && parts[0] === "keys" && req.method === "DELETE") {
      await boardOps.revokeApiKey(parts[1]!);
      return json({ ok: true, revoked: parts[1] });
    }
    if (parts.length === 3 && parts[0] === "keys" && parts[2] === "revoke" && req.method === "POST") {
      await boardOps.revokeApiKey(parts[1]!);
      return json({ ok: true, revoked: parts[1] });
    }

    // --- project settings ---
    if (parts.length === 2 && parts[0] === "projects" && parts[1] && req.method === "GET") {
      // fallthrough if not settings
    }
    if (parts.length === 3 && parts[0] === "projects" && parts[2] === "settings" && req.method === "GET") {
      const s = await boardOps.getProjectSettings(parts[1]!);
      return json({
        ok: true,
        settings: {
          projectId: s.projectId,
          githubRepo: s.githubRepo,
          replyWebhookUrl: s.replyWebhookUrl,
          hasGithubSecret: s.hasGithubSecret,
        },
      });
    }
    if (parts.length === 3 && parts[0] === "projects" && parts[2] === "settings" && req.method === "POST") {
      const s = await boardOps.updateProjectSettings(parts[1]!, {
        githubWebhookSecret: body.githubWebhookSecret === undefined ? undefined : (str(body.githubWebhookSecret) ?? null),
        githubRepo: body.githubRepo === undefined ? undefined : (str(body.githubRepo) ?? null),
        replyWebhookUrl: body.replyWebhookUrl === undefined ? undefined : (str(body.replyWebhookUrl) ?? null),
      });
      return json({
        ok: true,
        settings: {
          projectId: s.projectId,
          githubRepo: s.githubRepo,
          replyWebhookUrl: s.replyWebhookUrl,
          hasGithubSecret: s.hasGithubSecret,
        },
      });
    }

    // audit export
    if (parts.length === 1 && parts[0] === "export" && url.searchParams.get("history") === "1" && req.method === "GET") {
      const format = (url.searchParams.get("format") ?? "json") === "csv" ? "csv" : "json";
      const exp = await boardOps.exportHistory({
        projectId: projectRef(url),
        missionId: url.searchParams.get("mission") ?? url.searchParams.get("mission_id"),
        format,
      });
      if (format === "csv") {
        return new Response(exp.body, {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="mission-history.csv"',
            "cache-control": "no-store",
          },
        });
      }
      return json({ ok: true, count: exp.count, history: JSON.parse(exp.body) });
    }

    // attach artifact
    if (parts.length === 3 && parts[0] === "missions" && parts[2] === "artifacts" && req.method === "POST") {
      const urlA = str(body.url) ?? str(body.html_url);
      if (!urlA) return err(400, "url required", "bad_request");
      const m = await boardOps.attachMissionArtifact(parts[1]!, urlA, str(body.note));
      if (!m) return err(404, "mission not found", "mission_not_found");
      return json({ ok: true, mission: m });
    }

    // GET /  — catalog
    if (parts.length === 0 && req.method === "GET") {
      return json({
        ok: true,
        service: "agent-relay",
        protocol: "v0.2",
        endpoints: {
          health: "GET /api/agent/health",
          poll: "GET /api/agent/missions?column=ready&limit=5&agent=forge",
          claim: "POST /api/agent/missions/:id/claim",
          heartbeat: "POST /api/agent/missions/:id/heartbeat",
          escalate: "POST /api/agent/missions/:id/escalate",
          deliver: "POST /api/agent/missions/:id/deliver",
          action: "POST /api/agent/v1  { action, ... }",
          agents: "GET|POST /api/agent/agents",
          calls: "GET /api/agent/calls",
          reply: "POST /api/agent/calls/:id/reply",
          export: "GET /api/agent/export",
          admin: "GET /api/agent/admin?project=",
          projects: "GET|POST /api/agent/projects",
          github_ingest: "POST /api/agent/ingest/github",
          journal: "GET /api/agent/missions/:id/journal",
        },
      });
    }

    return err(404, `No route for ${req.method} ${path}`);
  } catch (e) {
    console.error("[agent-api]", e);
    return err(500, e instanceof Error ? e.message : "Internal error", "internal");
  }
}

async function handleAction(body: Record<string, unknown>): Promise<Response> {
  const action = str(body.action)?.toLowerCase();
  if (!action) return err(400, "action is required", "bad_request");

  if (action === "poll") {
    const column = (str(body.column) ?? "ready") as MissionColumn;
    const limit = typeof body.limit === "number" ? body.limit : Number(body.limit ?? 5);
    const tags = strArr(body.tags);
    return fromEngine(
      await boardOps.poll({
        column,
        limit: Number.isFinite(limit) ? limit : 5,
        agent: str(body.agent),
        tags,
        projectId: str(body.project) ?? str(body.project_id),
      }),
    );
  }

  const agent = str(body.agent) ?? str(body.agent_id);
  const missionId = str(body.mission_id) ?? str(body.missionId);
  if (action !== "poll" && !agent) return err(400, "agent is required", "bad_request");
  if (["claim", "heartbeat", "escalate", "deliver"].includes(action) && !missionId) {
    return err(400, "mission_id is required", "bad_request");
  }

  if (action === "claim") return fromEngine(await boardOps.claim(missionId!, agent!));
  if (action === "heartbeat") {
    return fromEngine(await boardOps.heartbeat(missionId!, agent!, str(body.note)));
  }
  if (action === "escalate") {
    const question = str(body.question);
    if (!question) return err(400, "question is required", "bad_request");
    return fromEngine(await boardOps.escalate(missionId!, agent!, question));
  }
  if (action === "deliver") {
    const summary = str(body.summary) ?? str(body.delivery) ?? "";
    return fromEngine(
      await boardOps.deliver(missionId!, agent!, summary, strArr(body.artifacts) ?? []),
    );
  }

  return err(400, `Unknown action: ${action}`, "bad_request");
}

/** True when the URL path is owned by this handler. */
export function isAgentApiPath(pathname: string): boolean {
  const p = pathname.split("?", 1)[0] ?? "";
  return p === "/api/agent" || p.startsWith("/api/agent/");
}
