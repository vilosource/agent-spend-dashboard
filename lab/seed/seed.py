#!/usr/bin/env python3
"""
Synthetic OTLP emitter for the local lab.

Generates ~7 days of fake assistant turns across ~10 fake users and ~3 fake
teams using model variants representative of what our developers actually run.
Emits via OTLP/HTTP to the lab Collector, which routes to Postgres via the
bridge (and to Prometheus when configured).

Per docs/strategy/local-lab-STRATEGY.md §6.1.
"""

from __future__ import annotations

import argparse
import os
import random
import sys
import time
import uuid
from dataclasses import dataclass

try:
    import requests  # type: ignore[import-not-found]
except ImportError:
    print("error: requests not installed. Run: pip install requests", file=sys.stderr)
    sys.exit(1)


@dataclass(frozen=True)
class ModelSpec:
    """Per-model cost shape for synthetic data."""
    name: str
    provider: str           # OTel canonical name (gen_ai.provider.name)
    api: str                # pi-mono dialect (agent.api.dialect)
    estimation: str         # 'metered' | 'subscription'
    cost_in_per_1m: float   # USD per million input tokens; 0 for subscription
    cost_out_per_1m: float


MODELS: list[ModelSpec] = [
    # z.ai GLM via Anthropic-compat — metered
    ModelSpec("glm-4.6",      "anthropic",     "anthropic-messages", "metered",      0.30, 1.50),
    ModelSpec("glm-4.5-air",  "anthropic",     "anthropic-messages", "metered",      0.20, 1.10),
    ModelSpec("glm-5",        "anthropic",     "anthropic-messages", "metered",      0.50, 2.00),
    # GitHub Copilot — subscription (cost stays zero)
    ModelSpec("claude-opus-4-7",  "github.copilot", "anthropic-messages", "subscription", 0.0, 0.0),
    ModelSpec("claude-sonnet-4",  "github.copilot", "anthropic-messages", "subscription", 0.0, 0.0),
    # Direct Anthropic — metered (rare in our setup but nice for dashboard variety)
    ModelSpec("claude-opus-4-5",  "anthropic", "anthropic-messages", "metered", 5.0, 25.0),
    # OpenAI — metered
    ModelSpec("gpt-5",        "openai",        "openai-responses",   "metered",      2.50, 10.0),
    # Google — metered
    ModelSpec("gemini-2.5-pro", "gcp.gen_ai",  "google-generative-ai", "metered",    1.25, 5.0),
]

REPOS = [
    "github.com/example-org/customer-portal",
    "github.com/example-org/billing-service",
    "github.com/example-org/inventory-api",
    "github.com/example-org/dashboard-ui",
    "github.com/example-org/data-pipeline",
]

BRANCHES = ["main", "develop", "feat/login-redesign", "fix/cart-rounding", "experiment/ml-suggest"]


def make_span(
    *,
    user_id: str,
    team: str,
    machine_id: str,
    session_id: str,
    workspace_repo: str,
    workspace_branch: str,
    model: ModelSpec,
    timestamp_ns: int,
    input_tokens: int,
    output_tokens: int,
) -> dict:
    cost_in = (input_tokens / 1_000_000) * model.cost_in_per_1m
    cost_out = (output_tokens / 1_000_000) * model.cost_out_per_1m
    cost_total = cost_in + cost_out

    duration_ns = int(random.uniform(2.0, 8.0) * 1_000_000_000)

    def attr(key: str, value, vtype: str = "stringValue") -> dict:
        return {"key": key, "value": {vtype: value}}

    attributes = [
        # gen_ai.* standard
        attr("gen_ai.operation.name", "chat"),
        attr("gen_ai.provider.name", model.provider),
        attr("gen_ai.request.model", model.name),
        attr("gen_ai.response.model", model.name),
        attr("gen_ai.usage.input_tokens", input_tokens, "intValue"),
        attr("gen_ai.usage.output_tokens", output_tokens, "intValue"),
        attr("gen_ai.usage.cache_read.input_tokens", 0, "intValue"),
        attr("gen_ai.usage.cache_creation.input_tokens", 0, "intValue"),
        attr("gen_ai.conversation.id", session_id),
        # agent.* extension
        attr("agent.user.id", user_id),
        attr("agent.user.team", team),
        attr("agent.machine.id", machine_id),
        attr("agent.session.id", session_id),
        attr("agent.workspace.cwd", f"/workspaces/{workspace_repo.split('/')[-1]}"),
        attr("agent.workspace.repo", workspace_repo),
        attr("agent.workspace.branch", workspace_branch),
        attr("agent.workspace.is_ci", False, "boolValue"),
        attr("agent.api.dialect", model.api),
        attr("agent.cost.input.usd", cost_in, "doubleValue"),
        attr("agent.cost.output.usd", cost_out, "doubleValue"),
        attr("agent.cost.cache_read.usd", 0.0, "doubleValue"),
        attr("agent.cost.cache_write.usd", 0.0, "doubleValue"),
        attr("agent.cost.total.usd", cost_total, "doubleValue"),
        attr("agent.cost.estimation", model.estimation),
        attr("agent.stop_reason", "stop"),
        attr("agent.event.kind", "turn"),
        attr("agent.harness.name", "pi"),
        attr("agent.harness.version", "0.74.0"),
    ]

    return {
        "traceId": uuid.uuid4().hex,            # 32 hex chars
        "spanId": uuid.uuid4().hex[:16],         # 16 hex chars
        "name": f"chat {model.name}",
        "kind": 3,  # SPAN_KIND_CLIENT
        "startTimeUnixNano": str(timestamp_ns),
        "endTimeUnixNano": str(timestamp_ns + duration_ns),
        "attributes": attributes,
        "status": {"code": 1},
    }


