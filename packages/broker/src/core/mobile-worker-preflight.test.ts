import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildMobileWorkerPreflight,
  normalizeMobileWorkerPreflightInput,
  renderMobileWorkerPreflightMarkdown,
  type MobileWorkerPreflightDryRunResult,
  type MobileWorkerPreflightFixture,
} from "./mobile-worker-preflight.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_DIR = join(__dirname, "../../fixtures/mobile-worker-preflight");

function loadFixture(name: string): MobileWorkerPreflightFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

function assertNoLiveBoundaries(result: MobileWorkerPreflightDryRunResult): void {
  for (const [key, value] of Object.entries(result.boundaries)) {
    assert.equal(value, false, `${key} must remain false`);
  }
  for (const [key, value] of Object.entries(result.packet.boundaries)) {
    assert.equal(value, false, `${key} must remain false`);
  }
}

describe("mobile worker preflight fixtures", () => {
  it("loads every fixture and builds a source-only packet", () => {
    const files = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json"));
    assert.ok(files.length >= 12, "expected mobile preflight fixture coverage with active-lane and workspace isolation cases");

    for (const file of files) {
      const result = buildMobileWorkerPreflight(loadFixture(file));
      assert.equal(result.kind, "a2a-broker.mobile-worker-preflight.dry-run");
      assert.equal(result.packet.kind, "a2a-broker.mobile-worker-preflight.packet");
      assert.match(result.packet.idempotencyKey, /^mobile-worker-preflight:[a-f0-9]{24}$/);
      assertNoLiveBoundaries(result);
    }
  });

  it("classifies a healthy Termux mobile worker as ready", () => {
    const result = buildMobileWorkerPreflight(loadFixture("healthy-mobile.json"));
    assert.equal(result.packet.input.nodeId, "daegyo");
    assert.equal(result.packet.state, "ready");
    assert.equal(result.packet.readyForActiveLane, true);
    assert.equal(result.packet.mobileHealth.lastSeenWindow, "fresh");
    assert.equal(result.packet.mobileHealth.pollWindow, "compatible");
    assert.equal(result.packet.mobileHealth.wakeLock, "held");
    assert.equal(result.packet.mobileHealth.workspaceIsolation, "configured");
  });

  it("classifies Daegyo-style slow polling against broker stale windows", () => {
    const result = buildMobileWorkerPreflight(loadFixture("slow-polling.json"));
    assert.equal(result.packet.state, "poll_interval_too_slow");
    assert.equal(result.packet.readyForActiveLane, false);
    assert.equal(result.packet.mobileHealth.lastSeenWindow, "stale");
    assert.equal(result.packet.mobileHealth.pollWindow, "too_slow");
    assert.ok(result.packet.signals.some((signal) => signal.code === "wake_lock_recommended"));
  });

  it("fails closed when supervisor and local forward are missing", () => {
    const result = buildMobileWorkerPreflight(
      loadFixture("missing-supervisor-local-forward.json"),
    );
    assert.equal(result.packet.state, "supervisor_missing");
    assert.equal(result.packet.readyForActiveLane, false);
    assert.equal(result.packet.mobileHealth.supervisor, "missing");
    assert.equal(result.packet.mobileHealth.localForward, "missing");
    assert.ok(result.packet.signals.some((signal) => signal.code === "local_forward_missing"));
  });

  it("recommends wake-lock before active lane assignment", () => {
    const result = buildMobileWorkerPreflight(loadFixture("wake-lock-recommended.json"));
    assert.equal(result.packet.state, "needs_wake_lock");
    assert.equal(result.packet.readyForActiveLane, false);
    assert.equal(result.packet.mobileHealth.wakeLock, "recommended");
    assert.match(result.packet.recommendedActions.join("\n"), /wake-lock/i);
  });

  it("skips non-mobile workers", () => {
    const result = buildMobileWorkerPreflight(loadFixture("non-mobile-worker.json"));
    assert.equal(result.packet.state, "not_mobile_worker");
    assert.equal(result.packet.readyForActiveLane, false);
    assert.equal(result.packet.mobileHealth.isMobileWorker, false);
    assert.match(result.packet.recommendedActions[0] ?? "", /Docker-runner or gateway doctor/i);
  });

  it("keeps healthy standby mobile workers non-active until workspace isolation is configured", () => {
    const result = buildMobileWorkerPreflight(
      loadFixture("healthy-mobile-no-active-lane.json"),
    );
    assert.equal(result.packet.state, "ready");
    assert.equal(result.packet.readyForActiveLane, false);
    assert.equal(result.packet.mobileHealth.wakeLock, "not_required");
    assert.equal(result.packet.mobileHealth.workspaceIsolation, "not_required");
    assert.equal(result.packet.input.activeLanePlanned, false);
    assert.equal(result.packet.mobileHealth.lastSeenWindow, "fresh");
    assert.equal(result.packet.mobileHealth.pollWindow, "compatible");
  });

  it("classifies degraded timing without poll failure as needs_wake_lock", () => {
    const result = buildMobileWorkerPreflight(loadFixture("degraded-timing.json"));
    assert.equal(result.packet.state, "needs_wake_lock");
    assert.equal(result.packet.readyForActiveLane, false);
    assert.equal(result.packet.mobileHealth.lastSeenWindow, "stale");
    assert.equal(result.packet.mobileHealth.pollWindow, "compatible");
    assert.equal(result.packet.mobileHealth.wakeLock, "recommended");
    assert.ok(result.packet.signals.some((s) => s.code === "last_seen_stale_window"));
    assert.ok(result.packet.signals.some((s) => s.code === "wake_lock_recommended"));
  });

  it("classifies worker past disconnected threshold as disconnected", () => {
    const result = buildMobileWorkerPreflight(loadFixture("disconnected-mobile.json"));
    assert.equal(result.packet.state, "disconnected");
    assert.equal(result.packet.readyForActiveLane, false);
    assert.equal(result.packet.mobileHealth.lastSeenWindow, "disconnected");
    assert.ok(result.packet.signals.some((s) => s.code === "last_seen_disconnected_window"));
    assert.ok(result.packet.recommendedActions.some((a) => /fresh heartbeat/i.test(a)));
  });

  it("classifies hermes-mobile worker as mobile worker with healthy signals", () => {
    const result = buildMobileWorkerPreflight(loadFixture("hermes-mobile-healthy.json"));
    assert.equal(result.packet.state, "ready");
    assert.equal(result.packet.readyForActiveLane, true);
    assert.equal(result.packet.mobileHealth.isMobileWorker, true);
    assert.equal(result.packet.mobileHealth.lastSeenWindow, "fresh");
    assert.equal(result.packet.input.nodeId, "yukson");
    assert.equal(result.packet.input.workerMode, "hermes-mobile");
  });

  it("skips supervisor/forward checks when not expected", () => {
    const result = buildMobileWorkerPreflight(loadFixture("no-tmux-not-expected.json"));
    assert.equal(result.packet.state, "ready");
    assert.equal(result.packet.readyForActiveLane, true);
    assert.equal(result.packet.mobileHealth.supervisor, "not_expected");
    assert.equal(result.packet.mobileHealth.localForward, "not_expected");
    assert.ok(result.packet.signals.some((s) => s.code === "supervisor_not_expected"));
    assert.ok(result.packet.signals.some((s) => s.code === "local_forward_not_expected"));
  });

  it("blocks healthy mobile liveness when isolated workspace root is missing", () => {
    const result = buildMobileWorkerPreflight(loadFixture("missing-isolated-workspace.json"));
    assert.equal(result.packet.state, "workspace_isolation_missing");
    assert.equal(result.packet.readyForActiveLane, false);
    assert.equal(result.packet.mobileHealth.lastSeenWindow, "fresh");
    assert.equal(result.packet.mobileHealth.pollWindow, "compatible");
    assert.equal(result.packet.mobileHealth.workspaceIsolation, "missing");
    assert.ok(result.packet.signals.some((s) => s.code === "workspace_isolation_missing"));
    assert.ok(result.packet.recommendedActions.some((a) => /isolated per-task mobile workspace/i.test(a)));
  });

  it("rejects workspace root shapes under forbidden config or credential paths", () => {
    const result = buildMobileWorkerPreflight(loadFixture("forbidden-workspace-path.json"));
    assert.equal(result.packet.state, "workspace_isolation_missing");
    assert.equal(result.packet.readyForActiveLane, false);
    assert.equal(result.packet.mobileHealth.workspaceIsolation, "forbidden_path");
    assert.ok(result.packet.signals.some((s) => s.code === "workspace_isolation_forbidden_path"));
    assert.ok(result.packet.recommendedActions.some((a) => /credential|provider/i.test(a)));
  });
});

