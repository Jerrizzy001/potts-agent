# shellcheck shell=bash
# Shared helpers for Potts WP-0 scripts. Source, do not execute.

POTTS_HOME="${POTTS_HOME:-$HOME/Library/Application Support/Potts}"
OPENCLAW_LIVE_DIR="${OPENCLAW_LIVE_DIR:-$HOME/.openclaw}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LMSTUDIO_DIR="${LMSTUDIO_DIR:-$HOME/.lmstudio}"
LIVE_GATEWAY_PORT="${LIVE_GATEWAY_PORT:-18789}"
POTTS_LAUNCH_LABELS=(ai.openclaw.gateway ai.openclaw.mac local.openclaw.qwen-server)

# LM Studio files that hold model load defaults / server binding (relative to LMSTUDIO_DIR).
LMSTUDIO_CONFIG_FILES=(
  ".internal/user-concrete-model-default-config"
  "apps/bionic/.internal/user-concrete-model-default-config"
  ".internal/http-server-config.json"
  ".internal/llmster-install-location.json"
)

# Paths inside ~/.openclaw never captured by snapshots (transient or reinstallable).
OPENCLAW_SNAPSHOT_EXCLUDES=(
  "*.sock" "*.lock" "*.lifecycle.lock" "*.sqlite-wal" "*.sqlite-shm" ".DS_Store"
  "/locks/" "/cache/" "/logs/" "/tmp/"
)
# Large reinstallable runtime (node + openclaw package); included only with --include-runtime.
OPENCLAW_RUNTIME_EXCLUDES=("/tools/")

SCRIPT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REDACT="$SCRIPT_LIB_DIR/redact.mjs"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# with_timeout SECONDS CMD... (macOS has no coreutils timeout)
with_timeout() {
  local secs="$1"; shift
  perl -e 'alarm shift; exec @ARGV or die "exec failed: $!"' "$secs" "$@"
}

utc_stamp() { date -u +%Y%m%dT%H%M%SZ; }

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }

ensure_private_dir() {
  mkdir -p "$1"
  chmod 700 "$1"
}

# Is the live gateway running? (launchd state OR a listener on the live port)
live_gateway_running() {
  if launchctl print "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null | grep -q 'state = running'; then
    return 0
  fi
  lsof -nP -iTCP:"$LIVE_GATEWAY_PORT" -sTCP:LISTEN >/dev/null 2>&1
}

# Strip OPENCLAW_* env so commands never get pointed somewhere unexpected.
clean_openclaw_env() {
  local v
  for v in $(env | awk -F= '/^OPENCLAW_/{print $1}'); do unset "$v"; done
}
