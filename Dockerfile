# Milkore API — multi-stage build (Node 22 LTS, non-root runtime).
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild sharp @prisma/engines prisma
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npm run build \
  && npx tsc prisma/seed.ts --outDir dist-seed --module commonjs --target es2022 --esModuleInterop --skipLibCheck \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl tini && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 milkore && mkdir -p /app/uploads && chown milkore /app/uploads
COPY --from=build --chown=milkore /app/node_modules ./node_modules
COPY --from=build --chown=milkore /app/dist ./dist
COPY --from=build --chown=milkore /app/dist-seed ./dist-seed
COPY --from=build --chown=milkore /app/prisma ./prisma
COPY --from=build --chown=milkore /app/package.json ./package.json
USER milkore
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
# Migrations run as a separate one-off step in deploy (see docs/DEPLOYMENT.md), never on every start.
CMD ["node", "dist/main.js"]
