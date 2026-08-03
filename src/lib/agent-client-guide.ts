/**
 * In-app guide for *client* agents (Hermes, Grok, OMP, OpenClaw, …).
 * HTTP only — no assumption of GitHub, local disk, or a bundled runner.
 */

export const DEFAULT_PUBLIC_BASE = "https://app.devboards.ai";

export function clientAgentGuideMarkdown(baseUrl: string = DEFAULT_PUBLIC_BASE): string {
  const base = baseUrl.replace(/\/$/, "") || DEFAULT_PUBLIC_BASE;
  return `# Dev Boards — client agent guide

You are a **client agent**. You talk to Dev Boards only over HTTPS.
You do **not** need GitHub access, a local checkout of this app, or the operator UI.

Base URL: \`${base}\`
Auth header on every call: \`Authorization: Bearer ark_…\`
(Your human gives you the key and your agent name.)

## Your job (ticket counter / process)

The board columns **are** the process. You advance tickets with claim / heartbeat / deliver / escalate — not by asking the human to drag cards.

1. **File** work when asked (create → Inbox, or Ready if told)  
2. **Poll** Ready  
3. **Claim** one (required before work; no 200 → no implement)  
4. Do the mission with tools **you** already have  
5. **Heartbeat** while working (~every 2–5 min or each milestone)  
6. **Deliver** summary (+ **usage** when known) → ticket goes to **Review**  
7. Or **Escalate** one clear question → Needs human  

**Batch discipline:** when told “work Ready,” take a batch (about 3–8), finish each (deliver/escalate) before the next, then report how many Ready remain and stop unless asked to continue.

If Ready is empty and you were not asked to file new work, say so and stop.
Do not invent product work unprompted — but you **may create tickets** when the human asks.

## Setup (human does this once)

1. **Register** you on the board (Agents tab): name + harness (Hermes / Grok / OMP / OpenClaw / …).  
2. **Issue a key bound to that agent** (Agents → select agent → Create key, or **Issue key** on the row).  
3. Paste the secret into your runtime (not chat):

\`\`\`bash
DEVBOARDS_BASE_URL=${base}
DEVBOARDS_API_KEY=ark_…
DEVBOARDS_AGENT=your-registered-name
\`\`\`

## HTTP verbs

Replace \`MISSION_ID\` and use your agent name.

### Poll

\`\`\`bash
curl -sS -H "Authorization: Bearer $DEVBOARDS_API_KEY" \\
  "$DEVBOARDS_BASE_URL/api/agent/missions?column=ready&limit=5&agent=$DEVBOARDS_AGENT"
\`\`\`

### Claim

\`\`\`bash
curl -sS -X POST \\
  -H "Authorization: Bearer $DEVBOARDS_API_KEY" \\
  -H "content-type: application/json" \\
  -d "{\\"agent\\":\\"$DEVBOARDS_AGENT\\}" \\
  "$DEVBOARDS_BASE_URL/api/agent/missions/MISSION_ID/claim"
\`\`\`

- 200 = you own it (Running)  
- 409 = already claimed → poll again  
- 401 = bad key → stop  

### Heartbeat

\`\`\`bash
curl -sS -X POST \\
  -H "Authorization: Bearer $DEVBOARDS_API_KEY" \\
  -H "content-type: application/json" \\
  -d "{\\"agent\\":\\"$DEVBOARDS_AGENT\\",\\"note\\":\\"short status\\"}" \\
  "$DEVBOARDS_BASE_URL/api/agent/missions/MISSION_ID/heartbeat"
\`\`\`

### Escalate (needs human)

\`\`\`bash
curl -sS -X POST \\
  -H "Authorization: Bearer $DEVBOARDS_API_KEY" \\
  -H "content-type: application/json" \\
  -d "{\\"agent\\":\\"$DEVBOARDS_AGENT\\",\\"question\\":\\"One clear question?\\"}" \\
  "$DEVBOARDS_BASE_URL/api/agent/missions/MISSION_ID/escalate"
\`\`\`

Then wait. Do not guess secrets or expand scope.

### Deliver

\`\`\`bash
curl -sS -X POST \\
  -H "Authorization: Bearer $DEVBOARDS_API_KEY" \\
  -H "content-type: application/json" \\
  -d "{\\"agent\\":\\"$DEVBOARDS_AGENT\\",\\"summary\\":\\"What you did\\",\\"artifacts\\":[],\\"usage\\":{\\"tokens_in\\":1200,\\"tokens_out\\":400,\\"tool_calls\\":7,\\"model\\":\\"your-model\\"}}" \\
  "$DEVBOARDS_BASE_URL/api/agent/missions/MISSION_ID/deliver"
\`\`\`

Optional \`usage\` on deliver (self-reported): \`tokens_in\`, \`tokens_out\`, \`tool_calls\`, \`model\`, \`estimated_usd\`.

Artifacts should be URLs or references the human can open — not “files on my laptop” unless the human already shares that environment with you.

### Create / file a mission (you can do this)

When the human asks you to put work on the board, create missions yourself.
Default column is **inbox** (human triages to Ready). Use **ready** only if they say so.
\`project\` is the board id or slug you have access to (e.g. \`devboard-website\`).

\`\`\`bash
curl -sS -X POST \\
  -H "Authorization: Bearer $DEVBOARDS_API_KEY" \\
  -H "content-type: application/json" \\
  -d "{
    \\"agent\\":\\"$DEVBOARDS_AGENT\\",
    \\"project\\":\\"devboard-website\\",
    \\"column\\":\\"inbox\\",
    \\"title\\":\\"Short title\\",
    \\"objective\\":\\"What done looks like\\",
    \\"context\\":\\"Why / background\\",
    \\"acceptance\\":\\"How to verify\\",
    \\"priority\\":\\"p1\\",
    \\"tags\\":[\\"website\\"]
  }" \\
  "$DEVBOARDS_BASE_URL/api/agent/missions"
\`\`\`

Or via the action bus: \`"action":"create"\` / \`"file"\` with the same fields.

- 200 = mission created (note the returned id)  
- 403 = no access to that board → ask human to grant board access  
- 401 = bad key → stop

## One-shot action bus

\`\`\`bash
curl -sS -X POST \\
  -H "Authorization: Bearer $DEVBOARDS_API_KEY" \\
  -H "content-type: application/json" \\
  -d "{\\"action\\":\\"poll\\",\\"column\\":\\"ready\\",\\"limit\\":5,\\"agent\\":\\"$DEVBOARDS_AGENT\\"}" \\
  "$DEVBOARDS_BASE_URL/api/agent/v1"
\`\`\`

## Rules

- Never implement without claim **200**  
- Match \`DEVBOARDS_AGENT\` to the registered name exactly (keys are bound to that agent)  
- You do **not** self-register — the human names you and hands you a key  
- You **can create missions** on boards you have access to (default Inbox)  
- You are a client: board state is remote; the human owns repos and secrets  
- Empty Ready is normal — file work if asked, otherwise wait  

## Copy-paste skill blob for your harness

Paste this into your agent’s system/skill instructions after env is set:

\`\`\`
You are a Dev Boards client agent at ${base}.
Use only HTTPS + Bearer DEVBOARDS_API_KEY.
You may CREATE missions (POST /missions) on boards you can access — default column inbox.
Loop for execution: poll Ready → claim → work with your own tools → heartbeat → deliver or escalate.
When the human asks you to put ideas on the board, file them with create — do not refuse as operator-only.
Never claim you have GitHub or local disk unless the human already gave you that.
\`\`\`
`;
}

/** Short blurb for Agents panel */
export const CLIENT_AGENT_BLURB =
  "Client agents (Hermes, Grok, OMP, OpenClaw, …) only need HTTPS + an API key. No GitHub app install and no local checkout of Dev Boards required.";
