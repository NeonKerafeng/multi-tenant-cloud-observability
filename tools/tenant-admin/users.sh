#!/usr/bin/env bash
set -euo pipefail

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://localhost:18081}"
REALM="${REALM:-observability}"
CLIENT_ID="${CLIENT_ID:-mtco-cli}"

usage() {
  cat <<'USAGE'
Usage:
  users.sh list
  users.sh get <user-id>
  users.sh create
  users.sh disable <user-id>
  users.sh enable <user-id>
  users.sh delete <user-id>
USAGE
}

get_token() {
  local username password response token

  read -r -p "Tenant admin username: " username
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

get_tenant_from_token() {
  python3 - "$TOKEN" <<'PY'
import base64
import json
import sys

token = sys.argv[1]

payload = token.split('.')[1]
payload += '=' * (-len(payload) % 4)

data = json.loads(
    base64.urlsafe_b64decode(payload)
)

groups = [
    g.lstrip('/')
    for g in data.get('groups', [])
    if g
]

if len(groups) != 1:
    raise SystemExit(
        'Token must contain exactly one tenant group'
    )

print(groups[0])
PY
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

if [ -z "$COMMAND" ]; then
  usage
  exit 1
fi

TOKEN=$(get_token)
TENANT=$(get_tenant_from_token)

echo "Tenant: $TENANT" >&2

case "$COMMAND" in
  list)
    api GET "/tenants/$TENANT/users"
    ;;

  get)
    USER_ID="${2:-}"
    [ -n "$USER_ID" ] || { usage; exit 1; }

    api GET "/tenants/$TENANT/users/$USER_ID"
    ;;

  create)
    read -r -p "New username: " USERNAME
    read -r -s -p "New password: " PASSWORD
    echo
    read -r -p "First name: " FIRST_NAME
    read -r -p "Last name: " LAST_NAME
    read -r -p "Email: " EMAIL

    BODY=$(
      jq -n \
        --arg username "$USERNAME" \
        --arg password "$PASSWORD" \
        --arg firstName "$FIRST_NAME" \
        --arg lastName "$LAST_NAME" \
        --arg email "$EMAIL" \
        '{
          username: $username,
          password: $password,
          firstName: $firstName,
          lastName: $lastName,
          email: $email,
          role: "viewer"
        }'
    )

    unset PASSWORD

    api POST "/tenants/$TENANT/users" "$BODY"
    ;;

  disable)
    USER_ID="${2:-}"
    [ -n "$USER_ID" ] || { usage; exit 1; }

    api POST "/tenants/$TENANT/users/$USER_ID/disable"
    ;;

  enable)
    USER_ID="${2:-}"
    [ -n "$USER_ID" ] || { usage; exit 1; }

    api POST "/tenants/$TENANT/users/$USER_ID/enable"
    ;;

  delete)
    USER_ID="${2:-}"
    [ -n "$USER_ID" ] || { usage; exit 1; }

    api DELETE "/tenants/$TENANT/users/$USER_ID"
    ;;

  *)
    usage
    exit 1
    ;;
esac
