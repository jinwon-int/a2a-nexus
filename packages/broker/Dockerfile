FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
COPY scripts/generate-build-info.mjs ./scripts/generate-build-info.mjs
RUN npm run build

FROM node:22-alpine AS runtime
ARG A2A_BROKER_VERSION=0.1.0
ARG A2A_BROKER_REVISION=unknown
ARG A2A_BROKER_CREATED
ARG A2A_BROKER_IMAGE_SOURCE=https://github.com/jinwon-int/a2a-broker
LABEL org.opencontainers.image.source=$A2A_BROKER_IMAGE_SOURCE \
      org.opencontainers.image.version=$A2A_BROKER_VERSION \
      org.opencontainers.image.revision=$A2A_BROKER_REVISION \
      org.opencontainers.image.created=$A2A_BROKER_CREATED
WORKDIR /app
ENV NODE_ENV=production \
    A2A_BROKER_VERSION=$A2A_BROKER_VERSION \
    A2A_BROKER_REVISION=$A2A_BROKER_REVISION \
    A2A_BROKER_BUILT_AT=$A2A_BROKER_CREATED \
    A2A_BROKER_SOURCE=github.com/jinwon-int/a2a-broker \
    A2A_BROKER_RUNTIME=docker
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY --from=build /app/dist ./dist
COPY scripts/generate-build-info.mjs ./scripts/generate-build-info.mjs
COPY scripts/export-sqlite-state.mjs ./scripts/export-sqlite-state.mjs
# Generate dist/build-info.json from Docker build ARGs so /health.build.revision
# and org.opencontainers.image.revision use the actual build-time values.
RUN node scripts/generate-build-info.mjs --runtime docker
COPY scripts/a2a-task-handler.mjs ./scripts/a2a-task-handler.mjs
COPY scripts/openclaw-a2a-task-handler.mjs ./scripts/openclaw-a2a-task-handler.mjs
COPY scripts/hermes-a2a-analysis-bridge.mjs ./scripts/hermes-a2a-analysis-bridge.mjs
RUN mkdir -p ./handlers \
  && cp scripts/a2a-task-handler.mjs ./handlers/a2a-task-handler.mjs \
  && cp scripts/openclaw-a2a-task-handler.mjs ./handlers/openclaw-a2a-task-handler.mjs \
  && cp scripts/hermes-a2a-analysis-bridge.mjs ./handlers/hermes-a2a-analysis-bridge.mjs
EXPOSE 8787
CMD ["node", "dist/server.js"]
