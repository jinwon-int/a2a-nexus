import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Static contract for docker/danso-runner.Dockerfile (a2a-nexus#2315). The
 * image is never built in tests; these checks pin the supply-chain gates.
 */

const dockerfile = readFileSync(new URL("../docker/danso-runner.Dockerfile", import.meta.url), "utf8");
const piriDockerfile = readFileSync(new URL("../docker/piri-runner.Dockerfile", import.meta.url), "utf8");
const releaseKey = readFileSync(new URL("../docker/danso-release.pub", import.meta.url), "utf8");

test("danso runner reuses the pinned bookworm base (glibc >= 2.35) of the piri runner", () => {
  const piriBase = /^FROM (node:22-bookworm-slim@sha256:[0-9a-f]{64})$/m.exec(piriDockerfile)?.[1];
  assert.ok(piriBase);
  const stages = [...dockerfile.matchAll(/^FROM (\S+)(?: AS (\S+))?$/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(stages, [[piriBase, "danso-verify"], [piriBase, undefined]]);
});

test("danso is installed only from a minisign-verified, sha256-pinned release archive", () => {
  assert.match(dockerfile, /^ARG DANSO_ARCHIVE_SHA256=$/m, "the archive pin is a required build arg without a default");
  assert.match(dockerfile, /grep -Eqx '\[0-9a-f\]\{64\}'/);
  assert.match(dockerfile, /COPY --from=danso-release SHA256SUMS SHA256SUMS\.minisig danso-\$\{DANSO_VERSION\}-\$\{DANSO_TARGET\}\.tar\.gz/);
  assert.match(dockerfile, /minisign -V -H -p \/danso\/danso-release\.pub -m SHA256SUMS/);
  assert.match(dockerfile, /\^Trusted comment: danso \$\{DANSO_VERSION\} /);
  assert.match(dockerfile, /grep -qx "\$\{DANSO_ARCHIVE_SHA256\}  \$\{archive\}" SHA256SUMS/);
  assert.match(dockerfile, /sha256sum -c -/);
  assert.match(dockerfile, /test "\$\(tar -tzf "\$\{archive\}"\)" = "danso"/);
  assert.doesNotMatch(dockerfile, /curl[^\n]*danso/i, "danso is never downloaded inside the build");
  assert.doesNotMatch(dockerfile, /cargo (build|install)/);
});

test("the pinned release key is jinwon-int/danso key E59BCBCB0600807C", () => {
  assert.match(dockerfile, /^ARG DANSO_RELEASE_KEY_ID=E59BCBCB0600807C$/m);
  assert.equal(
    releaseKey,
    "untrusted comment: minisign public key E59BCBCB0600807C\nRWR8gAAGy8ub5QA1pM6J0jZxlAFslOJ2NtnbCE7n17CLBGA54W+R/hE6\n",
  );
});

test("the image refuses a danso build without the flags the patch profile needs", () => {
  assert.match(dockerfile, /for flag in --prompt-file --system-context-file --tool-home --sandbox; do/);
  assert.match(dockerfile, /danso --version/);
});

test("danso runner carries the shared runner toolchain and keeps credentials runtime-mounted", () => {
  for (const pkg of ["bash", "ca-certificates", "curl", "git", "jq", "openssh-client", "python3", "ripgrep"]) {
    assert.match(dockerfile, new RegExp(`^\\s+${pkg} \\\\$`, "m"), `missing apt package ${pkg}`);
  }
  assert.match(dockerfile, /gh_\$\{GH_VERSION\}_linux_\$\{gh_arch\}\.tar\.gz/);
  assert.match(dockerfile, /install -m 0755 "\/tmp\/gh_\$\{GH_VERSION\}_linux_\$\{gh_arch\}\/bin\/gh" \/usr\/bin\/gh/);
  assert.match(dockerfile, /gitleaks_\$\{GITLEAKS_VERSION\}_linux_\$\{gitleaks_arch\}\.tar\.gz/);
  assert.match(dockerfile, /COPY --from=danso-verify \/danso\/out\/danso \/usr\/local\/bin\/danso/);
  assert.match(dockerfile, /org\.openclaw\.a2a-docker-runner\.harness="danso"/);
  assert.match(dockerfile, /credentials are mounted at runtime only/i);
  assert.doesNotMatch(dockerfile, /(COPY|ADD)\s+[^\n]*(glm\.env|\.config\/danso|danso-dir)/i);
  assert.doesNotMatch(dockerfile, /ZAI_API_KEY/);
  assert.match(dockerfile, /^WORKDIR \/work$/m);
});
