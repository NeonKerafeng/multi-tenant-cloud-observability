#!/usr/bin/env bash
# Runs the UI E2E suite: mock control-plane + mock Keycloak + headless Chromium.
# Usage: testing/control-plane-ui/run.sh   (ONLY=platformFlow to run one flow)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SITE_SRC="$HERE/../../kubernetes/base/control/control-plane-ui/site"
WORK="$(mktemp -d)"
PORT=9100

cp "$SITE_SRC"/* "$WORK/"
cp "$HERE/config.test.js" "$WORK/config.js"
mkdir -p "$HERE/shots"

node "$HERE/mock-server.js" "$WORK" "$PORT" > "$WORK/server.log" 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null; rm -rf "$WORK"' EXIT
sleep 1

OUT="$HERE" ONLY="${ONLY:-}" node "$HERE/e2e.js"
