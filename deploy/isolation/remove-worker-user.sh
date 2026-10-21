#!/bin/bash
# Potts WP-2: undo create-worker-user.sh.
#
#   deploy/isolation/remove-worker-user.sh                 # DRY RUN (default)
#   sudo deploy/isolation/remove-worker-user.sh --apply    # remove sudoers rule, wrapper, user, group
#   ... --apply --archive-jobs                             # also move /Users/Shared/potts-jobs aside
#
# The worker's home and the jobs root are MOVED to /Users/Shared/potts-removed-<UTC stamp>/ (never
# deleted), so job outputs can be inspected; delete that folder yourself when you no longer need it.
# Owner home permissions changed by --harden-home are not reverted automatically; to revert:
#   chmod o+rx /Users/<owner>
set -euo pipefail

WORKER="potts-worker"
WORKER_HOME="/Users/$WORKER"
JOBS_ROOT="/Users/Shared/potts-jobs"
WRAPPER="/usr/local/libexec/potts/potts-worker-run"
SUDOERS="/etc/sudoers.d/potts-worker"
APPLY=0; ARCHIVE_JOBS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --archive-jobs) ARCHIVE_JOBS=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
log() { printf '[remove-worker-user] %s\n' "$*"; }
run() { if [[ $APPLY -eq 1 ]]; then log "+ $*"; "$@"; else log "(dry-run) $*"; fi; }
[[ $APPLY -eq 0 || $EUID -eq 0 ]] || { log "ERROR: --apply must run as root"; exit 1; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="/Users/Shared/potts-removed-$STAMP"

[[ -e "$SUDOERS" ]] && run rm -f "$SUDOERS"
[[ $APPLY -eq 0 ]] || visudo -c >/dev/null || log "WARNING: visudo -c reports a problem after removal"
[[ -e "$WRAPPER" ]] && run rm -f "$WRAPPER"
[[ -d "$(dirname "$WRAPPER")" ]] && run rmdir "$(dirname "$WRAPPER")" || true
if pgrep -u "$WORKER" >/dev/null 2>&1; then run pkill -TERM -u "$WORKER"; fi
if dscl . -read "/Users/$WORKER" >/dev/null 2>&1; then run dscl . -delete "/Users/$WORKER"; else log "user $WORKER not present"; fi
if dscl . -read "/Groups/$WORKER" >/dev/null 2>&1; then run dscl . -delete "/Groups/$WORKER"; fi
if [[ -d "$WORKER_HOME" ]]; then run mkdir -p "$ARCHIVE"; run mv "$WORKER_HOME" "$ARCHIVE/home"; fi
if [[ $ARCHIVE_JOBS -eq 1 && -d "$JOBS_ROOT" ]]; then run mkdir -p "$ARCHIVE"; run mv "$JOBS_ROOT" "$ARCHIVE/jobs"; fi
log "done ($([[ $APPLY -eq 1 ]] && echo applied || echo 'dry run, nothing changed'))"
