/**
 * BeeZilla — HTTP error mapping for Dev Boards adapter.
 *
 * Maps raw HTTP status codes to semantic error types the
 * BeeZilla layer can act on (issue 103 / 9822).
 */

// ---------------------------------------------------------------------------
// Semantic error types
// ---------------------------------------------------------------------------

/**
 * Semantic errors produced by mapHttpError.
 * Each variant carries enough context for the caller to decide
 * whether to redirect, retry, or show a toast.
 */
export type DevBoardError =
  | { kind: "signed_out"; message: string }
  | { kind: "rate_limited"; retryAfterMs?: number; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "server_error"; status: number; message: string }
  | { kind: "network"; message: string }
  | { kind: "unknown"; status: number; message: string };

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Map an HTTP status code (+ optional body text) to a semantic error.
 *
 * Known mappings:
 *   401 → signed_out
 *   429 → rate_limited (reads Retry-After header when present)
 *   404 → not_found
 *   5xx → server_error
 *
 * @param status — HTTP status code
 * @param body — response body text (truncated to 400 chars)
 * @param headers — optional response headers (for Retry-After)
 * @returns a DevBoardError describing the failure
 */
export function mapHttpError(
  status: number,
  body: string,
  headers?: Record<string, string>,
): DevBoardError {
  const msg = (body ?? "").slice(0, 400);

  switch (status) {
    case 401:
      return { kind: "signed_out", message: msg || "Dev Boards returned 401 Unauthorized — session expired" };

    case 429: {
      const retryAfter = headers?.["retry-after"];
      const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
      return {
        kind: "rate_limited",
        retryAfterMs,
        message: msg || "Dev Boards rate limited this request",
      };
    }

    case 404:
      return { kind: "not_found", message: msg || "Dev Boards resource not found" };

    case 500:
    case 502:
    case 503:
    case 504:
      return { kind: "server_error", status, message: msg || `Dev Boards server error (${status})` };

    default:
      return { kind: "unknown", status, message: msg || `Unexpected Dev Boards response: ${status}` };
  }
}

/**
 * Convenience: check if an error means the session is invalid.
 */
export function isSignedOut(err: DevBoardError): err is { kind: "signed_out"; message: string } {
  return err.kind === "signed_out";
}
