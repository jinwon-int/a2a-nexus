FROM node:22-bookworm-slim

ARG PIRI_REPO=https://github.com/jinwon-int/piri.git
# Pinned distribution tag (jinwon-int/piri), not a moving branch: image
# builds stay reproducible and the baked harness revision is auditable.
# Bump deliberately via PR when piri ships a new distribution tag.
ARG PIRI_REF=v0.83.0-piri.1
ARG GH_VERSION=2.93.0
ARG GITLEAKS_VERSION=8.30.1

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    openssh-client \
    python3 \
    ripgrep \
    tar \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) gh_arch=amd64; gitleaks_arch=x64 ;; \
    arm64) gh_arch=arm64; gitleaks_arch=arm64 ;; \
    *) echo "unsupported tool architecture: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${gh_arch}.tar.gz" -o /tmp/gh.tgz; \
  tar -C /tmp -xzf /tmp/gh.tgz; \
  install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/bin/gh; \
  curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${gitleaks_arch}.tar.gz" -o /tmp/gitleaks.tgz; \
  tar -C /tmp -xzf /tmp/gitleaks.tgz gitleaks; \
  install -m 0755 /tmp/gitleaks /usr/bin/gitleaks; \
  rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_${gh_arch}" /tmp/gitleaks.tgz /tmp/gitleaks

# Piri is the fleet-owned harness (jinwon-int/piri), built from a pinned ref
# instead of an npm artifact. The monorepo build produces dist/cli.js for every
# workspace package in dependency order.
# Piri is the fleet-owned harness (jinwon-int/piri), built from a pinned ref
# instead of an npm artifact. The monorepo build produces dist/cli.js for every
# workspace package in dependency order. cli.js imports sibling dist modules,
# so expose it via a symlink (Node resolves the real path for relative imports)
# rather than copying the file alone.
RUN git clone --depth 1 --branch "${PIRI_REF}" "${PIRI_REPO}" /opt/piri \
  && cd /opt/piri \
  && npm ci --ignore-scripts \
  && npm run build \
  && ln -sf /opt/piri/packages/coding-agent/dist/cli.js /usr/local/bin/piri \
  && piri --version \
  && gh --version \
  && gitleaks version

# A2A analysis output contract for `piri -p --output-schema` (Phase 0 item 1,
# jinwon-int/a2a-nexus#1745; schema support landed in jinwon-int/piri#6).
# Baked to a well-known path; the runner command script picks it up by default
# (A2A_PIRI_OUTPUT_SCHEMA overrides, "off" disables for canary comparisons).
COPY --chmod=0644 docker/piri-analysis-output.schema.json /etc/a2a-runner/piri-analysis-output.schema.json
# BuildKit applies the COPY --chmod value to the auto-created parent directory
# too; restore the traverse bit so non-root container users can read the file.
RUN chmod 0755 /etc/a2a-runner

# Record the resolved piri commit so a built image is auditable even when
# PIRI_REF names a tag or branch instead of a commit.
RUN cd /opt/piri && git rev-parse HEAD > /etc/a2a-runner/piri-revision

# Piri credentials are mounted at runtime as a read-only directory under
# /run/secrets/piri-dir (agent/auth.json); the command script runs against a
# container-local copy, so credentials never enter image layers or artifacts.
LABEL org.openclaw.a2a-docker-runner.harness="piri" \
  org.openclaw.a2a-docker-runner.piri.ref="${PIRI_REF}"

WORKDIR /work
