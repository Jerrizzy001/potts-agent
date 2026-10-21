#!/usr/bin/env bash
# Potts WP-0: create a restorable snapshot of the working OpenClaw setup.
#
# Usage:
#   snapshot.sh [--out-dir DIR] [--label NAME] [--include-runtime] [--source-home DIR]
#
# Captures (read-only on the sources):
#   openclaw/      ~/.openclaw minus sockets, locks, caches, logs, tmp, sqlite -wal/-shm
#                  (and minus tools/ = the 1+ GB node/openclaw runtime unless --include-runtime).
#                  SQLite databases are copied with the sqlite3 online-backup API so the copy
#                  is transactionally consistent even while the gateway is running.
#   launchagents/  ai.openclaw.gateway.plist, ai.openclaw.mac.plist, local.openclaw.qwen-server.plist
#   lmstudio/      LM Studio / llmster model load defaults + HTTP server config
#
# Output (all 0600 inside a 0700 dir, default $POTTS_HOME/snapshots/):
#   <name>.tar.gz            the snapshot
#   <name>.tar.gz.sha256     sha256 of the tarball
#   <name>.manifest.json     per-file sha256/size/mode (also stored inside the tar as MANIFEST.json)
#
# WARNING: the snapshot contains live credentials (bot token, gateway token). It never
# leaves the Potts home dir and is never printed. Do not copy it into Git or cloud sync.
#
# --source-home DIR treats DIR as $HOME (for tests/rehearsals); default is the real $HOME.
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
umask 077

OUT_DIR=""
LABEL="openclaw-snapshot"
INCLUDE_RUNTIME=0
SRC_HOME="$HOME"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --include-runtime) INCLUDE_RUNTIME=1; shift ;;
    --source-home) SRC_HOME="$2"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || die "--label may contain only letters, digits, . _ -"

SRC_OC="$SRC_HOME/.openclaw"
SRC_LA="$SRC_HOME/Library/LaunchAgents"
SRC_LMS="$SRC_HOME/.lmstudio"
[[ -d "$SRC_OC" ]] || die "no OpenClaw dir at $SRC_OC"

if [[ -z "$OUT_DIR" ]]; then
  ensure_private_dir "$POTTS_HOME"
  OUT_DIR="$POTTS_HOME/snapshots"
fi
ensure_private_dir "$OUT_DIR"

STAMP="$(utc_stamp)"
NAME="$LABEL-$STAMP"
TAR="$OUT_DIR/$NAME.tar.gz"
[[ -e "$TAR" ]] && die "snapshot already exists: $TAR"
STAGE="$(mktemp -d "$OUT_DIR/.staging-$NAME.XXXXXX")"
chmod 700 "$STAGE"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# ---------------------------------------------------------------- ~/.openclaw
excludes=("${OPENCLAW_SNAPSHOT_EXCLUDES[@]}")
[[ $INCLUDE_RUNTIME -eq 1 ]] || excludes+=("${OPENCLAW_RUNTIME_EXCLUDES[@]}")
rsync_args=(-a)
for e in "${excludes[@]}"; do rsync_args+=(--exclude "$e"); done
log "copying $SRC_OC (excluding: ${excludes[*]})"
mkdir -p "$STAGE/openclaw"
rsync "${rsync_args[@]}" "$SRC_OC/" "$STAGE/openclaw/"
# Sockets can slip through pattern excludes on some rsync builds; remove any special files.
find "$STAGE/openclaw" \( -type s -o -type p \) -delete

log "consistent SQLite copies"
while IFS= read -r -d '' db; do
  rel="${db#"$SRC_OC"/}"
  dst="$STAGE/openclaw/$rel"
  # Only real SQLite files (skip *.bak copies, which rsync already copied as-is).
  if head -c 16 "$db" 2>/dev/null | grep -q "SQLite format 3"; then
    rm -f "$dst"
    if ! sqlite3 "file:$db?mode=ro" ".backup '$dst'" 2>/dev/null; then
      # Read-only open can fail for WAL databases without a -shm file. Copy db+wal to a private
      # temp dir and back up from that copy (never opens the live file read-write).
      tmpd="$(mktemp -d "$STAGE/.sqlite.XXXXXX")"
      cp -p "$db" "$tmpd/db"; [[ -f "$db-wal" ]] && cp -p "$db-wal" "$tmpd/db-wal"
      sqlite3 "$tmpd/db" ".backup '$dst'" || die "sqlite backup failed for $rel"
      rm -rf "$tmpd"
    fi
    chmod 600 "$dst"
  fi
done < <(find "$SRC_OC" \( -path "$SRC_OC/tmp" -o -path "$SRC_OC/cache" -o -path "$SRC_OC/logs" -o -path "$SRC_OC/tools" \) -prune \
          -o -type f \( -name '*.sqlite' -o -name '*.db' \) -print0)

# ---------------------------------------------------------------- launch agents
log "launch agents"
mkdir -p "$STAGE/launchagents"
for label in "${POTTS_LAUNCH_LABELS[@]}"; do
  f="$SRC_LA/$label.plist"
  if [[ -f "$f" ]]; then cp -p "$f" "$STAGE/launchagents/"; else log "  (missing $label.plist — skipped)"; fi
done

# ---------------------------------------------------------------- LM Studio
log "LM Studio model config"
mkdir -p "$STAGE/lmstudio"
for rel in "${LMSTUDIO_CONFIG_FILES[@]}"; do
  [[ -e "$SRC_LMS/$rel" ]] || continue
  mkdir -p "$STAGE/lmstudio/$(dirname "$rel")"
  cp -Rp "$SRC_LMS/$rel" "$STAGE/lmstudio/$rel"
done

# ---------------------------------------------------------------- manifest
log "manifest"
node "$SCRIPT_LIB_DIR/manifest.mjs" create "$STAGE" \
  --meta "createdAtUtc=$STAMP" --meta "sourceHome=$SRC_HOME" --meta "label=$LABEL" \
  --meta "includeRuntime=$INCLUDE_RUNTIME" --meta "excludes=${excludes[*]}" \
  --meta "openclawVersion=$(with_timeout 20 openclaw --version 2>/dev/null | head -1 || echo unknown)" \
  > "$STAGE/MANIFEST.json"
cp "$STAGE/MANIFEST.json" "$OUT_DIR/$NAME.manifest.json"

log "writing $TAR"
tar -C "$STAGE" -czf "$TAR" .
chmod 600 "$TAR" "$OUT_DIR/$NAME.manifest.json"
(cd "$OUT_DIR" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
chmod 600 "$TAR.sha256"

files="$(jq '.files | length' "$OUT_DIR/$NAME.manifest.json")"
size="$(du -h "$TAR" | awk '{print $1}')"
echo "snapshot: $TAR"
echo "  files: $files  size: $size  sha256: $(awk '{print $1}' "$TAR.sha256")"
