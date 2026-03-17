#!/usr/bin/env bash
# Shared configuration for all deploy scripts
set -euo pipefail

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

mkdir -p "$STATE_DIR"

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
