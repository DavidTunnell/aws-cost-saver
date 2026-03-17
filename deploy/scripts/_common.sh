#!/usr/bin/env bash
# Shared configuration for all deploy scripts
set -euo pipefail

# Prevent Git Bash (MSYS/MinGW) from mangling paths starting with /
export MSYS_NO_PATHCONV=1

# AWS settings
REGION="${AWS_REGION:-us-east-1}"
INSTANCE_TYPE="t3.small"
AMI_SSM_PARAM="/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
VOLUME_SIZE=20
KEY_NAME="${AWS_COST_SAVER_KEY_NAME:-aws-cost-saver-key}"
SECURITY_GROUP_NAME="aws-cost-saver-sg"
APP_NAME="aws-cost-saver"

# SSH settings
REMOTE_USER="ec2-user"
REMOTE_DIR="/home/${REMOTE_USER}/${APP_NAME}"
SSH_KEY="${AWS_COST_SAVER_SSH_KEY:-$HOME/.ssh/${KEY_NAME}.pem}"

# Local state directory (stores instance ID, EIP allocation, etc.)
STATE_DIR="$HOME/.aws-cost-saver"
INSTANCE_ID_FILE="${STATE_DIR}/instance-id"
EIP_ALLOC_FILE="${STATE_DIR}/eip-allocation-id"
EIP_IP_FILE="${STATE_DIR}/eip-ip"
SG_ID_FILE="${STATE_DIR}/sg-id"

# Audit log — records every AWS resource created for easy teardown
AUDIT_LOG="${STATE_DIR}/audit-log.json"

mkdir -p "$STATE_DIR"

# Helper: append to audit log
audit_log() {
  local action="$1"
  local resource_type="$2"
  local resource_id="$3"
  local details="${4:-}"
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Initialize log file if it doesn't exist
  if [[ ! -f "$AUDIT_LOG" ]]; then
    echo '{"deployment":{"created_at":"'"$timestamp"'","region":"'"$REGION"'","account":"unknown"},"resources":[],"actions":[]}' > "$AUDIT_LOG"
  fi

  # Append action to log using node (available on most dev machines)
  node -e "
    const fs = require('fs');
    const log = JSON.parse(fs.readFileSync('$AUDIT_LOG', 'utf-8'));
    log.actions.push({
      timestamp: '$timestamp',
      action: '$action',
      resource_type: '$resource_type',
      resource_id: '$resource_id',
      details: '$details'
    });
    if ('$action' === 'CREATE') {
      log.resources.push({
        type: '$resource_type',
        id: '$resource_id',
        region: '$REGION',
        created_at: '$timestamp',
        details: '$details',
        destroyed: false
      });
    }
    if ('$action' === 'DESTROY') {
      log.resources = log.resources.map(r =>
        r.id === '$resource_id' ? { ...r, destroyed: true, destroyed_at: '$timestamp' } : r
      );
    }
    fs.writeFileSync('$AUDIT_LOG', JSON.stringify(log, null, 2));
  " 2>/dev/null || true
}

# Helper: get the public IP
get_ip() {
  if [[ -f "$EIP_IP_FILE" ]]; then
    cat "$EIP_IP_FILE"
  else
    echo "ERROR: No Elastic IP found. Run 00-provision.sh first." >&2
    exit 1
  fi
}

# Helper: SSH into the instance
run_ssh() {
  ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "${REMOTE_USER}@$(get_ip)" "$@"
}

# Helper: SCP to the instance
run_scp() {
  scp -o StrictHostKeyChecking=no -i "$SSH_KEY" "$@"
}

echo_step() {
  echo ""
  echo "==> $1"
  echo ""
}
