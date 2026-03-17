#!/usr/bin/env bash
# Download a safe SQLite backup from the EC2 instance
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

IP=$(get_ip)
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="${STATE_DIR}/backups"
BACKUP_FILE="${BACKUP_DIR}/aws-cost-saver-${TIMESTAMP}.db"

mkdir -p "$BACKUP_DIR"

echo_step "Creating SQLite backup on server (safe hot backup)"
# Write backup to the bind-mounted data dir so it's accessible from the host
run_ssh << REMOTE_SCRIPT
set -euo pipefail
cd ${REMOTE_DIR}
docker compose exec -T app \
  node -e "
    const Database = require('better-sqlite3');
    const db = new Database('/app/backend/data/aws-cost-saver.db', { readonly: true });
    db.backup('/app/backend/data/backup.db').then(() => { db.close(); console.log('Backup complete'); });
  " 2>/dev/null || {
  # Fallback: direct file copy via host bind mount
  echo "Using file copy fallback..."
  cp ${REMOTE_DIR}/data/aws-cost-saver.db ${REMOTE_DIR}/data/backup.db
}
REMOTE_SCRIPT

echo_step "Downloading backup"
run_scp "${REMOTE_USER}@${IP}:${REMOTE_DIR}/data/backup.db" "$BACKUP_FILE"
run_ssh "rm -f ${REMOTE_DIR}/data/backup.db"

BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)

echo ""
echo "============================================"
echo "  Backup complete!"
echo "============================================"
echo ""
echo "  File: $BACKUP_FILE"
echo "  Size: $BACKUP_SIZE"
echo ""
echo "  All backups: ls -la $BACKUP_DIR"
echo ""
