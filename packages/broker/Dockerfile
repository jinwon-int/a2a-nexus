FROM node:22-alpine AS deps
WORKDIR /app/packages/broker
COPY packages/broker/package.json packages/broker/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM deps AS build
WORKDIR /app/packages/broker
COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/broker/tsconfig.json ./
COPY packages/broker/src ./src
COPY packages/broker/scripts/generate-build-info.mjs ./scripts/generate-build-info.mjs
RUN npm run build

FROM node:22-alpine AS runtime
ARG A2A_BROKER_VERSION=0.1.0
ARG A2A_BROKER_REVISION
ARG A2A_BROKER_CREATED
ARG A2A_BROKER_IMAGE_SOURCE=https://github.com/jinwon-int/a2a-nexus
# Production images must carry real provenance. Operators can still build local
# dev images by passing an explicit non-production revision/created pair, but the
# image no longer silently reports "unknown" or an empty build timestamp.
RUN test -n "$A2A_BROKER_REVISION" \
  && test "$A2A_BROKER_REVISION" != "unknown" \
  && test -n "$A2A_BROKER_CREATED"
LABEL org.opencontainers.image.source=$A2A_BROKER_IMAGE_SOURCE \
      org.opencontainers.image.version=$A2A_BROKER_VERSION \
      org.opencontainers.image.revision=$A2A_BROKER_REVISION \
      org.opencontainers.image.created=$A2A_BROKER_CREATED
WORKDIR /app
ENV NODE_ENV=production \
    A2A_BROKER_VERSION=$A2A_BROKER_VERSION \
    A2A_BROKER_REVISION=$A2A_BROKER_REVISION \
    A2A_BROKER_BUILT_AT=$A2A_BROKER_CREATED \
    A2A_BROKER_SOURCE=github.com/jinwon-int/a2a-nexus \
    A2A_BROKER_RUNTIME=docker
COPY packages/broker/package.json packages/broker/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY --from=build /app/packages/broker/dist ./dist
COPY packages/broker/scripts/generate-build-info.mjs ./scripts/generate-build-info.mjs
COPY packages/broker/scripts/export-sqlite-state.mjs ./scripts/export-sqlite-state.mjs
# Generate dist/build-info.json from Docker build ARGs so /health.build.revision
# and org.opencontainers.image.revision use the actual build-time values.
RUN node scripts/generate-build-info.mjs --runtime docker
COPY packages/broker/scripts/a2a-task-handler.mjs ./scripts/a2a-task-handler.mjs
COPY packages/broker/scripts/worker-model-policy.mjs ./scripts/worker-model-policy.mjs
COPY packages/broker/scripts/hermes-a2a-analysis-bridge.mjs ./scripts/hermes-a2a-analysis-bridge.mjs
RUN mkdir -p /var/lib/a2a-broker ./handlers \
  && cp scripts/a2a-task-handler.mjs ./handlers/a2a-task-handler.mjs \
  && cp scripts/worker-model-policy.mjs ./handlers/worker-model-policy.mjs \
  && cp scripts/hermes-a2a-analysis-bridge.mjs ./handlers/hermes-a2a-analysis-bridge.mjs \
  && chown -R node:node /app /var/lib/a2a-broker
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
