# Dev Boards — production-ish Node image (Nitro build output).
# Prefer docker compose for local Postgres wiring.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# git + ssh are for scripts/sync-private.mjs: the private recipe modules are cloned
# from github.com:GumbyEnder/beezilla-recipes with a read-only deploy key during
# `prebuild`. Debian slim ships neither, and RAILPACK's generated image cannot be
# told to install them — a missing git there failed five deploys and then shipped a
# stub build. This Dockerfile is the build definition because it can say `apt-get`.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends git openssh-client >/dev/null \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Build-time only. Declared as ARG (not ENV) so the key is not in the image env.
ARG BZ_PRIVATE_DEPLOY_KEY
ARG BZ_REQUIRE_PRIVATE=1
RUN npm run build \
 && rm -rf /app/.private

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV NITRO_HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/.output ./.output
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/migrations ./migrations
# Public SKILL.md served at GET /api/agent/skill.md
COPY --from=build /app/skills ./skills

EXPOSE 8080
# migrate then serve (same as npm start)
CMD ["npm", "run", "start"]
