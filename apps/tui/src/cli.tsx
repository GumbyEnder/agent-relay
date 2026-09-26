#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { DevBoardsClient } from "./client.js";
import { App } from "./app.js";
import { runStatus } from "./status.js";
import { loadConfig } from "./types.js";

function printUsage(): void {
  console.log(`devboards-tui — Dev Boards terminal client

Usage:
  devboards-tui              Interactive board
  devboards-tui --status     One-shot column counts (exit 1 if stale>0)
  devboards-tui --help

Env:
  DEVBOARDS_BASE_URL   default https://app.devboards.ai
  DEVBOARDS_API_KEY    required (ark_…)
  DEVBOARDS_AGENT      default frodo
  DEVBOARDS_BOARD      slug or board_ id (optional)
  DEVBOARDS_POLL_INTERVAL  seconds (default 30)
  DEVBOARDS_STALE_MS   default 300000
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    printUsage();
    process.exit(0);
  }
  if (args.includes("--status") || args.includes("-s")) {
    try {
      const code = await runStatus();
      process.exit(code);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    }
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    printUsage();
    process.exit(2);
  }

  const client = new DevBoardsClient(cfg.baseUrl, cfg.apiKey, cfg.agent);
  try {
    await client.health();
  } catch (e) {
    console.error(
      "health check failed:",
      e instanceof Error ? e.message : e,
    );
    process.exit(2);
  }

  const boards = await client.boards();
  if (boards.length === 0) {
    console.error("no boards visible for this key");
    process.exit(2);
  }
  const boardId = client.resolveBoardId(boards, cfg.board);

  const instance = render(
    <App
      client={client}
      cfg={cfg}
      initialBoards={boards}
      initialBoardId={boardId}
    />,
  );

  await instance.waitUntilExit();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
