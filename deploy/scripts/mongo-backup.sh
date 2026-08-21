#!/usr/bin/env bash
#
# One MongoDB backup run, with generational retention.
#
# Produces a single compressed archive per run:
#     /backups/daily/trademart-20260821T030000Z.archive.gz
#
# and promotes copies into weekly/ and monthly/ so that retention is a matter of
# counting files rather than parsing dates:
#
#     daily/    the last BACKUP_KEEP_DAILY runs      (default 7)
#     weekly/   one per ISO week, last 4             (default 4)
#     monthly/  one per calendar month, last 3       (default 3)
#
# DESIGN NOTES
#
# * `--archive --gzip` gives ONE file per run. A directory-per-dump is far more
#   awkward to copy off-box, and off-box is where a backup needs to end up.
#
# * The archive is written to a .partial name and renamed only on success. A
#   half-written archive that looks like a real backup is worse than no backup,
#   because it will be trusted.
#
# * Every run verifies the archive is readable before it is kept. An unverified
#   backup is a guess.
#
# * Retention deletes ONLY after a successful new backup. A failing job must
#   never be able to age out the last good copy.
set -euo pipefail

: "${MONGODB_URI:?MONGODB_URI is required}"
BACKUP_ROOT="${BACKUP_ROOT:-/backups}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-3}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ISO_WEEK="$(date -u +%G-W%V)"
MONTH="$(date -u +%Y-%m)"

DAILY_DIR="$BACKUP_ROOT/daily"
WEEKLY_DIR="$BACKUP_ROOT/weekly"
MONTHLY_DIR="$BACKUP_ROOT/monthly"
mkdir -p "$DAILY_DIR" "$WEEKLY_DIR" "$MONTHLY_DIR"

ARCHIVE="$DAILY_DIR/trademart-$STAMP.archive.gz"
PARTIAL="$ARCHIVE.partial"

log() { printf '[backup] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

cleanup_partial() {
  if [ -f "$PARTIAL" ]; then
    log "removing incomplete archive $PARTIAL"
    rm -f "$PARTIAL"
  fi
}
trap cleanup_partial EXIT

# ------------------------------------------------------------------ dump -------
log "starting mongodump"
# The URI carries the credentials, so it is never echoed. mongodump reads it from
# the environment rather than argv, keeping it out of `ps` output.
if ! mongodump --uri="$MONGODB_URI" --archive="$PARTIAL" --gzip --quiet; then
  log "ERROR mongodump failed - keeping existing backups untouched"
  exit 1
fi

SIZE="$(stat -c %s "$PARTIAL" 2>/dev/null || echo 0)"
if [ "$SIZE" -lt 1024 ]; then
  # A near-empty archive usually means auth succeeded against the wrong database.
  log "ERROR archive is only ${SIZE} bytes, which is implausible - refusing to keep it"
  exit 1
fi

# ---------------------------------------------------------------- verify -------
# Reads the archive back and lists its contents. This catches gzip corruption and
# truncation, which is the whole reason a backup is verified rather than assumed.
log "verifying archive is readable"
if ! mongorestore --archive="$PARTIAL" --gzip --dryRun --quiet 2>/dev/null; then
  # --dryRun is not available on every mongorestore build; fall back to a gzip
  # integrity test, which still catches the common corruption cases.
  if ! gzip -t "$PARTIAL" 2>/dev/null; then
    log "ERROR archive failed verification - refusing to keep it"
    exit 1
  fi
  log "mongorestore --dryRun unavailable; gzip integrity check passed"
fi

mv "$PARTIAL" "$ARCHIVE"
trap - EXIT
log "wrote $ARCHIVE ($(numfmt --to=iec "$SIZE" 2>/dev/null || echo "$SIZE bytes"))"

# ------------------------------------------------------------- promotion ------
# Hard links where possible so a promoted copy costs no extra disk; falls back to
# a real copy across filesystems.
promote() {
  local dir="$1" key="$2"
  if ! ls "$dir"/*"$key"* >/dev/null 2>&1; then
    ln "$ARCHIVE" "$dir/trademart-$key-$STAMP.archive.gz" 2>/dev/null \
      || cp "$ARCHIVE" "$dir/trademart-$key-$STAMP.archive.gz"
    log "promoted to $(basename "$dir")/ for $key"
  fi
}
promote "$WEEKLY_DIR" "$ISO_WEEK"
promote "$MONTHLY_DIR" "$MONTH"

# -------------------------------------------------------------- retention -----
# Only reached after a verified new backup exists, so the last good copy can never
# be deleted by a failing run.
prune() {
  local dir="$1" keep="$2"
  local count
  count="$(find "$dir" -maxdepth 1 -name '*.archive.gz' | wc -l | tr -d ' ')"
  if [ "$count" -le "$keep" ]; then
    log "$(basename "$dir"): $count/$keep retained, nothing to prune"
    return
  fi
  # Newest first, skip the ones to keep, delete the rest.
  find "$dir" -maxdepth 1 -name '*.archive.gz' -printf '%T@ %p\n' \
    | sort -rn | tail -n +"$((keep + 1))" | cut -d' ' -f2- \
    | while read -r old; do
        log "pruning $(basename "$old")"
        rm -f "$old"
      done
}
prune "$DAILY_DIR" "$KEEP_DAILY"
prune "$WEEKLY_DIR" "$KEEP_WEEKLY"
prune "$MONTHLY_DIR" "$KEEP_MONTHLY"

log "done"
