/**
 * Managed browser rendering — Hyperbrowser.
 *
 * `fetch_website` is a plain GET: modern pages render client-side, so a portal,
 * a pricing page or a supplier catalogue comes back as an empty shell. This
 * module renders the page properly and returns clean markdown.
 *
 * Job-based API (verified 2026-10-25):
 *   POST /api/scrape {url}            → { jobId }
 *   GET  /api/scrape/<jobId>          → { status, data: { markdown, metadata } }
 *
 * Measured: simple page ~2s, a heavy marketing page ~6s (985KB of HTML → 36KB
 * of clean text). That cost is why the caller routes HTTP-first and only
 * renders when the plain fetch came back thin — see `readWebPage` in webpage.ts.
 *
 * We send a URL and nothing else: no cookies, no credentials, no form values.
 */

const env = (key: string): string => process.env[key]?.trim() ?? "";
const HB_KEY = env("BZ_HYPERBROWSER_KEY");
const BASE = "https://api.hyperbrowser.ai/api";

export function browserAvailable(): boolean {
  return HB_KEY !== "";
}

export interface RenderResult {
  ok: boolean;
  finalUrl?: string;
  title?: string;
  markdown?: string;
  error?: string;
  ms: number;
}

interface ScrapeJob {
  jobId?: string;
  status?: string;
  data?: {
    markdown?: string;
    metadata?: { title?: string; url?: string; finalUrl?: string; statusCode?: number };
  };
  error?: string;
}

async function hb(path: string, init?: RequestInit): Promise<Response> {
  return fetch(BASE + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": HB_KEY,
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * Render one page. Never throws: a failure is a named error the caller can
 * state plainly ("I couldn't render that page") instead of a dead turn.
 */
export async function renderPage(
  rawUrl: string,
  opts?: { timeoutMs?: number },
): Promise<RenderResult> {
  const started = Date.now();
  const timeoutMs = Math.max(5000, Math.min(60000, opts?.timeoutMs ?? 30000));
  let url: URL;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, error: "that isn't a valid URL", ms: Date.now() - started };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { ok: false, error: "only http(s) pages can be rendered", ms: Date.now() - started };
  }
  if (!HB_KEY) return { ok: false, error: "the browser is not configured", ms: Date.now() - started };

  try {
    const created = await hb("/scrape", { method: "POST", body: JSON.stringify({ url: url.toString() }) });
    if (!created.ok) {
      const body = await created.text().catch(() => "");
      return {
        ok: false,
        error: `browser refused the job (${created.status})${body ? `: ${body.slice(0, 120)}` : ""}`,
        ms: Date.now() - started,
      };
    }
    const job = (await created.json()) as ScrapeJob;
    const jobId = job.jobId;
    if (!jobId) return { ok: false, error: "browser returned no job id", ms: Date.now() - started };

    // Poll. 1.2s is the provider's own settlement time; polling faster just
    // burns requests, and the caller's wall clock is the real budget.
    for (;;) {
      if (Date.now() - started > timeoutMs) {
        return { ok: false, error: `the page took longer than ${Math.round(timeoutMs / 1000)}s to render`, ms: Date.now() - started };
      }
      await new Promise((r) => setTimeout(r, 1200));
      const poll = await hb(`/scrape/${jobId}`);
      if (!poll.ok) continue;
      const state = (await poll.json()) as ScrapeJob;
      if (state.status === "completed") {
        const md = state.data?.markdown ?? "";
        const meta = state.data?.metadata ?? {};
        if (!md.trim()) {
          return { ok: false, error: "the page rendered but had no readable text", ms: Date.now() - started };
        }
        return {
          ok: true,
          finalUrl: meta.finalUrl || meta.url || url.toString(),
          title: (meta.title || "").slice(0, 200),
          markdown: md,
          ms: Date.now() - started,
        };
      }
      if (state.status === "failed" || state.status === "error") {
        return { ok: false, error: state.error || "the browser could not load that page", ms: Date.now() - started };
      }
    }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      ok: false,
      error: timedOut ? "the browser timed out" : "the browser request failed",
      ms: Date.now() - started,
    };
  }
}
