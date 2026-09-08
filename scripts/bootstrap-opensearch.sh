#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env not found at $ENV_FILE"
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

: "${OPENSEARCH_INITIAL_ADMIN_PASSWORD:?Missing OPENSEARCH_INITIAL_ADMIN_PASSWORD in .env}"
: "${OPENSEARCH_INGEST_PASSWORD:?Missing OPENSEARCH_INGEST_PASSWORD in .env}"

OPENSEARCH_URL="${OPENSEARCH_URL:-https://127.0.0.1:9200}"
OPENSEARCH_INGEST_USERNAME="${OPENSEARCH_INGEST_USERNAME:-otel-ingest}"

echo "[1/2] Creating/updating role: otel-ingest-role"

curl -fsSk \
  -u "admin:${OPENSEARCH_INITIAL_ADMIN_PASSWORD}" \
  -H 'Content-Type: application/json' \
  -X PUT \
  "${OPENSEARCH_URL}/_plugins/_security/api/roles/otel-ingest-role" \
  -d '{
    "cluster_permissions": [
      "cluster_composite_ops"
    ],
    "index_permissions": [
      {
        "index_patterns": ["otel-logs*"],
        "allowed_actions": [
          "create_index",
          "write"
        ]
      }
    ],
    "tenant_permissions": []
  }'

echo
echo "[2/2] Creating/updating user: ${OPENSEARCH_INGEST_USERNAME}"

curl -fsSk \
  -u "admin:${OPENSEARCH_INITIAL_ADMIN_PASSWORD}" \
  -H 'Content-Type: application/json' \
  -X PUT \
  "${OPENSEARCH_URL}/_plugins/_security/api/internalusers/${OPENSEARCH_INGEST_USERNAME}" \
  -d "{
    \"password\": \"${OPENSEARCH_INGEST_PASSWORD}\",
    \"opendistro_security_roles\": [
      \"otel-ingest-role\"
    ]
  }"

echo
echo "OpenSearch ingest service account bootstrapped successfully."
