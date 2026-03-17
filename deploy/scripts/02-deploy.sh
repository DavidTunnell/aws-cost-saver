#!/usr/bin/env bash
# Build Docker image, transfer to EC2, and start/restart the app
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

# Navigate to repo root (two levels up from deploy/scripts/)
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IP=$(get_ip)

echo_step "Building Docker image"
docker build -f "$REPO_ROOT/deploy/Dockerfile" -t "$APP_NAME:latest" "$REPO_ROOT"

echo_step "Saving and compressing Docker image"
TMPFILE="/tmp/${APP_NAME}.tar.gz"
docker save "$APP_NAME:latest" | gzip > "$TMPFILE"
IMAGE_SIZE=$(du -h "$TMPFILE" | cut -f1)
echo "Image size: ${IMAGE_SIZE}"

echo_step "Transferring image to EC2 ($IP)"
run_scp "$TMPFILE" "${REMOTE_USER}@${IP}:/tmp/${APP_NAME}.tar.gz"

echo_step "Transferring compose files"
run_scp "$REPO_ROOT/deploy/docker-compose.yml" "${REMOTE_USER}@${IP}:${REMOTE_DIR}/docker-compose.yml"
run_scp "$REPO_ROOT/deploy/Caddyfile" "${REMOTE_USER}@${IP}:${REMOTE_DIR}/Caddyfile"

echo_step "Loading image and starting containers"
# Note: unquoted heredoc — variables expand locally from _common.sh (intentional)
run_ssh << REMOTE_SCRIPT
set -euo pipefail
cd ${REMOTE_DIR}

# Load the Docker image
echo "Loading Docker image..."
docker load < /tmp/${APP_NAME}.tar.gz
rm -f /tmp/${APP_NAME}.tar.gz

# Start or restart containers
echo "Starting containers..."
docker compose up -d --force-recreate

echo ""
echo "Container status:"
docker compose ps
REMOTE_SCRIPT

# Clean up local temp file
rm -f "$TMPFILE"

echo_step "Verifying deployment"
sleep 5
if run_ssh "curl -sf http://localhost/api/health" >/dev/null 2>&1; then
  echo "Health check passed!"
else
  echo "WARNING: Health check failed. Check logs with:"
  echo "  ssh -i $SSH_KEY ${REMOTE_USER}@${IP} 'cd ${REMOTE_DIR} && docker compose logs app'"
fi

echo ""
echo "============================================"
echo "  Deployment complete!"
echo "============================================"
echo ""
echo "  App URL:     http://${IP}"
echo "  Health check: http://${IP}/api/health"
echo "  SSH:         ssh -i $SSH_KEY ${REMOTE_USER}@${IP}"
echo ""
echo "  To view logs: ssh -i $SSH_KEY ${REMOTE_USER}@${IP} 'cd ${REMOTE_DIR} && docker compose logs -f app'"
echo ""
