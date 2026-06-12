/**
 * Canonical plugin identifier (plugin-id.ts).
 *
 * Issue: a2a-nexus#648 — closes a zero-coverage gap. The plugin id is a
 * wire-stable contract value: the broker and host runtime key plugin
 * ownership and reload routing off this exact string, and it is re-exported
 * from standalone-broker-client. Pin the literal so an accidental rename is
 * caught here rather than as a silent runtime ownership mismatch.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { A2A_BROKER_ADAPTER_PLUGIN_ID } from "./dist/plugin-id.js";
import { A2A_BROKER_ADAPTER_PLUGIN_ID as ReExportedId } from "./dist/standalone-broker-client.js";

describe("A2A_BROKER_ADAPTER_PLUGIN_ID", () => {
  it("is the wire-stable canonical plugin id", () => {
    assert.equal(A2A_BROKER_ADAPTER_PLUGIN_ID, "a2a-broker-adapter");
  });

  it("is re-exported unchanged from standalone-broker-client", () => {
    assert.equal(ReExportedId, A2A_BROKER_ADAPTER_PLUGIN_ID);
  });
});
