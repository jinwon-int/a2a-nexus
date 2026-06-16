import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dockerfile = readFileSync(new URL("../docker/hermes-runner.Dockerfile", import.meta.url), "utf8");

test("Hermes runner image bakes in an external secret scanner for release-gate tasks (#780)", () => {
  assert.match(dockerfile, /ARG GITLEAKS_VERSION=\d+\.\d+\.\d+/);
  assert.match(dockerfile, /gitleaks_\$\{GITLEAKS_VERSION\}_linux_\$\{gitleaks_arch\}\.tar\.gz/);
  assert.match(dockerfile, /install -m 0755 \/tmp\/gitleaks \/usr\/bin\/gitleaks/);
  assert.match(dockerfile, /gitleaks version/);
});
