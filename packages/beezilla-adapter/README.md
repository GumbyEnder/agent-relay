# BeeZilla Dev Boards Adapter

Maps Dev Boards missions to BeeZilla civilian cards. Dev Boards owns all mission state; BeeZilla owns the user experience.

## Gate Policy (9303)

`createMissionsAfterApprove` refuses to create missions without a valid `first_ticket_cut` audit record. The audit must include `draft_version`, `timestamp`, and `user_action`.

## Install

```bash
NODE_ENV=development npm install
npm test
```

## Run Tests

```bash
npm test
```

Or compile first, then run with Node:

```bash
npm run build
npm run test:node
```

## Adapter Verbs

- `createMissionsAfterApprove(audit, client, boardId, agentName)` — Create missions after draft approval (gate enforced)
- `poll(client, agentName, boardId, column)` — Poll for ready missions
- `claim(client, missionId, agentName)` — Claim a mission
- `heartbeat(client, missionId, agentName, note?)` — Record heartbeat
- `deliver(client, missionId, agentName, summary, usage?)` — Deliver completed work
- `escalate(client, missionId, agentName, question)` — Escalate to human
- `toCivilianCard(mission)` — Convert Dev Boards mission to civilian card (strips internals)

## Column Mapping

| Dev Boards | BeeZilla (civilian) |
|---|---|
| inbox, ready | Waiting |
| running | Working |
| needs_human, blocked | Needs you |
| review, done | Done |
