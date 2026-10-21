#!/bin/bash
# Potts WP-2: create the dedicated, non-admin, hidden `potts-worker` macOS user that runs
# arbitrary-code jobs (coding agents, builds, tests) outside the owner's account.
#
#   deploy/isolation/create-worker-user.sh                 # DRY RUN (default): print the plan, change nothing
#   sudo deploy/isolation/create-worker-user.sh --apply    # create it (run from the OWNER's account via sudo)
#   sudo deploy/isolation/create-worker-user.sh --apply --harden-home   # also chmod o-rwx the owner's home
#
# What --apply does:
#   1. group + user `potts-worker`: standard (NOT admin), hidden (IsHidden=1), no password login
#      (Password '*'), shell /usr/bin/false, home /Users/potts-worker mode 0700.
#   2. jobs root /Users/Shared/potts-jobs: owner:potts-worker 0770 + inherited ACLs so both the
#      owner (broker) and the worker can create/read job files. Nothing else is shared.
#   3. wrapper /usr/local/libexec/potts/potts-worker-run (root:wheel 0755) from this repo.
#   4. /etc/sudoers.d/potts-worker (root:wheel 0440, checked with visudo -c) containing ONLY:
#        <owner> ALL=(potts-worker) NOPASSWD: /usr/local/libexec/potts/potts-worker-run
#      (no root rule, no other command, no other user).
#   5. --harden-home: chmod o-rwx /Users/<owner> (drwxr-xr-x+ -> drwxr-x---+) so the worker cannot
#      read world-readable files in the owner's home (project checkouts etc.).
# Rollback: deploy/isolation/remove-worker-user.sh
set -euo pipefail

WORKER="potts-worker"
WORKER_HOME="/Users/$WORKER"
JOBS_ROOT="/Users/Shared/potts-jobs"
WRAPPER_DIR="/usr/local/libexec/potts"
WRAPPER="$WRAPPER_DIR/potts-worker-run"
SUDOERS="/etc/sudoers.d/potts-worker"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC_WRAPPER="$HERE/potts-worker-run"

APPLY=0; HARDEN_HOME=0; OWNER="${SUDO_USER:-$(id -un)}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --harden-home) HARDEN_HOME=1; shift ;;
    --owner) OWNER="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '[create-worker-user] %s\n' "$*"; }
