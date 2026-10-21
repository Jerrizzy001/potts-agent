#!/bin/bash
# Potts WP-2: protected configuration ownership plan, check and (optional) fix.
#
#   deploy/isolation/protect-policy.sh                    # DRY RUN: report what is wrong and what --apply would change
#   deploy/isolation/protect-policy.sh --apply            # fix modes (owner files only; no sudo needed)
#   deploy/isolation/protect-policy.sh --lock-policy      # also set the user-immutable flag on policy.json (chflags uchg)
#   deploy/isolation/protect-policy.sh --unlock-policy    # clear it before you edit the policy yourself
#   deploy/isolation/protect-policy.sh --verify-worker    # prove potts-worker cannot read the protected files (needs the worker user)
#   deploy/isolation/protect-policy.sh --check-keychain   # confirm the Keychain items exist (never prints their values)
#
# Ownership plan (who may read/write what):
#   $POTTS_HOME (default ~/Library/Application Support/Potts)   owner, 0700   broker/daemon only
#     policy.json        owner, 0600 (optionally uchg)  edited by the owner by hand; the broker refuses it if group/world-writable
#     potts.db(-wal/-shm) owner, 0600                    broker is the only writer (approvals, actions, audit ledger)
#     audit-head.json    owner, 0600                    last exported audit head {seq,hash} (WP-8 writes it, see docs/architecture/core.md)
#     run/               owner, 0700  broker.sock, ingress.sock, owner-channel.sock (0600 each)
#     logs/, snapshots/  owner, 0700
#   Login Keychain (owner)   potts/ingress-hmac-key     HMAC key shared by the broker (ingress verifier) and the gateway plugin
#                            potts/telegram-owner-id    owner Telegram user id (identifier, not a secret)
#   ~/.openclaw              owner, 0700  (gateway config holds the plugin config, never the key itself)
#   potts-worker (other macOS user)                     NO access to any of the above: different uid, owner home o-rwx,
#                                                       Keychain is per-user, Seatbelt denies /Users/* except the job workspace.
#   The OpenClaw model runs inside the gateway as the owner uid: it is kept away from these files by the
#   effective tool constraint (no exec/fs-write/web/browser; read only inside the agent workspace), not by uid.
set -euo pipefail

POTTS_HOME="${POTTS_HOME:-$HOME/Library/Application Support/Potts}"
APPLY=0; LOCK=0; UNLOCK=0; VERIFY_WORKER=0; CHECK_KC=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --lock-policy) LOCK=1; shift ;;
    --unlock-policy) UNLOCK=1; shift ;;
    --verify-worker) VERIFY_WORKER=1; shift ;;
    --check-keychain) CHECK_KC=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ $EUID -ne 0 ]] || { echo "run as the owner, not root" >&2; exit 1; }

PROBLEMS=0
log() { printf '[protect-policy] %s\n' "$*"; }
fix() { # description, command...
  local what="$1"; shift
  PROBLEMS=$((PROBLEMS + 1))
  if [[ $APPLY -eq 1 ]]; then log "FIX  $what: $*"; "$@"; else log "WOULD FIX  $what: $*"; fi
}
mode_of() { stat -f '%Lp' "$1"; }
owner_of() { stat -f '%Su' "$1"; }

check_path() { # path, wanted-mode, kind(dir|file|sock)
  local p="$1" want="$2" kind="$3"
  [[ -e "$p" || -S "$p" ]] || { log "absent  $p"; return; }
  if [[ -L "$p" ]]; then log "PROBLEM $p is a symlink (refusing to follow)"; PROBLEMS=$((PROBLEMS + 1)); return; fi
  local o; o="$(owner_of "$p")"
  if [[ "$o" != "$(id -un)" ]]; then log "PROBLEM $p is owned by $o, expected $(id -un) (fix manually)"; PROBLEMS=$((PROBLEMS + 1)); fi
  local m; m="$(mode_of "$p")"
  if [[ "$m" != "$want" ]]; then fix "$p mode $m -> $want ($kind)" chmod "$want" "$p"; else log "ok      $p ($m)"; fi
  if ls -led "$p" 2>/dev/null | grep -qE '^\s*[0-9]+: (group:everyone|user:potts-worker|group:potts-worker) allow'; then
    log "PROBLEM $p has an ACL granting everyone/potts-worker access"; PROBLEMS=$((PROBLEMS + 1))
  fi
}

