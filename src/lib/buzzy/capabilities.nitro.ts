/**
 * Nitro handler for /api/buzzy/capabilities — the truth about what this
 * deployment can actually do.
 *
 * Written because every "it said it couldn't" incident this week ended in an env
 * var: the empty Connect window was a missing signing key, the silent music was a
 * plan, the desktop had no key. None of that was visible to the owner, who could
 * only see the symptom.
 *
 * This endpoint answers from the same registry the chat loop uses, so it cannot
 * drift from behaviour: a tool listed as offered here is the tool the model is
 * offered, and a capability marked unavailable names the exact env var or plan.
 */
import { defineEventHandler } from "h3";
import { TOOL_POLICIES } from "./toolRegistry";
import { musicConfigured } from "./music";
import { browserAvailable } from "./browser";
import { threeDConfigured } from "./models3d";
import { signingSecret } from "./inferenceToken";
import { resolveOperatorContext } from "@/lib/auth/verify.server";

const has = (key: string) => Boolean((process.env[key] ?? "").trim());

function headersFromEvent(event: any): Headers {
  const rawHeaders = event?.node?.req?.headers ?? event?.req?.headers ?? {};
  if (rawHeaders instanceof Headers) return rawHeaders;
  const init: [string, string][] = Object.entries(
    rawHeaders as Record<string, string | string[] | undefined>,
  ).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]);
  return new Headers(init);
}

export default defineEventHandler(async (event) => {
  // Model ids and provider endpoints are deployment internals. The page is
  // reachable by every signed-in customer, so a non-admin gets the honest
  // "this is configured" answer without the wiring; an admin (a name in
  // AGENT_RELAY_ADMIN_EMAILS) gets the model and the base URL they need to
  // debug it. Everything else — what is on, what is missing — stays visible to
  // everyone, because that is the question this endpoint exists to answer.
  let isAdmin = false;
  try {
    const ctx = await resolveOperatorContext(headersFromEvent(event));
    isAdmin = ctx.role === "admin";
  } catch {
    isAdmin = false;
  }

  // Availability is public; wiring is not. Vendor names, model ids, env var
  // names and internal route paths are deployment internals, and this route is
  // reachable by every visitor on the consumer host — an anonymous GET used to
  // read the whole deployment inventory back out of these `detail` strings.
  // Same rule the chat and voice lanes already follow: a non-admin is told
  // whether a capability works, never what it is built from.
  const detail = (adminText: string, publicText: string) =>
    isAdmin ? adminText : publicText;

  const tools = TOOL_POLICIES.map((p) => ({
    name: p.name,
    offered: p.offered,
    gate: p.gate,
    cost: p.cost,
    timeoutMs: p.timeoutMs,
    withheld: p.offered ? null : (p.withheldReason ?? "retired"),
  }));

  const capabilities = [
    {
      id: "chat",
      label: "Conversation and drafting",
      ok: has("BZ_CHAT_KEY") || has("BZ_CHAT_BASE_URL"),
      detail: has("BZ_CHAT_KEY")
        ? detail(
            `model ${process.env.BZ_CHAT_MODEL?.trim() || "z-ai/glm-5.3-flash"} via ${process.env.BZ_CHAT_BASE_URL?.trim() || "Nous inference"}`,
            "connected — the model this deployment is configured with",
          )
        : detail(
            "no provider key on this deployment (BZ_CHAT_KEY)",
            "no provider key on this deployment — chat cannot answer here",
          ),
    },
    {
      id: "documents",
      label: "Documents, sheets and presentations",
      ok: true,
      detail: "render tools save versioned files to the Library",
    },
    {
      id: "music",
      label: "Music generation",
      ok: musicConfigured(),
      detail: musicConfigured()
        ? detail(
            "ElevenLabs music_v2_5 through the generate_music tool",
            "connected — music can be produced here",
          )
        : detail(
            "BZ_ELEVEN_KEY is unset — music cannot be produced here",
            "no music provider on this deployment — music cannot be produced here",
          ),
    },
    {
      id: "search",
      label: "Live web search and page reading",
      ok: has("BZ_BRAVE_KEY"),
      detail: has("BZ_BRAVE_KEY")
        ? detail(
            "Brave search behind /api/search, pages read server-side",
            "connected — live search and server-side page reading",
          )
        : detail(
            "BZ_BRAVE_KEY is unset — search will refuse rather than guess",
            "no search provider on this deployment — search will refuse rather than guess",
          ),
    },
    {
      id: "transcription",
      label: "Speech to text",
      ok: has("BZ_CHAT_KEY"),
      detail: has("BZ_CHAT_KEY")
        ? detail(
            "rides the chat key (BZ_ASR_MODEL)",
            "connected — speech is transcribed here",
          )
        : detail("needs BZ_CHAT_KEY", "needs the chat provider"),
    },
    {
      id: "voice",
      label: "Spoken replies",
      ok: has("BZ_CHAT_KEY"),
      detail: has("BZ_CHAT_KEY")
        ? detail(
            `audio lane ${process.env.BZ_VOICE_MODEL?.trim() || "openai/gpt-audio-mini"}`,
            "spoken replies in one voice",
          )
        : detail("needs BZ_CHAT_KEY", "needs the chat provider"),
    },
    {
      id: "browser",
      label: "Headless browser for hard pages",
      ok: browserAvailable(),
      detail: browserAvailable()
        ? detail("Hyperbrowser available", "a headless browser is available for hard pages")
        : detail("plain fetch only", "plain page fetch only"),
    },
    {
      id: "three_d",
      label: "3D model generation",
      ok: threeDConfigured(),
      detail: threeDConfigured()
        ? "configured"
        : detail("no 3D provider key", "no 3D provider on this deployment"),
    },
    {
      id: "desktop_connect",
      label: "Desktop app connection (managed inference)",
      ok: Boolean(signingSecret()),
      detail: signingSecret()
        ? detail(
            "mints short-lived bz1 tokens; provider key stays server-side",
            "connected — desktop sessions get short-lived tokens, the provider key stays server-side",
          )
        : detail(
            "BZ_INFERENCE_SIGNING_KEY is unset — the desktop will get 503 not_configured",
            "not configured — the desktop app cannot connect here yet",
          ),
    },
  ];

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    capabilities,
    tools,
  };
});
