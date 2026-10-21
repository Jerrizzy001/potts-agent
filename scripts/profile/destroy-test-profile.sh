#!/usr/bin/env bash
# Potts WP-0: delete an isolated OpenClaw test profile created by create-test-profile.sh.
#
# Usage:
#   destroy-test-profile.sh [--name potts-test] --confirm
#
# Refuses unless: the dir is ~/.openclaw-<name> and carries the POTTS_TEST_PROFILE marker,
# it is not the live ~/.openclaw, no launchd service exists for the profile, and no gateway
# is listening on the profile's port (stop your short-lived test gateway first).
set -euo pipefail
# shellcheck source=../baseline/lib.sh
source "$(cd "$(dirname "$0")/../baseline" && pwd)/lib.sh"

NAME="potts-test"; CONFIRM=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --confirm) CONFIRM=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{1,40}$ ]] || die "invalid --name"
DIR="$HOME/.openclaw-$NAME"
[[ "$DIR" != "$OPENCLAW_LIVE_DIR" && "$DIR" != "$HOME/.openclaw" ]] || die "refusing to touch the live dir"
[[ -d "$DIR" ]] || { echo "nothing to do: $DIR does not exist"; exit 0; }
[[ -f "$DIR/POTTS_TEST_PROFILE" ]] || die "$DIR has no POTTS_TEST_PROFILE marker; refusing (not created by Potts)"

port="$(awk -F= '/^port=/{print $2}' "$DIR/POTTS_TEST_PROFILE")"
if [[ -n "$port" ]] && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  die "a process is listening on test port $port; stop the test gateway first"
fi
if launchctl list 2>/dev/null | awk '{print $3}' | grep -q -- "$NAME"; then
  die "a launchd job mentioning '$NAME' is loaded; remove it manually (the test profile must not have services)"
fi
if [[ $CONFIRM -ne 1 ]]; then
  echo "DRY RUN: would delete $DIR ($(du -sh "$DIR" | awk '{print $1}')). Re-run with --confirm."
  exit 0
fi
rm -rf "$DIR"
echo "deleted $DIR"
