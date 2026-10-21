#!/usr/bin/env bash
# Installs the generated Potts profile into an OpenClaw workspace.
#
#   profile/install-to-openclaw-workspace.sh [--workspace DIR] [--apply]
#
# Default workspace: ~/.openclaw/workspace (the live assistant). Without
# --apply this is a dry run: it prints a unified diff of every change and
# writes nothing. With --apply it first copies every file it will touch into
# DIR/.potts-profile-backup-<UTC timestamp>/, then writes:
#   IDENTITY.md, SOUL.md, POTTS-STATUS.md  replaced by the generated files
#   AGENTS.md  generated Potts section inserted/replaced between potts markers
#              (the owner's existing rules are kept verbatim)
#   USER.md    generated preferences section inserted/replaced between markers
#              (the owner's existing notes are kept verbatim)
# Rollback: copy the files back from the backup directory.
# Tip: rehearse on the isolated test profile first:
#   profile/install-to-openclaw-workspace.sh --workspace ~/.openclaw-potts-test/workspace
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/workspace"
WS="${HOME}/.openclaw/workspace"
APPLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) WS="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for f in IDENTITY.md SOUL.md POTTS-STATUS.md AGENTS.potts-section.md USER.potts-section.md; do
  [[ -f "$SRC/$f" ]] || { echo "missing generated file $SRC/$f (run: npm run memory -- profile generate --spec <spec.json>)" >&2; exit 1; }
done
[[ -d "$WS" ]] || { echo "workspace not found: $WS" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/potts-profile.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp "$SRC/IDENTITY.md" "$STAGE/IDENTITY.md"
cp "$SRC/SOUL.md" "$STAGE/SOUL.md"
cp "$SRC/POTTS-STATUS.md" "$STAGE/POTTS-STATUS.md"
node --disable-warning=ExperimentalWarning "$HERE/lib/merge-section.ts" agents "$WS/AGENTS.md" "$SRC/AGENTS.potts-section.md" > "$STAGE/AGENTS.md"
node --disable-warning=ExperimentalWarning "$HERE/lib/merge-section.ts" user "$WS/USER.md" "$SRC/USER.potts-section.md" > "$STAGE/USER.md"

CHANGED=()
for f in IDENTITY.md SOUL.md POTTS-STATUS.md AGENTS.md USER.md; do
  if [[ -f "$WS/$f" ]] && cmp -s "$WS/$f" "$STAGE/$f"; then
    echo "unchanged: $f"
    continue
  fi
  CHANGED+=("$f")
  echo "=== $f"
  if [[ -f "$WS/$f" ]]; then diff -u "$WS/$f" "$STAGE/$f" || true; else diff -u /dev/null "$STAGE/$f" || true; fi
done

if [[ ${#CHANGED[@]} -eq 0 ]]; then echo "Nothing to change."; exit 0; fi
if [[ $APPLY -ne 1 ]]; then
  echo
  echo "DRY RUN: ${#CHANGED[@]} file(s) would change in $WS. Re-run with --apply to install (existing files are backed up first)."
  exit 0
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$WS/.potts-profile-backup-$TS"
mkdir -p "$BACKUP"
chmod 700 "$BACKUP"
for f in "${CHANGED[@]}"; do
  if [[ -f "$WS/$f" ]]; then cp -p "$WS/$f" "$BACKUP/$f"; fi
done
for f in "${CHANGED[@]}"; do
  cp "$STAGE/$f" "$WS/$f.potts-tmp"
  mv "$WS/$f.potts-tmp" "$WS/$f"
done
echo "Installed ${#CHANGED[@]} file(s) into $WS. Backup: $BACKUP"
echo "Rollback: cp -p \"$BACKUP\"/* \"$WS\"/  (and delete POTTS-STATUS.md if it was new)"
