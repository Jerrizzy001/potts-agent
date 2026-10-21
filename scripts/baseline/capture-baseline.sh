#!/usr/bin/env bash
# Potts WP-0: capture a REDACTED, read-only baseline of the working OpenClaw setup.
#
# Usage:
#   capture-baseline.sh [--out DIR] [--verify PREV_DIR] [--quiet]
#
#   --out DIR         write the capture to DIR (default: $POTTS_HOME/baselines/<UTC stamp>)
#   --verify PREV     after capturing, diff the stable part against PREV; exit 10 if changed
#
# Read-only: it only reads files and runs read-only OpenClaw CLI queries
# (health, gateway status, plugins list/inspect, agents list, cron list/status,
# exec-policy show, sandbox explain, approvals get). It never edits ~/.openclaw,
# LaunchAgents or LM Studio state, and never prints secret values: every
# secret-ish value is replaced by <redacted:sha256:PREFIX> before it is written.
#
# Output layout:
#   stable/    content expected to stay identical while the setup is unchanged (diffed by --verify)
#   volatile/  runtime status (pids, timings, cron run state) — informational only
#   SUMMARY.txt short human summary (no secrets)
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
umask 077

OUT=""
VERIFY=""
QUIET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --verify) VERIFY="$2"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

clean_openclaw_env
command -v jq >/dev/null || die "jq is required (/usr/bin/jq on macOS)"
command -v openclaw >/dev/null || die "openclaw CLI not on PATH"
[[ -d "$OPENCLAW_LIVE_DIR" ]] || die "no OpenClaw state dir at $OPENCLAW_LIVE_DIR"
if [[ -n "$VERIFY" && ! -d "$VERIFY/stable" ]]; then die "--verify: $VERIFY/stable not found"; fi

STAMP="$(utc_stamp)"
if [[ -z "$OUT" ]]; then
  ensure_private_dir "$POTTS_HOME"
  ensure_private_dir "$POTTS_HOME/baselines"
  OUT="$POTTS_HOME/baselines/$STAMP"
fi
[[ -e "$OUT" ]] && die "output dir already exists: $OUT"
ensure_private_dir "$OUT"
S="$OUT/stable"; V="$OUT/volatile"
mkdir -p "$S/launch-agents" "$S/service-env" "$S/lmstudio" "$S/schedules" "$V"

CFG="$OPENCLAW_LIVE_DIR/openclaw.json"
redact_json() { node "$REDACT" json "${1:--}"; }
oc() { with_timeout 45 openclaw "$@" 2>/dev/null; }

config_mtime_before="$(stat -f %m "$CFG" 2>/dev/null || echo none)"

# ---------------------------------------------------------------- versions
log "versions"
{
  echo "openclaw_cli: $(oc --version | head -1)"
  echo "openclaw_cli_path: $(command -v openclaw)"
  echo "node_path_default: $(command -v node) $(node -v)"
  echo "npm: $(npm -v 2>/dev/null)"
  gw_node="$(plutil -extract ProgramArguments.3 raw "$LAUNCH_AGENTS_DIR/ai.openclaw.gateway.plist" 2>/dev/null || true)"
  if [[ -n "$gw_node" && -x "$gw_node" ]]; then echo "gateway_node: $gw_node $("$gw_node" -v)"; fi
  if [[ -f "$LMSTUDIO_DIR/.internal/llmster-install-location.json" ]]; then
    echo "llmster: $(jq -r .path "$LMSTUDIO_DIR/.internal/llmster-install-location.json")"
  fi
  echo "macos: $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
  echo "arch: $(uname -m)"
} > "$S/versions.txt"

# ---------------------------------------------------------------- config
log "openclaw.json (redacted)"
redact_json "$CFG" > "$S/openclaw.json"

log "gateway status"
oc gateway status --json | redact_json > "$V/gateway-status.json" || echo '{}' > "$V/gateway-status.json"
jq '{packageVersion: .service.layout.packageVersion, entrypoint: .service.layout.entrypoint,
     programArguments: .service.command.programArguments, label: .service.label,
     loaded: .service.loaded}' "$V/gateway-status.json" > "$S/gateway-service.json" 2>/dev/null || true

log "gateway bind/port + listeners"
{
  jq '{bind: .gateway.bind, port: .gateway.port, mode: .gateway.mode, authMode: .gateway.auth.mode,
       tailscale: .gateway.tailscale.mode, nodesDeny: .gateway.nodes.commands.deny}' "$S/openclaw.json"
} > "$S/gateway.json"
port="$(jq -r '.port // 18789' "$S/gateway.json")"
lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $1, $9}' | sort -u > "$S/gateway-listeners.txt" || true
lsof -nP -iTCP:1234 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $1, $9}' | sort -u > "$S/lmstudio-listeners.txt" || true

