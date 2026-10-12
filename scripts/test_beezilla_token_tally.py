#!/usr/bin/env python3
"""Unit tests for scripts/beezilla-token-tally.py.

All fixtures below are SYNTHETIC test inputs -- they never represent runtime
usage and are never read from runtime output files. They exercise the pure
logic (role/lane classification, identity dedup/mirror, cost provenance,
receipts, sanitization, ledger append) using temporary in-memory / temp-dir
SQLite databases.

Run:  python3 -m unittest scripts.test_beezilla_token_tally -v
or:   python3 scripts/test_beezilla_token_tally.py
"""
from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from importlib import util as _il_util

# load the sibling module by path (filename contains hyphens, not importable
# by module name directly)
HERE = Path(__file__).resolve().parent
_MOD_PY = HERE / "beezilla-token-tally.py"
_spec = _il_util.spec_from_file_location("beezilla_token_tally", _MOD_PY)
_bz = _il_util.module_from_spec(_spec)
_spec.loader.exec_module(_bz)
bz = _bz


def _mkdb(path: Path, usage_rows, session_rows=()):
    con = sqlite3.connect(path)
    con.execute("""
        CREATE TABLE IF NOT EXISTS session_model_usage (
            session_id TEXT, model TEXT, billing_provider TEXT,
            billing_base_url TEXT, billing_mode TEXT, task TEXT,
            api_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
            cache_read_tokens INTEGER, cache_write_tokens INTEGER,
            reasoning_tokens INTEGER, estimated_cost_usd REAL,
            actual_cost_usd REAL, cost_status TEXT, cost_source TEXT,
            first_seen REAL, last_seen REAL)""")
    con.executemany("""
        INSERT INTO session_model_usage (
            session_id, model, billing_provider, billing_base_url, billing_mode,
            task, api_call_count, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, reasoning_tokens, estimated_cost_usd,
            actual_cost_usd, cost_status, cost_source, first_seen, last_seen)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", usage_rows)
    if session_rows:
        cols = [c[1] for c in con.execute("PRAGMA table_info(sessions)")]
        if not cols:
            con.execute("""
                CREATE TABLE sessions (
                    id TEXT, parent_session_id TEXT, model TEXT,
                    billing_provider TEXT, created_source TEXT)""")
        con.executemany("""
            INSERT OR REPLACE INTO sessions (
                id, parent_session_id, model, billing_provider, created_source)
            VALUES (?,?,?,?,?)""", session_rows)
    con.commit()
    con.close()


_COLORDER = (
    "sid", "model", "provider", "baseurl", "mode", "task",
    "calls", "tin", "tout", "crt", "cwt", "re", "est", "act",
    "cstat", "csrc", "fs", "ls")


FLASH = "deepseek/deepseek-v4-flash-0731"
PRO = "deepseek/deepseek-v4-pro-0813"
SOLAR = "upstage/solar-pro4"
MERCURY = "inception/mercury-2.5"
KIMI = "moonshotai/kimi-k2.6"
QWEN = "Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf"
GLM = "z-ai/glm-5.3-flash"


def _usage(sid, model, **over):
    vals = {"sid": sid, "model": model,
            "provider": "nous",
            "baseurl": "https://inference-api.nousresearch.com/v1",
            "mode": "", "task": "", "calls": 2, "tin": 606, "tout": 103,
            "crt": 8448, "cwt": 0, "re": 2, "est": 0.000175112, "act": 0.0,
            "cstat": "estimated", "csrc": "provider_models_api",
            "fs": 1000.0, "ls": 1000.0}
    vals.update(over)
    return tuple(vals[k] for k in _COLORDER)


def _usedict(sid, model, **over):
    """dict form of a usage row using the module's real field names."""
    d = {
        "session_id": sid, "model": model,
        "billing_provider": "nous",
        "billing_base_url": "https://inference-api.nousresearch.com/v1",
        "billing_mode": "", "task": "",
        "api_call_count": 2, "input_tokens": 606, "output_tokens": 103,
        "cache_read_tokens": 8448, "cache_write_tokens": 0,
        "reasoning_tokens": 2, "estimated_cost_usd": 0.000175112,
        "actual_cost_usd": 0.0, "cost_status": "estimated",
        "cost_source": "provider_models_api",
    }
    d.update(over)
    return d


def _sources_for_one(root, profile, rows, session_rows=()):
    p = root / profile
    p.mkdir(parents=True, exist_ok=True)
    _mkdb(p / "state.db", rows, session_rows)
    return root


class SourceDiscoveryTest(unittest.TestCase):
    def test_absent_and_available_empty_and_expected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "gollum").mkdir(parents=True)
            _mkdb(root / "gollum" / "state.db", [])
            sources = bz.discover_profile_sources(
                root, ["gollum", "utility-worker", "coder-b70",
                       "pippin", "business-docs", "aragorn", "frodo"])
            by = {s["profile"]: s for s in sources}
            self.assertEqual(by["gollum"]["state"], "available-empty")
            self.assertEqual(by["utility-worker"]["state"], "absent")
            for missing in ("pippin", "business-docs", "aragorn", "coder-b70"):
                self.assertEqual(by[missing]["state"], "absent")
            self.assertEqual(by["frodo"]["state"], "absent")


