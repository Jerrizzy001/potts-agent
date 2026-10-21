#!/usr/bin/env bash
# Install the Potts daemon as a per-user LaunchAgent (label local.potts.daemon).
# Dry run by default; nothing outside a private temp dir is written unless --apply.
# Never uses sudo. Only ever touches the label local.potts.daemon.
set -euo pipefail

readonly LABEL="local.potts.daemon"
readonly MIN_NODE="24.12.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly TEMPLATE="$SCRIPT_DIR/$LABEL.plist"

LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHCTL="${LAUNCHCTL:-launchctl}"

APPLY=0
SKIP_CHECK=0
PRINT_PLIST=0
NODE_BIN=""
POTTS_HOME_ARG="${POTTS_HOME:-$HOME/Library/Application Support/Potts}"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() {
  cat <<EOF
Usage: deploy/launchd/install-daemon.sh [options]

Renders deploy/launchd/$LABEL.plist and installs it as a per-user LaunchAgent.
Without --apply this is a DRY RUN: it validates, renders, lints and diffs, but
writes nothing outside a private temp directory and never calls launchctl.

Options:
  --apply           Actually install: create logs dir, back up any existing plist,
                    install it (mode 0644), launchctl bootout + bootstrap.
  --node <path>     Absolute path to node >= $MIN_NODE (default: \`command -v node\`).
  --home <dir>      Potts home (default: \$POTTS_HOME or ~/Library/Application Support/Potts).
  --repo <dir>      Potts repository (default: the repo containing this script).
  --skip-check      Do not run \`src/daemon/main.ts --check\` before installing.
  --print-plist     Print the rendered plist to stdout.
  -h, --help        Show this help.

Environment overrides (for tests):
  LAUNCH_AGENTS_DIR  default ~/Library/LaunchAgents
  LAUNCHCTL          default launchctl

Other agents (ai.openclaw.*, local.openclaw.qwen-server) are only listed, never modified.
EOF
}

die() { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --skip-check) SKIP_CHECK=1; shift ;;
    --print-plist) PRINT_PLIST=1; shift ;;
    --node) [[ $# -ge 2 ]] || die "--node needs a value"; NODE_BIN="$2"; shift 2 ;;
    --home) [[ $# -ge 2 ]] || die "--home needs a value"; POTTS_HOME_ARG="$2"; shift 2 ;;
    --repo) [[ $# -ge 2 ]] || die "--repo needs a value"; REPO="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[[ "$(id -u)" -ne 0 ]] || die "do not run as root; this installs a per-user LaunchAgent"

# Reject values that cannot be represented safely in the plist / sed.
check_value() {
  local name="$1" value="$2"
  [[ -n "$value" ]] || die "$name is empty"
  [[ "$value" == /* ]] || die "$name must be an absolute path: $value"
  case "$value" in
    *$'\n'*|*$'\r'*) die "$name contains a newline" ;;
  esac
}

if [[ "$APPLY" -eq 1 ]]; then echo "Mode: APPLY (will install and load $LABEL)"; else echo "Mode: DRY RUN (pass --apply to install)"; fi

step "Validate node"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
  [[ -n "$NODE_BIN" ]] || die "node not found on PATH; pass --node /absolute/path/to/node"
fi
check_value "node path" "$NODE_BIN"
[[ -x "$NODE_BIN" && ! -d "$NODE_BIN" ]] || die "node is not an executable file: $NODE_BIN"
NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null)" || die "could not run $NODE_BIN"
version_ge() {
  local IFS=.
  local -a a b
  read -r -a a <<<"$1"; read -r -a b <<<"$2"
  local i x y
  for i in 0 1 2; do
    x="${a[$i]:-0}"; y="${b[$i]:-0}"
    x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
    (( 10#${x:-0} > 10#${y:-0} )) && return 0
    (( 10#${x:-0} < 10#${y:-0} )) && return 1
  done
  return 0
}
version_ge "$NODE_VERSION" "$MIN_NODE" || die "node $NODE_VERSION at $NODE_BIN is older than $MIN_NODE"
echo "node: $NODE_BIN (v$NODE_VERSION) OK"

step "Validate repo and home"
check_value "repo" "$REPO"
REPO="${REPO%/}"
[[ -f "$REPO/src/daemon/main.ts" ]] || die "repo has no src/daemon/main.ts: $REPO"
echo "repo: $REPO OK"
check_value "POTTS_HOME" "$POTTS_HOME_ARG"
POTTS_HOME_VAL="${POTTS_HOME_ARG%/}"
LOG_DIR="$POTTS_HOME_VAL/logs"
BACKUP_DIR="$POTTS_HOME_VAL/backups/launchd"
DEST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
echo "POTTS_HOME: $POTTS_HOME_VAL"
echo "logs:       $LOG_DIR"
echo "target:     $DEST"

step "Render template"
[[ -f "$TEMPLATE" ]] || die "template missing: $TEMPLATE"
TMPDIR_RENDER="$(mktemp -d "${TMPDIR:-/tmp}/potts-launchd.XXXXXX")"
chmod 700 "$TMPDIR_RENDER"
trap 'rm -rf "$TMPDIR_RENDER"' EXIT
RENDERED="$TMPDIR_RENDER/$LABEL.plist"

# XML-escape (& first), then escape for a sed replacement using '|' as delimiter.
xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"
  printf '%s' "$s"
}
sed_escape() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }
sub() { sed_escape "$(xml_escape "$1")"; }

sed -e "s|@NODE@|$(sub "$NODE_BIN")|g" \
    -e "s|@REPO@|$(sub "$REPO")|g" \
    -e "s|@POTTS_HOME@|$(sub "$POTTS_HOME_VAL")|g" \
    -e "s|@LOG_DIR@|$(sub "$LOG_DIR")|g" \
    "$TEMPLATE" >"$RENDERED"
if grep -Eq '@(NODE|REPO|POTTS_HOME|LOG_DIR)@' "$RENDERED"; then die "unrendered placeholder left in plist"; fi
echo "rendered: $RENDERED"

step "Lint rendered plist"
plutil -lint "$RENDERED"
RENDERED_LABEL="$(plutil -extract Label raw -o - "$RENDERED")"
[[ "$RENDERED_LABEL" == "$LABEL" ]] || die "rendered label is '$RENDERED_LABEL', expected exactly '$LABEL'; refusing"
RENDERED_NODE="$(plutil -extract ProgramArguments.0 raw -o - "$RENDERED")"
[[ "$RENDERED_NODE" == "$NODE_BIN" ]] || die "node path did not round-trip through the plist ($RENDERED_NODE)"
RENDERED_HOME="$(plutil -extract EnvironmentVariables.POTTS_HOME raw -o - "$RENDERED")"
[[ "$RENDERED_HOME" == "$POTTS_HOME_VAL" ]] || die "POTTS_HOME did not round-trip through the plist ($RENDERED_HOME)"
echo "label: $RENDERED_LABEL OK"

if [[ "$PRINT_PLIST" -eq 1 ]]; then
  echo "----- BEGIN RENDERED PLIST -----"
  cat "$RENDERED"
  echo "----- END RENDERED PLIST -----"
fi

step "Diff against installed plist"
if [[ -f "$DEST" ]]; then
  if diff -u "$DEST" "$RENDERED"; then echo "(installed plist is identical)"; fi
else
  echo "(no existing $DEST)"
fi

step "Other launch agents (read-only, untouched)"
OTHERS="$(ls -1 "$LAUNCH_AGENTS_DIR" 2>/dev/null | grep -E '^(ai\.openclaw\..*|local\.openclaw\.qwen-server)\.plist$' || true)"
if [[ -n "$OTHERS" ]]; then
  while IFS= read -r f; do echo "untouched: ${f%.plist}"; done <<<"$OTHERS"
else
  echo "(none found)"
fi

step "Daemon preflight check"
if [[ "$SKIP_CHECK" -eq 1 ]]; then
  echo "skipped (--skip-check)"
else
  echo "running: POTTS_HOME=\"$POTTS_HOME_VAL\" $NODE_BIN --disable-warning=ExperimentalWarning $REPO/src/daemon/main.ts --check"
  if ! (cd "$REPO" && POTTS_HOME="$POTTS_HOME_VAL" "$NODE_BIN" --disable-warning=ExperimentalWarning "$REPO/src/daemon/main.ts" --check); then
    die "daemon --check failed; fix the reported problems (or pass --skip-check) before installing"
  fi
  echo "check OK"
fi

if [[ "$APPLY" -ne 1 ]]; then
  step "Dry run complete"
  echo "Would: mkdir -p (0700) $LOG_DIR"
  [[ -f "$DEST" ]] && echo "Would: back up $DEST to $BACKUP_DIR/<timestamp>.plist"
  echo "Would: install rendered plist to $DEST (mode 0644)"
  echo "Would: $LAUNCHCTL bootout gui/$(id -u)/$LABEL (ignored if not loaded)"
  echo "Would: $LAUNCHCTL bootstrap gui/$(id -u) $DEST"
  echo "Re-run with --apply to install."
  exit 0
fi

DOMAIN="gui/$(id -u)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

step "Create log directory"
mkdir -p "$LOG_DIR"
chmod 700 "$POTTS_HOME_VAL" "$LOG_DIR"
echo "ok: $LOG_DIR (0700)"

if [[ -f "$DEST" ]]; then
  step "Back up existing plist"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$POTTS_HOME_VAL/backups" "$BACKUP_DIR"
  cp -p "$DEST" "$BACKUP_DIR/$TS.plist"
  echo "backup: $BACKUP_DIR/$TS.plist"
fi

step "Install plist"
mkdir -p "$LAUNCH_AGENTS_DIR"
install -m 0644 "$RENDERED" "$DEST"
echo "installed: $DEST (0644)"

step "Load agent"
echo "$LAUNCHCTL bootout $DOMAIN/$LABEL"
if "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" 2>/dev/null; then echo "previous instance unloaded"; else echo "(was not loaded)"; fi
echo "$LAUNCHCTL bootstrap $DOMAIN $DEST"
attempt=1
until "$LAUNCHCTL" bootstrap "$DOMAIN" "$DEST"; do
  if [[ "$attempt" -ge 3 ]]; then die "launchctl bootstrap failed after $attempt attempts"; fi
  attempt=$((attempt + 1))
  echo "bootstrap failed; retrying ($attempt/3) in 2 s"
  sleep 2
done

step "Status"
"$LAUNCHCTL" print "$DOMAIN/$LABEL" | head -n 20 || true
echo
echo "Installed $LABEL. Logs: $LOG_DIR/daemon.err.log"
