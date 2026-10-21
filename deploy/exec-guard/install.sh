#!/usr/bin/env bash
# Installs the Potts exec deletion guard into $POTTS_HOME/bin/guard (rm, rmdir).
#   deploy/exec-guard/install.sh            # dry run
#   deploy/exec-guard/install.sh --apply
# The directory is referenced by integrations/openclaw/config-patches/potts-agent-auto.patch.json
# (tools.exec.pathPrepend). Never touches OpenClaw config or any other LaunchAgent.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POTTS_HOME="${POTTS_HOME:-$HOME/Library/Application Support/Potts}"
DEST="$POTTS_HOME/bin/guard"
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
echo "guard dir: $DEST  ($([[ $APPLY -eq 1 ]] && echo APPLY || echo 'DRY RUN'))"
for name in rm rmdir; do
  if [[ $APPLY -eq 1 ]]; then
    mkdir -p "$DEST"; chmod 700 "$POTTS_HOME/bin" "$DEST" 2>/dev/null || true
    install -m 0755 "$HERE/deletion-guard.sh" "$DEST/$name"
    echo "installed $DEST/$name"
  else
    echo "would install $DEST/$name"
  fi
done
if [[ $APPLY -eq 1 ]]; then
  out="$("$DEST/rm" -rf /tmp/potts-guard-selftest 2>&1 >/dev/null)" && { echo "ERROR: guard did not refuse" >&2; exit 1; } || true
  [[ "$out" == *"was NOT run"* ]] || { echo "ERROR: unexpected guard output: $out" >&2; exit 1; }
  echo "self-test: rm refused as expected"
fi