class CloudIdentityTest(unittest.TestCase):
    ALL_FIVE = [FLASH, PRO, SOLAR, MERCURY, KIMI]

    def test_five_exact_cloud_ids_classified(self):
        for i, m in enumerate(self.ALL_FIVE):
            row = _usage(f"s{i}", m)
            self.assertEqual(bz._lane_of({"model": m, "billing_base_url":
                                          "https://inference-api.nousresearch"
                                          "/v1"}), "cloud",
                             f"{m} should be cloud lane")
            self.assertIn(m, bz.EXACT_CLOUD_MODEL_IDS)

    def test_local_qwen_and_legacy_glm(self):
        lq = bz._lane_of({"model": QWEN, "billing_base_url":
                          "http://localhost:18081/v1"})
        lg = bz._lane_of({"model": GLM, "billing_base_url":
                          "https://inference-api.nousresearch.com/v1"})
        self.assertEqual(lq, "local-b70")
        self.assertEqual(lg, "legacy")


class RoleLineageTest(unittest.TestCase):
    def test_coordinator_root_vs_worker_child_in_frodo(self):
        row_root = _usedict("coord_root", FLASH)
        sessions = {"coord_root": {"parent_session_id": None}}
        self.assertEqual(bz.resolve_role("frodo", row_root, sessions),
                         "coordinator")
        row_child = _usedict("child1", FLASH)
        sessions_c = {"child1": {"parent_session_id": "coord_root"}}
        self.assertEqual(bz.resolve_role("frodo", row_child, sessions_c),
                         "worker")

    def test_worker_profiles_are_workers(self):
        for prof in ("coder-b70", "gollum", "aragorn", "pippin"):
            self.assertEqual(
                bz.resolve_role(prof, _usedict("x", FLASH),
                                {"x": {"parent_session_id": None}}),
                "worker")

    def test_unknown_when_no_metadata(self):
        self.assertEqual(bz.resolve_role("ghost", _usedict("x", FLASH), {}),
                         "unknown")


class CostProvenanceTest(unittest.TestCase):
    def test_prefer_actual_over_estimate(self):
        row = _usedict("s", FLASH, estimated_cost_usd=0.5, actual_cost_usd=0.37,
                       cost_status="measured", cost_source="billing")
        c = bz.cost_for(row)
        self.assertEqual(c["actual_cost_usd"], 0.37)
        self.assertEqual(c["actual_status"], "measured")
        self.assertEqual(c["preferred_cost_usd"], 0.37)

    def test_zero_actual_with_unknown_status_is_unknown(self):
        row = _usedict("s", FLASH, estimated_cost_usd=0.0, actual_cost_usd=0.0,
                       cost_status="unknown", cost_source="none")
        c = bz.cost_for(row)
        self.assertIsNone(c["actual_cost_usd"])  # NOT free
        self.assertEqual(c["actual_status"], "unknown")

    def test_measured_actual_zero_is_known_zero_not_unknown(self):
        # an explicitly measured zero is a real known 0.0, unlike a default 0.0
        row = _usedict("s", FLASH, estimated_cost_usd=0.0, actual_cost_usd=0.0,
                       cost_status="reconciled", cost_source="provider_invoice")
        c = bz.cost_for(row)
        self.assertEqual(c["actual_cost_usd"], 0.0)
        self.assertEqual(c["actual_status"], "reconciled")
        self.assertIsNotNone(c["actual_cost_usd"])

    def test_title_generation_legacy_estimate_preserved(self):
        row = _usedict("s", FLASH, task="title_generation",
                       estimated_cost_usd=3.227e-05, actual_cost_usd=0.0,
                       cost_status=None, cost_source=None)
        c = bz.cost_for(row)
        self.assertAlmostEqual(c["estimated_cost_usd"], 3.227e-05, places=11)
        self.assertEqual(c["estimate_status"], "unknown/legacy")
        self.assertIsNone(c["actual_cost_usd"])

    def test_never_adds_actual_plus_estimate(self):
        row = _usedict("s", FLASH, estimated_cost_usd=0.5, actual_cost_usd=0.37,
                       cost_status="measured", cost_source="billing")
        c = bz.cost_for(row)
        self.assertEqual(c["preferred_cost_usd"], 0.37)  # not 0.87


