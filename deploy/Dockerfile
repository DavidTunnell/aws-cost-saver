# Stage 1: Build frontend and backend
FROM node:20-bookworm AS builder

WORKDIR /app

# Build frontend
COPY frontend/package*.json frontend/
RUN cd frontend && npm ci
COPY frontend/ frontend/
RUN cd frontend && npx vite build

# Build backend (better-sqlite3 needs build tools — included in bookworm)
COPY backend/package*.json backend/
RUN cd backend && npm ci
COPY backend/ backend/
RUN cd backend && npm run build

# Stage 2: Slim runtime image
FROM node:20-bookworm-slim

# Install AWS CLI (needed by solutions route which uses execSync with aws commands)
RUN apt-get update && apt-get install -y --no-install-recommends \
    awscli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

# Copy compiled backend and production node_modules
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/node_modules ./node_modules
COPY --from=builder /app/backend/package.json ./

# Copy built frontend
COPY --from=builder /app/frontend/dist ../frontend/dist

# Data directory will be bind-mounted from host for persistence
RUN mkdir -p /app/backend/data

ENV NODE_ENV=production
ENV PORT=8000
EXPOSE 8000

CMD ["node", "dist/index.js"]
