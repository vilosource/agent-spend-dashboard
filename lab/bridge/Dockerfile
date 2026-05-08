# Bridge: OTLP/JSONL → Postgres for the local lab.
# Replaced by the API service in phase 0.3; do not depend on this image.
FROM python:3.12-slim
RUN pip install --no-cache-dir 'psycopg[binary]>=3.2.0,<4'
COPY bridge.py /app/bridge.py
ENTRYPOINT ["python3", "/app/bridge.py"]
