# Dev Boards — production-ish Node image (Nitro build output).
# Prefer docker compose for local Postgres wiring.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

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
