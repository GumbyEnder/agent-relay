/**
 * Board owners (operator role) can mint keys on their boards only.
 * CAP_MIN.manage_keys stays admin; shared/demo boards stay admin-only.
 */
import { durableBoard, ensureBoardReady } from "../src/lib/board-store.server";
import { handleAgentApiRequest } from "../src/lib/agent-api.server";
import { getSql } from "../src/lib/db";
import { roleCan } from "../src/lib/auth/roles";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function jsonOf(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

async function sessionHeaders(userId: string): Promise<HeadersInit> {
  const sql = await getSql();
  const token = `tok_${userId}_${Date.now().toString(36)}`;
  const id = `ses_${userId}_${Date.now().toString(36)}`;
  await sql`
    insert into "session" (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
    values (${id}, ${token}, ${userId}, now() + interval '1 day', now(), now())
  `;
  return {
    cookie: `agent-relay.session_token=${token}`,
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    origin: "http://localhost:8090",
    host: "localhost:8090",
    "sec-fetch-site": "same-origin",
  };
}

async function main() {
  assert(roleCan("operator", "manage_keys") === false, "platform manage_keys stays admin");
  await ensureBoardReady();

  const stamp = Date.now().toString(36);
  const owner = await durableBoard.adminCreateUser({
    email: `owner-${stamp}@example.test`,
    password: "testpass-99",
    name: "Owner Op",
    role: "operator",
  });
  const peer = await durableBoard.adminCreateUser({
    email: `peer-${stamp}@example.test`,
    password: "testpass-99",
    name: "Peer Op",
    role: "operator",
  });
  const viewer = await durableBoard.adminCreateUser({
    email: `viewer-${stamp}@example.test`,
    password: "testpass-99",
    name: "Viewer",
    role: "viewer",
  });
  const admin = await durableBoard.adminCreateUser({
    email: `admin-${stamp}@example.test`,
    password: "testpass-99",
    name: "Admin",
    role: "admin",
  });

  const ownBoard = await durableBoard.createProject({
    name: `Owner board ${stamp}`,
    slug: `own-${stamp}`,
    ownerUserId: owner.id,
  });
  const peerBoard = await durableBoard.createProject({
    name: `Peer board ${stamp}`,
    slug: `peer-${stamp}`,
    ownerUserId: peer.id,
  });
  const sharedBoard = await durableBoard.createProject({
    name: `Shared board ${stamp}`,
    slug: `shared-${stamp}`,
    ownerUserId: null,
  });

  const registered = await durableBoard.registerAgent({
    name: `key-bot-${stamp}`,
    harness: "custom",
    role: "client",
    projectId: ownBoard.id,
  });
  assert(registered.ok, "register agent");
  const agentId = registered.data.agent.id;
  await durableBoard.grantBoardAccess(agentId, peerBoard.id);

  const prev = process.env.AGENT_RELAY_HUMAN_AUTH;
  process.env.AGENT_RELAY_HUMAN_AUTH = "1";
  try {
    const ownerH = await sessionHeaders(owner.id);
    const peerH = await sessionHeaders(peer.id);
    const viewerH = await sessionHeaders(viewer.id);
    const adminH = await sessionHeaders(admin.id);

    const ownerMint = await jsonOf(
      await handleAgentApiRequest(
        new Request("http://localhost:8090/api/agent/keys", {
          method: "POST",
          headers: ownerH,
          body: JSON.stringify({
            projectId: ownBoard.id,
            agentId,
            name: "owner-key",
          }),
        }),
      ),
    );
    assert(ownerMint.status === 200 && ownerMint.body.ok === true, "owner operator can POST /keys on own board");
    const minted = ownerMint.body.key as { secret?: string };
    assert(typeof minted?.secret === "string" && minted.secret.startsWith("ark_"), "owner got ark_ secret");

    const peerSteal = await jsonOf(
      await handleAgentApiRequest(
        new Request("http://localhost:8090/api/agent/keys", {
          method: "POST",
          headers: peerH,
          body: JSON.stringify({
            projectId: ownBoard.id,
            agentId,
            name: "stolen-key",
          }),
        }),
      ),
    );
    assert(
      peerSteal.status === 403 || peerSteal.status === 404,
      `peer cannot mint on someone else's board (got ${peerSteal.status})`,
    );

    const viewerMint = await jsonOf(
      await handleAgentApiRequest(
        new Request("http://localhost:8090/api/agent/keys", {
          method: "POST",
          headers: viewerH,
          body: JSON.stringify({
            projectId: ownBoard.id,
            agentId,
            name: "viewer-key",
          }),
        }),
      ),
    );
    assert(viewerMint.status === 403 || viewerMint.status === 404, "viewer cannot mint");

    const adminMint = await jsonOf(
      await handleAgentApiRequest(
        new Request("http://localhost:8090/api/agent/keys", {
          method: "POST",
          headers: adminH,
          body: JSON.stringify({
            projectId: ownBoard.id,
            agentId,
            name: "admin-key",
          }),
        }),
      ),
    );
    assert(adminMint.status === 200 && adminMint.body.ok === true, "admin can mint on any board");

    const listOwner = await jsonOf(
      await handleAgentApiRequest(
        new Request(
          `http://localhost:8090/api/agent/keys?agent=${encodeURIComponent(agentId)}&project=${encodeURIComponent(ownBoard.id)}`,
          { headers: ownerH },
        ),
      ),
    );
    assert(listOwner.status === 200, "owner can list keys on own board");

    const listPeer = await jsonOf(
      await handleAgentApiRequest(
        new Request(
          `http://localhost:8090/api/agent/keys?agent=${encodeURIComponent(agentId)}&project=${encodeURIComponent(ownBoard.id)}`,
          { headers: peerH },
        ),
      ),
    );
    assert(listPeer.status === 403 || listPeer.status === 404, "peer cannot list keys on foreign board");

    const mintedId = (ownerMint.body.key as { id?: string }).id;
    assert(mintedId, "minted key id");
    const revealed = await jsonOf(
      await handleAgentApiRequest(
        new Request(`http://localhost:8090/api/agent/keys/${mintedId}/reveal`, {
          method: "POST",
          headers: ownerH,
          body: "{}",
        }),
      ),
    );
    assert(revealed.status === 200 && revealed.body.ok === true, "owner can reveal own key");

    const ownerIssue = await jsonOf(
      await handleAgentApiRequest(
        new Request("http://localhost:8090/api/agent/agents", {
          method: "POST",
          headers: ownerH,
          body: JSON.stringify({
            name: `issued-${stamp}`,
            harness: "custom",
            project: ownBoard.id,
            issueKey: true,
          }),
        }),
      ),
    );
    assert(ownerIssue.status === 200 && ownerIssue.body.issuedKey === true, "owner POST /agents issueKey");

    const peerIssue = await jsonOf(
      await handleAgentApiRequest(
        new Request("http://localhost:8090/api/agent/agents", {
          method: "POST",
          headers: peerH,
          body: JSON.stringify({
            name: `peer-issued-${stamp}`,
            harness: "custom",
            project: ownBoard.id,
            issueKey: true,
          }),
        }),
      ),
    );
    assert(peerIssue.status === 200, "peer can still register agent");
    assert(peerIssue.body.issuedKey !== true, "peer cannot issueKey on foreign board");

    const sharedMint = await jsonOf(
      await handleAgentApiRequest(
        new Request("http://localhost:8090/api/agent/keys", {
          method: "POST",
          headers: ownerH,
          body: JSON.stringify({
            projectId: sharedBoard.id,
            agentId,
            name: "shared-op-key",
          }),
        }),
      ),
    );
    assert(sharedMint.status === 403, "operator cannot mint on shared/demo board");

    const sharedList = await jsonOf(
      await handleAgentApiRequest(
        new Request(
          `http://localhost:8090/api/agent/keys?project=${encodeURIComponent(sharedBoard.id)}`,
          { headers: ownerH },
        ),
      ),
    );
    assert(sharedList.status === 403, "operator cannot list keys on shared/demo board");

    const viewerShared = await jsonOf(
      await handleAgentApiRequest(
        new Request("http://localhost:8090/api/agent/keys", {
          method: "POST",
          headers: viewerH,
          body: JSON.stringify({
            projectId: sharedBoard.id,
            agentId,
            name: "shared-viewer-key",
          }),
        }),
      ),
    );
    assert(viewerShared.status === 403, "viewer cannot mint on shared board");

    const adminShared = await jsonOf(
      await handleAgentApiRequest(
        new Request("http://localhost:8090/api/agent/keys", {
          method: "POST",
          headers: adminH,
          body: JSON.stringify({
            projectId: sharedBoard.id,
            agentId,
            name: "shared-admin-key",
          }),
        }),
      ),
    );
    assert(adminShared.status === 200 && adminShared.body.ok === true, "admin can mint on shared/demo board");

    const meOwner = await jsonOf(
      await handleAgentApiRequest(
        new Request("http://localhost:8090/api/agent/me", { headers: ownerH }),
      ),
    );
    const caps = (meOwner.body.capabilities ?? {}) as Record<string, boolean>;
    assert(caps.manage_keys === false, "/me manage_keys is platform-admin only");

    const revoked = await jsonOf(
      await handleAgentApiRequest(
        new Request(`http://localhost:8090/api/agent/keys/${mintedId}/revoke`, {
          method: "POST",
          headers: ownerH,
          body: "{}",
        }),
      ),
    );
    assert(revoked.status === 200 && revoked.body.ok === true, "owner can revoke own key");
  } finally {
    if (prev === undefined) delete process.env.AGENT_RELAY_HUMAN_AUTH;
    else process.env.AGENT_RELAY_HUMAN_AUTH = prev;
  }

  console.log("✓ owner operator mints keys on own board; peer/viewer denied; admin allowed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
