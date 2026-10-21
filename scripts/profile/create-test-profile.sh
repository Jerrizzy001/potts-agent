#!/usr/bin/env bash
# Potts WP-0: create an ISOLATED OpenClaw test profile for plugin/integration tests.
#
# Usage:
#   create-test-profile.sh [--name potts-test] [--port 19789] [--smoke-gateway] [--recreate]
#
# Creates ~/.openclaw-<name>/ (OpenClaw's native `--profile <name>` location) with:
#   * its own config, state dir and workspace (workspace INSIDE the profile dir — the
#     OpenClaw default for named profiles, ~/.openclaw/workspace-<name>, would live under
#     the live state dir, so it is overridden)
#   * gateway: mode=local, bind=loopback, port <port> (live uses 18789), token auth with a
#     fresh random token that is never printed, mDNS discovery off, tailscale off
#   * every channel disabled (Telegram, iMessage), plugin allowlist = [lmstudio] only
#   * model provider: local LM Studio http://127.0.0.1:1234/v1, model qwen/qwen3.5-9b
#     (32K context, 600 s TTL, no preload); NO credentials copied from the live profile
#   * no launchd service is installed (never run `gateway install` for this profile)
#
# Then runs read-only checks against it (config validate, agents list, plugins list), with a
# read-only health check of the LIVE gateway before and after. --smoke-gateway additionally
# starts a short-lived foreground test gateway (max 120 s), probes its health and stops it.
set -euo pipefail
# shellcheck source=../baseline/lib.sh
source "$(cd "$(dirname "$0")/../baseline" && pwd)/lib.sh"
umask 077

NAME="potts-test"; PORT=19789; SMOKE=0; RECREATE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --smoke-gateway) SMOKE=1; shift ;;
    --recreate) RECREATE=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{1,40}$ ]] || die "--name must match ^[a-z0-9][a-z0-9-]+$"
[[ "$NAME" == "default" || "$NAME" == "main" ]] && die "refusing reserved profile name '$NAME'"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be numeric"
(( PORT >= LIVE_GATEWAY_PORT + 120 || PORT + 120 <= LIVE_GATEWAY_PORT )) \
  || die "port $PORT is within 120 of the live gateway port $LIVE_GATEWAY_PORT (derived ports would collide)"

clean_openclaw_env
export OPENCLAW_DISABLE_BONJOUR=1
PROFILE_DIR="$HOME/.openclaw-$NAME"
[[ "$PROFILE_DIR" != "$OPENCLAW_LIVE_DIR" ]] || die "profile dir equals live dir"
ocp() { with_timeout "${OCP_TIMEOUT:-60}" openclaw --profile "$NAME" "$@"; }

live_health() {
  local out
  out="$(with_timeout 20 openclaw health --json --timeout 8000 2>/dev/null | jq -r '.ok' 2>/dev/null || true)"
  echo "${out:-unreachable}"
}

if [[ -e "$PROFILE_DIR" ]]; then
  [[ $RECREATE -eq 1 ]] || die "$PROFILE_DIR exists (use --recreate, or destroy-test-profile.sh)"
  bash "$(dirname "$0")/destroy-test-profile.sh" --name "$NAME" --confirm
fi
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && die "port $PORT is already in use"

live_cfg_hash_before="$(sha256_of "$OPENCLAW_LIVE_DIR/openclaw.json")"
echo "live gateway health (before): $(live_health)"

