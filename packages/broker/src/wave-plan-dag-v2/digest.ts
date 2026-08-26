/**
 * Canonical JSON encoding and framed SHA-256 digests for WavePlanDagV2
 * (spec §6, #1800 slice 1).
 *
 * Spec §6 pins the encoding exactly: object keys sorted by ascending ASCII
 * byte value, array order preserved (except where the manifest payload rules
 * in `manifest.ts` explicitly re-sort), JSON string escaping and UTF-8,
 * minimal base-10 safe integers, no insignificant whitespace. The digest
 * frame is `A2A-WAVE-PLAN-DAG-V2\0` + u32be(domain length) + domain +
 * u32be(payload length) + canonical payload, hashed with lowercase SHA-256
 * and prefixed with `sha256:`.
 *
 * This is a direct port of the framing in
 * `test/conformance/check-wave-plan-dag-v2.mjs`. The golden fixture pins the
 * resulting byte strings (`PINNED_MANIFEST_DIGEST` / receipt vectors), so the
 * runtime and the checker cannot silently diverge.
 */
import { createHash } from "node:crypto";

import { reject } from "./errors.js";

/** Spec §3: manifest digest domain. */
export const WAVE_PLAN_DAG_V2_MANIFEST_DIGEST_DOMAIN = "a2a.wave-plan-dag-v2.manifest.v2";
/** Spec §5: dry-run receipt digest domain. */
export const WAVE_PLAN_DAG_V2_RECEIPT_DIGEST_DOMAIN = "a2a.wave-plan-dag-v2.dry-run-receipt.v2";

const FRAME_HEADER = Buffer.from("A2A-WAVE-PLAN-DAG-V2\0", "ascii");

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * Values that may legally appear inside a V2 canonical payload. Anything else
 * (null, undefined, numbers that are not safe integers, non-printable ASCII)
 * is malformed by §6.
 */
export type WavePlanDagV2CanonicalValue =
  | string
  | number
  | boolean
  | WavePlanDagV2CanonicalValue[]
  | { [key: string]: WavePlanDagV2CanonicalValue };

/** ASCII-aware comparison, identical to the checker's ordering rules (§4). */
export function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCanonicalString(value: string): void {
  if (!PRINTABLE_ASCII.test(value)) {
    reject("manifest_malformed", "canonical string must be non-empty printable ASCII");
  }
}

/** Canonical JSON encoder per spec §6. Throws on any value outside §6's domain. */
export function canonicalizeWavePlanDagV2Json(value: WavePlanDagV2CanonicalValue): string {
  if (typeof value === "string") {
    assertCanonicalString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      reject("manifest_malformed", "canonical number must be a safe integer");
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalizeWavePlanDagV2Json).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort(compareAscii);
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalizeWavePlanDagV2Json(value[key])}`)
      .join(",")}}`;
  }
  reject("manifest_malformed", "null and unsupported canonical values are forbidden");
}

function u32be(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) {
    reject("manifest_malformed", "digest frame length exceeds uint32");
  }
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(length);
  return bytes;
}

/** Framed digest over one exact ASCII domain plus canonical payload bytes. */
export function framedWavePlanDagV2Digest(
  domain: string,
  payload: WavePlanDagV2CanonicalValue,
): string {
  assertCanonicalString(domain);
  const domainBytes = Buffer.from(domain, "ascii");
  const payloadBytes = Buffer.from(canonicalizeWavePlanDagV2Json(payload), "utf8");
  const digest = createHash("sha256")
    .update(Buffer.concat([FRAME_HEADER, u32be(domainBytes.length), domainBytes, u32be(payloadBytes.length), payloadBytes]))
    .digest("hex");
  return `sha256:${digest}`;
}
