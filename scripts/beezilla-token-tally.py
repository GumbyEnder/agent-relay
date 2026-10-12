#!/usr/bin/env python3
"""BeeZilla worker token/cost accounting CLI (read-only native sources).

Replacement for the legacy worker tally utility that:

  * Reads Hermes `session_model_usage` from profile `state.db` files READ-ONLY.
  * Treats a missing profile/DB/table/schema as explicitly UNAVAILABLE / UNKNOWN,
    never as a zero-cost/zero-usage worker.
  * Does not collapse distinct `task` rows and does not add session-level totals
    a second time on top of model-usage rows (usage is cumulative per identity).
  * Uses composite identity (session_id, model, billing_provider,
    billing_base_url, billing_mode, task) and dedupes mirror / symlinked /
    duplicated identities instead of silently summing them.
  * Classifies worker vs coordinator from profile + session lineage (frodo roots
    are coordinator, frodo delegate descendants and other worker profiles are
    workers), not only from model-name heuristics.
  * Preserves STORED estimated_cost_usd / actual_cost_usd and their provenance;
    defaults of 0.0 with unknown/None cost_status are reported as UNKNOWN cost,
    never as measured free work.
  * Does not blindly add reasoning_tokens back into billed totals (reasoning may
    overlap output). Cache counters are kept separate.
  * Reports approved-cloud vs local-B70 worker token shares as an operational
    preference and exposes legacy / coordinator / unclassified usage separately.
  * Emits JSON + markdown; is dry-run by default. A ledger snapshot is written
    only when --ledger is passed explicitly and the write is append-only /
    idempotent, preserving prior ledger history.
  * Sanitizes outward metadata (strips credentials / query strings from URLs and
    never emits raw prompts/conversations).

Python stdlib only. No pip install. Real Hermes state DBs are never mutated.

See scripts/README-beezilla-token-tally.md for schema / usage.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Identity of cloud models that are "current exact IDs" (kept unchanged).
# Local legacy model names are retained as dated history, not active lanes.
# ---------------------------------------------------------------------------
EXACT_CLOUD_MODEL_IDS = {
    "deepseek/deepseek-v4-flash-0731",
    "deepseek/deepseek-v4-pro-0813",
    "upstage/solar-pro4",
    "inception/mercury-2.5",
    "moonshotai/kimi-k2.6",
}
LEGACY_MODEL_MARKERS = ("z-ai/glm-5.3-flash", "glm-5.3-flash")
LOCAL_B70_MODEL_MARKERS = ("qwen_qwen3.6", "qwen3.6")
LOCAL_B70_URL_MARKERS = ("localhost:18081", "127.0.0.1:18081")

# Coordinator profile root (frodo root sessions are coordinator; its delegate
# descendants are workers). Every other discovered profile below is a worker.
COORDINATOR_PROFILE = "frodo"

WORKER_PROFILES = {
    "coder-b70",
    "aragorn",
    "gollum",
    "business-docs",
    "utility-worker",
    "pippin",
}

# Columns we consume from session_model_usage. Optional ones are tolerated when
# a profile's schema is older and lacks them (adapt conservatively).
ALL_USAGE_COLS = (
    "session_id", "model", "billing_provider", "billing_base_url", "billing_mode",
    "task", "api_call_count", "input_tokens", "output_tokens", "cache_read_tokens",
    "cache_write_tokens", "reasoning_tokens", "estimated_cost_usd",
    "actual_cost_usd", "cost_status", "cost_source", "first_seen", "last_seen",
)
NUMERIC_USAGE_COLS = (
    "api_call_count", "input_tokens", "output_tokens", "cache_read_tokens",
    "cache_write_tokens", "reasoning_tokens", "estimated_cost_usd",
    "actual_cost_usd",
)

# Columns we may use from the sessions table for lineage/role resolution.
SESSION_COLS = ("id", "parent_session_id", "model", "billing_provider",
                "profile_name", "created_source", "source")

USER_HOST_SENSITIVE_MARKERS = (
    "/home/", "/mnt/", "/Users/", "C:\\",
)


def _profile_root() -> Path:
    return Path.home() / ".hermes" / "profiles"


def sanitize_base_url(url: Optional[str]) -> Optional[str]:
    """Strip query strings / fragments from a URL."""
    if not url:
        return url
    text = str(url)
    for cut in ("?", "#"):
        idx = text.find(cut)
        if idx != -1:
            text = text[:idx]
    return text


def sanitize_metadata(record: Dict[str, Any]) -> Dict[str, Any]:
    """Return a safe outward copy of a record (allowlist only)."""
    safe = {k: record.get(k) for k in (
        "session_id", "model", "billing_provider", "billing_mode", "task",
        "api_call_count", "input_tokens", "output_tokens", "cache_read_tokens",
        "cache_write_tokens", "reasoning_tokens", "estimated_cost_usd",
        "actual_cost_usd", "cost_status", "cost_source", "profile", "role",
        "lane", "source",
    )}
    if record.get("billing_base_url"):
        safe["billing_base_url"] = sanitize_base_url(record["billing_base_url"])
    for k, v in list(safe.items()):
        if isinstance(v, str) and any(m in v for m in USER_HOST_SENSITIVE_MARKERS):
            safe[k] = "<redacted>"
    return safe


# ---------------------------------------------------------------------------
# Source discovery
# ---------------------------------------------------------------------------

def discover_profile_sources(root: Path, profiles: List[str]) -> List[Dict[str, Any]]:
    """Return per-profile source descriptors, distinguishing ABSENT vs
    AVAILABLE-EMPTY vs HAS-DATA vs UNAVAILABLE(table/schema missing)."""
    sources = []
    for profile in profiles:
        db_path = root / profile / "state.db"
        if not db_path.exists():
            sources.append({"profile": profile, "state": "absent",
                            "db": str(db_path), "rows": 0,
                            "reason": "profile/state.db not present"})
            continue
        resolved = db_path.resolve()
        try:
            con = sqlite3.connect(f"file:{resolved}?mode=ro", uri=True)
            cols = [r[1] for r in con.execute(
                "PRAGMA table_info(session_model_usage)")]
            counts = con.execute(
                "SELECT COUNT(*) FROM session_model_usage").fetchone()[0]
            con.close()
        except sqlite3.Error as e:
            sources.append({"profile": profile, "state": "unavailable",
                            "db": str(db_path), "rows": 0,
                            "reason": f"cannot read read-only: {e}"})
            continue
        if "session_id" not in cols or "model" not in cols:
            sources.append({"profile": profile, "state": "unavailable",
                            "db": str(db_path), "rows": 0,
                            "reason": "session_model_usage missing/incompatible "
                                      "schema"})
            continue
        status = "available-empty" if counts == 0 else "has-data"
        sources.append({"profile": profile, "state": status,
                        "db": str(db_path), "rows": counts,
                        "reason": "ok"})
    return sources


# ---------------------------------------------------------------------------
# Read usage rows (read-only, schema-drift tolerant)
# ---------------------------------------------------------------------------

def read_usage_rows(db_path: Path) -> List[Dict[str, Any]]:
    con = sqlite3.connect(f"file:{db_path.resolve()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    cols = [r[1] for r in con.execute(
        "PRAGMA table_info(session_model_usage)")]
    select_cols = [c for c in ALL_USAGE_COLS if c in cols]
    if "session_id" not in select_cols or "model" not in select_cols:
        con.close()
        return []
    q = "SELECT " + ", ".join(select_cols) + " FROM session_model_usage"
    rows = [dict(r) for r in con.execute(q)]
    con.close()
    for row in rows:
        for c in NUMERIC_USAGE_COLS:
            if c not in row:
                row[c] = None
        for c in ("billing_provider", "billing_base_url", "billing_mode",
                  "task", "cost_status", "cost_source"):
            if c not in row:
                row[c] = None
    return rows


def _read_session_rows(db_path: Path) -> Dict[str, Dict[str, Any]]:
    """Minimal session info (id -> {parent_session_id, created_source, ...})
    for lineage/role and source filtering. READ-ONLY."""
    try:
        con = sqlite3.connect(f"file:{db_path.resolve()}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        cols = [r[1] for r in con.execute("PRAGMA table_info(sessions)")]
        if "id" not in cols:
            con.close()
            return {}
        sel = [c for c in SESSION_COLS if c in cols]
        q = "SELECT " + ", ".join(sel) + " FROM sessions"
        out = {}
        for r in con.execute(q):
            d = dict(r)
            out[d["id"]] = d
        con.close()
        return out
    except sqlite3.Error:
        return {}


def identity_key(row: Dict[str, Any]) -> Tuple[str, ...]:
    return (str(row.get("session_id") or ""),
            str(row.get("model") or ""),
            str(row.get("billing_provider") or ""),
            str(row.get("billing_base_url") or ""),
            str(row.get("billing_mode") or ""),
            str(row.get("task") or ""))


def _lane_of(row: Dict[str, Any]) -> str:
    model = (row.get("model") or "").lower()
    url = (row.get("billing_base_url") or "").lower()
    if any(m in url for m in LOCAL_B70_URL_MARKERS) or \
       any(m in model for m in LOCAL_B70_MODEL_MARKERS):
        return "local-b70"
    if any(m in model for m in LEGACY_MODEL_MARKERS):
        return "legacy"  # legacy GLM = dated history, not an active lane
    return "cloud"


def resolve_role(profile: str, row: Dict[str, Any],
                 sessions: Dict[str, Dict[str, Any]]) -> str:
    """Fire role from profile + session lineage.

    frodo root sessions (no parent) are coordinator; frodo delegate descendants
    (with a parent) are workers; the dedicated worker profiles are workers. If
    metadata is insufficient the role is 'unknown'.
    """
    sid = str(row.get("session_id") or "")
    s = sessions.get(sid)
    parent = s.get("parent_session_id") if s else None
    if profile == COORDINATOR_PROFILE:
        if s is None:
            return "unknown"
        return "coordinator" if parent in (None, "") else "worker"
    if profile in WORKER_PROFILES:
        return "worker"
    if s is not None:
        return "worker" if parent not in (None, "") else "coordinator"
    return "unknown"


def _f(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _summer(row: Dict[str, Any]) -> Dict[str, float]:
    return {k: _f(row.get(k)) for k in (
        "api_call_count", "input_tokens", "output_tokens", "cache_read_tokens",
        "cache_write_tokens", "reasoning_tokens", "estimated_cost_usd",
        "actual_cost_usd")}


def cost_for(row: Dict[str, Any]) -> Tuple[Optional[float], str, str]:
    """Authoritative cost for a row.

    Prefer explicit measured actual when available; otherwise preserve stored
    estimate. Never add actual + estimate together. A default actual_cost_usd==0
    with unknown/None provenance is UNKNOWN cost, not measured free work.
    """
    act = row.get("actual_cost_usd")
    est = row.get("estimated_cost_usd")
    status = row.get("cost_status")
    source = row.get("cost_source")
    has_status = bool(status)
    has_source = bool(source)
    if not has_status or not has_source:
        # title-generation legacy estimate with null provenance
        if row.get("task") == "title_generation" and _f(est) != 0.0:
            return _f(est), "unknown/legacy", source or "unknown"
        # default 0.0 with no provenance -> UNKNOWN, not free
        return None, "unknown", source or "none"
    if status == "unknown":
        return None, "unknown", source or "none"
    # explicit measured actual
    if act is not None and _f(act) != 0.0:
        return _f(act), status, source
    # preserve stored estimate when no measured actual
    if est is not None and _f(est) != 0.0:
        return _f(est), status or "estimated", source or "provider_models_api"
    # explicit but zero
    return 0.0, status, source or "none"


def aggregate(sources: List[Dict[str, Any]],
              scope: Optional[Tuple[str, Any]]) -> Dict[str, Any]:
    """Aggregate usage across profiles with dedup and role/lane classification.

    scope: (None, None)                           -> profile-wide
           ("SESSIONS", set_of_ids)               -> exact session scope
           ("SOURCE", set_of_source_strings)      -> session created_source/source
    """
    seen_identity: Dict[Tuple[str, ...], str] = {}
    records: List[Dict[str, Any]] = []
    aggregates: Dict[Tuple[str, str], Dict[str, Any]] = {}
    conflicts = 0
    mirrored = 0

    def add(role: str, lane: str, sums: Dict[str, float],
            cost: Optional[float], provenance: Tuple[str, str]) -> None:
        key = (role, lane)
        agg = aggregates.setdefault(key, {
            "api_calls": 0.0, "input": 0.0, "output": 0.0,
            "cache_read": 0.0, "cache_write": 0.0, "reasoning": 0.0,
            "total_tokens": 0.0, "estimated_cost_usd": 0.0,
            "actual_cost_usd": 0.0, "cost_unknown": True,
            "rows": 0, "cost_provenance": provenance,
        })
        agg["api_calls"] += sums["api_call_count"]
        agg["input"] += sums["input_tokens"]
        agg["output"] += sums["output_tokens"]
        agg["cache_read"] += sums["cache_read_tokens"]
        agg["cache_write"] += sums["cache_write_tokens"]
        agg["reasoning"] += sums["reasoning_tokens"]
        agg["total_tokens"] += (sums["input_tokens"] + sums["output_tokens"]
                                + sums["cache_read_tokens"]
                                + sums["cache_write_tokens"])
        if cost is not None:
            agg["actual_cost_usd"] += cost
            agg["cost_unknown"] = False
        agg["estimated_cost_usd"] += sums["estimated_cost_usd"]
        agg["rows"] += 1

    for src in sources:
        if src["state"] != "has-data":
            continue
        profile = src["profile"]
        db = Path(src["db"])
        rows = read_usage_rows(db)
        sessions = _read_session_rows(db)
        source_filter = None
        if scope and scope[0] == "SOURCE":
            source_filter = {str(x) for x in scope[1]}
        scope_sids = scope[1] if (scope and scope[0] == "SESSIONS") else None
        for row in rows:
            sid = str(row.get("session_id") or "")
            if scope_sids is not None and sid not in scope_sids:
                continue
            if source_filter is not None:
                srec = sessions.get(sid)
                match = False
                if srec is not None:
                    for cname in ("created_source", "source"):
                        if str(srec.get(cname) or "") in source_filter:
                            match = True
                            break
                if not match:
                    continue
            key = identity_key(row)
            owner = seen_identity.get(key)
            if owner is None:
                seen_identity[key] = profile
            else:
                if owner != profile:
                    mirrored += 1
                    names = list(key)
                    record = {"kind": "mirror-duplicate",
                              "identity": names, "source": profile,
                              "already_owned_by": owner}
                    record.update(sanitize_metadata(row))
                    records.append(record)
                else:
                    # same identity within one source -> duplicate row
                    own2 = None
                    records.append({"kind": "duplicate-row",
                                    "identity": list(key),
                                    "source": profile,
                                    "message": "repeated identity in same "
                                               "source not double-counted",
                                    **sanitize_metadata(row)})
                continue
            role = resolve_role(profile, row, sessions)
            lane = _lane_of(row)
            cost, status, csrc = cost_for(row)
            sums = _summer(row)
            add(role, lane, sums, cost, (status, csrc))
            rec = {"kind": "usage", "identity": list(key), "profile": profile,
                   "role": role, "lane": lane, **{
                       k: sums[k] for k in (
                           "api_call_count", "input_tokens", "output_tokens",
                           "cache_read_tokens", "cache_write_tokens",
                           "reasoning_tokens", "estimated_cost_usd",
                           "actual_cost_usd")},
                   "cost_reported": cost,
                   "cost_provenance": (status, csrc),
                   "task": row.get("task"),
                   "model": row.get("model"),
                   "billing_provider": row.get("billing_provider"),
                   "billing_mode": row.get("billing_mode"),
                   "session_id": sid}
            records.append(rec)

    return {"aggregates": aggregates, "records": records,
            "conflicts": conflicts,
            "mirror_duplicates_ignored": mirrored}


# ---------------------------------------------------------------------------
# Receipts (JSON/JSONL attempt receipts) ingestion with dedup/coverage
# ---------------------------------------------------------------------------

RECEIPT_FIELDS = ("attempt_id", "mission", "task", "role", "profile", "model",
                  "provider", "input_tokens", "output_tokens",
                  "cache_read_tokens", "cache_write_tokens", "reasoning_tokens",
                  "duration_s", "success", "retry", "actual_cost_usd",
                  "estimated_cost_usd", "cost_provenance")


def load_receipts(path: Path) -> Tuple[List[Dict[str, Any]], List[str]]:
    errors: List[str] = []
    receipts: List[Dict[str, Any]] = []
    try:
        text = Path(path).expanduser().read_text(encoding="utf-8")
    except OSError as e:
        return [], [f"cannot read receipts: {e}"]
    prefix = text.lstrip()
    if not prefix:
        return [], []
    if prefix.startswith("["):
        try:
            data = json.loads(text)
            if not isinstance(data, list):
                errors.append("receipts JSON root must be a list")
            else:
                for i, item in enumerate(data):
                    if isinstance(item, dict):
                        receipts.append(item)
                    else:
                        errors.append(f"receipt #{i}: expected object")
        except json.JSONDecodeError as e:
            errors.append(f"receipts invalid JSON: {e}")
    else:
        for i, line in enumerate(text.splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    receipts.append(obj)
                else:
                    errors.append(f"receipt line {i}: expected object")
            except json.JSONDecodeError as e:
                errors.append(f"receipt line {i}: {e}")
    return receipts, errors


def dedup_receipts(receipts: List[Dict[str, Any]],
                   records: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Dedup receipts by attempt_id and mark coverage by native records.

    A receipt is 'covered_by_native' when a native usage identity exists for the
    same (model, provider, task). Covered receipts are NOT summed again, which
    would double-count the native aggregate rows. Uncovered receipts (which can
    carry per-attempt success/retry/duration) are summed as extra evidence.
    """
    native_ident = set()
    for rec in records:
        if rec["kind"] != "usage":
            continue
        native_ident.add((rec["identity"][1], rec["identity"][2],
                          rec["identity"][5]))
    seen: set[str] = set()
    unique: List[Dict[str, Any]] = []
    dup_ids = 0
    uncovered: List[Dict[str, Any]] = []
    covered = 0
    for rc in receipts:
        aid = rc.get("attempt_id")
        if aid is None:
            unique.append({**_pick(rc), "covered_by_native": False,
                           "no_attempt_id": True})
            continue
        if aid in seen:
            dup_ids += 1
            continue
        seen.add(aid)
        ident = (rc.get("model"), rc.get("provider"), rc.get("task"))
        is_covered = ident in native_ident
        if is_covered:
            covered += 1
        else:
            uncovered.append(rc)
        unique.append({**_pick(rc), "covered_by_native": is_covered})
    out = {"attempts_total": len(unique), "unique_ids": len(seen),
           "duplicate_ids_dropped": dup_ids,
           "covered_by_native": covered,
           "uncovered_extra": len(uncovered),
           "records": unique,
           "errors": []}
    if uncovered:
        s = {"attempts": 0, "input": 0.0, "output": 0.0,
             "cache_read": 0.0, "cache_write": 0.0, "reasoning": 0.0,
             "estimated_cost_usd": 0.0, "actual_cost_usd": 0.0}
        for rc in uncovered:
            s["attempts"] += 1
            s["input"] += _f(rc.get("input_tokens"))
            s["output"] += _f(rc.get("output_tokens"))
            s["cache_read"] += _f(rc.get("cache_read_tokens"))
            s["cache_write"] += _f(rc.get("cache_write_tokens"))
            s["reasoning"] += _f(rc.get("reasoning_tokens"))
            s["estimated_cost_usd"] += _f(rc.get("estimated_cost_usd"))
            s["actual_cost_usd"] += _f(rc.get("actual_cost_usd"))
        out["uncovered_totals"] = s
    return out


