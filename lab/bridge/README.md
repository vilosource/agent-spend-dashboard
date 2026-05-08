# Bridge — OTLP/JSONL → Postgres

A small Python script that reads spans from the OTel Collector's `file/spans` exporter output and inserts them into `agent_spend_logs`.

## Why a Python script and not a Collector exporter

The OTel Collector's official `postgresql` exporter does not exist; the experimental `sqlexporter` has unstable shape; rolling our own Collector exporter is not justified for the lab. The Collector does what Collectors do (receive, batch, redact, fan out); the **last hop to Postgres is application code** that lives in this script.

When the API service lands (phase 0.3), it absorbs this responsibility and the bridge goes away.

## Run

```bash
pip install psycopg[binary]
python3 bridge.py \
   --spans /var/log/otel/spans.jsonl \
   --dsn 'postgresql://<user>:<password>@localhost:5432/agent_spend'
```

It tails the JSONL file, parses each span, and inserts a row per assistant turn (skipping spans without `agent.user.id`).

In the lab, this runs as a Compose service (`bridge`) automatically.
