import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const docPath = new URL("../docs/validation/a2a-nexus-842-advisory-sidecar-closeout-readiness-matrix.md", import.meta.url);

async function doc() {
  return readFile(docPath, "utf8");
}

const requiredRows = [
  "technical source readiness",
  "approval boundary",
  "live sidecar execution",
  "provider and hermes sends",
  "routing influence",
  "broker state and database mutation",
  "deploy restart release and secrets",
  "terminal brief ack and replay",
  "rollback and owner",
];

const forbiddenClaims = [
  /#764 is closeable now/i,
  /sidecar live activation is approved/i,
  /provider send is approved/i,
  /terminal brief ack is approved/i,
  /deployment is approved/i,
];

test("#842 readiness matrix records the source-only closeout decision surface", async () => {
  const content = await doc();

  assert.match(content, /# A2A Nexus #842 advisory sidecar closeout readiness matrix/);
  assert.match(content, /Parent umbrella: #764/);
  assert.match(content, /A2A cleanup parent: #840/);
  assert.match(content, /Issue: #842/);
  assert.match(content, /analysisStatus: complete-source-only/);

  for (const row of requiredRows) {
    assert.match(content.toLowerCase(), new RegExp(row));
  }
});

test("#842 matrix is fail-closed for live/provider/routing/db/deploy/ack actions", async () => {
  const content = await doc();

  assert.match(content, /source-only\/no-live/i);
  assert.match(content, /NO-GO/i);
  assert.match(content, /must not start.*sidecar/i);
  assert.match(content, /must not send.*provider/i);
  assert.match(content, /must not change.*routing/i);
  assert.match(content, /must not mutate.*database/i);
  assert.match(content, /must not deploy.*restart/i);
  assert.match(content, /must not ACK.*terminal/i);

  for (const forbidden of forbiddenClaims) {
    assert.doesNotMatch(content, forbidden);
  }
});

test("#842 matrix defines exact close conditions for #842 but keeps #764 open", async () => {
  const content = await doc();

  assert.match(content, /#842 is closeable after this PR merges/i);
  assert.match(content, /#764 remains open/i);
  assert.match(content, /future operator approval/i);
  assert.match(content, /separate approval/i);
  assert.match(content, /rollback owner/i);
});
