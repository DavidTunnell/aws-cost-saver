#!/usr/bin/env bash
# Configure the EC2 instance: install Docker, create app directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

IP=$(get_ip)

echo_step "Waiting for SSH to be available on $IP..."
SSH_READY=false
for i in $(seq 1 30); do
  if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -i "$SSH_KEY" "${REMOTE_USER}@${IP}" "echo ready" 2>/dev/null; then
    SSH_READY=true
    break
  fi
  echo "  Attempt $i/30 — waiting..."
  sleep 5
done
if [[ "$SSH_READY" != "true" ]]; then
  echo "ERROR: SSH not available after 150 seconds. Check security group, key pair, and instance status." >&2
  exit 1
fi

echo_step "Installing Docker on EC2 instance"
run_ssh << 'REMOTE_SCRIPT'
set -euo pipefail

# Install Docker
sudo yum update -y
sudo yum install -y docker
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker $USER

# Install Docker Compose plugin
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

echo "Docker version: $(docker --version)"
echo "Docker Compose version: $(docker compose version)"
REMOTE_SCRIPT

echo_step "Creating app directory"
run_ssh "mkdir -p ${REMOTE_DIR}/data"

echo_step "Setting up .env file"
# Check if .env already exists on the server
if run_ssh "test -f ${REMOTE_DIR}/.env" 2>/dev/null; then
  echo ".env file already exists on the server. Skipping."
else
  echo "Creating .env file on the server..."
  echo ""
  echo "You need to provide the following:"
  echo ""

  read -rp "  ANTHROPIC_API_KEY: " ANTHROPIC_KEY
  MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" 2>/dev/null || \
               python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || \
               openssl rand -hex 32)

  run_ssh "cat > ${REMOTE_DIR}/.env << EOF
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
MASTER_ENCRYPTION_KEY=${MASTER_KEY}
NODE_ENV=production
PORT=8000
EOF
chmod 600 ${REMOTE_DIR}/.env"

  echo ""
  echo "  MASTER_ENCRYPTION_KEY has been auto-generated."
  echo "  IMPORTANT: Save this key! If lost, encrypted AWS credentials become unreadable."
  echo "  Key: ${MASTER_KEY}"
  echo ""
fi

echo ""
echo "============================================"
echo "  EC2 instance configured successfully!"
echo "============================================"
echo ""
echo "  Next step: ./02-deploy.sh"
echo ""
