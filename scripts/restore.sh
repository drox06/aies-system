#!/usr/bin/env bash
#
# Restore a backup into a SCRATCH database and print a row-count sanity report.
# Spec.md §7.5 step 8: "A backup you have not restored is not a backup."
#
# This is the script that makes the quarterly drill actually happen, so it is built to be run
# casually and safely rather than only in an emergency.
#
# Usage:
#   ./scripts/restore.sh /volume1/aies-backups/2026-08-08 "postgresql://.../aies_restore_test"
#
# It will REFUSE to restore over a database whose name does not look like a scratch target, on the
# theory that the one thing worse than no backup is a restore drill that overwrites production.

set -Eeuo pipefail

BACKUP_DIR="${1:-}"
TARGET_URL="${2:-}"

usage() {
  cat <<'USAGE'
Usage: restore.sh <backup-dir> <target-database-url>

  <backup-dir>          a directory produced by backup-to-nas.sh (contains database.dump)
  <target-database-url> a scratch database. Its name must contain "restore", "scratch" or "test".

Set ALLOW_UNSAFE_TARGET=1 to override the name check — only during a genuine recovery, and only
after you are certain of the target.
USAGE
}

[ -n "${BACKUP_DIR}" ] && [ -n "${TARGET_URL}" ] || { usage; exit 2; }
[ -f "${BACKUP_DIR}/database.dump" ] || { echo "No database.dump in ${BACKUP_DIR}"; exit 1; }

log() { printf '%s  %s\n' "$(date +'%F %T')" "$*"; }

# --- guard rail ------------------------------------------------------------------------------
DB_NAME="$(printf '%s' "${TARGET_URL}" | sed -E 's#.*/([^/?]+).*#\1#')"
if ! printf '%s' "${DB_NAME}" | grep -qiE 'restore|scratch|test'; then
  if [ "${ALLOW_UNSAFE_TARGET:-0}" != "1" ]; then
    cat >&2 <<EOF
Refusing to restore into "${DB_NAME}".

The drill is supposed to prove the backup is good, not to put it into production. Point this at a
scratch database whose name contains "restore", "scratch" or "test".

If this IS a real recovery and you mean to overwrite ${DB_NAME}, re-run with:
  ALLOW_UNSAFE_TARGET=1 $0 "$@"
EOF
    exit 1
  fi
  log "WARNING: overriding the target-name check and restoring into ${DB_NAME}."
fi

if [ -f "${BACKUP_DIR}/manifest.json" ]; then
  log "Backup manifest:"
  cat "${BACKUP_DIR}/manifest.json"
else
  log "WARNING: no manifest.json — cannot confirm when the dump and storage sync were taken."
fi

log "Restoring into ${DB_NAME}..."
# --clean --if-exists so the drill is repeatable against the same scratch database.
# Not --exit-on-error: a fresh scratch DB legitimately lacks roles the dump references, and
# stopping on the first such notice would abort an otherwise perfect restore.
pg_restore --dbname="${TARGET_URL}" --clean --if-exists --no-owner --no-privileges \
           --jobs=4 "${BACKUP_DIR}/database.dump" 2> >(tee /tmp/restore-stderr.log >&2) || true

if grep -qiE '^pg_restore: error' /tmp/restore-stderr.log 2>/dev/null; then
  log "pg_restore reported errors (above). Review before signing off the drill."
fi

# --- sanity report ----------------------------------------------------------------------------
# Row counts per table are what turn "the command exited 0" into evidence. An empty AuditLog or a
# User table with 0 rows means the restore silently produced an empty shell.
log "Row counts:"
psql "${TARGET_URL}" --quiet --no-align --field-separator=' | ' <<'SQL'
SELECT relname AS table, n_live_tup AS approx_rows
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC, relname;
SQL

log "Spot checks on the tables that must never be empty:"
psql "${TARGET_URL}" --quiet <<'SQL'
SELECT
  (SELECT count(*) FROM "User")       AS users,
  (SELECT count(*) FROM "Role")       AS roles,
  (SELECT count(*) FROM "Permission") AS permissions,
  (SELECT count(*) FROM "AuditLog")   AS audit_rows;
SQL

cat <<'EOF'

------------------------------------------------------------------------------
Drill checklist — record the result in docs/DEPLOYMENT.md §8:

  [ ] pg_restore completed without errors
  [ ] User / Role / Permission counts match production expectations
  [ ] AuditLog is non-empty (it is the ISO evidence trail)
  [ ] A known recent record is present and correct
  [ ] Storage: spot-check that <backup-dir>/storage contains a recently uploaded file

  Date performed: ____________   By: ____________
------------------------------------------------------------------------------
EOF
