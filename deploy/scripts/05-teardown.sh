#!/usr/bin/env bash
# Destroy all AWS resources created by 00-provision.sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

echo ""
echo "WARNING: This will permanently destroy:"
echo "  - EC2 instance and its EBS volume"
echo "  - Elastic IP address"
echo "  - Security group"
echo "  - All data on the server (run 03-backup-db.sh first!)"
echo ""
read -rp "Type 'destroy' to confirm: " CONFIRM
if [[ "$CONFIRM" != "destroy" ]]; then
  echo "Aborted."
  exit 0
fi

# Terminate EC2 instance
if [[ -f "$INSTANCE_ID_FILE" ]]; then
  INSTANCE_ID=$(cat "$INSTANCE_ID_FILE")
  echo_step "Terminating EC2 instance: $INSTANCE_ID"
  aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID" 2>/dev/null || true
  echo "Waiting for instance to terminate..."
  aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$INSTANCE_ID" 2>/dev/null || true
  rm -f "$INSTANCE_ID_FILE"
  echo "Instance terminated."
fi

# Release Elastic IP
if [[ -f "$EIP_ALLOC_FILE" ]]; then
  EIP_ALLOC=$(cat "$EIP_ALLOC_FILE")
  echo_step "Releasing Elastic IP: $EIP_ALLOC"
  aws ec2 release-address --region "$REGION" --allocation-id "$EIP_ALLOC" 2>/dev/null || true
  rm -f "$EIP_ALLOC_FILE" "$EIP_IP_FILE"
  echo "Elastic IP released."
fi

# Delete security group
if [[ -f "$SG_ID_FILE" ]]; then
  SG_ID=$(cat "$SG_ID_FILE")
  echo_step "Deleting security group: $SG_ID"
  # Wait a moment for ENIs to detach
  sleep 5
  aws ec2 delete-security-group --region "$REGION" --group-id "$SG_ID" 2>/dev/null || {
    echo "  Could not delete security group (may still have dependencies). Try again later."
  }
  rm -f "$SG_ID_FILE"
fi

echo ""
echo "============================================"
echo "  All resources destroyed."
echo "============================================"
echo ""
