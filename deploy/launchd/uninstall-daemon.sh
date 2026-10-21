#!/usr/bin/env bash
# Unload and remove the Potts daemon LaunchAgent (label local.potts.daemon).
# Dry run by default. --apply unloads it and MOVES the plist into the Potts
# backups directory (never deletes). Never touches any other label, never sudo.
set -euo pipefail

readonly LABEL="local.potts.daemon"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHCTL="${LAUNCHCTL:-launchctl}"
POTTS_HOME_VAL="${POTTS_HOME:-$HOME/Library/Application Support/Potts}"
APPLY=0

usage() {
  cat <<EOF
Usage: deploy/launchd/uninstall-daemon.sh [--apply] [--home <dir>]

Without --apply this is a DRY RUN that only prints what would happen.
  --apply        launchctl bootout gui/\$UID/$LABEL, then move
                 $LAUNCH_AGENTS_DIR/$LABEL.plist to
                 \$POTTS_HOME/backups/launchd/removed-<timestamp>.plist
  --home <dir>   Potts home (default: \$POTTS_HOME or ~/Library/Application Support/Potts)
  -h, --help     Show this help.

Potts data (database, logs, backups) is never deleted. Other launch agents are not touched.
Environment overrides (for tests): LAUNCH_AGENTS_DIR, LAUNCHCTL.
EOF
}

die() { echo "ERROR: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --home) [[ $# -ge 2 ]] || die "--home needs a value"; POTTS_HOME_VAL="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[[ "$(id -u)" -ne 0 ]] || die "do not run as root"
[[ "$POTTS_HOME_VAL" == /* ]] || die "POTTS_HOME must be an absolute path: $POTTS_HOME_VAL"
POTTS_HOME_VAL="${POTTS_HOME_VAL%/}"

DOMAIN="gui/$(id -u)"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
BACKUP_DIR="$POTTS_HOME_VAL/backups/launchd"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/removed-$TS.plist"

if [[ "$APPLY" -ne 1 ]]; then
  echo "Mode: DRY RUN (pass --apply to uninstall)"
  echo "Would: $LAUNCHCTL bootout $DOMAIN/$LABEL"
  if [[ -f "$PLIST" ]]; then
    echo "Would: move $PLIST -> $DEST"
  else
    echo "(no plist at $PLIST)"
  fi
  echo "Potts data in $POTTS_HOME_VAL is kept."
  exit 0
fi

echo "Mode: APPLY"
echo "==> $LAUNCHCTL bootout $DOMAIN/$LABEL"
if "$LAUNCHCTL" bootout "$DOMAIN/$LABEL"; then echo "unloaded"; else echo "(was not loaded)"; fi

if [[ -f "$PLIST" ]]; then
  echo "==> move plist to backups"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$POTTS_HOME_VAL" "$POTTS_HOME_VAL/backups" "$BACKUP_DIR"
  mv "$PLIST" "$DEST"
  echo "moved: $PLIST -> $DEST"
else
  echo "(no plist at $PLIST; nothing to move)"
fi
echo "Uninstalled $LABEL. Potts data in $POTTS_HOME_VAL is kept."
