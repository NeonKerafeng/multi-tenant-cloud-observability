#!/usr/bin/env bash
set -euo pipefail

TYPE="${1:-logs}"
RATE="${2:-10}"
DURATION="${3:-30s}"
NS=observability

if [[ "$TYPE" != "logs" && "$TYPE" != "metrics" ]]; then
  echo "Usage: $0 {logs|metrics} [rate] [duration]"
  exit 1
fi

if ! [[ "$RATE" =~ ^[0-9]+$ ]] || [[ "$RATE" -eq 0 ]]; then
  echo "Rate must be a positive integer"
  exit 1
fi

NAME="telemetrygen-${TYPE}-$(date +%s)"

kubectl -n "$NS" run "$NAME" \
  --restart=Never \
  --image=ghcr.io/open-telemetry/opentelemetry-collector-contrib/telemetrygen:v0.161.0 \
  -- \
  "$TYPE" \
  --otlp-endpoint=test-otel-agent:4317 \
  --otlp-insecure \
  --rate="$RATE" \
  --duration="$DURATION"

kubectl -n "$NS" label pod "$NAME" app=mtco-telemetrygen --overwrite
echo "Pod: $NAME"
echo "Logs: kubectl -n $NS logs -f pod/$NAME"
