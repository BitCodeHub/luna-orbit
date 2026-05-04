# Luna Orbit — production container.
#
# Multi-stage build. Final image is ~1.5GB because Chromium (via
# agent-browser) is huge but unavoidable for a real browser-driver.
#
#   docker build -t lumen/luna-orbit .
#   docker run -p 8780:8780 -v luna-data:/data lumen/luna-orbit
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Copy package metadata + install with dev deps for the build step.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY plans ./plans
COPY README.md LICENSE ./
RUN npm run build

# Drop dev deps for the runtime image.
RUN npm prune --omit=dev

# ────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Chromium runtime libs — required by agent-browser's bundled Playwright Chrome.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 \
    libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
    xdg-utils libcurl4 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/plans ./plans
COPY --from=build /app/package.json ./
COPY --from=build /app/README.md /app/LICENSE ./

# Pre-download Chromium so it's baked into the image — first request is fast.
RUN node ./node_modules/.bin/agent-browser install --with-deps || \
    node ./node_modules/.bin/agent-browser install || true

ENV NODE_ENV=production
ENV LUNA_ORBIT_DATA_DIR=/data
EXPOSE 8780
VOLUME /data

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve", "--port", "8780", "--data-dir", "/data", "--max-parallel", "2"]
