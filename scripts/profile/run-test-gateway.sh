#!/usr/bin/env bash
# Potts WP-0: run a SHORT-LIVED foreground gateway for the isolated test profile, run a
# command against it, then stop it. Never installs a service; never touches the live profile.
#
# Usage:
#   run-test-gateway.sh [--name potts-test] [--max-seconds 300] [-- CMD ARGS...]
#
# While CMD runs, these are exported for it:
#   POTTS_TEST_PROFILE=<name>  POTTS_TEST_GATEWAY_PORT=<port>  POTTS_TEST_PROFILE_DIR=<dir>
# CMD should call OpenClaw only as `openclaw --profile "$POTTS_TEST_PROFILE" …`
# (or scripts/profile/oc-test.sh …). Exit status = CMD's exit status (or 1 if the gateway
# never became healthy). Without CMD it just proves the gateway starts and stops.
set -euo pipefail
# shellcheck source=../baseline/lib.sh
source "$(cd "$(dirname "$0")/../baseline" && pwd)/lib.sh"

NAME="potts-test"; MAX=300
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --max-seconds) MAX="$2"; shift 2 ;;
    --) shift; break ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (put the command after --)" ;;
  esac
done
CMD=("$@")

clean_openclaw_env
export OPENCLAW_DISABLE_BONJOUR=1
PROFILE_DIR="$HOME/.openclaw-$NAME"
[[ -f "$PROFILE_DIR/POTTS_TEST_PROFILE" ]] || die "$PROFILE_DIR is not a Potts test profile (run create-test-profile.sh)"
PORT="$(awk -F= '/^port=/{print $2}' "$PROFILE_DIR/POTTS_TEST_PROFILE")"
[[ -n "$PORT" && "$PORT" != "$LIVE_GATEWAY_PORT" ]] || die "bad test port '$PORT'"
cfg_port="$(jq -r '.gateway.port' "$PROFILE_DIR/openclaw.json")"
cfg_bind="$(jq -r '.gateway.bind' "$PROFILE_DIR/openclaw.json")"
[[ "$cfg_port" == "$PORT" && "$cfg_bind" == "loopback" ]] || die "test profile config must keep port=$PORT bind=loopback"
[[ "$(jq -r '[.channels // {} | .[] | select(.enabled == true)] | length' "$PROFILE_DIR/openclaw.json")" == "0" ]] \
  || die "a channel is enabled in the test profile; refusing (no second Telegram poller, ever)"
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && die "port $PORT already in use"

glog="$PROFILE_DIR/test-gateway.log"
log "starting test gateway '$NAME' on 127.0.0.1:$PORT (max ${MAX}s, log $glog)"
with_timeout "$MAX" openclaw --profile "$NAME" gateway run --port "$PORT" --bind loopback > "$glog" 2>&1 &
gpid=$!

stop_gateway() {
  # The CLI wrapper spawns a separate `openclaw-gateway` process that outlives it, so also stop
  # listeners on the TEST port that hold THIS profile's files open. Nothing else is signalled.
  kill -TERM "$gpid" 2>/dev/null || true
  local pids p
  pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
  for p in $pids; do
    if lsof -p "$p" 2>/dev/null | grep -qF "$PROFILE_DIR/"; then kill -TERM "$p" 2>/dev/null || true
    else log "WARNING: pid $p on port $PORT does not belong to $PROFILE_DIR; not touching it"; fi
  done
  for _ in $(seq 1 15); do lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done
  for p in $pids; do
    if kill -0 "$p" 2>/dev/null && lsof -p "$p" 2>/dev/null | grep -qF "$PROFILE_DIR/"; then kill -KILL "$p" 2>/dev/null || true; fi
  done
  wait "$gpid" 2>/dev/null || true
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then log "WARNING: something still listens on $PORT"
  else log "test gateway stopped"; fi
}
trap stop_gateway EXIT

ok=""
for _ in $(seq 1 60); do
  sleep 1
  kill -0 "$gpid" 2>/dev/null || break
  ok="$(with_timeout 15 openclaw --profile "$NAME" health --json --timeout 4000 2>/dev/null | jq -r '.ok' 2>/dev/null || true)"
  [[ "$ok" == "true" ]] && break
done
if [[ "$ok" != "true" ]]; then
  log "test gateway did not become healthy; last log lines:"
  tail -20 "$glog" | node "$REDACT" text >&2
  exit 1
fi
listeners="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sort -u | tr '\n' ' ')"
log "test gateway healthy; listeners: $listeners"
case "$listeners" in *127.0.0.1:*|*"[::1]:"*) ;; *) die "unexpected listener addresses: $listeners" ;; esac
if echo "$listeners" | grep -q -E '(\*|0\.0\.0\.0):'; then die "test gateway bound beyond loopback"; fi

rc=0
if [[ ${#CMD[@]} -gt 0 ]]; then
  export POTTS_TEST_PROFILE="$NAME" POTTS_TEST_GATEWAY_PORT="$PORT" POTTS_TEST_PROFILE_DIR="$PROFILE_DIR"
  "${CMD[@]}" || rc=$?
fi
exit "$rc"
