#!/usr/bin/env bash
# Restore a SQLite backup to the EC2 instance
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

IP=$(get_ip)

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <path-to-backup.db>"
  echo ""
  echo "Available backups:"
  ls -la "${STATE_DIR}/backups/" 2>/dev/null || echo "  No backups found."
  exit 1
fi

BACKUP_PATH="$1"
if [[ ! -f "$BACKUP_PATH" ]]; then
  echo "ERROR: Backup file not found: $BACKUP_PATH" >&2
  exit 1
fi

echo_step "Stopping app container"
run_ssh "cd ${REMOTE_DIR} && docker compose stop app"

echo_step "Uploading backup to server"
run_scp "$BACKUP_PATH" "${REMOTE_USER}@${IP}:${REMOTE_DIR}/data/aws-cost-saver.db"

echo_step "Removing WAL/SHM files"
run_ssh "rm -f ${REMOTE_DIR}/data/aws-cost-saver.db-wal ${REMOTE_DIR}/data/aws-cost-saver.db-shm"

echo_step "Restarting app container"
run_ssh "cd ${REMOTE_DIR} && docker compose start app"

echo ""
echo "============================================"
echo "  Database restored successfully!"
echo "============================================"
echo ""
echo "  Restored from: $BACKUP_PATH"
echo ""
