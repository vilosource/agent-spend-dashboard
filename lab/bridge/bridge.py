#!/usr/bin/env python3
"""
Bridge — OTLP/JSONL → Postgres.

Reads the OTel Collector's `file/spans` JSONL output, extracts agent.* + gen_ai.*
attributes from each span, and inserts a row per assistant turn into
agent_spend_logs.

Spans without `agent.user.id` or `agent.harness.name` are skipped (they would
have been filtered by the Collector's filter/sanity processor; this is defense
in depth).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    import psycopg  # type: ignore[import-not-found]
    from psycopg.rows import dict_row  # type: ignore[import-not-found]
except ImportError:
    print("error: psycopg not installed. Run: pip install 'psycopg[binary]'", file=sys.stderr)
    sys.exit(1)


INSERT_SQL = """
INSERT INTO agent_spend_logs (
    ts, user_id, team, machine_id, session_id,
    workspace_cwd, workspace_repo, workspace_branch, workspace_is_ci,
    provider, api, model, response_model,
    harness_name, harness_version,
    input_tokens, output_tokens, cache_read, cache_write,
    cost_input_usd, cost_output_usd, cost_cache_read_usd, cost_cache_write_usd, cost_total_usd,
    cost_estimation,
    stop_reason, event_kind, environment
) VALUES (
    %(ts)s, %(user_id)s, %(team)s, %(machine_id)s, %(session_id)s,
    %(workspace_cwd)s, %(workspace_repo)s, %(workspace_branch)s, %(workspace_is_ci)s,
    %(provider)s, %(api)s, %(model)s, %(response_model)s,
    %(harness_name)s, %(harness_version)s,
    %(input_tokens)s, %(output_tokens)s, %(cache_read)s, %(cache_write)s,
    %(cost_input_usd)s, %(cost_output_usd)s, %(cost_cache_read_usd)s, %(cost_cache_write_usd)s, %(cost_total_usd)s,
    %(cost_estimation)s,
    %(stop_reason)s, %(event_kind)s, %(environment)s
)
"""


def attrs_to_dict(attributes: list[dict[str, Any]]) -> dict[str, Any]:
    """Flatten OTLP attribute list into a plain dict.

    OTLP attribute values are wrapped in a single-key object indicating the type
    (stringValue, intValue, doubleValue, boolValue, arrayValue). We unwrap the
    common cases.
    """
    out: dict[str, Any] = {}
    for a in attributes or []:
        key = a.get("key")
        if not key:
            continue
        v = a.get("value", {})
        if "stringValue" in v:
            out[key] = v["stringValue"]
        elif "intValue" in v:
            out[key] = int(v["intValue"])
        elif "doubleValue" in v:
            out[key] = float(v["doubleValue"])
        elif "boolValue" in v:
            out[key] = bool(v["boolValue"])
        elif "arrayValue" in v:
            arr = v["arrayValue"].get("values", [])
            out[key] = [next(iter(item.values())) for item in arr if item]
    return out


def span_to_row(span: dict[str, Any], resource_attrs: dict[str, Any]) -> dict[str, Any] | None:
    """Build a row for INSERT from a single OTLP span. Returns None to skip."""
    span_attrs = attrs_to_dict(span.get("attributes", []))
    # Resource attributes apply to every span on the resource; merge them under.
    a: dict[str, Any] = {**resource_attrs, **span_attrs}

    # Required fields — skip if missing.
    user_id = a.get("agent.user.id")
    harness_name = a.get("agent.harness.name")
    if not user_id or not harness_name:
        return None

    # OTLP timestamps are nanoseconds since epoch as a string. Convert to a
    # timezone-aware datetime so psycopg writes it correctly to TIMESTAMPTZ.
    start_ns = int(span.get("startTimeUnixNano", 0))
    ts = datetime.fromtimestamp(start_ns / 1_000_000_000, tz=timezone.utc)

    return {
        "ts": ts,
        "user_id": user_id,
        "team": a.get("agent.user.team"),
        "machine_id": a.get("agent.machine.id") or "00000000-0000-0000-0000-000000000000",
        "session_id": a.get("agent.session.id") or "00000000-0000-0000-0000-000000000000",
        "workspace_cwd": a.get("agent.workspace.cwd"),
        "workspace_repo": a.get("agent.workspace.repo"),
        "workspace_branch": a.get("agent.workspace.branch"),
        "workspace_is_ci": bool(a.get("agent.workspace.is_ci", False)),
        "provider": a.get("gen_ai.provider.name") or "unknown",
        "api": a.get("agent.api.dialect") or "unknown",
        "model": a.get("gen_ai.request.model") or "unknown",
        "response_model": a.get("gen_ai.response.model"),
        "harness_name": harness_name,
        "harness_version": a.get("agent.harness.version"),
        "input_tokens": int(a.get("gen_ai.usage.input_tokens") or 0),
        "output_tokens": int(a.get("gen_ai.usage.output_tokens") or 0),
        "cache_read": int(a.get("gen_ai.usage.cache_read.input_tokens") or 0),
        "cache_write": int(a.get("gen_ai.usage.cache_creation.input_tokens") or 0),
        "cost_input_usd": float(a.get("agent.cost.input.usd") or 0),
        "cost_output_usd": float(a.get("agent.cost.output.usd") or 0),
        "cost_cache_read_usd": float(a.get("agent.cost.cache_read.usd") or 0),
        "cost_cache_write_usd": float(a.get("agent.cost.cache_write.usd") or 0),
        "cost_total_usd": float(a.get("agent.cost.total.usd") or 0),
        "cost_estimation": a.get("agent.cost.estimation") or "metered",
        "stop_reason": a.get("agent.stop_reason"),
        "event_kind": a.get("agent.event.kind") or "turn",
        "environment": a.get("deployment.environment") or "prod",
    }


def iter_spans_from_payload(payload: dict[str, Any]) -> Iterable[tuple[dict[str, Any], dict[str, Any]]]:
    """Yield (span, resource_attrs) tuples from an OTLP traces payload."""
    for rs in payload.get("resourceSpans", []):
        resource_attrs = attrs_to_dict(rs.get("resource", {}).get("attributes", []))
        for ss in rs.get("scopeSpans", []):
            for span in ss.get("spans", []):
                yield span, resource_attrs


def tail_jsonl(path: Path) -> Iterable[str]:
    """Tail a JSONL file. Re-opens on rotation."""
    inode: int | None = None
    f = None
    while True:
        if not path.exists():
            time.sleep(0.5)
            continue
        try:
            stat = path.stat()
            if f is None or inode != stat.st_ino:
                if f is not None:
                    f.close()
                f = path.open("r")
                inode = stat.st_ino
                # Start from end on first open; rotations replay from start.
                f.seek(0, os.SEEK_END if inode is None else os.SEEK_SET)
            line = f.readline()
            if not line:
                time.sleep(0.2)
                continue
            yield line
        except FileNotFoundError:
            time.sleep(0.5)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spans", default=os.environ.get("BRIDGE_SPANS", "/var/log/otel/spans.jsonl"))
    ap.add_argument("--dsn", default=os.environ.get("BRIDGE_DSN", ""))
    ap.add_argument("--once", action="store_true", help="Read spans file once and exit; don't tail")
    args = ap.parse_args()

    if not args.dsn:
        print("error: --dsn or BRIDGE_DSN required", file=sys.stderr)
        sys.exit(1)

    path = Path(args.spans)
    print(f"bridge: dsn={args.dsn}", file=sys.stderr)
    print(f"bridge: spans={path}", file=sys.stderr)

    with psycopg.connect(args.dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            inserted = 0
            skipped = 0
            errors = 0

            def process(line: str) -> None:
                nonlocal inserted, skipped, errors
                line = line.strip()
                if not line:
                    return
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError as e:
                    errors += 1
                    print(f"bridge: skip malformed JSON line: {e}", file=sys.stderr)
                    return
                for span, resource_attrs in iter_spans_from_payload(payload):
                    row = span_to_row(span, resource_attrs)
                    if row is None:
                        skipped += 1
                        continue
                    try:
                        cur.execute(INSERT_SQL, row)
                        inserted += 1
                    except Exception as e:  # noqa: BLE001 — log and keep going
                        errors += 1
                        print(f"bridge: insert failed: {e}", file=sys.stderr)

            if args.once:
                if path.exists():
                    with path.open("r") as f:
                        for line in f:
                            process(line)
                print(
                    f"bridge: done. inserted={inserted} skipped={skipped} errors={errors}",
                    file=sys.stderr,
                )
                return

            for line in tail_jsonl(path):
                process(line)


if __name__ == "__main__":
    main()