log "health"
oc health --json --timeout 10000 | jq '{ok, durationMs, defaultAgentId, heartbeatSeconds,
   channels: (.channels // {} | with_entries(.value |= ({configured, running, connected, ok} | with_entries(select(.value != null))))),
   plugins: ((.plugins // {}) | if type=="object" then (keys) else . end)}' 2>/dev/null \
  | redact_json > "$V/health.json" || echo '{"ok":false,"error":"health query failed"}' > "$V/health.json"

# ---------------------------------------------------------------- plugins / agents
log "plugins"
oc plugins list --json | jq '[.plugins[] | {id, version, origin, enabled, status, format,
   toolNames, commands, services, channelIds}] | sort_by(.id)' | redact_json > "$S/plugins.json" \
  || echo '[]' > "$S/plugins.json"
oc plugins registry --json | jq '{state, refreshReasons, differences}' > "$S/plugin-registry.json" 2>/dev/null || true
for p in $(jq -r '.[] | select(.enabled==true) | .id' "$S/plugins.json"); do
  oc plugins inspect "$p" --json | jq --arg p "$p" '{id: $p, diagnostics, compatibility,
     install: (.install // null | if . then {source, spec, resolvedVersion, integrity} else null end)}' 2>/dev/null
done | jq -s 'sort_by(.id)' | redact_json > "$S/plugins-enabled-detail.json" || true

log "agents"
oc agents list --json | redact_json > "$S/agents.json" || echo '[]' > "$S/agents.json"

# ---------------------------------------------------------------- tool permissions
log "tool permissions"
jq '{tools, agentsDefaults: (.agents.defaults | {skills, model, modelPolicy, workspace}),
     agentEntries: (.agents.entries // {} | map_values({tools, sandbox, skills})),
     commands, channelsAllow: (.channels // {} | map_values({enabled, dmPolicy, groupPolicy}))}' \
  "$S/openclaw.json" > "$S/tool-permissions-config.json"
oc exec-policy show --json | redact_json > "$S/exec-policy.json" || true
oc sandbox explain --agent main --json | redact_json > "$S/sandbox-explain-main.json" || true
oc approvals get --json | redact_json > "$S/approvals.json" || true

# ---------------------------------------------------------------- launch agents
log "launch agents"
for label in "${POTTS_LAUNCH_LABELS[@]}"; do
  f="$LAUNCH_AGENTS_DIR/$label.plist"
  [[ -f "$f" ]] || { echo "missing" > "$S/launch-agents/$label.missing"; continue; }
  plutil -convert json -o - "$f" | redact_json > "$S/launch-agents/$label.json"
  st="$(launchctl print "gui/$(id -u)/$label" 2>/dev/null | awk -F' = ' '/^\tstate =|^\tpid =|^\tlast exit code =/{gsub(/^\t/,"",$1); print $1"="$2}' | tr '\n' ' ')"
  echo "$label: ${st:-not loaded}" >> "$V/launchd-state.txt"
done
if [[ -d "$OPENCLAW_LIVE_DIR/service-env" ]]; then
  for f in "$OPENCLAW_LIVE_DIR"/service-env/*; do
    [[ -f "$f" ]] || continue
    node "$REDACT" env "$f" > "$S/service-env/$(basename "$f")"
  done
fi

# ---------------------------------------------------------------- LM Studio / llmster
log "LM Studio model load settings"
for rel in "${LMSTUDIO_CONFIG_FILES[@]}"; do
  src="$LMSTUDIO_DIR/$rel"
  [[ -e "$src" ]] || continue
  while IFS= read -r f; do
    r="${f#"$LMSTUDIO_DIR"/}"
    dst="$S/lmstudio/$(echo "$r" | tr '/' '__')"
    redact_json "$f" > "$dst"
  done < <(find "$src" -type f -name '*.json')
done
# Effective standalone load settings for the Potts model, flattened for humans.
q="$LMSTUDIO_DIR/.internal/user-concrete-model-default-config/qwen/qwen3.5-9b.json"
if [[ -f "$q" ]]; then
  jq '[(.load.fields // [])[], (.operation.fields // [])[]] | map({(.key): .value}) | add' "$q" > "$S/lmstudio-qwen3.5-9b-effective.json"
fi

# ---------------------------------------------------------------- schedules
log "schedules / automations"
oc cron list --json | jq '[.jobs[] | {id, name, declarationKey, agentId, enabled, schedule,
   sessionTarget, wakeMode, payloadKind: .payload.kind, deliveryMode: (.delivery.mode // null),
   scheduledToolPolicy, configRevision}] | sort_by(.id)' | redact_json > "$S/schedules/openclaw-cron.json" \
  || echo '"cron query failed"' > "$S/schedules/openclaw-cron.json"
oc cron list --json | jq '[.jobs[] | {id, name, state}]' | redact_json > "$V/openclaw-cron-state.json" || true
oc cron status --json | jq '{enabled, triggersEnabled, storage, jobs}' > "$S/schedules/openclaw-cron-status.json" 2>/dev/null || true
(crontab -l 2>/dev/null || echo "# no user crontab") | node "$REDACT" text > "$S/schedules/user-crontab.txt"
{
  for d in "$LAUNCH_AGENTS_DIR" /Library/LaunchAgents /Library/LaunchDaemons; do
    [[ -d "$d" ]] || continue
    grep -l -i -E 'potts|openclaw|qwen|lmstudio|llmster' "$d"/*.plist 2>/dev/null || true
  done
} | sort > "$S/schedules/launchd-plists-matching.txt"
launchctl list 2>/dev/null | awk 'NR>1 && tolower($3) ~ /potts|openclaw|qwen|lmstudio|llmster/ {print $3}' | sed -E 's/(\.[0-9]+)+$/.<n>/' | sort -u \
  > "$S/schedules/launchd-loaded-labels.txt"

# ---------------------------------------------------------------- raw file fingerprints
log "fingerprints"
{
  for f in "$CFG" "$LAUNCH_AGENTS_DIR"/{ai.openclaw.gateway,ai.openclaw.mac,local.openclaw.qwen-server}.plist \
           "$OPENCLAW_LIVE_DIR"/service-env/* ; do
    [[ -f "$f" ]] && printf '%s  %s\n' "$(sha256_of "$f")" "${f/#$HOME/~}"
  done
  for rel in "${LMSTUDIO_CONFIG_FILES[@]}"; do
    [[ -e "$LMSTUDIO_DIR/$rel" ]] || continue
    find "$LMSTUDIO_DIR/$rel" -type f | sort | while IFS= read -r f; do
      printf '%s  %s\n' "$(sha256_of "$f")" "${f/#$HOME/~}"
    done
  done
} > "$S/file-sha256.txt"

config_mtime_after="$(stat -f %m "$CFG" 2>/dev/null || echo none)"
cat > "$OUT/meta.json" <<EOF
{"capturedAtUtc":"$STAMP","host":"$(hostname -s)","user":"$(id -un)","script":"potts scripts/baseline/capture-baseline.sh","configMtimeBefore":"$config_mtime_before","configMtimeAfter":"$config_mtime_after"}
EOF

# ---------------------------------------------------------------- summary
{
  echo "Potts baseline $STAMP"
  sed 's/^/  /' "$S/versions.txt"
  echo "  gateway: $(jq -c . "$S/gateway.json")"
  echo "  gateway listeners: $(tr '\n' ';' < "$S/gateway-listeners.txt")"
  echo "  health ok: $(jq -r '.ok' "$V/health.json")"
  echo "  plugins enabled: $(jq -r '[.[] | select(.enabled==true) | .id] | join(",")' "$S/plugins.json")"
  echo "  agents: $(jq -r '[.[] | .id] | join(",")' "$S/agents.json" 2>/dev/null)"
  echo "  tools profile: $(jq -c '.tools' "$S/tool-permissions-config.json")"
  echo "  qwen load settings: $(jq -c . "$S/lmstudio-qwen3.5-9b-effective.json" 2>/dev/null)"
  echo "  openclaw cron jobs: $(jq -r 'if type=="array" then (map(.name) | join(", ")) else . end' "$S/schedules/openclaw-cron.json")"
  echo "  launchd labels: $(tr '\n' ' ' < "$S/schedules/launchd-loaded-labels.txt")"
  echo "  config untouched during capture: $([[ "$config_mtime_before" == "$config_mtime_after" ]] && echo yes || echo NO)"
} > "$OUT/SUMMARY.txt"
chmod -R go-rwx "$OUT"
[[ $QUIET -eq 1 ]] || cat "$OUT/SUMMARY.txt"
echo "baseline written: $OUT"

# ---------------------------------------------------------------- verify
if [[ -n "$VERIFY" ]]; then
  echo
  echo "== verify against $VERIFY"
  if diff -ru "$VERIFY/stable" "$S" > "$OUT/verify.diff"; then
    echo "VERIFY: no changes in stable baseline"
    exit 0
  else
    echo "VERIFY: CHANGED (redacted diff below, also in $OUT/verify.diff)"
    cat "$OUT/verify.diff"
    exit 10
  fi
fi
