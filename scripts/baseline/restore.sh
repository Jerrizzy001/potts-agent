#!/usr/bin/env bash
# Potts WP-0: restore a snapshot made by snapshot.sh.
#
# Usage:
#   restore.sh SNAPSHOT.tar.gz [--target DIR] [--confirm] [--stop-services]
#              [--components openclaw,launchagents,lmstudio]
#
#   (no --confirm)    dry run: verify the snapshot and print the plan; changes nothing.
#   --target DIR      rehearsal: treat DIR as $HOME (restores into DIR/.openclaw,
#                     DIR/Library/LaunchAgents, DIR/.lmstudio). Never touches services.
#   --confirm         actually write.
#   --stop-services   LIVE restore only: if the gateway is running, stop the three Potts/OpenClaw
#                     launch agents with `launchctl bootout`, restore, then bootstrap them again.
#                     Without it a live restore refuses while the gateway is running.
#
# Safety:
#   * The tarball's sha256 and every file's manifest hash are checked before anything is written.
#   * The current state is snapshotted (label pre-restore) before it is overwritten.
#   * ~/.openclaw is mirrored with --delete EXCEPT the excluded transient paths
#     (sockets, locks, cache, logs, tmp, and tools/ when the snapshot has no runtime).
#   * Stale SQLite -wal/-shm files next to restored databases are removed so an old WAL
#     can never be replayed onto the restored database.
#   * Restoring brings back the credentials in the snapshot (e.g. a bot token you have since
#     revoked). Rotate/revoke again after restoring if that applies.
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
umask 077

SNAP=""; TARGET=""; CONFIRM=0; STOP_SERVICES=0; COMPONENTS="openclaw,launchagents,lmstudio"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --confirm) CONFIRM=1; shift ;;
    --stop-services) STOP_SERVICES=1; shift ;;
    --components) COMPONENTS="$2"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) [[ -z "$SNAP" ]] || die "only one snapshot path allowed"; SNAP="$1"; shift ;;
  esac
done
[[ -n "$SNAP" && -f "$SNAP" ]] || die "snapshot tarball required (see --help)"
has_component() { [[ ",$COMPONENTS," == *",$1,"* ]]; }

LIVE=0
if [[ -z "$TARGET" ]]; then
  LIVE=1; DEST_HOME="$HOME"
else
  mkdir -p "$TARGET"
  DEST_HOME="$(cd "$TARGET" && pwd -P)"
  if [[ "$DEST_HOME" == "$(cd "$HOME" && pwd -P)" ]]; then LIVE=1; fi
fi
DEST_OC="$DEST_HOME/.openclaw"; DEST_LA="$DEST_HOME/Library/LaunchAgents"; DEST_LMS="$DEST_HOME/.lmstudio"

# ---------------------------------------------------------------- verify snapshot
sumfile="$SNAP.sha256"
[[ -f "$sumfile" ]] || die "missing $sumfile"
expected="$(awk '{print $1}' "$sumfile")"
actual="$(sha256_of "$SNAP")"
[[ "$expected" == "$actual" ]] || die "sha256 mismatch for $SNAP"
log "tarball sha256 ok"

ensure_private_dir "$POTTS_HOME"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/potts-restore.XXXXXX")"
chmod 700 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT
tar -C "$STAGE" -xpzf "$SNAP"
node "$SCRIPT_LIB_DIR/manifest.mjs" verify "$STAGE" "$STAGE/MANIFEST.json" >/dev/null \
  || die "snapshot content does not match its manifest"
log "manifest ok ($(jq '.files|length' "$STAGE/MANIFEST.json") files)"
include_runtime="$(jq -r '.meta.includeRuntime // "0"' "$STAGE/MANIFEST.json")"

# ---------------------------------------------------------------- plan
echo "Restore plan"
echo "  snapshot:   $SNAP ($(jq -r '.meta.createdAtUtc' "$STAGE/MANIFEST.json"), $(jq -r '.meta.openclawVersion' "$STAGE/MANIFEST.json"))"
echo "  mode:       $([[ $LIVE -eq 1 ]] && echo 'LIVE' || echo "rehearsal into $DEST_HOME")"
echo "  components: $COMPONENTS"
has_component openclaw && echo "  - mirror openclaw/ -> $DEST_OC (protecting: ${OPENCLAW_SNAPSHOT_EXCLUDES[*]}$([[ $include_runtime == 1 ]] || echo " ${OPENCLAW_RUNTIME_EXCLUDES[*]}"))"
has_component launchagents && echo "  - copy $(ls "$STAGE/launchagents" | tr '\n' ' ')-> $DEST_LA"
has_component lmstudio && echo "  - copy LM Studio model config -> $DEST_LMS"
if [[ $CONFIRM -ne 1 ]]; then
  echo "DRY RUN: nothing changed. Re-run with --confirm to restore."
  exit 0
