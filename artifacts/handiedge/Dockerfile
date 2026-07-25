# HandiEdge — build from the repo root:
#   docker build -f artifacts/handiedge/Dockerfile -t handiedge .
#   docker run --rm -p 8080:8080 handiedge                       # API
#   docker run --rm handiedge pnpm --filter @workspace/handiedge run run --date 2026-07-25
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# Install workspace dependencies (context is the repo root).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY lib ./lib
COPY artifacts/handiedge ./artifacts/handiedge
RUN pnpm install --filter @workspace/handiedge... --config.confirmModulesPurge=false || pnpm install

# Bake a trained model into the image so it's usable immediately.
WORKDIR /app/artifacts/handiedge
RUN pnpm run make-history && pnpm run train

ENV HANDIEDGE_SOURCE=fixture
ENV PORT=8080
EXPOSE 8080
CMD ["pnpm", "run", "serve"]
