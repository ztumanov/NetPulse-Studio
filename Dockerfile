# ==============================================================================
# Stage 1: Build & Test Stage (Node.js 22 Alpine)
# ==============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package manifests first for optimal Docker layer caching
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --no-audit --no-fund

# Copy application source code
COPY . .

# Run the 39 L1-L7 network simulator unit tests before building production bundle
RUN npx tsx --test src/network/simulator.test.ts

# Build production static bundle into /app/dist
RUN npm run build

# ==============================================================================
# Stage 2: Production Web Server Stage (Nginx Alpine)
# ==============================================================================
FROM nginx:1.27-alpine AS production

# Copy custom Nginx configuration (SPA routing + Gzip + cache headers)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy compiled static assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
