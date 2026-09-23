# AuthForge — production image (multi-stage, Next.js standalone output).
# Build from the repo root:  docker build -f deploy/Dockerfile -t authforge .

FROM node:22-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# The glob keeps the build working when the lockfile is absent (e.g. a source
# archive that stripped it); `npm ci` is still preferred for reproducibility.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else \
      echo "WARNING: package-lock.json missing — falling back to 'npm install' (non-reproducible build)"; \
      npm install; \
    fi
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN groupadd -r authforge && useradd -r -g authforge authforge
# standalone server already bundles the traced node_modules (incl. pg)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY scripts/migrate.mjs ./scripts/migrate.mjs
USER authforge
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
