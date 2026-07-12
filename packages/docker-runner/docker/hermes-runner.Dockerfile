FROM node:22-bookworm-slim

ARG HERMES_REPO=https://github.com/NousResearch/hermes-agent.git
ARG HERMES_REF=9de9c25f620ff7f1ce0fd5457d596052d5159596
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
    python3-venv \
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

RUN git clone "$HERMES_REPO" /usr/local/lib/hermes-agent \
  && cd /usr/local/lib/hermes-agent \
  && git checkout "$HERMES_REF" \
  && python3 -m venv /usr/local/lib/hermes-agent/venv \
  && /usr/local/lib/hermes-agent/venv/bin/python -m pip install --upgrade pip \
  && /usr/local/lib/hermes-agent/venv/bin/pip install -e /usr/local/lib/hermes-agent

RUN printf '%s\n' \
  '#!/usr/bin/env bash' \
  'unset PYTHONPATH' \
  'unset PYTHONHOME' \
  'exec "/usr/local/lib/hermes-agent/venv/bin/hermes" "$@"' \
  > /usr/local/bin/hermes \
  && chmod 0755 /usr/local/bin/hermes \
  && hermes --version \
  && gh --version \
  && gitleaks version

LABEL org.openclaw.a2a-docker-runner.harness="hermes" \
  org.openclaw.a2a-docker-runner.hermes.ref="${HERMES_REF}"

WORKDIR /work
