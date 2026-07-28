FROM node:22-bookworm-slim

ARG CODEX_PACKAGE=@openai/codex@0.144.1
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

RUN npm install -g "${CODEX_PACKAGE}" \
  && codex --version \
  && gh --version \
  && gitleaks version

# A task-scoped credential clone is mounted read-write at runtime under
# /run/secrets/codex-dir. The host runner validates and atomically writes back
# only a compatible refreshed auth.json; credentials never enter image layers
# or task artifacts.
LABEL org.openclaw.a2a-docker-runner.harness="codex" \
  org.openclaw.a2a-docker-runner.codex.package="${CODEX_PACKAGE}"

WORKDIR /work
