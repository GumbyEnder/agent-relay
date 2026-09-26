import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { ApiError, DevBoardsClient } from "./client.js";
import { fetchBoardSnapshot } from "./status.js";
import {
  COLUMNS,
  COLUMN_LABEL,
  isStale,
  type Board,
  type ClientConfig,
  type Mission,
  type MissionColumn,
} from "./types.js";

type PromptKind = "deliver" | "escalate" | "heartbeat" | "search" | null;

function trunc(s: string, n: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return t.slice(0, Math.max(0, n - 1)) + "…";
}

function colorForColumn(col: MissionColumn): string {
  switch (col) {
    case "ready":
      return "cyan";
    case "running":
      return "green";
    case "needs_human":
      return "magenta";
    case "review":
      return "blue";
    case "blocked":
      return "yellow";
    case "done":
      return "gray";
    default:
      return "white";
  }
}

export function App({
  client,
  cfg,
  initialBoards,
  initialBoardId,
}: {
  client: DevBoardsClient;
  cfg: ClientConfig;
  initialBoards: Board[];
  initialBoardId: string | null;
}) {
  const { exit } = useApp();
  const [boards, setBoards] = useState(initialBoards);
  const [boardIdx, setBoardIdx] = useState(() => {
    const i = initialBoards.findIndex((b) => b.id === initialBoardId);
    return i >= 0 ? i : 0;
  });
  const boardId = boards[boardIdx]?.id ?? null;
  const board = boards[boardIdx] ?? null;

  const [byCol, setByCol] = useState<Record<MissionColumn, Mission[]>>(() => {
    const empty = {} as Record<MissionColumn, Mission[]>;
    for (const c of COLUMNS) empty[c] = [];
    return empty;
  });
  const [colIdx, setColIdx] = useState(1); // ready
  const [cardIdx, setCardIdx] = useState(0);
  const [detail, setDetail] = useState(false);
  const [detailMission, setDetailMission] = useState<Mission | null>(null);
  const [compact, setCompact] = useState(true);
  const [filter, setFilter] = useState("");
  const [prompt, setPrompt] = useState<PromptKind>(null);
  const [promptValue, setPromptValue] = useState("");
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("ready");
  const [err, setErr] = useState("");
  const [lastPoll, setLastPoll] = useState<number | null>(null);
  const [caps, setCaps] = useState({ calls: false });

  const col = COLUMNS[colIdx] ?? "ready";
  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    const list = byCol[col] || [];
    if (!q) return list;
    return list.filter((m) => {
      const blob = `${m.title} ${m.id} ${(m.tags || []).join(" ")}`.toLowerCase();
      return blob.includes(q);
    });
  }, [byCol, col, filter]);

  const selected = filtered[cardIdx] ?? null;

  const staleCount = useMemo(() => {
    let n = 0;
    for (const c of COLUMNS) {
      for (const m of byCol[c] || []) {
        if (isStale(m, cfg.staleMs)) n += 1;
      }
    }
    return n;
  }, [byCol, cfg.staleMs]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const snap = await fetchBoardSnapshot(client, boardId);
      setByCol(snap);
      setLastPoll(Date.now());
      setErr("");
      setStatus("polled ok");
      try {
        const c = await client.calls(true);
        setCaps({ calls: c.allowed });
      } catch {
        setCaps({ calls: false });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      setStatus("poll failed");
    } finally {
      setBusy(false);
    }
  }, [client, boardId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), cfg.pollIntervalMs);
    return () => clearInterval(t);
  }, [refresh, cfg.pollIntervalMs]);

  useEffect(() => {
    setCardIdx(0);
  }, [colIdx, filter, boardId]);

  const openDetail = useCallback(async () => {
    if (!selected) return;
    setDetail(true);
    try {
      const full = await client.mission(selected.id);
      setDetailMission(full);
    } catch {
      setDetailMission(selected);
    }
  }, [client, selected]);

  const runAction = useCallback(
    async (fn: () => Promise<void>, okMsg: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
        setStatus(okMsg);
        setErr("");
        await refresh();
      } catch (e) {
        const msg =
          e instanceof ApiError
            ? `${e.status} ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        setErr(msg);
        setStatus("action failed");
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );

  const submitPrompt = useCallback(async () => {
    if (!selected || !prompt) return;
    const value = promptValue.trim();
    const kind = prompt;
    setPrompt(null);
    setPromptValue("");
    if (kind === "search") {
      setFilter(value);
      return;
    }
    if (kind === "deliver") {
      await runAction(
        async () => {
          await client.deliver(selected.id, value || "Done");
          setDetail(false);
        },
        "delivered → review",
      );
      return;
    }
    if (kind === "escalate") {
      if (!value) {
        setErr("escalate needs a question");
        return;
      }
      await runAction(
        async () => {
          await client.escalate(selected.id, value);
          setDetail(false);
        },
        "escalated → needs_human",
      );
      return;
    }
    if (kind === "heartbeat") {
      await runAction(
        async () => {
          await client.heartbeat(selected.id, value || "working");
        },
        "heartbeat sent",
      );
    }
  }, [selected, prompt, promptValue, client, runAction]);

  useInput((input: string, key: { escape?: boolean; return?: boolean; downArrow?: boolean; upArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; shift?: boolean }) => {
    if (prompt) {
      if (key.escape) {
        setPrompt(null);
        setPromptValue("");
      }
      if (key.return) void submitPrompt();
      return;
    }
    if (help) {
      if (key.escape || input === "?" || input === "q") setHelp(false);
      return;
    }
    if (key.escape) {
      if (detail) {
        setDetail(false);
        setDetailMission(null);
      } else if (filter) {
        setFilter("");
      }
      return;
    }
    if (input === "q") {
      exit();
      return;
    }
    if (input === "?") {
      setHelp(true);
      return;
    }
    if (input === "R") {
      void refresh();
      return;
    }
    if (input === ".") {
      setCompact((c) => !c);
      return;
    }
    if (input === "/") {
      setPrompt("search");
      setPromptValue(filter);
      return;
    }
    if (input === "b") {
      if (boards.length === 0) return;
      setBoardIdx((i) => (i + 1) % boards.length);
      return;
    }
    if (input === "j" || key.downArrow) {
      setCardIdx((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
      return;
    }
    if (input === "k" || key.upArrow) {
      setCardIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (input === "l" || input === "]" || key.rightArrow) {
      setColIdx((i) => Math.min(i + 1, COLUMNS.length - 1));
      return;
    }
    if (input === "h" || input === "[" || key.leftArrow) {
      // bare h is heartbeat when design said H for heartbeat - design: h/l columns, H heartbeat
      if (input === "h" && !key.shift) {
        setColIdx((i) => Math.max(0, i - 1));
      }
      return;
    }
    if (input === "H") {
      if (!selected) return;
      setPrompt("heartbeat");
      setPromptValue("");
      return;
    }
    if (key.return) {
      void openDetail();
      return;
    }
    if (input === "c") {
      if (!selected) return;
      void runAction(async () => {
        await client.claim(selected.id);
      }, "claimed → running");
      return;
    }
    if (input === "D") {
      if (!selected) return;
      setPrompt("deliver");
      setPromptValue("Done");
      return;
    }
    if (input === "e") {
      if (!selected) return;
      setPrompt("escalate");
      setPromptValue("");
      return;
    }
  });

  const age =
    lastPoll == null ? "—" : `${Math.round((Date.now() - lastPoll) / 1000)}s`;

  const maxCards = compact ? 8 : 5;
  const visible = filtered.slice(0, maxCards);

  return (
    <Box flexDirection="column" width="100%">
      <Box>
        <Text bold color="white">
          DEVBOARDS-TUI
        </Text>
        <Text> </Text>
        <Text color="cyan">{board?.slug || board?.name || "—"}</Text>
        <Text dimColor>
          {" "}
          · {cfg.agent} · poll {age}
          {busy ? " · …" : ""} · stale {staleCount}
          {caps.calls ? "" : " · ark-only"}
        </Text>
      </Box>
      {err ? (
        <Text color="red">err: {trunc(err, 100)}</Text>
      ) : (
        <Text dimColor>status: {status}</Text>
      )}

      <Box marginTop={1}>
        {COLUMNS.map((c, i) => {
          const n = (byCol[c] || []).length;
          const active = i === colIdx;
          return (
            <Box key={c} marginRight={1}>
              <Text
                color={colorForColumn(c)}
                bold={active}
                inverse={active}
                dimColor={!active && n === 0}
              >
                {COLUMN_LABEL[c]}:{n}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column" borderStyle="single" paddingX={1}>
        <Text bold color={colorForColumn(col)}>
          {COLUMN_LABEL[col]} ({filtered.length}
          {filter ? ` filter=${filter}` : ""})
        </Text>
        {visible.length === 0 ? (
          <Text dimColor>empty</Text>
        ) : (
          visible.map((m, i) => {
            const sel = i === cardIdx;
            const stale = isStale(m, cfg.staleMs);
            const line = compact
              ? `${(m.priority || "p?").toString().toUpperCase()} ${trunc(m.title, 48)}${stale ? " STALE" : ""}${m.claimedBy ? ` @${m.claimedBy}` : ""}`
              : `${(m.priority || "p?").toString().toUpperCase()} ${trunc(m.title, 56)}\n  ${m.id}${stale ? " STALE" : ""} ${m.claimedBy || ""}`;
            return (
              <Text key={m.id} inverse={sel} color={stale ? "red" : undefined}>
                {sel ? "› " : "  "}
                {line}
              </Text>
            );
          })
        )}
        {filtered.length > maxCards ? (
          <Text dimColor>  … +{filtered.length - maxCards} more</Text>
        ) : null}
      </Box>

      {detail && (detailMission || selected) ? (
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="round"
          paddingX={1}
        >
          <Text bold>
            {(detailMission || selected)!.title}{" "}
            <Text dimColor>({(detailMission || selected)!.id})</Text>
          </Text>
          <Text>
            col={(detailMission || selected)!.column} pri=
            {(detailMission || selected)!.priority || "—"} claimed=
            {(detailMission || selected)!.claimedBy || "—"}
          </Text>
          <Text>
            obj: {trunc((detailMission || selected)!.objective || "", 200)}
          </Text>
          <Text dimColor>
            ctx: {trunc((detailMission || selected)!.context || "", 160)}
          </Text>
          <Text dimColor>
            acc: {trunc((detailMission || selected)!.acceptance || "", 120)}
          </Text>
          {(detailMission || selected)!.artifacts?.length ? (
            <Text>
              artifacts:{" "}
              {trunc((detailMission || selected)!.artifacts!.join(" | "), 120)}
            </Text>
          ) : null}
          <Text dimColor>Esc close · c claim · D deliver · e escalate · H hb</Text>
        </Box>
      ) : null}

      {prompt ? (
        <Box marginTop={1}>
          <Text color="yellow">
            {prompt === "deliver"
              ? "deliver summary: "
              : prompt === "escalate"
                ? "escalate question: "
                : prompt === "heartbeat"
                  ? "heartbeat note: "
                  : "search: "}
          </Text>
          <TextInput
            value={promptValue}
            onChange={setPromptValue}
            onSubmit={() => void submitPrompt()}
          />
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>
            j/k cards · h/l cols · Enter detail · c claim · D deliver · e esc · H
            hb · R refresh · b board · / search · . dens · ? help · q quit
          </Text>
        </Box>
      )}

      {help ? (
        <Box flexDirection="column" borderStyle="double" marginTop={1} paddingX={1}>
          <Text bold>Help — P0 chords</Text>
          <Text>c claim · D deliver · e escalate · H heartbeat</Text>
          <Text>j/k move selection · h/l or [/] columns · b next board</Text>
          <Text>R refresh · / filter · . compact · Esc back · q quit</Text>
          <Text dimColor>
            ark_ keys: claim/hb/deliver/escalate. Move/calls reply may need
            operator session.
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
