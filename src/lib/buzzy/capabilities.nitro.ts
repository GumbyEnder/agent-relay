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

const has = (key: string) => Boolean((process.env[key] ?? "").trim());

export default defineEventHandler(() => {
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
        ? `model ${process.env.BZ_CHAT_MODEL?.trim() || "z-ai/glm-5.3-flash"} via ${process.env.BZ_CHAT_BASE_URL?.trim() || "Nous inference"}`
        : "no provider key on this deployment (BZ_CHAT_KEY)",
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
        ? "ElevenLabs music_v2_5 through the generate_music tool"
        : "BZ_ELEVEN_KEY is unset — music cannot be produced here",
    },
    {
      id: "search",
      label: "Live web search and page reading",
      ok: has("BZ_BRAVE_KEY"),
      detail: has("BZ_BRAVE_KEY")
        ? "Brave search behind /api/search, pages read server-side"
        : "BZ_BRAVE_KEY is unset — search will refuse rather than guess",
    },
    {
      id: "transcription",
      label: "Speech to text",
      ok: has("BZ_CHAT_KEY"),
      detail: has("BZ_CHAT_KEY") ? "rides the chat key (BZ_ASR_MODEL)" : "needs BZ_CHAT_KEY",
    },
    {
      id: "voice",
      label: "Spoken replies",
      ok: has("BZ_CHAT_KEY"),
      detail: has("BZ_CHAT_KEY")
        ? `audio lane ${process.env.BZ_VOICE_MODEL?.trim() || "openai/gpt-audio-mini"}`
        : "needs BZ_CHAT_KEY",
    },
    {
      id: "browser",
      label: "Headless browser for hard pages",
      ok: browserAvailable(),
      detail: browserAvailable() ? "Hyperbrowser available" : "plain fetch only",
    },
    {
      id: "three_d",
      label: "3D model generation",
      ok: threeDConfigured(),
      detail: threeDConfigured() ? "configured" : "no 3D provider key",
    },
    {
      id: "desktop_connect",
      label: "Desktop app connection (managed inference)",
      ok: Boolean(signingSecret()),
      detail: signingSecret()
        ? "mints short-lived bz1 tokens; provider key stays server-side"
        : "BZ_INFERENCE_SIGNING_KEY is unset — the desktop will get 503 not_configured",
    },
  ];

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    capabilities,
    tools,
  };
});
