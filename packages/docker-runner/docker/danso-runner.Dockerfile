# syntax=docker/dockerfile:1
#
# Runner image for the docker-runner `danso` patch profile (a2a-nexus#2315).
#
# danso is installed from a SIGNED release, not built from source and not
# fetched from an unsigned URL. The release files (danso-<ver>-<target>.tar.gz,
# SHA256SUMS, SHA256SUMS.minisig from jinwon-int/danso release.yml) are passed
# as a named build context, and the build refuses to continue unless:
#   1. SHA256SUMS verifies (minisign -V -H) against docker/danso-release.pub,
#      a copy of jinwon-int/danso keys/danso-release.pub (key E59BCBCB0600807C),
#      and its trusted comment names DANSO_VERSION;
#   2. the archive matches the pinned DANSO_ARCHIVE_SHA256 build arg (required,
#      no default) and that exact line is in the signed SHA256SUMS;
#   3. the archive contains exactly one member, `danso` (danso
#      docs/release-signing.md "Archive layout").
#
# Build on an operator host (never on a fleet node):
#   gh release download v<ver> -R jinwon-int/danso -D /tmp/danso-release
#   # or, while releases are workflow artifacts:
#   # gh run download <run-id> -R jinwon-int/danso -n signed-release -D /tmp/danso-release
#   docker build -f docker/danso-runner.Dockerfile \
#     --build-context danso-release=/tmp/danso-release \
#     --build-arg DANSO_VERSION=<ver> \
#     --build-arg DANSO_ARCHIVE_SHA256=<sha256 of the tarball from SHA256SUMS> \
#     -t a2a-docker-runner-danso:<ver>-<a2a-nexus short sha> packages/docker-runner
#
# The release binary is built on ubuntu-22.04 (glibc 2.35 floor). The base
# below is Debian bookworm (glibc 2.36), the same pinned base as the piri and
# claude-code runners; `danso --version` in the final stage proves it loads.

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS danso-verify

ARG DANSO_VERSION=0.1.0
ARG DANSO_TARGET=x86_64-unknown-linux-gnu
ARG DANSO_ARCHIVE_SHA256=
ARG DANSO_RELEASE_KEY_ID=E59BCBCB0600807C

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates minisign tar gzip \
  && rm -rf /var/lib/apt/lists/*

COPY docker/danso-release.pub /danso/danso-release.pub
COPY --from=danso-release SHA256SUMS SHA256SUMS.minisig danso-${DANSO_VERSION}-${DANSO_TARGET}.tar.gz /danso/release/

RUN set -eu; \
  archive="danso-${DANSO_VERSION}-${DANSO_TARGET}.tar.gz"; \
  if ! printf '%s' "${DANSO_ARCHIVE_SHA256}" | grep -Eqx '[0-9a-f]{64}'; then \
    echo "DANSO_ARCHIVE_SHA256 build arg is required (64 lowercase hex, from the signed SHA256SUMS)" >&2; exit 1; \
  fi; \
  grep -qx "untrusted comment: minisign public key ${DANSO_RELEASE_KEY_ID}" /danso/danso-release.pub; \
  cd /danso/release; \
  minisign -V -H -p /danso/danso-release.pub -m SHA256SUMS > /danso/minisign-verify.txt; \
  grep -q "^Trusted comment: danso ${DANSO_VERSION} " /danso/minisign-verify.txt; \
  grep -qx "${DANSO_ARCHIVE_SHA256}  ${archive}" SHA256SUMS; \
  printf '%s  %s\n' "${DANSO_ARCHIVE_SHA256}" "${archive}" | sha256sum -c -; \
  test "$(tar -tzf "${archive}")" = "danso"; \
  install -d -m 0755 /danso/out; \
  tar -xzf "${archive}" -C /danso/out danso; \
  chmod 0755 /danso/out/danso; \
  { \
    printf 'archive=%s\n' "${archive}"; \
    printf 'archive_sha256=%s\n' "${DANSO_ARCHIVE_SHA256}"; \
    printf 'release_key_id=%s\n' "${DANSO_RELEASE_KEY_ID}"; \
    grep '^Trusted comment: ' /danso/minisign-verify.txt | sed 's/^Trusted comment: /trusted_comment=/'; \
  } > /danso/out/danso-release.txt

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

ARG DANSO_VERSION=0.1.0
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
    *) echo "unsupported architecture for the danso runner (danso releases are x86_64 only): $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${gh_arch}.tar.gz" -o /tmp/gh.tgz; \
  tar -C /tmp -xzf /tmp/gh.tgz; \
  install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/bin/gh; \
  curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${gitleaks_arch}.tar.gz" -o /tmp/gitleaks.tgz; \
  tar -C /tmp -xzf /tmp/gitleaks.tgz gitleaks; \
  install -m 0755 /tmp/gitleaks /usr/bin/gitleaks; \
  rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_${gh_arch}" /tmp/gitleaks.tgz /tmp/gitleaks

COPY --from=danso-verify /danso/out/danso /usr/local/bin/danso
COPY --from=danso-verify /danso/out/danso-release.txt /etc/a2a-runner/danso-release.txt
RUN chmod 0755 /etc/a2a-runner \
  && chmod 0644 /etc/a2a-runner/danso-release.txt \
  && danso --version \
  && for flag in --prompt-file --system-context-file --tool-home --sandbox; do \
       danso --help | grep -q -- "$flag" \
         || { echo "danso ${DANSO_VERSION} lacks $flag; the danso patch profile requires it (--prompt-file: jinwon-int/danso#206)" >&2; exit 1; }; \
     done \
  && gh --version \
  && gitleaks version

# GLM credentials are mounted at runtime only: a read-only directory at
# /run/secrets/danso-dir holding glm.env. They are never baked into image
# layers or written to runner artifacts.
LABEL org.openclaw.a2a-docker-runner.harness="danso" \
  org.openclaw.a2a-docker-runner.danso.version="${DANSO_VERSION}"

WORKDIR /work
