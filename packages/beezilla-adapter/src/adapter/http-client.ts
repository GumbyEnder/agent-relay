/**
 * BeeZilla HTTP client for Dev Boards agent API.
 * Create uses ingest/github only (agent key cannot POST /missions).
 * Does not live in Dev Boards engine — this package calls it.
 */
import type {
  DevBoardClient,
  DevBoardColumn,
  MissionCreateRequest,
  MissionUsage,
  PollResponse,
} from "./types.js";

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  repository?: string;
  nextNumber?: () => number;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

async function readJson(res: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}): Promise<unknown> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dev Boards HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

export function createHttpClient(opts: HttpClientOptions): DevBoardClient {
  const base = opts.baseUrl.replace(/\/$/, "");
  const repo = opts.repository ?? "GumbyEnder/agent-relay";
  let n = 20000;
  const nextNumber = opts.nextNumber ?? (() => ++n);

  return {
    async getMissions(params) {
      const q = new URLSearchParams();
      if (params.column) q.set("column", params.column);
      if (params.agent) q.set("agent", params.agent);
      if (params.project) q.set("project", params.project);
      q.set("limit", "20");
      const res = await opts.fetch(`${base}/api/agent/missions?${q}`, {
        method: "GET",
        headers: authHeaders(opts.apiKey),
      });
      const d = (await readJson(res)) as PollResponse;
      return { ok: true, missions: d.missions ?? [] };
    },

    async createMission(input: MissionCreateRequest) {
      const number = nextNumber();
      const payload = {
        projectId: input.projectId,
        number,
        title: input.title,
        body: [input.objective, input.context, input.constraints]
          .filter(Boolean)
          .join("\n\n"),
        html_url: `https://github.com/${repo}/issues/${number}`,
        state: "open",
        labels: (input.tags ?? []).map((name) => ({ name })),
        repository: { full_name: repo },
      };
      const res = await opts.fetch(`${base}/api/agent/ingest/github`, {
        method: "POST",
        headers: authHeaders(opts.apiKey),
        body: JSON.stringify(payload),
      });
      const d = (await readJson(res)) as {
        ok?: boolean;
        mission?: { id: string };
      };
      const id = d.mission?.id;
      if (!id) throw new Error("ingest/github returned no mission id");
      return { ok: true as const, mission: { id } };
    },

    async claim(missionId, agent) {
      const res = await opts.fetch(
        `${base}/api/agent/missions/${missionId}/claim`,
        {
          method: "POST",
          headers: authHeaders(opts.apiKey),
          body: JSON.stringify({ agent }),
        },
      );
      await readJson(res);
      return { ok: true as const };
    },

    async heartbeat(missionId, agent, note) {
      const res = await opts.fetch(
        `${base}/api/agent/missions/${missionId}/heartbeat`,
        {
          method: "POST",
          headers: authHeaders(opts.apiKey),
          body: JSON.stringify({ agent, note }),
        },
      );
      await readJson(res);
      return { ok: true as const };
    },

    async escalate(missionId, agent, question) {
      const res = await opts.fetch(
        `${base}/api/agent/missions/${missionId}/escalate`,
        {
          method: "POST",
          headers: authHeaders(opts.apiKey),
          body: JSON.stringify({ agent, question }),
        },
      );
      await readJson(res);
      return { ok: true as const };
    },

    async deliver(missionId, agent, summary, usage?: MissionUsage | null) {
      const res = await opts.fetch(
        `${base}/api/agent/missions/${missionId}/deliver`,
        {
          method: "POST",
          headers: authHeaders(opts.apiKey),
          body: JSON.stringify({ agent, summary, usage: usage ?? null }),
        },
      );
      await readJson(res);
      return { ok: true as const };
    },

    async move(missionId, column: DevBoardColumn, actor?: string) {
      const res = await opts.fetch(
        `${base}/api/agent/missions/${missionId}/move`,
        {
          method: "POST",
          headers: authHeaders(opts.apiKey),
          body: JSON.stringify({ column, actor }),
        },
      );
      await readJson(res);
      return { ok: true as const };
    },
  };
}
