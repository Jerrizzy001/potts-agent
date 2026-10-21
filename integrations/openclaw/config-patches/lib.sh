#!/bin/bash
# Shared helpers for the WP-2 OpenClaw config-patch scripts. Sourced, not executed.
# Target selection is always explicit: --profile <name> (an isolated Potts test profile) or --live.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
POTTS_HOME="${POTTS_HOME:-$HOME/Library/Application Support/Potts}"
OPENCLAW_BIN="${OPENCLAW_BIN:-$(command -v openclaw || echo "$HOME/.npm-global/bin/openclaw")}"
TOOLS_PATH="agents.entries.main.tools"

log() { printf '[%s] %s\n' "$(basename "$0" .sh)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# Sets TARGET_DESC, CONFIG, and the OC array (command prefix).
select_target() {
  local profile="$1" live="$2"
  if [[ -n "$profile" && "$live" == 1 ]]; then die "choose either --profile NAME or --live"; fi
  if [[ -n "$profile" ]]; then
    [[ -f "$HOME/.openclaw-$profile/POTTS_TEST_PROFILE" ]] || die "~/.openclaw-$profile is not a Potts test profile"
    CONFIG="$HOME/.openclaw-$profile/openclaw.json"
    OC=("$REPO_ROOT/scripts/profile/oc-test.sh" --name "$profile")
    TARGET_DESC="test profile '$profile'"
  elif [[ "$live" == 1 ]]; then
    CONFIG="$HOME/.openclaw/openclaw.json"
    OC=("$OPENCLAW_BIN")
    TARGET_DESC="LIVE profile (~/.openclaw)"
  else
    die "a target is required: --profile potts-test  or  --live"
  fi
  [[ -f "$CONFIG" ]] || die "config not found: $CONFIG"
}

# Prints the JSON value at a dot path of the target config (null when absent). No secrets live under these paths.
config_subtree() {
  jq -c --arg p "$1" 'getpath($p | split("."))' "$CONFIG"
}

confirm_live() {
  local yes="$1"
  [[ "$TARGET_DESC" == LIVE* ]] || return 0
  [[ "$yes" == 1 ]] && return 0
  if [[ -t 0 ]]; then
    printf 'This changes the LIVE OpenClaw config (%s). Type APPLY to continue: ' "$CONFIG"
    read -r answer
    [[ "$answer" == "APPLY" ]] || die "not confirmed"
  else
    die "refusing to change the live config non-interactively without --yes"
  fi
}
