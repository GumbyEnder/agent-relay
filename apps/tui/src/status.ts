import { DevBoardsClient } from "./client.js";
import {
  COLUMNS,
  isStale,
  loadConfig,
  type Mission,
  type MissionColumn,
} from "./types.js";

export async function runStatus(): Promise<number> {
  const cfg = loadConfig();
  const client = new DevBoardsClient(cfg.baseUrl, cfg.apiKey, cfg.agent);
  const boards = await client.boards();
  const boardId = client.resolveBoardId(boards, cfg.board);
  const board = boards.find((b) => b.id === boardId);
  const counts: Record<string, number> = {};
  let stale = 0;
  const all: Mission[] = [];
  for (const col of COLUMNS) {
    const ms = client.filterByBoard(await client.missions(col, 100), boardId);
    counts[col] = ms.length;
    all.push(...ms);
  }
  for (const m of all) {
    if (isStale(m, cfg.staleMs)) stale += 1;
  }
  const parts = COLUMNS.map((c) => `${c[0]}${counts[c] ?? 0}`).join(" ");
  // i0 r2 n1 … compact
  const compact = COLUMNS.map((c) => {
    const letter =
      c === "inbox"
        ? "i"
        : c === "ready"
          ? "r"
          : c === "running"
            ? "u"
            : c === "needs_human"
              ? "n"
              : c === "review"
                ? "v"
                : c === "done"
                  ? "d"
                  : c === "blocked"
                    ? "x"
                    : "?";
    return `${letter}${counts[c] ?? 0}`;
  }).join(" ");
  const name = board?.slug || board?.name || boardId || "all";
  console.log(
    `devboards ${name} agent=${cfg.agent} ${compact} stale=${stale} poll_ok`,
  );
  // unused var silence
  void parts;
  return stale > 0 ? 1 : 0;
}

export async function fetchBoardSnapshot(
  client: DevBoardsClient,
  boardId: string | null,
): Promise<Record<MissionColumn, Mission[]>> {
  const out = {} as Record<MissionColumn, Mission[]>;
  await Promise.all(
    COLUMNS.map(async (col) => {
      const ms = await client.missions(col, 80);
      out[col] = client.filterByBoard(ms, boardId);
    }),
  );
  return out;
}