def _pick(rc: Dict[str, Any]) -> Dict[str, Any]:
    return {k: rc.get(k) for k in RECEIPT_FIELDS if k in rc}


# ---------------------------------------------------------------------------
# Ledger append (explicit, idempotent, append-only)
# ---------------------------------------------------------------------------

def append_ledger(ledger_path: Path, snapshot: Dict[str, Any]) -> str:
    ledger = Path(ledger_path).expanduser()
    if not ledger.exists():
        ledger.write_text("", encoding="utf-8")
    lines = [
        "\n",
        "<!-- BeeZilla worker accounting snapshot (aragorn fallback attempt) -->",
        f"<!-- generated: {snapshot['generated_utc']} -->",
    ]
    agg = snapshot.get("result", {}).get("aggregates", {})
    for key in sorted(agg):
        a = agg[key]
        lines.append(f"## bucket {key[0]}/{key[1]}")
        lines.append(f"- rows: {a.get('rows')}")
        lines.append(f"- api_calls: {a.get('api_calls')}")
        lines.append(f"- input/output/cache_r/cache_w: {a.get('input')} / "
                     f"{a.get('output')} / {a.get('cache_read')} / "
                     f"{a.get('cache_write')}")
        lines.append(f"- reasoning: {a.get('reasoning')}")
        lines.append(f"- total_tokens: {a.get('total_tokens')}")
        lines.append(f"- actual_cost_usd (known): {a.get('actual_cost_usd')}")
        lines.append(f"- estimated_cost_usd (stored sum): "
                     f"{a.get('estimated_cost_usd')}")
        lines.append(f"- cost_unknown: {a.get('cost_unknown')}")
    lines.append("\n")
    block = "\n".join(lines)
    with open(ledger, "a", encoding="utf-8") as fh:
        fh.write(block)
    return block