fi

# ---------------------------------------------------------------- services
STOPPED=()
if [[ $LIVE -eq 1 ]]; then
  if live_gateway_running; then
    [[ $STOP_SERVICES -eq 1 ]] || die "live gateway is running; refusing. Re-run with --stop-services (owner only) or stop it first."
    for label in ai.openclaw.mac ai.openclaw.gateway local.openclaw.qwen-server; do
      if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
        log "launchctl bootout gui/$(id -u)/$label"
        launchctl bootout "gui/$(id -u)/$label" || die "failed to stop $label"
        STOPPED+=("$label")
      fi
    done
    sleep 2
    live_gateway_running && die "gateway still running after bootout; aborting before any write"
  fi
fi
restart_services() {
  local label
  for label in local.openclaw.qwen-server ai.openclaw.gateway ai.openclaw.mac; do
    if [[ " ${STOPPED[*]:-} " == *" $label "* ]]; then
      log "launchctl bootstrap gui/$(id -u) $DEST_LA/$label.plist"
      launchctl bootstrap "gui/$(id -u)" "$DEST_LA/$label.plist" || log "WARNING: failed to restart $label — start it manually"
    fi
  done
}
[[ ${#STOPPED[@]} -gt 0 ]] && trap 'restart_services; rm -rf "$STAGE"' EXIT

# ---------------------------------------------------------------- pre-restore backup
if [[ -d "$DEST_OC" ]]; then
  if [[ $LIVE -eq 1 ]]; then backup_dir="$POTTS_HOME/snapshots"; else backup_dir="$DEST_HOME/.potts-pre-restore"; fi
  log "backing up current state to $backup_dir"
  bash "$SCRIPT_LIB_DIR/snapshot.sh" --source-home "$DEST_HOME" --out-dir "$backup_dir" --label pre-restore \
    $([[ $include_runtime == 1 ]] && echo --include-runtime) >/dev/null \
    || die "pre-restore backup failed; nothing was changed"
fi

# ---------------------------------------------------------------- apply
if has_component openclaw; then
  log "restoring $DEST_OC"
  mkdir -p "$DEST_OC"; chmod 700 "$DEST_OC"
  args=(-a --delete)
  for e in "${OPENCLAW_SNAPSHOT_EXCLUDES[@]}"; do args+=(--exclude "$e"); done
  [[ $include_runtime == 1 ]] || for e in "${OPENCLAW_RUNTIME_EXCLUDES[@]}"; do args+=(--exclude "$e"); done
  rsync "${args[@]}" "$STAGE/openclaw/" "$DEST_OC/"
  # Remove stale WAL/SHM beside every restored database.
  jq -r '.files[] | select(.path | startswith("openclaw/")) | .path' "$STAGE/MANIFEST.json" | while IFS= read -r p; do
    f="$DEST_OC/${p#openclaw/}"
    if head -c 16 "$f" 2>/dev/null | grep -q "SQLite format 3"; then rm -f "$f-wal" "$f-shm"; fi
  done
fi
if has_component launchagents; then
  log "restoring launch agents"
  mkdir -p "$DEST_LA"
  for f in "$STAGE"/launchagents/*.plist; do [[ -f "$f" ]] && cp -p "$f" "$DEST_LA/"; done
fi
if has_component lmstudio; then
  log "restoring LM Studio model config"
  mkdir -p "$DEST_LMS"
  rsync -a "$STAGE/lmstudio/" "$DEST_LMS/"
fi

# ---------------------------------------------------------------- verify result
prefixes=()
has_component openclaw && prefixes+=(--prefix "openclaw/:.openclaw/")
has_component launchagents && prefixes+=(--prefix "launchagents/:Library/LaunchAgents/")
has_component lmstudio && prefixes+=(--prefix "lmstudio/:.lmstudio/")
# Verify only the selected components.
jq --arg c "$COMPONENTS" '.files |= map(select((.path|split("/")[0]) as $top | ($c|split(",")) | index($top)))' \
  "$STAGE/MANIFEST.json" > "$STAGE/MANIFEST.selected.json"
node "$SCRIPT_LIB_DIR/manifest.mjs" verify "$DEST_HOME" "$STAGE/MANIFEST.selected.json" "${prefixes[@]}"

echo "restore complete into $DEST_HOME"
[[ $LIVE -eq 1 ]] && echo "NOTE: credentials in the snapshot are now active again; re-revoke any rotated since $(jq -r '.meta.createdAtUtc' "$STAGE/MANIFEST.json")."
exit 0
