#!/usr/bin/env bash
set -euo pipefail

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://localhost:18081}"
REALM="${REALM:-observability}"
CLIENT_ID="${CLIENT_ID:-mtco-cli}"

usage() {
  cat <<'USAGE'
Usage:
  users.sh list <tenant>
  users.sh get <tenant> <user-id>
  users.sh create <tenant>
  users.sh disable <tenant> <user-id>
  users.sh enable <tenant> <user-id>
  users.sh delete <tenant> <user-id>
USAGE
}

get_token() {
  local username password response token

  read -r -p "Platform admin username: " username
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

if [ -z "$COMMAND" ] || [ -z "$TENANT" ]; then
  usage
  exit 1
fi

TOKEN=$(get_token)

case "$COMMAND" in
  list)
    api GET "/tenants/$TENANT/users"
    ;;

  get)
    USER_ID="${3:-}"
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
    read -r -p "Role [tenant-admin/viewer]: " ROLE

    if [ "$ROLE" != "tenant-admin" ] &&
       [ "$ROLE" != "viewer" ]; then
      echo "Role must be tenant-admin or viewer" >&2
      exit 1
    fi

    BODY=$(
      jq -n \
        --arg username "$USERNAME" \
        --arg password "$PASSWORD" \
        --arg firstName "$FIRST_NAME" \
        --arg lastName "$LAST_NAME" \
        --arg email "$EMAIL" \
        --arg role "$ROLE" \
        '{
          username: $username,
          password: $password,
          firstName: $firstName,
          lastName: $lastName,
          email: $email,
          role: $role
        }'
    )

    unset PASSWORD

    api POST "/tenants/$TENANT/users" "$BODY"
    ;;

  disable)
    USER_ID="${3:-}"
    [ -n "$USER_ID" ] || { usage; exit 1; }

    api POST "/tenants/$TENANT/users/$USER_ID/disable"
    ;;

  enable)
    USER_ID="${3:-}"
    [ -n "$USER_ID" ] || { usage; exit 1; }

    api POST "/tenants/$TENANT/users/$USER_ID/enable"
    ;;

  delete)
    USER_ID="${3:-}"
    [ -n "$USER_ID" ] || { usage; exit 1; }

    api DELETE "/tenants/$TENANT/users/$USER_ID"
    ;;

  *)
    usage
    exit 1
    ;;
esac
