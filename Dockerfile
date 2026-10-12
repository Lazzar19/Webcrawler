# syntax=docker/dockerfile:1

# Node major version matches backend/.nvmrc.
# The deps stage is discarded. The runtime image keeps production
# packages only, so Jest and ESLint stay out.

FROM node:24-bookworm-slim AS deps
WORKDIR /src
RUN --mount=type=bind,source=backend/package.json,target=package.json \
    --mount=type=bind,source=backend/package-lock.json,target=package-lock.json \
    --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

RUN groupadd --gid 1001 appgroup \
    && useradd --uid 1001 --gid appgroup --no-create-home --shell /usr/sbin/nologin appuser

COPY --from=deps --link --chown=1001:1001 /src/node_modules ./backend/node_modules
COPY --link --chown=1001:1001 backend/package.json ./backend/package.json
COPY --link --chown=1001:1001 backend/src ./backend/src
COPY --link --chown=1001:1001 backend/tests/fixtures/demo.js backend/tests/fixtures/server.js ./backend/tests/fixtures/

USER appuser

LABEL org.opencontainers.image.source="https://github.com/Lazzar19/webcrawler"
LABEL org.opencontainers.image.title="webcrawler"

ENTRYPOINT ["node", "backend/tests/fixtures/demo.js"]
