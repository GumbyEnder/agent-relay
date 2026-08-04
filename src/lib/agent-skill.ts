/**
 * Public SKILL.md for client agents — installable without GitHub checkout.
 * Prefer shipping the file at skills/devboards/SKILL.md; fall back to generated text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PUBLIC_BASE } from "./agent-client-guide";

export function clientAgentSkillMarkdown(baseUrl: string = DEFAULT_PUBLIC_BASE): string {
  const base = baseUrl.replace(/\/$/, "") || DEFAULT_PUBLIC_BASE;
  const fromDisk = tryReadSkillFile();
  if (fromDisk) {
    // Keep live base URL current when the file hardcodes production.
    return fromDisk
      .replaceAll("https://app.devboards.ai", base)
      .replace(
        /DEVBOARDS_BASE_URL=https:\/\/[^\s`]+/g,
        `DEVBOARDS_BASE_URL=${base}`,
      );
  }
  return fallbackSkill(base);
}

function tryReadSkillFile(): string | null {
  const candidates = [
    join(process.cwd(), "skills/devboards/SKILL.md"),
    join(process.cwd(), "agent-relay/skills/devboards/SKILL.md"),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      /* try next */
    }
  }
  return null;
}

function fallbackSkill(base: string): string {
  return `---
name: devboards
description: Client agent loop for Dev Boards over HTTPS only.
version: 1.3.0
author: GumbyEnder
license: MIT
metadata:
  hermes:
    tags: [devboards, kanban, client-agent]
    category: autonomous-ai-agents
---

# Dev Boards — client agent

You are a **remote client**. You only talk to Dev Boards over HTTPS.
You do **not** need GitHub, a local checkout of Dev Boards, or the operator UI.

Canonical guide (always current on the live site):

- HTTP: \`GET ${base}/api/agent/client-guide\`
- This skill: \`GET ${base}/api/agent/skill.md\`

## Prerequisites

\`\`\`bash
DEVBOARDS_BASE_URL=${base}
DEVBOARDS_API_KEY=ark_…
DEVBOARDS_AGENT=your-registered-name
DEVBOARDS_BOARD=your-board-slug
\`\`\`

## Job loop

1. Poll Ready — \`GET /api/agent/missions?column=ready&agent=$AGENT&project=$BOARD\`
2. Claim one — \`POST …/missions/:id/claim\`
3. Heartbeat while working
4. Deliver or escalate

\`project\` accepts board **slug or id**. Do not use Hermes kanban for Dev Boards work.
`;
}
