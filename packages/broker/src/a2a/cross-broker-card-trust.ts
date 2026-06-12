/**
 * Signed-agent-card trust for the cross-broker terminal-brief receiver.
 *
 * Federation peers already authenticate transport-level with the edge
 * secret; this adds an opt-in identity layer built on A2A 1.0 signed agent
 * cards: the receiver pins one public key per peer broker id (a JSON trust
 * anchor file), and every inbound projection must carry the sender's signed
 * agent card, verified against the pinned key for the claimed
 * handoff/origin broker id. Key possession is the identity.
 *
 * Opt-in and fail-closed: with no anchor file configured, behavior is
 * unchanged; with one configured, a missing card, an unknown broker id, or
 * a signature that does not verify rejects the projection.
 */
import { readFileSync } from "node:fs";
import { verifyAgentCardSignature, type AgentCardSignature } from "./agent-card-signing.js";

export type CrossBrokerTrustAnchors = Map<string, string>;

/** Load `{ "<brokerId>": "<SPKI public key PEM>" }`; null disables the gate. */
export function loadCrossBrokerTrustAnchors(file: string | undefined): CrossBrokerTrustAnchors | null {
  if (!file?.trim()) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const anchors: CrossBrokerTrustAnchors = new Map();
  for (const [brokerId, pem] of Object.entries(parsed)) {
    if (typeof pem !== "string" || !pem.includes("PUBLIC KEY")) {
      throw new Error(`trust anchor for "${brokerId}" must be an SPKI public key PEM string`);
    }
    anchors.set(brokerId.trim(), pem);
  }
  if (anchors.size === 0) {
    throw new Error("cross-broker trust anchor file must pin at least one broker key");
  }
  return anchors;
}

export type CrossBrokerCardVerdict =
  | { ok: true; brokerId: string }
  | { ok: false; reason: string };

/**
 * Verify the sender's signed agent card embedded in a cross-broker
 * projection body against the pinned anchor for the claimed broker id.
 */
export function verifyCrossBrokerSenderCard(
  anchors: CrossBrokerTrustAnchors,
  body: unknown,
): CrossBrokerCardVerdict {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!record) {
    return { ok: false, reason: "projection body must be an object" };
  }
  const handoff = record.crossBrokerHandoff as Record<string, unknown> | undefined;
  const claimed =
    (typeof handoff?.handoffBrokerId === "string" && handoff.handoffBrokerId.trim()) ||
    (typeof record.originBrokerId === "string" && record.originBrokerId.trim()) ||
    "";
  if (!claimed) {
    return { ok: false, reason: "projection must claim a handoff/origin broker id" };
  }
  const anchor = anchors.get(claimed);
  if (!anchor) {
    return { ok: false, reason: `no trust anchor pinned for broker "${claimed}"` };
  }
  const card = record.senderAgentCard;
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    return { ok: false, reason: "projection must carry the sender's signed agent card (senderAgentCard)" };
  }
  let verified = false;
  try {
    verified = verifyAgentCardSignature(
      card as Record<string, unknown> & { signatures?: AgentCardSignature[] },
      anchor,
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    return { ok: false, reason: `sender agent card signature does not verify against the pinned key for "${claimed}"` };
  }
  return { ok: true, brokerId: claimed };
}
