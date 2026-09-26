import type { Board, HumanCall, Mission, MissionColumn } from "./types.js";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class DevBoardsClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private agent: string,
  ) {}

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers, body: payload });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg =
        typeof data === "object" && data && "error" in data
          ? String((data as { error: unknown }).error)
          : text.slice(0, 200) || res.statusText;
      throw new ApiError(msg, res.status, text);
    }
    return data as T;
  }

  health(): Promise<unknown> {
    return this.req("GET", "/api/agent/health");
  }

  async boards(): Promise<Board[]> {
    const d = await this.req<{ boards?: Board[]; projects?: Board[] }>(
      "GET",
      "/api/agent/boards",
    );
    return d.boards || d.projects || [];
  }

  async missions(
    column: MissionColumn | string,
    limit = 50,
  ): Promise<Mission[]> {
    const q = new URLSearchParams({
      column: String(column),
      limit: String(limit),
      agent: this.agent,
    });
    const d = await this.req<{ missions?: Mission[]; items?: Mission[] }>(
      "GET",
      `/api/agent/missions?${q}`,
    );
    return d.missions || d.items || [];
  }

  async mission(id: string): Promise<Mission> {
    const d = await this.req<{ mission: Mission }>(
      "GET",
      `/api/agent/missions/${id}`,
    );
    return d.mission;
  }

  async claim(id: string): Promise<Mission> {
    const d = await this.req<{ mission: Mission }>(
      "POST",
      `/api/agent/missions/${id}/claim`,
      { agent: this.agent },
    );
    return d.mission;
  }

  async heartbeat(id: string, note = ""): Promise<Mission> {
    const d = await this.req<{ mission: Mission }>(
      "POST",
      `/api/agent/missions/${id}/heartbeat`,
      { agent: this.agent, note },
    );
    return d.mission;
  }

  async deliver(
    id: string,
    summary: string,
    artifacts: string[] = [],
  ): Promise<Mission> {
    const d = await this.req<{ mission: Mission }>(
      "POST",
      `/api/agent/missions/${id}/deliver`,
      { agent: this.agent, summary, artifacts },
    );
    return d.mission;
  }

  async escalate(id: string, question: string): Promise<Mission> {
    const d = await this.req<{ mission: Mission }>(
      "POST",
      `/api/agent/missions/${id}/escalate`,
      { agent: this.agent, question },
    );
    return d.mission;
  }

  async calls(openOnly = true): Promise<{ calls: HumanCall[]; allowed: boolean }> {
    try {
      const q = openOnly ? "?open=1" : "";
      const d = await this.req<{ calls?: HumanCall[]; items?: HumanCall[] }>(
        "GET",
        `/api/agent/calls${q}`,
      );
      return { calls: d.calls || d.items || [], allowed: true };
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        return { calls: [], allowed: false };
      }
      throw e;
    }
  }

  resolveBoardId(boards: Board[], ref: string): string | null {
    if (!ref) return boards[0]?.id ?? null;
    const r = ref.trim();
    const byId = boards.find((b) => b.id === r);
    if (byId) return byId.id;
    const bySlug = boards.find((b) => b.slug === r || b.name === r);
    return bySlug?.id ?? null;
  }

  filterByBoard(missions: Mission[], boardId: string | null): Mission[] {
    if (!boardId) return missions;
    return missions.filter((m) => m.projectId === boardId);
  }
}
