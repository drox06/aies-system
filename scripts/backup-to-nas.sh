#!/usr/bin/env bash
#
# Nightly backup of Supabase Postgres + Storage to the Synology DS220+.
# Spec.md §7.5 step 5. Run by DSM Task Scheduler; see docs/DEPLOYMENT.md §5.
#
# One direction only, always. The NAS is never the authoritative copy while the platform runs on
# Supabase (Spec.md §7.2) — a two-way sync between a cloud database and a NAS is a data-loss
# incident waiting for a quiet weekend.
#
# Required environment (set them in the DSM task, not in this file):
#   DIRECT_URL        session-mode Postgres URL — NOT the pooled one; pg_dump needs a real session
#   BACKUP_ROOT       e.g. /volume1/aies-backups
#   RCLONE_REMOTE     configured rclone remote for the Supabase storage bucket, e.g. aies-storage:
# Optional:
#   RETAIN_DAYS       default 30

set -Eeuo pipefail

: "${DIRECT_URL:?DIRECT_URL is required}"
: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
: "${RCLONE_REMOTE:?RCLONE_REMOTE is required}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"

STAMP="$(date +%F)"
DEST="${BACKUP_ROOT}/${STAMP}"
# Write to a .partial directory and rename only on success, so a half-finished backup can never be
# mistaken for a complete one by the restore script or by a human in a hurry.
STAGING="${DEST}.partial"

log() { printf '%s  %s\n' "$(date +'%F %T')" "$*"; }

fail() {
  log "FAILED on line $1. Staging directory kept at ${STAGING} for inspection."
  exit 1
}
trap 'fail $LINENO' ERR

command -v pg_dump >/dev/null || { log "pg_dump not found"; exit 1; }
command -v rclone  >/dev/null || { log "rclone not found";  exit 1; }

rm -rf "${STAGING}"
mkdir -p "${STAGING}"

log "Dumping database..."
DUMP_STARTED="$(date -u +%FT%TZ)"
# -Fc (custom format) so restore.sh can use pg_restore: parallelisable, and selective restore of a
# single table is possible during an incident.
pg_dump --dbname="${DIRECT_URL}" --format=custom --no-owner --no-privileges \
        --file="${STAGING}/database.dump"
DUMP_FINISHED="$(date -u +%FT%TZ)"

log "Syncing storage bucket..."
STORAGE_MARKER="$(date -u +%FT%TZ)"
rclone sync "${RCLONE_REMOTE}" "${STAGING}/storage" --create-empty-src-dirs --stats-one-line

# The manifest is what makes the pair identifiable at restore time (Spec.md §7.5 step 5): the dump
# and the storage sync are taken at different instants, and knowing which is which matters when
# reconciling a file that exists in one and not the other.
DUMP_BYTES="$(stat -c %s "${STAGING}/database.dump" 2>/dev/null || stat -f %z "${STAGING}/database.dump")"
STORAGE_FILES="$(find "${STAGING}/storage" -type f | wc -l | tr -d ' ')"
STORAGE_BYTES="$(du -sb "${STAGING}/storage" 2>/dev/null | cut -f1 || echo unknown)"

cat > "${STAGING}/manifest.json" <<JSON
{
  "backupDate": "${STAMP}",
  "dumpStartedAt": "${DUMP_STARTED}",
  "dumpFinishedAt": "${DUMP_FINISHED}",
  "storageSyncMarker": "${STORAGE_MARKER}",
  "dumpBytes": ${DUMP_BYTES},
  "storageFileCount": ${STORAGE_FILES},
  "storageBytes": "${STORAGE_BYTES}",
  "pgDumpVersion": "$(pg_dump --version | head -1)",
  "rcloneVersion": "$(rclone version | head -1)",
  "host": "$(hostname)"
}
JSON

# Verify the dump is readable before declaring success. A dump that cannot be listed is not a
# backup, and finding that out during a restore is finding out too late.
log "Verifying dump is readable..."
pg_restore --list "${STAGING}/database.dump" > "${STAGING}/toc.txt"
TOC_LINES="$(wc -l < "${STAGING}/toc.txt" | tr -d ' ')"
if [ "${TOC_LINES}" -lt 10 ]; then
  log "Dump table of contents has only ${TOC_LINES} lines — refusing to mark this backup complete."
  exit 1
fi

rm -rf "${DEST}"
mv "${STAGING}" "${DEST}"
log "Backup complete: ${DEST} (dump ${DUMP_BYTES} bytes, ${STORAGE_FILES} storage files)"

# Retention. Btrfs snapshots of the share (docs/DEPLOYMENT.md §7) are the real defence against
# ransomware and mistakes; this only stops the volume filling.
log "Pruning backups older than ${RETAIN_DAYS} days..."
find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime "+${RETAIN_DAYS}" \
  -exec rm -rf {} + 2>/dev/null || true

log "Done."