log "POTTS_HOME=$POTTS_HOME  mode=$([[ $APPLY -eq 1 ]] && echo APPLY || echo 'DRY RUN')"
check_path "$POTTS_HOME" 700 dir
for d in run logs snapshots baselines backups openclaw-backups; do check_path "$POTTS_HOME/$d" 700 dir; done
for f in policy.json potts.db potts.db-wal potts.db-shm audit-head.json config.json potts.json accounts.json; do check_path "$POTTS_HOME/$f" 600 file; done
for s in broker.sock ingress.sock owner-channel.sock; do check_path "$POTTS_HOME/run/$s" 600 sock; done
check_path "$HOME/.openclaw" 700 dir
check_path "$HOME/.ssh" 700 dir
check_path "$HOME/Library" 700 dir   # macOS default; covers Keychains, Messages, Mail, browser profiles

home_mode="$(mode_of "$HOME")"
if (( (8#$home_mode & 8#007) != 0 )); then
  log "PROBLEM owner home $HOME is mode $home_mode (world-accessible). Recommended: chmod o-rwx \"$HOME\"  (create-worker-user.sh --harden-home does this)"
  PROBLEMS=$((PROBLEMS + 1))
fi

POL="$POTTS_HOME/policy.json"
if [[ -f "$POL" ]]; then
  flags="$(ls -lO "$POL" | awk '{print $5}')"
  if [[ $LOCK -eq 1 && "$flags" != *uchg* ]]; then fix "lock policy" chflags uchg "$POL"; fi
  if [[ $UNLOCK -eq 1 && "$flags" == *uchg* ]]; then
    if [[ $APPLY -eq 1 ]]; then log "unlocking $POL for editing"; chflags nouchg "$POL"; else log "WOULD unlock $POL (chflags nouchg)"; fi
  fi
  log "policy flags: ${flags}"
fi

if [[ $CHECK_KC -eq 1 ]]; then
  for acct in ingress-hmac-key telegram-owner-id; do
    if /usr/bin/security find-generic-password -s potts -a "$acct" >/dev/null 2>&1; then log "ok      keychain item potts/$acct exists"
    else log "MISSING keychain item potts/$acct  -> security add-generic-password -U -s potts -a $acct -T /usr/bin/security -w   (prompts for the value)"; PROBLEMS=$((PROBLEMS + 1)); fi
  done
fi

if [[ $VERIFY_WORKER -eq 1 ]]; then
  W=/usr/local/libexec/potts/potts-worker-run
  if ! id potts-worker >/dev/null 2>&1 || ! sudo -n -u potts-worker -l "$W" >/dev/null 2>&1; then
    log "potts-worker or its sudo rule is missing; run deploy/isolation/create-worker-user.sh first"; PROBLEMS=$((PROBLEMS + 1))
  else
    job="$(mktemp -d /Users/Shared/potts-jobs/verify-XXXXXX)"
    prof="$(printf '(version 1)\n(deny default)\n(allow process*)\n(allow sysctl-read)\n(allow file-read*)\n(allow file-write* (subpath "%s"))\n(allow file-write-data (literal "/dev/null"))\n' "$job" | base64)"
    # NOTE: this profile deliberately does NOT deny reads, so the check below proves the uid boundary alone.
    for target in "$POL" "$POTTS_HOME/potts.db" "$HOME/.openclaw/openclaw.json" "$HOME/.ssh" "$HOME/Library/Keychains"; do
      if sudo -n -u potts-worker "$W" --workspace "$job" --cwd "$job" --timeout-sec 10 --profile-b64 "$prof" -- /bin/ls "$target" >/dev/null 2>&1; then
        log "FAIL    potts-worker CAN read $target"; PROBLEMS=$((PROBLEMS + 1))
      else
        log "ok      potts-worker cannot read $target"
      fi
    done
    rm -rf "$job"
  fi
fi

log "done: $PROBLEMS item(s) $([[ $APPLY -eq 1 ]] && echo 'handled' || echo 'to address')"
[[ $APPLY -eq 1 || $PROBLEMS -eq 0 ]] || exit 3
