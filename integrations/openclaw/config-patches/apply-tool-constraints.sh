#!/bin/bash
# Potts WP-2: constrain the Potts agent's effective OpenClaw tool surface.
#
#   apply-tool-constraints.sh --profile potts-test            # DRY RUN (default): show current vs proposed, validate
#   apply-tool-constraints.sh --profile potts-test --apply    # apply to the isolated test profile
#   apply-tool-constraints.sh --live                          # DRY RUN against the live profile (validates only)
#   apply-tool-constraints.sh --live --apply                  # owner only: backup + apply (asks you to type APPLY)
#
# Options: --patch FILE (default: potts-agent-tools.patch.json next to this script), --yes (skip the live prompt)
#
# What changes: ONLY agents.entries.main.tools is replaced (config patch --replace-path), giving the
# Potts agent: the potts-broker tools + read (workspace only) + memory_search/memory_get, and denying
# exec/process/code_execution, web, browser/UI, computer/nodes, messaging, media generation, automation/
# gateway/plugins, sessions_send/sessions_spawn/subagents, file write/edit/apply_patch.
# A backup (full openclaw.json, 0600) and the previous subtree are saved under
#   $POTTS_HOME/openclaw-backups/<UTC stamp>-<target>/  ->  roll back with rollback-tool-constraints.sh --backup <dir>
set -euo pipefail
source "$(dirname "$0")/lib.sh"

PROFILE=""; LIVE=0; APPLY=0; YES=0; PATCH="$(dirname "$0")/potts-agent-tools.patch.json"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --live) LIVE=1; shift ;;
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --patch) PATCH="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
select_target "$PROFILE" "$LIVE"
[[ -f "$PATCH" ]] || die "patch not found: $PATCH"
jq -e '.agents.entries.main.tools | type == "object"' "$PATCH" >/dev/null || die "patch must define agents.entries.main.tools"

log "target: $TARGET_DESC ($CONFIG)"
log "mode: $([[ $APPLY -eq 1 ]] && echo APPLY || echo 'DRY RUN (nothing will change)')"
log "global tools (unchanged by this patch): $(config_subtree tools)"
log "current $TOOLS_PATH: $(config_subtree "$TOOLS_PATH")"
log "proposed $TOOLS_PATH: $(jq -c '.agents.entries.main.tools' "$PATCH")"

log "validating with: openclaw config patch --dry-run"
"${OC[@]}" config patch --file "$PATCH" --replace-path "$TOOLS_PATH" --dry-run --json >/tmp/potts-patch-dry.$$ 2>&1 || { cat /tmp/potts-patch-dry.$$ >&2; rm -f /tmp/potts-patch-dry.$$; die "OpenClaw rejected the patch"; }
jq -c '{ok, changes: (.changes // .changedPaths // null)}' /tmp/potts-patch-dry.$$ 2>/dev/null || cat /tmp/potts-patch-dry.$$
rm -f /tmp/potts-patch-dry.$$

if [[ $APPLY -eq 0 ]]; then
  log "dry run complete. Re-run with --apply to change $TARGET_DESC."
  exit 0
fi
confirm_live "$YES"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
tag="$( [[ -n "$PROFILE" ]] && echo "$PROFILE" || echo live )"
BACKUP="$POTTS_HOME/openclaw-backups/$stamp-$tag"
umask 077
mkdir -p "$BACKUP"
chmod 700 "$POTTS_HOME/openclaw-backups" "$BACKUP"
cp -p "$CONFIG" "$BACKUP/openclaw.json"
chmod 600 "$BACKUP/openclaw.json"
jq -n --arg path "$TOOLS_PATH" --argjson prev "$(config_subtree "$TOOLS_PATH")" --arg config "$CONFIG" --arg target "$TARGET_DESC" --arg sha "$(shasum -a 256 "$CONFIG" | awk '{print $1}')" \
  '{path: $path, previous: $prev, config: $config, target: $target, configSha256Before: $sha}' > "$BACKUP/previous-subtree.json"
log "backup written to $BACKUP"

"${OC[@]}" config patch --file "$PATCH" --replace-path "$TOOLS_PATH"
"${OC[@]}" config validate >/dev/null || log "WARNING: config validate reported problems; inspect with: openclaw config validate"
log "applied. new $TOOLS_PATH: $(config_subtree "$TOOLS_PATH")"
log "verify:   $(dirname "$0")/effective-tools.sh $( [[ -n "$PROFILE" ]] && echo "--profile $PROFILE" || echo --live )"
log "rollback: $(dirname "$0")/rollback-tool-constraints.sh $( [[ -n "$PROFILE" ]] && echo "--profile $PROFILE" || echo --live ) --backup \"$BACKUP\" --apply"