describe("normalizeMobileWorkerPreflightInput", () => {
  it("accepts raw mobile worker input and computes lastSeenAgeSec from lastSeenAt", () => {
    const input = normalizeMobileWorkerPreflightInput(
      {
        nodeId: "daegyo",
        workerMode: "termux-mobile",
        lastSeenAt: "2026-05-29T10:00:00.000Z",
        pollIntervalSec: 20,
        isolatedWorkspaceRootShape: "~/.hermes/a2a-workspaces/<homeBrokerId>/<taskId>",
      },
      { now: "2026-05-29T10:00:25.000Z" },
    );
    assert.equal(input.lastSeenAgeSec, 25);
    assert.equal(input.staleAfterSec, 30);
    assert.equal(input.disconnectedAfterSec, 90);
    assert.equal(input.isolatedWorkspaceRootShape, "~/.hermes/a2a-workspaces/<homeBrokerId>/<taskId>");
  });

  it("rejects missing nodeId", () => {
    assert.throws(
      () => normalizeMobileWorkerPreflightInput({ workerMode: "termux-mobile" }),
      /nodeId/i,
    );
  });

  it("rejects impossible stale/disconnected thresholds", () => {
    assert.throws(
      () => normalizeMobileWorkerPreflightInput({
        nodeId: "daegyo",
        workerMode: "termux-mobile",
        staleAfterSec: 90,
        disconnectedAfterSec: 30,
      }),
      /disconnectedAfterSec/i,
    );
  });
});

describe("renderMobileWorkerPreflightMarkdown", () => {
  it("renders operator-readable no-live boundaries", () => {
    const result = buildMobileWorkerPreflight(loadFixture("slow-polling.json"));
    const markdown = renderMobileWorkerPreflightMarkdown(result);
    assert.match(markdown, /Mobile worker preflight/);
    assert.match(markdown, /poll_interval_too_slow/);
    assert.match(markdown, /termuxWakeLockChanged\*\*: false/);
    assert.match(markdown, /filesystemMutation\*\*: false/);
    assert.match(markdown, /does not inspect live host state/i);
  });
});
