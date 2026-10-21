#!/bin/bash
# Potts WP-2: install / remove the potts-broker OpenClaw plugin (linked from this repo).
#
#   integrations/openclaw/install-plugin.sh --profile potts-test            # DRY RUN: print the plan
#   integrations/openclaw/install-plugin.sh --profile potts-test --apply    # install into the isolated test profile
#   integrations/openclaw/install-plugin.sh --live --apply                  # owner only (asks you to type APPLY)
#   integrations/openclaw/install-plugin.sh --live --apply --owner-channel  # also enable the OwnerChannel socket service
#   ... --daemon-sockets   # also point the read tools and /forget at the Potts daemon (run/read.sock, run/memory-control.sock)
#   integrations/openclaw/install-plugin.sh --live --uninstall --apply      # remove it again (repo files are kept)
#
# --apply: backs up openclaw.json (0600) under $POTTS_HOME/openclaw-backups/, runs
#   openclaw plugins install -l <repo>/integrations/openclaw/potts-broker-plugin --force --accept-capabilities
# and sets plugins.entries.potts-broker.config to secret REFERENCES only:
#   { ownerTelegramIdRef: "keychain:potts/telegram-owner-id", ingressKeyRef: "keychain:potts/ingress-hmac-key", ownerChannel: false }
# The live gateway must be running (the install is applied to it, as in docs/phase0/test-profile.md).
# Install the plugin BEFORE applying the tool constraints, so potts_* tools exist when they are allowed.
set -euo pipefail
source "$(dirname "$0")/config-patches/lib.sh"
PLUGIN_DIR="$REPO_ROOT/integrations/openclaw/potts-broker-plugin"
PROFILE=""; LIVE=0; APPLY=0; YES=0; OWNER_CHANNEL=false; DAEMON_SOCKETS=false; UNINSTALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --live) LIVE=1; shift ;;
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --yes) YES=1; shift ;;
    --owner-channel) OWNER_CHANNEL=true; shift ;;
    --daemon-sockets) DAEMON_SOCKETS=true; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
select_target "$PROFILE" "$LIVE"
# `plugins uninstall` is refused by oc-test.sh; call openclaw directly with a clean env for test profiles.
if [[ -n "$PROFILE" ]]; then RAW_OC=(env -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH OPENCLAW_DISABLE_BONJOUR=1 "$OPENCLAW_BIN" --profile "$PROFILE"); else RAW_OC=("$OPENCLAW_BIN"); fi

log "target: $TARGET_DESC"
if [[ $UNINSTALL -eq 1 ]]; then
  log "plan: openclaw plugins uninstall potts-broker --force --keep-files"
  if [[ $APPLY -eq 0 ]]; then "${RAW_OC[@]}" plugins uninstall potts-broker --dry-run; exit 0; fi
  confirm_live "$YES"
  "${RAW_OC[@]}" plugins uninstall potts-broker --force --keep-files
  log "removed. If the tool constraints are applied, potts_* tools simply disappear; roll those back separately if wanted."
  exit 0
fi

CFG_JSON="$(jq -n --argjson oc "$OWNER_CHANNEL" --argjson ds "$DAEMON_SOCKETS" --arg rs "$POTTS_HOME/run/read.sock" --arg ms "$POTTS_HOME/run/memory-control.sock" \
  '{ownerTelegramIdRef: "keychain:potts/telegram-owner-id", ingressKeyRef: "keychain:potts/ingress-hmac-key", ownerChannel: $oc} + (if $ds then {readSocket: $rs, memoryControlSocket: $ms} else {} end)')"
log "plan: plugins install -l \"$PLUGIN_DIR\" --force --accept-capabilities"
log "plan: plugins.entries.potts-broker.config = $CFG_JSON"
if [[ $APPLY -eq 0 ]]; then log "dry run; nothing changed. Re-run with --apply."; exit 0; fi
confirm_live "$YES"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"; tag="$( [[ -n "$PROFILE" ]] && echo "$PROFILE" || echo live )"
BACKUP="$POTTS_HOME/openclaw-backups/$stamp-$tag-plugin"
umask 077; mkdir -p "$BACKUP"; cp -p "$CONFIG" "$BACKUP/openclaw.json"; chmod 600 "$BACKUP/openclaw.json"
log "backup: $BACKUP/openclaw.json"

"${OC[@]}" plugins install -l "$PLUGIN_DIR" --force --accept-capabilities
patch="$(mktemp)"; trap 'rm -f "$patch"' EXIT
jq -n --argjson cfg "$CFG_JSON" '{plugins: {entries: {"potts-broker": {enabled: true, config: $cfg}}}}' > "$patch"
"${OC[@]}" config patch --file "$patch" --replace-path 'plugins.entries.potts-broker.config'
"${OC[@]}" plugins inspect potts-broker --runtime --json | jq -c '{status: .plugin.status, tools: [.tools[].names[]], commands, diagnostics}' || true
log "next: integrations/openclaw/config-patches/apply-tool-constraints.sh $( [[ -n "$PROFILE" ]] && echo "--profile $PROFILE" || echo --live ) --apply"