run() {
  if [[ $APPLY -eq 1 ]]; then log "+ $*"; "$@"; else log "(dry-run) $*"; fi
}
die() { log "ERROR: $*"; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "macOS only"
[[ "$OWNER" != "root" && -n "$OWNER" ]] || die "cannot determine the owner account; run via sudo from the owner's account or pass --owner NAME"
id -u "$OWNER" >/dev/null 2>&1 || die "owner account '$OWNER' does not exist"
[[ -f "$SRC_WRAPPER" ]] || die "missing $SRC_WRAPPER"
if [[ $APPLY -eq 1 && $EUID -ne 0 ]]; then die "--apply must run as root: sudo $0 --apply"; fi

free_id() { # $1 = dscl path (/Users|/Groups), $2 = attribute
  local used; used="$(dscl . -list "$1" "$2" | awk '{print $2}')"
  for i in $(seq 610 699); do grep -qx "$i" <<<"$used" || { echo "$i"; return; }; done
  die "no free id in 610-699"
}

log "owner account: $OWNER"
log "mode: $([[ $APPLY -eq 1 ]] && echo APPLY || echo 'DRY RUN (nothing will change)')"

# 1. group + user
if dscl . -read "/Users/$WORKER" >/dev/null 2>&1; then
  log "user $WORKER already exists; verifying it is not an admin"
  if dseditgroup -o checkmember -m "$WORKER" admin >/dev/null 2>&1; then die "$WORKER is in the admin group; refusing (remove it from admin first)"; fi
else
  GID="$(dscl . -read "/Groups/$WORKER" PrimaryGroupID 2>/dev/null | awk '{print $2}' || true)"
  if [[ -z "$GID" ]]; then
    GID="$(free_id /Groups PrimaryGroupID)"
    run dscl . -create "/Groups/$WORKER"
    run dscl . -create "/Groups/$WORKER" PrimaryGroupID "$GID"
    run dscl . -create "/Groups/$WORKER" RealName "Potts Worker"
    run dscl . -create "/Groups/$WORKER" Password '*'
  fi
  UID_NEW="$(free_id /Users UniqueID)"
  run dscl . -create "/Users/$WORKER"
  run dscl . -create "/Users/$WORKER" UniqueID "$UID_NEW"
  run dscl . -create "/Users/$WORKER" PrimaryGroupID "$GID"
  run dscl . -create "/Users/$WORKER" RealName "Potts Worker"
  run dscl . -create "/Users/$WORKER" UserShell /usr/bin/false
  run dscl . -create "/Users/$WORKER" NFSHomeDirectory "$WORKER_HOME"
  run dscl . -create "/Users/$WORKER" Password '*'
  run dscl . -create "/Users/$WORKER" IsHidden 1
fi
run mkdir -p "$WORKER_HOME"
run chown "$WORKER:$WORKER" "$WORKER_HOME"
run chmod 0700 "$WORKER_HOME"

# 2. jobs root shared by owner (broker) and worker only
ACL_PERMS="read,write,append,execute,delete,list,search,add_file,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,file_inherit,directory_inherit"
run mkdir -p "$JOBS_ROOT"
run chown "$OWNER:$WORKER" "$JOBS_ROOT"
run chmod 0770 "$JOBS_ROOT"
run chmod -N "$JOBS_ROOT"
run chmod +a "user:$WORKER allow $ACL_PERMS" "$JOBS_ROOT"
run chmod +a "user:$OWNER allow $ACL_PERMS" "$JOBS_ROOT"

# 3. wrapper (root-owned so neither the owner account nor the worker can modify it)
run mkdir -p "$WRAPPER_DIR"
run chown root:wheel "$WRAPPER_DIR"
run chmod 0755 "$WRAPPER_DIR"
run install -o root -g wheel -m 0755 "$SRC_WRAPPER" "$WRAPPER"

# 4. sudoers drop-in: exactly one rule
RULE="$OWNER ALL=($WORKER) NOPASSWD: $WRAPPER"
log "sudoers rule: $RULE"
if [[ $APPLY -eq 1 ]]; then
  tmp="$(mktemp)"
  printf '# Potts WP-2: owner may run ONLY the worker wrapper as %s (no password). Remove with remove-worker-user.sh\n%s\n' "$WORKER" "$RULE" > "$tmp"
  visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "visudo rejected the rule"; }
  install -o root -g wheel -m 0440 "$tmp" "$SUDOERS"
  rm -f "$tmp"
  grep -Eq '^[#@]includedir[[:space:]]+(/private)?/etc/sudoers\.d' /etc/sudoers || log "WARNING: /etc/sudoers has no includedir for /etc/sudoers.d; the rule will not be active"
  visudo -c >/dev/null || die "sudoers no longer validates; inspect $SUDOERS"
else
  log "(dry-run) write $SUDOERS (0440) with the rule above, validated by visudo -cf"
fi

# 5. owner home permissions
HOME_MODE="$(stat -f '%Sp' "/Users/$OWNER")"
log "owner home /Users/$OWNER is $HOME_MODE"
if [[ "${HOME_MODE:7:1}" == "r" ]]; then
  if [[ $HARDEN_HOME -eq 1 ]]; then
    run chmod o-rwx "/Users/$OWNER"
  else
    log "RECOMMENDED: the owner home is world-readable; re-run with --harden-home (chmod o-rwx /Users/$OWNER)"
  fi
fi
if dseditgroup -o checkmember -m "$WORKER" staff >/dev/null 2>&1; then
  log "NOTE: $WORKER is a member of 'staff'; group-readable (staff) files in the owner's home stay readable to it. Consider chmod 700 /Users/$OWNER."
fi

log "verify afterwards (as the owner, no sudo password should be asked):"
log "  id $WORKER && dseditgroup -o checkmember -m $WORKER admin   # must say NOT a member"
log "  sudo -n -u $WORKER -l $WRAPPER                              # must print the wrapper path"
log "  sudo -n -u $WORKER /bin/ls ~                               # must FAIL (no such rule)"
log "  node --test tests/adversarial/dedicated-user.test.ts       # runs the dedicated-user bypass suite"
