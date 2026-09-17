/**
 * BeeZilla — HTTP error mapping tests (issue 103 / 9822).
 *
 * Tests:
 * 1. 401 → signed_out
 * 2. 429 → rate_limited with/without Retry-After
 * 3. 404 → not_found
 * 4. 500/502/503/504 → server_error
 * 5. Unknown status → unknown
 * 6. isSignedOut type guard
 * 7. Body truncation at 400 chars
 */

import { describe, it, expect } from "vitest";
import { mapHttpError, isSignedOut, type DevBoardError } from "./http-errors.js";

describe("mapHttpError", () => {
  it("maps 401 to signed_out", () => {
    const err = mapHttpError(401, "Unauthorized");
    expect(err.kind).toBe("signed_out");
    expect(err.message).toBe("Unauthorized");
  });

  it("maps 401 without body to signed_out with default message", () => {
    const err = mapHttpError(401, "");
    expect(err.kind).toBe("signed_out");
    expect(err.message).toContain("401 Unauthorized");
  });

  it("maps 429 to rate_limited", () => {
    const err = mapHttpError(429, "Too many requests", { "retry-after": "30" });
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("maps 429 without Retry-After header", () => {
    const err = mapHttpError(429, "Rate limited");
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("maps 404 to not_found", () => {
    const err = mapHttpError(404, "Not found");
    expect(err.kind).toBe("not_found");
    expect(err.message).toBe("Not found");
  });

  it("maps 500 to server_error", () => {
    const err = mapHttpError(500, "Internal server error");
    expect(err.kind).toBe("server_error");
    expect(err.status).toBe(500);
  });

  it("maps 502 to server_error", () => {
    const err = mapHttpError(502, "Bad gateway");
    expect(err.kind).toBe("server_error");
    expect(err.status).toBe(502);
  });

  it("maps 503 to server_error", () => {
    const err = mapHttpError(503, "Service unavailable");
    expect(err.kind).toBe("server_error");
    expect(err.status).toBe(503);
  });

  it("maps 504 to server_error", () => {
    const err = mapHttpError(504, "Gateway timeout");
    expect(err.kind).toBe("server_error");
    expect(err.status).toBe(504);
  });

  it("maps unknown status to unknown", () => {
    const err = mapHttpError(418, "I'm a teapot");
    expect(err.kind).toBe("unknown");
    expect(err.status).toBe(418);
    expect(err.message).toBe("I'm a teapot");
  });

  it("truncates body to 400 characters", () => {
    const longBody = "x".repeat(1000);
    const err = mapHttpError(500, longBody);
    expect(err.message.length).toBe(400);
  });

  it("handles null/undefined body gracefully", () => {
    const err1 = mapHttpError(401, "");
    expect(err1.kind).toBe("signed_out");

    const err2 = mapHttpError(500, "");
    expect(err2.kind).toBe("server_error");
  });
});

describe("isSignedOut", () => {
  it("returns true for signed_out errors", () => {
    const err: DevBoardError = { kind: "signed_out", message: "expired" };
    expect(isSignedOut(err)).toBe(true);
  });

  it("returns false for other error kinds", () => {
    const err: DevBoardError = { kind: "rate_limited", message: "too many" };
    expect(isSignedOut(err)).toBe(false);

    const err2: DevBoardError = { kind: "server_error", status: 500, message: "oops" };
    expect(isSignedOut(err2)).toBe(false);
  });
});
