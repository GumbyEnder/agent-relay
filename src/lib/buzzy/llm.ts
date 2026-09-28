/**
 * Buzzy LLM harness — lightweight OpenAI-compatible chat completions.
 *
 * Reads BZ_CHAT_BASE_URL / BZ_CHAT_KEY / BZ_CHAT_MODEL from env.
 * Defaults to Nous Inference API (cloud-only — no local models).
 *
 * BZ_CHAT_MODELS is a JSON array of { label, model } objects.
 * If unset, defaults to a single "Marvin" entry.
 */

const env = (key: string): string => {
  const v = process.env[key]?.trim();
  return v ?? "";
};

const BASE_URL = env("BZ_CHAT_BASE_URL") || "https://inference-api.nousresearch.com/v1";
const API_KEY = env("BZ_CHAT_KEY");
const DEFAULT_MODEL = env("BZ_CHAT_MODEL") || "z-ai/glm-5.3-flash";

/** Parsed model catalog from BZ_CHAT_MODELS. */
let _models: Array<{ label: string; model: string }> | null = null;

function getModels(): Array<{ label: string; model: string }> {
  if (_models !== null) return _models;
  const raw = env("BZ_CHAT_MODELS");
  if (!raw) {
    _models = [{ label: "Marvin", model: DEFAULT_MODEL }];
    return _models!;
  }
  try {
    _models = JSON.parse(raw);
  } catch {
    console.warn("[buzzy/llm] BZ_CHAT_MODELS is not valid JSON — using default");
    _models = [{ label: "Marvin", model: DEFAULT_MODEL }];
  }
  return _models!;
}

if (!API_KEY) {
  console.warn("[buzzy/llm] BZ_CHAT_KEY is not set — chat will fail at runtime");
}

/**
 * Call the chat completions endpoint.
 * @param messages — chat messages.
 * @param opts — optional model override, temperature, max tokens.
 * @returns the assistant text from the first choice.
 */
export async function chatCompletion(
  messages: Array<{ role: string; content: string }>,
  opts?: { model?: string; temperature?: number; maxTokens?: number },
): Promise<string> {
  const model = opts?.model || DEFAULT_MODEL;
  // BASE_URL may or may not end in "/v1" — join paths, never use new URL()
  // (an absolute path would REPLACE the base path and drop "/v1").
  const url = new URL(
    BASE_URL.replace(/\/+$/, "") + "/chat/completions",
  );
  const body = {
    model,
    messages,
    temperature: opts?.temperature ?? 0.7,
    max_tokens: opts?.maxTokens ?? 2048,
    stream: false,
  };

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned no content in first choice");
  }

  return content.trim();
}

export { getModels };
