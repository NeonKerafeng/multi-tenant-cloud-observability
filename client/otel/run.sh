#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

docker rm -f otel-agent 2>/dev/null || true

docker run -d \
  --name otel-agent \
  --restart unless-stopped \
  --network host \
  --user 0:0 \
  --env-file "$SCRIPT_DIR/agent.env" \
  -v "$SCRIPT_DIR/agent.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  -v /:/hostfs:ro \
  -v /proc:/hostfs/proc:ro \
  -v /sys:/hostfs/sys:ro \
  otel/opentelemetry-collector-contrib:0.160.0 \
  --config=/etc/otelcol-contrib/config.yaml
