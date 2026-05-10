# Scenario test container — drives a real `pi` turn against a real LLM
# (z.ai by default), with `pi-usage-reporter` loaded as a pi extension
# pointing at the lab API's /v1/traces endpoint.
#
# This is a regression-fixture image, NOT a production artifact. It
# exists so the scenarios under lab/scenario/scenarios/*.sh can prove
# end-to-end that real OTLP spans land as real rows in agent_spend_logs.
# Each scenario invocation is a fresh container.
#
# What's baked in:
#   - pi-coding-agent (the harness) — pinned version
#   - the reporter's OpenTelemetry runtime deps (the dist itself is
#     bind-mounted at run time so iterating on the reporter doesn't
#     require an image rebuild)
#
# What's NOT baked in (provided at run time by scripts/scenario):
#   - the reporter's dist/      → /opt/reporter/dist  (bind mount)
#   - the LLM provider key      → ZAI_API_KEY env var
#   - the agent-spend bearer    → PI_USAGE_TOKEN env var
#   - the OTLP endpoint URL     → PI_USAGE_ENDPOINT env var

FROM node:20-slim

# pi-coding-agent — host has @mariozechner/0.66.1, the reporter declares
# its peer at @earendil-works/* >= 0.74.0 but D10 in pi-extensions
# decisions log records that hook event shapes are unchanged across the
# scope migration. Pinning the version we know works on the host so
# the scenario reproduces the user's actual setup.
ARG PI_VERSION=0.66.1
RUN npm install --omit=dev --silent --no-fund --no-audit \
    -g @mariozechner/pi-coding-agent@${PI_VERSION}

# Reporter's runtime deps. Installed globally so the reporter's dist
# (bind-mounted at /opt/reporter/dist) can resolve them via NODE_PATH.
# These versions match packages/pi-usage-reporter/package.json. When
# you bump the reporter, bump these.
RUN npm install --omit=dev --silent --no-fund --no-audit -g \
    @opentelemetry/api@^1.9.0 \
    @opentelemetry/sdk-node@^0.217.0 \
    @opentelemetry/exporter-trace-otlp-http@^0.217.0 \
    @opentelemetry/exporter-metrics-otlp-http@^0.217.0 \
    @opentelemetry/sdk-metrics@^2.7.0 \
    @opentelemetry/resources@^2.7.0 \
    @opentelemetry/semantic-conventions@^1.40.0

# Make the global node_modules visible to non-global resolution paths so
# the reporter's `import "@opentelemetry/api"` resolves at runtime.
ENV NODE_PATH=/usr/local/lib/node_modules

# pi reads ~/.pi/agent/settings.json for extension discovery. The
# entrypoint writes this at container start so the path stays
# parameterizable without rebuilding the image.
COPY entrypoint.sh /usr/local/bin/scenario-entrypoint
RUN chmod +x /usr/local/bin/scenario-entrypoint

WORKDIR /workdir

ENTRYPOINT ["/usr/local/bin/scenario-entrypoint"]
