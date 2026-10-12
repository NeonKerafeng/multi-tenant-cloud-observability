#!/usr/bin/env bash
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Run as root:"
  echo "  sudo ./bootstrap.sh <control-plane-url>"
  exit 1
fi

if [ "$#" -ne 1 ]; then
  echo "Usage:"
  echo "  sudo ./bootstrap.sh <control-plane-url>"
  exit 1
fi

CONTROL_PLANE_URL="${1%/}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_CONFIG_SOURCE="$SCRIPT_DIR/otel/agent.yaml"

if [ ! -f "$AGENT_CONFIG_SOURCE" ]; then
  echo "Missing agent config:"
  echo "  $AGENT_CONFIG_SOURCE"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required"
  exit 1
fi

RESPONSE_FILE=""
ENV_TMP=""
trap 'rm -f -- ${RESPONSE_FILE:+"$RESPONSE_FILE"} ${ENV_TMP:+"$ENV_TMP"}' EXIT

read -rsp "Enrollment token: " ENROLLMENT_TOKEN
echo

echo "Exchanging enrollment token..."

RESPONSE_FILE=$(mktemp)

STATUS=$(
  curl -sS \
    -o "$RESPONSE_FILE" \
    -w '%{http_code}' \
    -X POST \
    "$CONTROL_PLANE_URL/api/v1/agent-enrollments/exchange" \
    -H 'Content-Type: application/json' \
    --data-binary @- <<EOF
{"token":"$ENROLLMENT_TOKEN"}
EOF
) || {
  echo "Cannot reach control-plane at $CONTROL_PLANE_URL"
  exit 1
}

unset ENROLLMENT_TOKEN

if [ "$STATUS" != "201" ] && [ "$STATUS" != "200" ]; then
  echo "Enrollment failed (HTTP $STATUS):"
  python3 - "$RESPONSE_FILE" <<'PYERR'
import json, sys

raw = open(sys.argv[1]).read()

try:
    error = json.loads(raw)["error"]
    print("  " + error["code"] + ": " + error["message"])
except Exception:
    print("  " + raw[:300])
PYERR

  if [ "$STATUS" -ge 500 ] || [ "$STATUS" = "429" ]; then
    echo "Temporary problem: run this script again with the SAME token"
    echo "(it stays valid until it expires)."
  fi

  exit 1
fi

RESPONSE=$(cat "$RESPONSE_FILE")
rm -f "$RESPONSE_FILE"
RESPONSE_FILE=""

AGENT_ID=$(
  printf '%s' "$RESPONSE" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["agentId"])'
)

CLIENT_ID=$(
  printf '%s' "$RESPONSE" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["clientId"])'
)

CLIENT_SECRET=$(
  printf '%s' "$RESPONSE" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["clientSecret"])'
)

TOKEN_URL=$(
  printf '%s' "$RESPONSE" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["tokenUrl"])'
)

GATEWAY_ENDPOINT=$(
  printf '%s' "$RESPONSE" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["gatewayEndpoint"])'
)

unset RESPONSE

echo "Installing configuration..."

install -d -m 700 /etc/mtco-agent

install -m 644 \
  "$AGENT_CONFIG_SOURCE" \
  /etc/mtco-agent/agent.yaml

ENV_TMP=$(mktemp)

cat > "$ENV_TMP" <<EOF
OTEL_AGENT_CLIENT_ID=$CLIENT_ID
OTEL_AGENT_CLIENT_SECRET=$CLIENT_SECRET
KEYCLOAK_TOKEN_URL=$TOKEN_URL
OTEL_GATEWAY_ENDPOINT=$GATEWAY_ENDPOINT
EOF

install -m 600 "$ENV_TMP" /etc/mtco-agent/agent.env

unset CLIENT_SECRET

echo
echo "Enrollment successful."
echo "Agent ID: $AGENT_ID"
echo
echo "Installed:"
echo "  /etc/mtco-agent/agent.yaml"
echo "  /etc/mtco-agent/agent.env"
