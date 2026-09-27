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

read -rsp "Enrollment token: " ENROLLMENT_TOKEN
echo

echo "Exchanging enrollment token..."

RESPONSE=$(
  curl -fsS \
    -X POST \
    "$CONTROL_PLANE_URL/agent-enrollments/exchange" \
    -H 'Content-Type: application/json' \
    --data-binary @- <<EOF
{"token":"$ENROLLMENT_TOKEN"}
EOF
)

unset ENROLLMENT_TOKEN

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
trap 'rm -f "$ENV_TMP"' EXIT

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