def emit_batch(endpoint: str, spans: list[dict], environment: str = "lab") -> None:
    payload = {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        {"key": "service.name", "value": {"stringValue": "pi-usage-reporter"}},
                        {"key": "service.version", "value": {"stringValue": "0.0.0"}},
                        {"key": "deployment.environment", "value": {"stringValue": environment}},
                    ]
                },
                "scopeSpans": [
                    {
                        "scope": {"name": "pi-usage-reporter-seed"},
                        "spans": spans,
                    }
                ],
            }
        ]
    }
    r = requests.post(f"{endpoint}/v1/traces", json=payload, timeout=10)
    r.raise_for_status()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default=os.environ.get("OTEL_ENDPOINT", "http://localhost:4318"))
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--users", type=int, default=10)
    ap.add_argument("--teams", type=int, default=3)
    ap.add_argument("--turns-per-user-per-day", type=int, default=40)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    random.seed(args.seed)

    teams = [f"seed-team-{chr(ord('a') + i)}" for i in range(args.teams)]
    users = [
        (f"seed-user-{i+1}@example.invalid", random.choice(teams), str(uuid.uuid4()))
        for i in range(args.users)
    ]

    now = int(time.time() * 1_000_000_000)
    day_ns = 86_400 * 1_000_000_000

    total_spans = 0
    batch: list[dict] = []
    BATCH_SIZE = 64

    for day in range(args.days):
        day_start_ns = now - (args.days - day) * day_ns
        for user_id, team, machine_id in users:
            session_id = str(uuid.uuid4())
            for turn in range(args.turns_per_user_per_day):
                model = random.choice(MODELS)
                # Distribute throughout the day with some clustering.
                # For the most-recent day, weight half the turns into the LAST 3 HOURS
                # so the burn-rate dashboard's default 24h window shows a real cost
                # rate signal instead of being mostly empty.
                if day == args.days - 1 and turn < args.turns_per_user_per_day // 2:
                    # Recent slice: last 3 hours
                    ts_ns = now - random.randint(0, 3 * 3600 * 1_000_000_000)
                else:
                    ts_ns = day_start_ns + random.randint(0, day_ns - 1)
                # Realistic-ish token counts
                input_tokens = int(random.lognormvariate(7.0, 0.6))    # ~1100 mean
                output_tokens = int(random.lognormvariate(5.5, 0.7))   # ~250 mean

                span = make_span(
                    user_id=user_id,
                    team=team,
                    machine_id=machine_id,
                    session_id=session_id,
                    workspace_repo=random.choice(REPOS),
                    workspace_branch=random.choice(BRANCHES),
                    model=model,
                    timestamp_ns=ts_ns,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                )
                batch.append(span)
                total_spans += 1
                if len(batch) >= BATCH_SIZE:
                    emit_batch(args.endpoint, batch)
                    batch = []
                # Occasional new session so we have multiple sessions per user per day
                if random.random() < 0.05:
                    session_id = str(uuid.uuid4())

    if batch:
        emit_batch(args.endpoint, batch)

    print(
        f"seed: emitted {total_spans} spans across {args.users} users, {args.teams} teams, "
        f"{args.days} days to {args.endpoint}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
