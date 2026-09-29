#!/usr/bin/env bash
set -euo pipefail

KEYCLOAK_BASE_URL="${KEYCLOAK_BASE_URL:-http://localhost:8080}"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://localhost:18081}"

for cmd in curl python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "$cmd is required"
    exit 1
  fi
done

usage() {
  echo "Usage:"
  echo "  $0 list"
  echo "  $0 get <tenant-id>"
  echo "  $0 create <tenant-id>"
  echo "  $0 delete <tenant-id>"
  exit 1
}

ACTION="${1:-}"

case "$ACTION" in
  list)
    ;;
  get|create|delete)
    TENANT_ID="${2:-}"
    if [[ -z "$TENANT_ID" ]]; then
      usage
    fi
    ;;
  *)
    usage
    ;;
esac

read -rp "Platform admin username: " USERNAME
read -rsp "Password: " PASSWORD
echo

echo "Authenticating with Keycloak..."

TOKEN_RESPONSE=$(
  curl -sS \
    -X POST \
    "$KEYCLOAK_BASE_URL/realms/observability/protocol/openid-connect/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=password' \
    --data-urlencode 'client_id=mtco-cli' \
    --data-urlencode "username=$USERNAME" \
    --data-urlencode "password=$PASSWORD"
)

unset PASSWORD

ACCESS_TOKEN=$(
  printf '%s' "$TOKEN_RESPONSE" |
    python3 -c '
import json, sys

data = json.load(sys.stdin)
token = data.get("access_token")

if not token:
    print(
        data.get(
            "error_description",
            data.get("error", "Authentication failed")
        ),
        file=sys.stderr,
    )
    sys.exit(1)

print(token)
'
)

unset TOKEN_RESPONSE

case "$ACTION" in
  list)
    RESPONSE=$(
      curl -sS \
        -w '\n%{http_code}' \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        "$CONTROL_PLANE_URL/tenants"
    )
    ;;

  get)
    RESPONSE=$(
      curl -sS \
        -w '\n%{http_code}' \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        "$CONTROL_PLANE_URL/tenants/$TENANT_ID"
    )
    ;;

  create)
    RESPONSE=$(
      curl -sS \
        -w '\n%{http_code}' \
        -X POST \
        "$CONTROL_PLANE_URL/tenants" \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        -H 'Content-Type: application/json' \
        -d "{\"tenantId\":\"$TENANT_ID\"}"
    )
    ;;

  delete)
    RESPONSE=$(
      curl -sS \
        -w '\n%{http_code}' \
        -X DELETE \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        "$CONTROL_PLANE_URL/tenants/$TENANT_ID"
    )
    ;;
esac

unset ACCESS_TOKEN

BODY=$(printf '%s' "$RESPONSE" | sed '$d')
STATUS=$(printf '%s' "$RESPONSE" | tail -n1)

echo
echo "HTTP $STATUS"

printf '%s\n' "$BODY" |
  python3 -m json.tool 2>/dev/null ||
  printf '%s\n' "$BODY"

if [[ "$STATUS" -lt 200 || "$STATUS" -ge 300 ]]; then
  exit 1
fi

