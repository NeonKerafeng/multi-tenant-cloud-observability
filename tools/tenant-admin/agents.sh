#!/usr/bin/env bash
set -euo pipefail

KEYCLOAK_BASE_URL="${KEYCLOAK_BASE_URL:-http://localhost:8080}"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://localhost:18081}"

usage() {
  echo "Usage:"
  echo "  $0 list"
  echo "  $0 get <agent-id>"
  echo "  $0 disable <agent-id>"
  echo "  $0 enable <agent-id>"
  echo "  $0 delete <agent-id>"
  exit 1
}

if [ "$#" -lt 1 ]; then
  usage
fi

ACTION="$1"
AGENT_ID="${2:-}"

case "$ACTION" in
  list)
    ;;
  get|disable|enable|delete)
    if [ -z "$AGENT_ID" ]; then
      usage
    fi
    ;;
  *)
    usage
    ;;
esac

for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "$cmd is required"
    exit 1
  fi
done

read -rp "Tenant/platform admin username: " USERNAME
read -rsp "Password: " PASSWORD
echo

echo "Authenticating..."

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
    jq -r '.access_token // empty'
)

if [ -z "$ACCESS_TOKEN" ]; then
  echo "Authentication failed:"
  printf '%s\n' "$TOKEN_RESPONSE" | jq
  exit 1
fi

unset TOKEN_RESPONSE

case "$ACTION" in
  list)
    curl -sS \
      "$CONTROL_PLANE_URL/agents" \
      -H "Authorization: Bearer $ACCESS_TOKEN" |
      jq
    ;;

  get)
    curl -sS \
      "$CONTROL_PLANE_URL/agents/$AGENT_ID" \
      -H "Authorization: Bearer $ACCESS_TOKEN" |
      jq
    ;;

  disable)
    curl -sS \
      -X POST \
      "$CONTROL_PLANE_URL/agents/$AGENT_ID/disable" \
      -H "Authorization: Bearer $ACCESS_TOKEN" |
      jq
    ;;

  enable)
    curl -sS \
      -X POST \
      "$CONTROL_PLANE_URL/agents/$AGENT_ID/enable" \
      -H "Authorization: Bearer $ACCESS_TOKEN" |
      jq
    ;;

  delete)
    read -rp "Delete agent $AGENT_ID? [y/N]: " CONFIRM

    if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
      echo "Cancelled."
      exit 0
    fi

    curl -sS \
      -X DELETE \
      "$CONTROL_PLANE_URL/agents/$AGENT_ID" \
      -H "Authorization: Bearer $ACCESS_TOKEN" |
      jq
    ;;
esac

unset ACCESS_TOKEN

