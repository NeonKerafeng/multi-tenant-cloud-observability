#!/usr/bin/env bash
set -euo pipefail

NS=observability
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

kubectl -n "$NS" get secret test-otel-agent-credentials >/dev/null 2>&1 || {
  echo "Missing secret: test-otel-agent-credentials"
  echo "Create it with your enrolled Agent credentials first."
  exit 1
}

kubectl -n "$NS" create configmap test-otel-agent-config \
  --from-file=agent.yaml="$BASE/config/agent.yaml" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f "$BASE/manifests/agent.yaml"

kubectl -n "$NS" rollout status deployment/test-otel-agent --timeout=120s