class DedupMirrorTest(unittest.TestCase):
    def _build_sources(self, td):
        root = Path(td)
        a = root / "aragorn"
        a.mkdir(parents=True)
        c = root / "coder-b70"
        c.mkdir()
        row = _usage("s9", FLASH)
        _mkdb(a / "state.db", [row])
        _mkdb(c / "state.db", [row])
        return root

    def test_mirror_duplicate_ignored(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._build_sources(td)
            sources = bz.discover_profile_sources(
                root, ["aragorn", "coder-b70", "gollum", "pippin",
                       "business-docs", "utility-worker", "frodo"])
            res = bz.aggregate(sources, None)
            self.assertEqual(res["mirror_duplicates_ignored"], 1)
            has = [r for r in res["records"] if r["kind"] == "usage"]
            self.assertEqual(len(has), 1)
            total = res["aggregates"][("worker", "cloud")]["total_tokens"]
            self.assertEqual(total, 606 + 103 + 8448)


class AggregateCountsTest(unittest.TestCase):
    def test_totals_and_reasoning_not_double_added(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "coder-b70").mkdir(parents=True)
            _mkdb(root / "coder-b70" / "state.db", [
                _usage("s1", QWEN, baseurl="http://localhost:18081/v1",
                       calls=1, tin=10, tout=5, crt=0, re=4),
                _usage("s2", QWEN, baseurl="http://localhost:18081/v1",
                       calls=1, tin=10, tout=5, crt=0, re=4),
                _usage("s3", QWEN, baseurl="http://localhost:18081/v1",
                       calls=1, tin=10, tout=5, crt=100, re=0),
            ])
            sources = bz.discover_profile_sources(
                root, ["coder-b70", "aragorn", "frodo", "gollum", "pippin",
                       "business-docs", "utility-worker"])
            res = bz.aggregate(sources, None)
            agg = res["aggregates"][("worker", "local-b70")]
            self.assertEqual(agg["input"], 30)
            self.assertEqual(agg["output"], 15)
            self.assertEqual(agg["cache_read"], 100)
            self.assertEqual(agg["reasoning"], 8)
            self.assertEqual(agg["total_tokens"], 30 + 15 + 100)
            self.assertEqual(agg["api_calls"], 3)


class ThreeRowEstimateOnlyRegressionTest(unittest.TestCase):
    """Mirrors the real estimate-only three-row pattern (two main-task rows,
    one auxiliary title_generation estimate). Synthetic inputs only; asserts
    actual_cost_usd is null, the stored estimate total is preserved, and the
    native token/call counters reconcile exactly."""

    def _build(self, td, session_rows=()):
        root = Path(td)
        rows = [
            _usage("b7fe50", FLASH, calls=2, tin=3228, tout=131, crt=5888,
                   cwt=0, re=2, est=0.000326732, act=0.0,
                   cstat="estimated", csrc="provider_models_api"),
            _usage("5f9915", FLASH, task="title_generation", calls=1, tin=437,
                   tout=12, crt=0, cwt=0, re=0, est=3.227e-05, act=0.0,
                   cstat=None, csrc=None),
            _usage("5f9915", FLASH, calls=2, tin=606, tout=103, crt=8448,
                   cwt=0, re=2, est=0.000175112, act=0.0,
                   cstat="estimated", csrc="provider_models_api"),
        ]
        _sources_for_one(root, "aragorn", rows, session_rows)
        return root

    def test_estimate_only_actual_is_null_and_estimate_preserved(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._build(td)
            sources = bz.discover_profile_sources(root, ["aragorn", "frodo"])
            res = bz.aggregate(sources, None)
            agg = res["aggregates"][("worker", "cloud")]
            self.assertEqual(agg["rows"], 3)
            self.assertEqual(agg["api_calls"], 5)
            self.assertEqual(agg["input"], 4271)
            self.assertEqual(agg["output"], 246)
            self.assertEqual(agg["cache_read"], 14336)
            self.assertEqual(agg["cache_write"], 0)
            self.assertEqual(agg["reasoning"], 4)
            self.assertEqual(agg["total_tokens"], 4271 + 246 + 14336)
            # estimate preserved (includes title_generation), actual is NULL
            self.assertAlmostEqual(agg["estimated_cost_usd"], 0.000534114,
                                   places=7)
            self.assertIsNone(agg["actual_cost_usd"])
            self.assertTrue(agg["cost_unknown"])
            self.assertEqual(agg["actual_rows_known"], 0)
            self.assertEqual(agg["actual_rows_unknown"], 3)
            self.assertIsNone(agg["known_actual_cost_usd"])

    def test_source_scope_selects_same_rows(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._build(
                td, session_rows=[("b7fe50", None, FLASH, "nous",
                                   "beezilla-route-validation"),
                                  ("5f9915", None, FLASH, "nous",
                                   "beezilla-route-validation")])
            sources = bz.discover_profile_sources(root, ["aragorn", "frodo"])
            res = bz.aggregate(sources, ("SOURCE",
                                         {"beezilla-route-validation"}))
            agg = res["aggregates"][("worker", "cloud")]
            self.assertEqual(agg["rows"], 3)
            self.assertIsNone(agg["actual_cost_usd"])
            self.assertAlmostEqual(agg["estimated_cost_usd"], 0.000534114,
                                   places=7)


class MixedKnownAndEstimatedAggregateTest(unittest.TestCase):
    def test_mixed_actual_unknown_but_known_partial_exposed(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            rows = [
                _usage("ska", FLASH, est=0.1, act=0.37, calls=1, tin=10,
                       tout=1, crt=0, re=0, cstat="measured", csrc="billing"),
                _usage("sest", FLASH, est=0.05, act=0.0, calls=1, tin=10,
                       tout=1, crt=0, re=0, cstat="estimated",
                       csrc="provider_models_api"),
            ]
            _sources_for_one(root, "aragorn", rows)
            sources = bz.discover_profile_sources(root, ["aragorn", "frodo"])
            agg = bz.aggregate(sources, None)["aggregates"][("worker", "cloud")]
            # actual total is incomplete => NULL, even though one row is known
            self.assertIsNone(agg["actual_cost_usd"])
            self.assertTrue(agg["cost_unknown"])
            self.assertEqual(agg["actual_rows_known"], 1)
            self.assertEqual(agg["actual_rows_unknown"], 1)
            self.assertAlmostEqual(agg["known_actual_cost_usd"], 0.37, places=7)
            self.assertAlmostEqual(agg["estimated_cost_usd"], 0.15, places=7)

    def test_all_measured_rows_give_full_known_actual(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            rows = [
                _usage("s1", FLASH, est=0.1, act=0.37, calls=1, tin=10,
                       tout=1, crt=0, re=0, cstat="measured", csrc="billing"),
                _usage("s2", FLASH, est=0.0, act=0.13, calls=1, tin=10,
                       tout=1, crt=0, re=0, cstat="reconciled",
                       csrc="invoice"),
            ]
            _sources_for_one(root, "aragorn", rows)
            sources = bz.discover_profile_sources(root, ["aragorn", "frodo"])
            agg = bz.aggregate(sources, None)["aggregates"][("worker", "cloud")]
            self.assertIsNone(agg["known_actual_cost_usd"])
            self.assertFalse(agg["cost_unknown"])
            self.assertAlmostEqual(agg["actual_cost_usd"], 0.50, places=7)


class ReceiptTest(unittest.TestCase):
    def _usage_record(self, sid, model=FLASH, provider="nous", task="",
                      base_url="https://inference-api.nousresearch.com/v1",
                      mode=""):
        return {"kind": "usage", "session_id": sid,
                "identity": [sid, model, provider, base_url, mode, task]}

    def test_dedup_and_native_coverage(self):
        record = self._usage_record("s1")
        receipts = [
            {"attempt_id": "a-1", "session_id": "s1", "model": FLASH,
             "provider": "nous", "task": "", "success": True,
             "input_tokens": 100},
            {"attempt_id": "a-1", "session_id": "s1", "model": FLASH,
             "provider": "nous", "task": "", "success": True,
             "input_tokens": 999},  # dup id
            {"attempt_id": "a-2", "session_id": "s1", "model": FLASH,
             "provider": "nous", "task": "background_review", "success": False,
             "retry": True, "input_tokens": 50, "output_tokens": 5},
        ]
        out = bz.dedup_receipts(receipts, [record])
        self.assertEqual(out["unique_ids"], 2)
        self.assertEqual(out["duplicate_ids_dropped"], 1)
        self.assertEqual(out["covered_by_native"], 1)
        self.assertEqual(out["unlinked_ambiguous"], 1)  # a-2 unmatched ident
        self.assertEqual(out["ambiguous_linkage"], 0)

    def test_separate_sessions_same_identity_not_covered_without_link(self):
        # two different sessions share model/provider/task; a receipt MUST carry
        # an explicit matching session id to be covered, else it is unlinked.
        recs = [self._usage_record("s1"), self._usage_record("s2")]
        receipts = [
            {"attempt_id": "a-1", "session_id": "s1", "model": FLASH,
             "provider": "nous", "task": "", "success": True},
            # no session id at all -> cannot be proven covered
            {"attempt_id": "a-2", "model": FLASH, "provider": "nous",
             "task": "", "success": True},
            # wrong session -> unlinked (model/provider/task alone insufficient)
            {"attempt_id": "a-3", "session_id": "s-other", "model": FLASH,
             "provider": "nous", "task": "", "success": True},
        ]
        out = bz.dedup_receipts(receipts, recs)
        self.assertEqual(out["covered_by_native"], 1)  # only a-1
        self.assertEqual(out["unlinked_ambiguous"], 2)  # a-2, a-3

    def test_ambiguous_when_multiple_native_rows_match(self):
        # same session, same (model, provider, task), different base_url -> the
        # full identity differs; the receipt cannot pick one => ambiguous.
        recs = [
            self._usage_record("s1", base_url="https://a.example/v1"),
            self._usage_record("s1", base_url="https://b.example/v1"),
        ]
        receipts = [
            {"attempt_id": "a-1", "session_id": "s1", "model": FLASH,
             "provider": "nous", "task": "", "success": True},
        ]
        out = bz.dedup_receipts(receipts, recs)
        self.assertEqual(out["covered_by_native"], 0)
        self.assertEqual(out["ambiguous_linkage"], 1)
        self.assertEqual(out["unlinked_ambiguous"], 1)

    def test_unlinked_evidence_summary_preserved(self):
        recs = [self._usage_record("s1")]
        receipts = [
            {"attempt_id": "a-1", "model": FLASH, "provider": "nous",
             "task": "x", "success": False, "retry": True},
            {"attempt_id": "a-2", "model": FLASH, "provider": "nous",
             "task": "y", "success": True},
        ]
        out = bz.dedup_receipts(receipts, recs)
        self.assertEqual(out["unlinked_ambiguous"], 2)
        ev = out["unlinked_evidence"]
        self.assertEqual(ev["attempts"], 2)
        self.assertEqual(ev["success"], 1)
        self.assertEqual(ev["retry"], 1)


class ReportFormattingTest(unittest.TestCase):
    def test_json_and_markdown_do_not_fabricate_actual(self):
        result = {
            "generated_utc": "2026-01-01T00:00:00Z",
            "sources": [],
            "scope": {"description": ["profile-wide"]},
            "aggregates": {
                ("worker", "cloud"): {
                    "rows": 3, "api_calls": 5.0, "input": 4271.0,
                    "output": 246.0, "cache_read": 14336.0,
                    "cache_write": 0.0, "reasoning": 4.0,
                    "total_tokens": 18853.0, "estimated_cost_usd": 0.000534114,
                    "actual_cost_usd": None, "known_actual_cost_usd": None,
                    "actual_rows_known": 0, "actual_rows_unknown": 3,
                    "cost_unknown": True,
                },
            },
            "receipts": None,
            "mirror_duplicates_ignored": 0,
            "warnings": [],
            "limitations": [],
        }
        jdoc = bz.build_json(result)
        a = jdoc["aggregates"]["worker/cloud"]
        self.assertIsNone(a["actual_cost_usd"])
        self.assertAlmostEqual(a["estimated_cost_usd"], 0.000534114, places=7)
        self.assertTrue(a["cost_unknown"])

        md = bz.build_markdown(result)
        self.assertIn("UNKNOWN", md)
        # the stored ESTIMATE (not the actual) is the only place 0.000534... appears
        self.assertIn("0.000534 | UNKNOWN | UNKNOWN |", md)
        self.assertIn("Stored estimate USD", md)
        self.assertIn("Actual cost USD", md)

    def test_markdown_mixed_partial_coverage_note(self):
        result = {
            "generated_utc": "2026-01-01T00:00:00Z",
            "sources": [],
            "scope": {"description": ["profile-wide"]},
            "aggregates": {
                ("worker", "cloud"): {
                    "rows": 2, "api_calls": 2.0, "input": 20.0,
                    "output": 2.0, "cache_read": 0.0, "cache_write": 0.0,
                    "reasoning": 0.0, "total_tokens": 22.0,
                    "estimated_cost_usd": 0.15, "actual_cost_usd": None,
                    "known_actual_cost_usd": 0.37, "actual_rows_known": 1,
                    "actual_rows_unknown": 1, "cost_unknown": True,
                },
            },
            "receipts": None,
            "mirror_duplicates_ignored": 0,
            "warnings": [],
            "limitations": [],
        }
        md = bz.build_markdown(result)
        self.assertIn("Partial known actual", md)
        self.assertIn("1/2 rows measured", md)


class SanitizeAndLedgerTest(unittest.TestCase):
    def test_secret_metadata_scrubbed(self):
        rec = {"session_id": "s", "model": FLASH, "billing_base_url":
               "https://host/v1?key=SECRET123&token=abc",
               "cwd": "/home/alice/secret/proj"}
        safe = bz.sanitize_metadata(rec)
        self.assertNotIn("key=", safe["billing_base_url"])
        self.assertNotIn("SECRET123", safe["billing_base_url"])
        self.assertNotIn("cwd", safe)

    def test_ledger_append_preserves_history(self):
        with tempfile.TemporaryDirectory() as td:
            lp = Path(td) / "ledger.md"
            lp.write_text("# OLD\n", encoding="utf-8")
            snap = {"generated_utc": "2026-01-01T00:00:00Z",
                    "result": {"aggregates": {("worker", "cloud"): {
                        "rows": 1, "api_calls": 2.0, "input": 6.0,
                        "output": 1.0, "cache_read": 8.0, "cache_write": 0.0,
                        "reasoning": 0.0, "total_tokens": 15.0,
                        "actual_cost_usd": 0.001, "known_actual_cost_usd": None,
                        "actual_rows_known": 1, "actual_rows_unknown": 0,
                        "estimated_cost_usd": 0.001,
                        "cost_unknown": False}}}}
            bz.append_ledger(lp, snap)
            text = lp.read_text(encoding="utf-8")
            self.assertTrue(text.startswith("# OLD\n"))  # history preserved
            self.assertIn("worker/cloud", text)


class ReadOnlyTest(unittest.TestCase):
    def test_real_style_db_read_readonly_and_schema_drift(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            p = root / "codersub"
            p.mkdir()
            db = p / "state.db"
            con = sqlite3.connect(db)
            con.execute("""CREATE TABLE session_model_usage (
                session_id TEXT, model TEXT, task TEXT)""")  # minimal old schema
            con.execute("INSERT INTO session_model_usage VALUES (?,?,?)",
                        ("r1", FLASH, ""))
            con.commit()
            con.close()
            rows = bz.read_usage_rows(db)
            self.assertEqual(len(rows), 1)
            self.assertIsNone(rows[0]["input_tokens"])  # missing -> None, not 0
            self.assertTrue(db.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)