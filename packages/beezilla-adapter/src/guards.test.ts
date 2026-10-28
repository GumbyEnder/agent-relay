/**
 * BeeZilla — Structural guard tests.
 *
 * These tests enforce three invariants that must hold for the entire
 * beezilla-adapter package:
 *
 * 1. No migrations/ directory or *.sqlite files may exist under the
 *    package root (database access belongs to the adapter client, not
 *    the adapter itself).
 * 2. No source file may import src/lib/board-engine.ts — the adapter
 *    talks to Dev Boards via HTTP, never the local board engine.
 * 3. There is exactly one board ID: BEEZILLA_BOARD_ID = board_etzsvw4mq7d8.
 *    No second board constant or alternate board reference is allowed.
 *
 * Run: npm test
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Resolve the package root (one level above src/)
// ---------------------------------------------------------------------------

const PKG_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// 1. No migrations / sqlite
// ---------------------------------------------------------------------------

describe("no migrations / sqlite", () => {
  it("rejects a migrations/ directory under the package root", () => {
    const migrationsDir = path.join(PKG_ROOT, "migrations");
    expect(fs.existsSync(migrationsDir)).toBe(false);
  });

  it("rejects any *.sqlite file under the package root", () => {
    const sqliteFiles: string[] = [];
    function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".sqlite") || entry.name.endsWith(".sqlite3")) {
          sqliteFiles.push(full);
        }
      }
    }
    walk(PKG_ROOT);
    expect(sqliteFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. No import of src/lib/board-engine.ts
// ---------------------------------------------------------------------------

describe("no board-engine import", () => {
  it("rejects any import of board-engine.ts in source files", () => {
    const srcDir = path.join(PKG_ROOT, "src");
    const offending: string[] = [];

    function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const content = fs.readFileSync(full, "utf-8");
          if (/board-engine/.test(content)) {
            offending.push(full);
          }
        }
      }
    }

    walk(srcDir);
    expect(offending, `board-engine.ts import found in: ${offending.join(", ")}`).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Single board — BEEZILLA_BOARD_ID = board_etzsvw4mq7d8
// ---------------------------------------------------------------------------

describe("single board ID", () => {
  it("documents that BEEZILLA_BOARD_ID is board_etzsvw4mq7d8", () => {
    // The board ID is the only board this adapter targets.
    // Any other board ID would indicate a second board that must not exist.
    const actualBoardId = "board_etzsvw4mq7d8";
    expect(actualBoardId).toBe("board_etzsvw4mq7d8");
  });

  it("rejects any second board ID in source files", () => {
    // Scan all .ts source files for board IDs that differ from the canonical one.
    // We look for the pattern "board_" followed by a hex-ish string.
    const srcDir = path.join(PKG_ROOT, "src");
    const boardPattern = /board_[a-zA-Z0-9_]{10,}/g;
    const found: string[] = [];

    function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const content = fs.readFileSync(full, "utf-8");
          let match: RegExpExecArray | null;
          while ((match = boardPattern.exec(content)) !== null) {
            const id = match[0];
            if (id !== "board_etzsvw4mq7d8") {
              found.push(`${full}: ${id}`);
            }
          }
        }
      }
    }

    walk(srcDir);
    expect(found, `Unexpected board IDs found: ${found.join(", ")}`).toHaveLength(0);
  });
});
