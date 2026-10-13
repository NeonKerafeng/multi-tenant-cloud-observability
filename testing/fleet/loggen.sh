#!/bin/sh
# DRAFT (TODO-20 parked 2026-10-08). Validated with otelcol-contrib 0.161.0
# (`validate` + local run: file_log parsing OK). Not deployable yet: needs a
# token path whose issuer matches otel-gateway (TODO-04, or a Host-rewriting
# proxy). See WORK_NOTES.md TODO-20.
# Fake application log generator (TESTING ONLY, busybox sh).
# Line format parsed by agent.yaml (file_log regex_parser):
#   2026-10-08T02:55:00Z INFO checkout-api request handled ...
# Each "host" gets its own error rate and occasional incident bursts.

OUT="${LOG_FILE:-/var/log/fleet/app.log}"
MAX_BYTES="${MAX_BYTES:-5000000}"

mkdir -p "$(dirname "$OUT")"
: > "$OUT"

# Per-host personality, derived from the hostname (stable per pod).
SEED=$(hostname | cksum | cut -d' ' -f1)
ERROR_PCT=$(( SEED % 6 + 1 ))      # 1..6 % of lines are ERROR
WARN_PCT=$(( SEED % 9 + 4 ))       # 4..12 % are WARN

SERVICES="checkout-api payment-worker auth-service inventory-db nginx cron"

pick() { # pick <index> <words...>
  i=$1; shift
  n=$#
  i=$(( i % n + 1 ))
  eval "echo \${$i}"
}

info_msg() {
  case $(( RANDOM % 6 )) in
    0) echo "request handled method=GET path=/api/orders status=200 duration_ms=$(( RANDOM % 120 + 5 ))" ;;
    1) echo "request handled method=POST path=/api/checkout status=201 duration_ms=$(( RANDOM % 400 + 20 ))" ;;
    2) echo "cache hit ratio=0.$(( RANDOM % 90 + 10 ))" ;;
    3) echo "job completed name=reconcile items=$(( RANDOM % 500 ))" ;;
    4) echo "user login succeeded user_id=$(( RANDOM % 9000 + 1000 ))" ;;
    *) echo "health check ok" ;;
  esac
}

warn_msg() {
  case $(( RANDOM % 4 )) in
    0) echo "slow request path=/api/search duration_ms=$(( RANDOM % 3000 + 1500 ))" ;;
    1) echo "retrying upstream call attempt=$(( RANDOM % 3 + 1 ))" ;;
    2) echo "disk usage high percent=$(( RANDOM % 15 + 80 ))" ;;
    *) echo "connection pool near capacity in_use=$(( RANDOM % 5 + 45 ))/50" ;;
  esac
}

error_msg() {
  case $(( RANDOM % 4 )) in
    0) echo "upstream timeout service=payment-gateway after_ms=5000" ;;
    1) echo "database error: deadlock detected table=orders" ;;
    2) echo "unhandled exception: NullReferenceException at OrderService.Submit" ;;
    *) echo "failed to publish message queue=events error=connection refused" ;;
  esac
}

while true; do
  # Incident burst: ~1 in 200 ticks, 20 ERROR lines from one service.
  if [ $(( RANDOM % 200 )) -eq 0 ]; then
    svc=$(pick $RANDOM $SERVICES)
    j=0
    while [ $j -lt 20 ]; do
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR $svc $(error_msg)" >> "$OUT"
      j=$(( j + 1 ))
    done
  fi

  lines=$(( RANDOM % 3 + 1 ))
  k=0
  while [ $k -lt $lines ]; do
    roll=$(( RANDOM % 100 ))
    svc=$(pick $RANDOM $SERVICES)
    if [ $roll -lt $ERROR_PCT ]; then
      lvl=ERROR; msg=$(error_msg)
    elif [ $roll -lt $(( ERROR_PCT + WARN_PCT )) ]; then
      lvl=WARN; msg=$(warn_msg)
    else
      lvl=INFO; msg=$(info_msg)
    fi
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $lvl $svc $msg" >> "$OUT"
    k=$(( k + 1 ))
  done

  # Keep the file bounded (file_log follows truncation).
  if [ "$(wc -c < "$OUT")" -gt "$MAX_BYTES" ]; then
    : > "$OUT"
  fi

  sleep 1
done
