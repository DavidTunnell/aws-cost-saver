#!/usr/bin/env bash
# Provision EC2 instance, security group, and Elastic IP
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

echo_step "Creating security group: ${SECURITY_GROUP_NAME}"

# Get default VPC
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters "Name=isDefault,Values=true" \
  --query "Vpcs[0].VpcId" --output text)

if [[ "$VPC_ID" == "None" || -z "$VPC_ID" ]]; then
  echo "ERROR: No default VPC found in region $REGION. Create one or specify a VPC." >&2
  exit 1
fi

# Create security group
SG_ID=$(aws ec2 create-security-group --region "$REGION" \
  --group-name "$SECURITY_GROUP_NAME" \
  --description "AWS Cost Saver - web app access" \
  --vpc-id "$VPC_ID" \
  --query "GroupId" --output text 2>/dev/null) || {
  # Already exists — look it up
  SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=group-name,Values=$SECURITY_GROUP_NAME" \
    --query "SecurityGroups[0].GroupId" --output text)
  echo "Security group already exists: $SG_ID"
}

echo "$SG_ID" > "$SG_ID_FILE"

# Add ingress rules (ignore errors if rules already exist)
# HTTP/HTTPS open to the world, SSH restricted to deployer's IP
MY_IP=$(curl -s https://checkip.amazonaws.com 2>/dev/null || echo "0.0.0.0")
SSH_CIDR="${MY_IP}/32"
if [[ "$MY_IP" == "0.0.0.0" ]]; then
  echo "  WARNING: Could not detect your IP. Opening SSH to 0.0.0.0/0"
  SSH_CIDR="0.0.0.0/0"
else
  echo "  Restricting SSH to your IP: $MY_IP"
fi

aws ec2 authorize-security-group-ingress --region "$REGION" \
  --group-id "$SG_ID" \
  --protocol tcp --port 22 --cidr "$SSH_CIDR" 2>/dev/null || true
for PORT in 80 443; do
  aws ec2 authorize-security-group-ingress --region "$REGION" \
    --group-id "$SG_ID" \
    --protocol tcp --port "$PORT" --cidr 0.0.0.0/0 2>/dev/null || true
done
echo "Security group configured: $SG_ID"

echo_step "Resolving AMI for Amazon Linux 2023"
AMI_ID=$(aws ssm get-parameters --region "$REGION" \
  --names "$AMI_SSM_PARAM" \
  --query "Parameters[0].Value" --output text)
echo "AMI: $AMI_ID"

echo_step "Launching EC2 instance: ${INSTANCE_TYPE}"

# Check if key pair exists
aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" >/dev/null 2>&1 || {
  echo "ERROR: SSH key pair '$KEY_NAME' not found in region $REGION."
  echo "Create one with: aws ec2 create-key-pair --region $REGION --key-name $KEY_NAME --query KeyMaterial --output text > ~/.ssh/${KEY_NAME}.pem && chmod 600 ~/.ssh/${KEY_NAME}.pem"
  exit 1
}

INSTANCE_ID=$(aws ec2 run-instances --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":${VOLUME_SIZE},\"VolumeType\":\"gp3\"}}]" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${APP_NAME}}]" \
  --query "Instances[0].InstanceId" --output text)

echo "$INSTANCE_ID" > "$INSTANCE_ID_FILE"
echo "Instance launched: $INSTANCE_ID"

echo_step "Waiting for instance to be running..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
echo "Instance is running."

echo_step "Allocating Elastic IP"
EIP_ALLOC=$(aws ec2 allocate-address --region "$REGION" \
  --domain vpc \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=${APP_NAME}}]" \
  --query "AllocationId" --output text)
echo "$EIP_ALLOC" > "$EIP_ALLOC_FILE"

EIP_IP=$(aws ec2 associate-address --region "$REGION" \
  --instance-id "$INSTANCE_ID" \
  --allocation-id "$EIP_ALLOC" \
  --query "AssociationId" --output text >/dev/null && \
  aws ec2 describe-addresses --region "$REGION" \
    --allocation-ids "$EIP_ALLOC" \
    --query "Addresses[0].PublicIp" --output text)
echo "$EIP_IP" > "$EIP_IP_FILE"

echo ""
echo "============================================"
echo "  EC2 instance provisioned successfully!"
echo "============================================"
echo ""
echo "  Instance ID:  $INSTANCE_ID"
echo "  Public IP:    $EIP_IP"
echo "  Region:       $REGION"
echo "  SSH command:  ssh -i $SSH_KEY ${REMOTE_USER}@${EIP_IP}"
echo ""
echo "  Next step:    ./01-configure.sh"
echo ""
