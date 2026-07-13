FROM node:22-bookworm-slim

ARG A2A_NEXUS_REPO=https://github.com/jinwon-int/a2a-nexus.git
ARG A2A_NEXUS_REF=main
ARG CLAUDE_CODE_PACKAGE=@anthropic-ai/claude-code
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

RUN npm install -g "${CLAUDE_CODE_PACKAGE}" \
  && claude --version \
  && gh --version \
  && gitleaks version

# The runner image contains only the bridge executable. Claude credentials are mounted at runtime
# via /run/secrets/claude-dir and are never baked into image layers.
RUN set -eux; \
  git clone --filter=blob:none --no-checkout "$A2A_NEXUS_REPO" /tmp/a2a-nexus; \
  cd /tmp/a2a-nexus; \
  git checkout "$A2A_NEXUS_REF"; \
  install -d -m 0755 /opt/a2a-broker/scripts; \
  install -m 0755 packages/broker/scripts/claude-a2a-patch-bridge.mjs /opt/a2a-broker/scripts/claude-a2a-patch-bridge.mjs; \
  install -m 0755 packages/broker/scripts/finalizer-tool-policy.mjs /opt/a2a-broker/scripts/finalizer-tool-policy.mjs; \
  node --input-type=module -e "import('/opt/a2a-broker/scripts/claude-a2a-patch-bridge.mjs')"; \
  rm -rf /tmp/a2a-nexus

LABEL org.openclaw.a2a-docker-runner.harness="claude-code" \
  org.openclaw.a2a-docker-runner.cccb.ref="${A2A_NEXUS_REF}" \
  org.openclaw.a2a-docker-runner.claude.package="${CLAUDE_CODE_PACKAGE}"

WORKDIR /work
