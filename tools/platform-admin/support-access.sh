#!/usr/bin/env bash
set -euo pipefail

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://localhost:18081}"
REALM="${REALM:-observability}"
CLIENT_ID="${CLIENT_ID:-mtco-cli}"

usage() {
  cat <<'USAGE'
Time-boxed access of a platform admin to ONE tenant's Grafana org.

Usage:
  support-access.sh grant  <tenant> [minutes] [Viewer|Editor]   (asks for a reason)
  support-access.sh list   <tenant> [--active]
  support-access.sh revoke <tenant> <grant-id>
  support-access.sh mine   [--active]                           (all tenants)

Defaults: 60 minutes, Viewer. Max: SUPPORT_ACCESS_MAX_MINUTES (480).
After a grant, reload Grafana and switch to the tenant's org.
USAGE
}

get_token() {
  local username password response token

  read -r -p "Username (platform-admin; tenant-admin may only list): " username
  read -r -s -p "Password: " password
  echo >&2

  response=$(
    curl -sS \
      -X POST \
      "$KEYCLOAK_URL/realms/$REALM/protocol/openid-connect/token" \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data-urlencode grant_type=password \
      --data-urlencode client_id="$CLIENT_ID" \
      --data-urlencode username="$username" \
      --data-urlencode password="$password"
  )

  unset password

  token=$(jq -r '.access_token // empty' <<<"$response")

  if [ -z "$token" ]; then
    echo "$response" | jq >&2
    exit 1
  fi

  printf '%s' "$token"
}

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"

  if [ -n "$body" ]; then
    curl -sS \
      -X "$method" \
      "$CONTROL_PLANE_URL$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      -d "$body" \
      | jq
  else
    curl -sS \
      -X "$method" \
      "$CONTROL_PLANE_URL$path" \
      -H "Authorization: Bearer $TOKEN" \
      | jq
  fi
}

COMMAND="${1:-}"
TENANT="${2:-}"

if [ -z "$COMMAND" ] ||
   { [ "$COMMAND" != "mine" ] && [ -z "$TENANT" ]; }; then
  usage
  exit 1
fi

active_query() {
  if [ "${1:-}" = "--active" ]; then
    printf '?active=true'
  fi
}

TOKEN=$(get_token)

case "$COMMAND" in
  grant)
    MINUTES="${3:-60}"
    ROLE="${4:-Viewer}"

    read -r -p "Reason (ticket id + what you need to check): " REASON

    BODY=$(
      jq -n \
        --arg reason "$REASON" \
        --argjson minutes "$MINUTES" \
        --arg role "$ROLE" \
        '{ reason: $reason, minutes: $minutes, role: $role }'
    )

    api POST "/tenants/$TENANT/support-access" "$BODY"
    ;;

  list)
    api GET "/tenants/$TENANT/support-access$(active_query "${3:-}")"
    ;;

  revoke)
    GRANT_ID="${3:-}"
    [ -n "$GRANT_ID" ] || { usage; exit 1; }

    api DELETE "/tenants/$TENANT/support-access/$GRANT_ID"
    ;;

  mine)
    api GET "/support-access$(active_query "${2:-}")"
    ;;

  *)
    usage
    exit 1
    ;;
esac
