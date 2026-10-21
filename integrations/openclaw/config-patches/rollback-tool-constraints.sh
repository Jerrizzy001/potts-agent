#!/bin/bash
# Potts WP-2: undo apply-tool-constraints.sh by restoring the saved agents.entries.main.tools subtree.
#
#   rollback-tool-constraints.sh --profile potts-test --backup <dir>           # DRY RUN
#   rollback-tool-constraints.sh --profile potts-test --backup <dir> --apply
#   rollback-tool-constraints.sh --live --backup <dir> --apply                 # owner only (asks you to type APPLY)
#
# Only the one subtree is restored (other config changes made since are kept). If the subtree did not
# exist before, it is deleted. The full pre-change openclaw.json is also in <dir>/openclaw.json (0600) for
# a manual whole-file restore if ever needed (stop the gateway first; see docs/phase0/README.md).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

PROFILE=""; LIVE=0; APPLY=0; YES=0; BACKUP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --live) LIVE=1; shift ;;
    --backup) BACKUP="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
select_target "$PROFILE" "$LIVE"
[[ -n "$BACKUP" && -f "$BACKUP/previous-subtree.json" ]] || die "--backup <dir> containing previous-subtree.json is required"
[[ "$(jq -r .config "$BACKUP/previous-subtree.json")" == "$CONFIG" ]] || die "that backup belongs to $(jq -r .config "$BACKUP/previous-subtree.json"), not $CONFIG"

prev="$(jq -c .previous "$BACKUP/previous-subtree.json")"
patch="$(mktemp)"
trap 'rm -f "$patch"' EXIT
jq -n --argjson prev "$prev" '{agents: {entries: {main: {tools: $prev}}}}' > "$patch"
log "target: $TARGET_DESC"
log "current $TOOLS_PATH: $(config_subtree "$TOOLS_PATH")"
log "restore to: $prev"
args=(config patch --file "$patch")
[[ "$prev" == "null" ]] || args+=(--replace-path "$TOOLS_PATH")
"${OC[@]}" "${args[@]}" --dry-run --json >/dev/null || die "OpenClaw rejected the rollback patch"
if [[ $APPLY -eq 0 ]]; then log "dry run OK. Re-run with --apply."; exit 0; fi
confirm_live "$YES"
"${OC[@]}" "${args[@]}"
log "restored. $TOOLS_PATH is now: $(config_subtree "$TOOLS_PATH")"