# ---------------------------------------------------------------- write profile
log "creating $PROFILE_DIR"
ensure_private_dir "$PROFILE_DIR"
ensure_private_dir "$PROFILE_DIR/workspace"
TOKEN="$(openssl rand -hex 32)"
PROFILE_DIR="$PROFILE_DIR" PORT="$PORT" TOKEN="$TOKEN" NAME="$NAME" node --input-type=module -e '
import { writeFileSync } from "node:fs";
const { PROFILE_DIR, PORT, TOKEN, NAME } = process.env;
const model = "qwen/qwen3.5-9b";
const cfg = {
  gateway: {
    mode: "local", bind: "loopback", port: Number(PORT),
    auth: { mode: "token", token: TOKEN },
    tailscale: { mode: "off" },
  },
  discovery: { mdns: { mode: "off" } },
  agents: {
    defaults: {
      model: { primary: `lmstudio/${model}` },
      models: { [`lmstudio/${model}`]: { alias: "qwen-local", params: { temperature: 0.7, extra_body: { ttl: 600 } } } },
      modelPolicy: { allow: [`lmstudio/${model}`] },
      thinkingDefault: "off",
      workspace: `${PROFILE_DIR}/workspace`,
      skills: [],
    },
    entries: { main: { identity: { name: "Potts (test profile)", theme: "Isolated test agent. No channels, no real accounts." } } },
  },
  models: {
    providers: {
      lmstudio: {
        api: "openai-completions",
        apiKey: "lm-studio-local-no-auth",
        baseUrl: "http://127.0.0.1:1234/v1",
        params: { preload: false },
        models: [{
          id: model, name: "Qwen 3.5 9B MLX (test profile)", input: ["text"], reasoning: true,
          contextWindow: 32768, contextTokens: 32768, maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  },
  channels: { telegram: { enabled: false }, imessage: { enabled: false } },
  plugins: {
    allow: ["lmstudio"],
    entries: {
      lmstudio: { enabled: true },
      telegram: { enabled: false }, imessage: { enabled: false }, "voice-call": { enabled: false },
      codex: { enabled: false }, browser: { enabled: false },
    },
    slots: { memory: "none" },
  },
  memory: { search: { enabled: false } },
  tools: { profile: "minimal" },
  session: { dmScope: "per-channel-peer" },
};
writeFileSync(`${PROFILE_DIR}/openclaw.json`, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
writeFileSync(`${PROFILE_DIR}/POTTS_TEST_PROFILE`, `name=${NAME}\nport=${PORT}\ncreatedBy=potts scripts/profile/create-test-profile.sh\n`, { mode: 0o600 });
'
unset TOKEN
cat > "$PROFILE_DIR/workspace/AGENTS.md" <<'EOF'
# Potts test profile
Isolated OpenClaw profile for Potts plugin tests. No channels, no real accounts, no credentials.
EOF

# ---------------------------------------------------------------- read-only checks
log "config validate"
ocp config validate 2>&1 | node "$REDACT" text | sed 's/^/  /'
log "config file path resolution"
resolved="$(ocp config file 2>/dev/null | tail -1 || true)"
echo "  config file: $resolved"
[[ "$resolved" == *".openclaw-$NAME/openclaw.json"* ]] || die "profile did not resolve to $PROFILE_DIR (got: $resolved)"
log "agents list"
ocp agents list --json 2>/dev/null | jq -c '[.[] | {id, model, workspace}]' | sed 's/^/  /'
log "plugins enabled"
ocp plugins list --json 2>/dev/null | jq -c '[.plugins[] | select(.enabled==true) | .id]' | sed 's/^/  /'

# ---------------------------------------------------------------- optional smoke gateway
if [[ $SMOKE -eq 1 ]]; then
  log "smoke: short-lived test gateway + read-only health/status/agents queries against it"
  bash "$(dirname "$0")/run-test-gateway.sh" --name "$NAME" --max-seconds 120 -- \
    bash -c 'set -e
      echo "  test health ok: $(openclaw --profile "$POTTS_TEST_PROFILE" health --json --timeout 5000 2>/dev/null | jq -r .ok)"
      st=$(openclaw --profile "$POTTS_TEST_PROFILE" gateway status --json 2>/dev/null | jq -c "{port: .gateway.port, bind: .gateway.bindMode, rpcOk: .rpc.ok, serviceLoaded: .service.loaded}")
      echo "  test gateway status: $st"
      echo "  test agents: $(openclaw --profile "$POTTS_TEST_PROFILE" agents list --json 2>/dev/null | jq -c "[.[].id]")"'
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && die "test gateway still listening on $PORT after stop"
  echo "  test gateway stopped; nothing listening on $PORT"
fi

# ---------------------------------------------------------------- live untouched?
echo "live gateway health (after): $(live_health)"
[[ "$(sha256_of "$OPENCLAW_LIVE_DIR/openclaw.json")" == "$live_cfg_hash_before" ]] \
  && echo "live openclaw.json unchanged: yes" || echo "WARNING: live openclaw.json changed during this run"
[[ -e "$OPENCLAW_LIVE_DIR/workspace-$NAME" ]] && echo "WARNING: $OPENCLAW_LIVE_DIR/workspace-$NAME exists"
echo "test profile ready: $PROFILE_DIR (port $PORT). Use: openclaw --profile $NAME <command>"
