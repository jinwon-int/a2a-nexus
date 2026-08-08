FROM node:22-alpine AS deps
WORKDIR /app
# Workspace-aware install: the broker depends on the in-repo
# a2a-policy-referee package (#1601 P1), so installs must run at the
# monorepo root with the root lockfile.
COPY package.json package-lock.json ./
COPY packages/broker/package.json packages/broker/
COPY packages/policy-referee/package.json packages/policy-referee/
COPY packages/attestation/package.json packages/attestation/
RUN npm ci --include=dev -w packages/broker -w packages/policy-referee -w packages/attestation

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/policy-referee/tsconfig.json packages/policy-referee/
COPY packages/policy-referee/src packages/policy-referee/src
COPY packages/attestation/tsconfig.json packages/attestation/
COPY packages/attestation/src packages/attestation/src
COPY packages/broker/tsconfig.json packages/broker/
COPY packages/broker/src packages/broker/src
COPY packages/broker/scripts/generate-build-info.mjs packages/broker/scripts/generate-build-info.mjs
# #1766: generate-build-info verifies any claimed revision through the shared
# preflight evaluator, so the evaluator must travel with it. `.git` is not in
# the image, so the evaluator reports "unverifiable" here by design — the
# fail-closed comparison happens on the host that starts the image build.
COPY packages/broker/scripts/check-build-revision.mjs packages/broker/scripts/check-build-revision.mjs
# tsc -b builds the policy-referee reference first (composite project refs).
RUN npm run build -w packages/broker

FROM node:22-alpine AS runtime
ARG A2A_BROKER_VERSION=0.1.0
ARG A2A_BROKER_REVISION
ARG A2A_BROKER_CREATED
ARG A2A_BROKER_IMAGE_SOURCE=https://github.com/jinwon-int/a2a-nexus
# #1766: did scripts/check-build-revision.mjs verify A2A_BROKER_REVISION against
# git HEAD for this build? Defaults to false so an image can never claim
# verification it did not get; `npm run build:image -w packages/broker` sets it.
ARG A2A_BROKER_REVISION_VERIFIED=false
# Production images must carry real provenance. Operators can still build local
# dev images by passing an explicit non-production revision/created pair, but the
# image no longer silently reports "unknown" or an empty build timestamp.
# The shape assertions are additive (#1766): a revision that is not a git SHA
# cannot be checked against the tree that produced it, so it is not provenance.
RUN test -n "$A2A_BROKER_REVISION" \
  && test "$A2A_BROKER_REVISION" != "unknown" \
  && test -n "$A2A_BROKER_CREATED" \
  && printf '%s' "$A2A_BROKER_REVISION" | grep -Eq '^[0-9a-f]{7,40}(-dirty)?$' \
  && { test "$A2A_BROKER_REVISION_VERIFIED" = "true" || test "$A2A_BROKER_REVISION_VERIFIED" = "false"; }
LABEL org.opencontainers.image.source=$A2A_BROKER_IMAGE_SOURCE \
      org.opencontainers.image.version=$A2A_BROKER_VERSION \
      org.opencontainers.image.revision=$A2A_BROKER_REVISION \
      org.opencontainers.image.created=$A2A_BROKER_CREATED \
      dev.a2a.image.revision-verified=$A2A_BROKER_REVISION_VERIFIED
WORKDIR /app
ENV NODE_ENV=production \
    A2A_BROKER_VERSION=$A2A_BROKER_VERSION \
    A2A_BROKER_REVISION=$A2A_BROKER_REVISION \
    A2A_BROKER_REVISION_VERIFIED=$A2A_BROKER_REVISION_VERIFIED \
    A2A_BROKER_BUILT_AT=$A2A_BROKER_CREATED \
    A2A_BROKER_SOURCE=github.com/jinwon-int/a2a-nexus \
    A2A_BROKER_RUNTIME=docker
COPY package.json package-lock.json ./
COPY packages/broker/package.json packages/broker/
COPY packages/policy-referee/package.json packages/policy-referee/
COPY packages/attestation/package.json packages/attestation/
RUN npm ci --omit=dev -w packages/broker -w packages/policy-referee -w packages/attestation
COPY --from=build /app/packages/broker/dist ./packages/broker/dist
COPY --from=build /app/packages/policy-referee/dist ./packages/policy-referee/dist
COPY --from=build /app/packages/attestation/dist ./packages/attestation/dist
COPY packages/broker/scripts/generate-build-info.mjs ./packages/broker/scripts/generate-build-info.mjs
COPY packages/broker/scripts/check-build-revision.mjs ./packages/broker/scripts/check-build-revision.mjs
COPY packages/broker/scripts/export-sqlite-state.mjs ./packages/broker/scripts/export-sqlite-state.mjs
COPY packages/broker/scripts/lib ./packages/broker/scripts/lib
# Generate dist/build-info.json from Docker build ARGs so /health.build.revision
# and org.opencontainers.image.revision use the actual build-time values.
RUN cd packages/broker && node scripts/generate-build-info.mjs --runtime docker
COPY packages/broker/scripts/a2a-task-handler.mjs ./packages/broker/scripts/a2a-task-handler.mjs
COPY packages/broker/scripts/worker-model-policy.mjs ./packages/broker/scripts/worker-model-policy.mjs
COPY packages/broker/scripts/hermes-a2a-analysis-bridge.mjs ./packages/broker/scripts/hermes-a2a-analysis-bridge.mjs
RUN mkdir -p /var/lib/a2a-broker ./handlers ./handlers/lib \
  && cp packages/broker/scripts/a2a-task-handler.mjs ./handlers/a2a-task-handler.mjs \
  && cp packages/broker/scripts/worker-model-policy.mjs ./handlers/worker-model-policy.mjs \
  && cp packages/broker/scripts/lib/source-carriers.mjs ./handlers/lib/source-carriers.mjs \
  && cp packages/broker/scripts/lib/retrieval-snapshot-carriers.mjs ./handlers/lib/retrieval-snapshot-carriers.mjs \
  && cp packages/broker/scripts/lib/live-operation-adapter.mjs ./handlers/lib/live-operation-adapter.mjs \
  && cp packages/broker/scripts/hermes-a2a-analysis-bridge.mjs ./handlers/hermes-a2a-analysis-bridge.mjs \
  && chown -R node:node /app /var/lib/a2a-broker
USER node
EXPOSE 8787
CMD ["node", "packages/broker/dist/server.js"]
