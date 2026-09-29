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

read -rp "Tenant admin username: " USERNAME
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
        data.get("error_description", data.get("error", "Authentication failed")),
        file=sys.stderr,
    )
    sys.exit(1)

print(token)
'
)

unset TOKEN_RESPONSE

echo "Creating enrollment..."

ENROLL_RESPONSE=$(
  curl -sS \
    -X POST \
    "$CONTROL_PLANE_URL/agent-enrollments" \
    -H "Authorization: Bearer $ACCESS_TOKEN"
)

unset ACCESS_TOKEN

ENROLLMENT_TOKEN=$(
  printf '%s' "$ENROLL_RESPONSE" |
    python3 -c '
import json, sys

data = json.load(sys.stdin)

token = data.get("enrollmentToken")

if not token:
    print(data, file=sys.stderr)
    sys.exit(1)

print(token)
'
)

EXPIRES_AT=$(
  printf '%s' "$ENROLL_RESPONSE" |
    python3 -c '
import json, sys
data = json.load(sys.stdin)
print(data["expiresAt"])
'
)

unset ENROLL_RESPONSE

echo
echo "Enrollment created successfully."
echo
echo "Enrollment token:"
echo "$ENROLLMENT_TOKEN"
echo
echo "Expires at:"
echo "$EXPIRES_AT"
echo
echo "Send ONLY this enrollment token to the host owner."