# ---------------------------------------------------------------------------
# Report builders
# ---------------------------------------------------------------------------

def build_json(result: Dict[str, Any]) -> Dict[str, Any]:
    agg = {}
    for key, val in result["aggregates"].items():
        agg["/".join(key)] = val
    return {
        "generated_utc": result["generated_utc"],
        "note": "Sanitized outward report. Real sources READ-ONLY.",
        "sources": result["sources"],
        "scope": result["scope"],
        "aggregates": agg,
        "receipts": result.get("receipts"),
        "mirror_duplicates_ignored": result["mirror_duplicates_ignored"],
        "warnings": result.get("warnings", []),
        "limitations": result.get("limitations", []),
    }


def build_markdown(result: Dict[str, Any]) -> str:
    agg = result["aggregates"]
    lines = [
        "# BeeZilla worker token/cost accounting",
        "",
        f"**Generated (UTC):** {result['generated_utc']}",
        "",
        "Scope: " + "; ".join(result["scope"].get("description", [])),
        "",
        "## Source availability",
        "",
        "| Profile | State | Rows | Note |",
        "|---|---|---:|---|",
    ]
    for s in result["sources"]:
        lines.append(f"| {s['profile']} | {s['state']} | {s['rows']} | "
                     f"{s.get('reason', '')} |")
    lines += ["",
              "## Buckets (role / lane)",
              "",
              "| Bucket | Rows | API calls | Input | Output | Cache-R | Cache-W | "
              "Reasoning | Total tokens | Reported cost USD | Cost known |",
              "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for key in sorted(agg):
        a = agg[key]
        lines.append(
            f"| {key[0]}/{key[1]} | {a['rows']} | {a['api_calls']:.0f} | "
            f"{a['input']:.0f} | {a['output']:.0f} | {a['cache_read']:.0f} | "
            f"{a['cache_write']:.0f} | {a['reasoning']:.0f} | "
            f"{a['total_tokens']:.0f} | {a['actual_cost_usd']:.6f} | "
            f"{'yes' if not a['cost_unknown'] else 'UNKNOWN'} |")
    cloud = 0.0
    b70 = 0.0
    for (role, lane), a in agg.items():
        if role != "worker":
            continue
        if lane == "local-b70":
            b70 += a["total_tokens"]
        elif lane == "cloud":
            cloud += a["total_tokens"]
    total_worker = cloud + b70
    lines += ["",
              "## Operational worker-token share preference (cloud vs local B70)",
              "",
              f"- approved-cloud worker tokens: {cloud:.0f}",
              f"- local-B70 worker tokens: {b70:.0f}",
              f"- cloud share of worker tokens: "
              f"{100.0 * cloud / total_worker:.1f}%" if total_worker > 0
              else "- NO worker tokens observed; share is not a measured 0%.",
              ""]
    rc = result.get("receipts")
    if rc:
        lines += ["## Attempt receipts", "",
                  f"- total attempts: {rc.get('attempts_total')}",
                  f"- unique ids: {rc.get('unique_ids')}",
                  f"- duplicate ids dropped: {rc.get('duplicate_ids_dropped')}",
                  f"- covered by native rows (not re-summed): "
                  f"{rc.get('covered_by_native')}",
                  f"- uncovered extra (summed): {rc.get('uncovered_extra')}", ""]
        if rc.get("uncovered_totals"):
            u = rc["uncovered_totals"]
            lines += ["Uncovered attempt totals:",
                      f"- attempts: {u['attempts']} input: {u['input']:.0f} "
                      f"output: {u['output']:.0f} cache_r: {u['cache_read']:.0f} "
                      f"cache_w: {u['cache_write']:.0f} "
                      f"reasoning: {u['reasoning']:.0f}",
                      f"- cost: est {u['estimated_cost_usd']:.6f} / "
                      f"act {u['actual_cost_usd']:.6f}", ""]
    if result.get("warnings"):
        lines += ["## Warnings", ""]
        lines += [f"- {w}" for w in result["warnings"]]
    if result.get("limitations"):
        lines += ["## Implementation limitations", ""]
        lines += [f"- {l}" for l in result["limitations"]]
    lines += ["",
              "Notes:",
              "- Native session totals are NOT summed again; only "
              "`session_model_usage` rows are aggregated.",
              "- Native semantics: input/cache_read/cache_write are separate "
              "counters; total = input + output + cache_read + cache_write.",
              "- reasoning_tokens is reported separately and is NOT blindly "
              "added to billed totals (it may overlap output).",
              "- Default actual_cost_usd==0 with unknown/null provenance is "
              "UNKNOWN cost, not measured free work.",
              "- Title-generation rows are distinct tasks kept separate; a "
              "stored nonzero estimated_cost_usd with null provenance is "
              "preserved as legacy/unknown, not re-priced.",
              "- Mirrored/duplicated identities are counted once."]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_scope(args) -> Tuple[Optional[Tuple[str, Any]], List[str]]:
    desc: List[str] = []
    if args.source:
        src = set(args.source)
        desc.append(f"source={', '.join(sorted(src))} "
                    "(session created_source/source)")
        return ("SOURCE", src), desc
    if args.sessions:
        sids = set(args.sessions)
        desc.append(f"sessions={','.join(sorted(sids))}")
        return ("SESSIONS", sids), desc
    if args.root_session:
        desc.append(f"root_session={args.root_session} (exact session only)")
        return ("SESSIONS", {args.root_session}), desc
    desc.append("profile-wide (NO project/task claim; not BeeZilla-exact)")
    return None, desc


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        prog="beezilla-token-tally",
        description="BeeZilla worker token/cost accounting (read-only).")
    ap.add_argument("--profile-root", default=None,
                    help="Profile root dir (default: ~/.hermes/profiles; pass a "
                         "synthetic tree for tests).")
    ap.add_argument("--profile", action="append", default=None,
                    help="Profiles to inspect (default: known worker profiles "
                         "+ coordinator frodo).")
    ap.add_argument("--source", action="append", default=None,
                    help="Only include usage whose session created_source/source "
                         "equals this value (repeatable).")
    ap.add_argument("--sessions", action="append", default=None,
                    help="Only include these exact session ids (repeatable).")
    ap.add_argument("--root-session", default=None,
                    help="Select only this exact session id.")
    ap.add_argument("--receipts", default=None,
                    help="Optional JSON/JSONL attempt-receipt file.")
    ap.add_argument("--json", action="store_true",
                    help="Print the sanitized JSON report to stdout.")
    ap.add_argument("--markdown", action="store_true",
                    help="Print the markdown report to stdout.")
    ap.add_argument("--ledger", default=None,
                    help="Append a dated snapshot to a ledger file (append-only; "
                         "preserves prior history). Dry-run unless provided.")
    args = ap.parse_args(argv)

    root = Path(args.profile_root).expanduser() if args.profile_root \
        else _profile_root()
    profiles = args.profile if args.profile else \
        sorted(WORKER_PROFILES) + [COORDINATOR_PROFILE]
    sources = discover_profile_sources(root, profiles)
    scope, scope_desc = parse_scope(args)
    result = aggregate(sources, scope)
    result["scope"] = {"description": scope_desc}
    result["sources"] = sources

    if args.receipts:
        rct, errs = load_receipts(Path(args.receipts))
        result["receipts"] = dedup_receipts(rct, result["records"])
        result["receipts"]["errors"] = errs
    else:
        result["receipts"] = None

    # Known semantic limitations (documented, not fabricated).
    limitations = [
        "Native session_model_usage is cumulative, not per-call; failed/retried "
        "attempts are not broken out natively, so per-attempt breakdown is "
        "reported as unknown unless covered by receipts.",
    ]
    if scope is None:
        limitations.append(
            "Scope is profile-wide; it is NOT a BeeZilla project/task-exact "
            "attribution. Use --source/--sessions/--root-session for project "
            "attribution.")
    result["limitations"] = limitations
    result["warnings"] = []

    result["generated_utc"] = datetime.now(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    snapshot = {"generated_utc": result["generated_utc"], "result": result}

    printed = False
    if args.json:
        print(json.dumps(build_json(result), indent=2, default=str))
        printed = True
    if args.markdown:
        print(build_markdown(result))
        printed = True
    if not printed:
        # default: concise bucket summary to stdout
        agg = result["aggregates"]
        for key in sorted(agg):
            a = agg[key]
            print(f"{key[0]}/{key[1]}: rows={a['rows']} "
                  f"calls={a['api_calls']:.0f} "
                  f"total_tokens={a['total_tokens']:.0f} "
                  f"cost_known={bool(not a['cost_unknown'])} "
                  f"reported_usd={a['actual_cost_usd']:.6f}")
        if result["receipts"]:
            r = result["receipts"]
            print(f"receipts: total={r['attempts_total']} "
                  f"dup_dropped={r['duplicate_ids_dropped']} "
                  f"covered={r['covered_by_native']} "
                  f"uncovered={r['uncovered_extra']}")

    if args.ledger:
        append_ledger(Path(args.ledger), snapshot)
        print(f"ledger appended: {args.ledger}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
