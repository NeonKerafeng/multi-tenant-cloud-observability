#!/usr/bin/env bash
set -euo pipefail

OTEL_VERSION="0.161.0"

if [ "$EUID" -ne 0 ]; then
  echo "Run as root:"
  echo "  sudo ./install.sh <control-plane-url>"
  exit 1
fi

if [ "$#" -ne 1 ]; then
  echo "Usage:"
  echo "  sudo ./install.sh <control-plane-url>"
  exit 1
fi

CONTROL_PLANE_URL="${1%/}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_SCRIPT="$SCRIPT_DIR/bootstrap.sh"

if [ ! -f "$BOOTSTRAP_SCRIPT" ]; then
  echo "Missing bootstrap script:"
  echo "  $BOOTSTRAP_SCRIPT"
  exit 1
fi

if [ ! -f "$SCRIPT_DIR/otel/agent.yaml" ]; then
  echo "Missing agent config:"
  echo "  $SCRIPT_DIR/otel/agent.yaml"
  exit 1
fi

echo "Installing dependencies..."

apt-get update
apt-get install -y \
  curl \
  ca-certificates \
  python3

ARCH="$(dpkg --print-architecture)"

case "$ARCH" in
  amd64|arm64)
    ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

DEB_FILE="/tmp/otelcol-contrib_${OTEL_VERSION}_linux_${ARCH}.deb"

DOWNLOAD_URL="https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTEL_VERSION}/otelcol-contrib_${OTEL_VERSION}_linux_${ARCH}.deb"

echo "Downloading OpenTelemetry Collector Contrib ${OTEL_VERSION}..."

curl -fL \
  "$DOWNLOAD_URL" \
  -o "$DEB_FILE"

echo "Installing OpenTelemetry Collector..."

apt-get install -y "$DEB_FILE"

rm -f "$DEB_FILE"

echo "Disabling package default service..."

systemctl disable --now otelcol-contrib 2>/dev/null || true

echo "Installed:"
otelcol-contrib --version

echo
echo "Starting machine enrollment..."

"$BOOTSTRAP_SCRIPT" "$CONTROL_PLANE_URL"

echo
echo "Installing MTCO systemd service..."

cat > /etc/systemd/system/mtco-agent.service <<'EOF'
[Unit]
Description=MTCO OpenTelemetry Agent
Wants=network-online.target
After=network-online.target

[Service]
Type=simple

EnvironmentFile=/etc/mtco-agent/agent.env

ExecStart=/usr/bin/otelcol-contrib --config=/etc/mtco-agent/agent.yaml

Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

echo "Starting MTCO Agent..."

systemctl enable --now mtco-agent

if ! systemctl is-active --quiet mtco-agent; then
  echo
  echo "MTCO Agent failed to start."
  echo
  systemctl status mtco-agent --no-pager || true
  exit 1
fi

echo
echo "MTCO Agent installed successfully."
echo
echo "Service:"
echo "  mtco-agent"
echo
echo "Status:"
systemctl is-enabled mtco-agent
systemctl is-active mtco-agent
