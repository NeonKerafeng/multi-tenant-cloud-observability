#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

docker run -d \
  --name otel-agent \
  --restart unless-stopped \
  --network host \
  --user 0:0 \
  -v "$SCRIPT_DIR/agent.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  -v /:/hostfs:ro \
  otel/opentelemetry-collector-contrib:0.160.0 \
  --config=/etc/otelcol-contrib/config.yaml
