#!/usr/bin/env bash
set -euo pipefail

NS=observability
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

kubectl -n "$NS" delete pod \
  -l app=mtco-telemetrygen \
  --ignore-not-found=true

kubectl delete -f "$BASE/manifests/agent.yaml" --ignore-not-found
kubectl -n "$NS" delete configmap test-otel-agent-config --ignore-not-found

echo "Testing workloads removed."
echo "Agent credentials Secret preserved."
