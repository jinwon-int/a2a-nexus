/**
 * A2A-Version header negotiation (A2A 1.0 §version negotiation).
 *
 * The spec requires clients to send `A2A-Version` with each request and
 * servers to process requests using the semantics of the requested version,
 * falling back to 0.3 semantics for an empty value.
 *
 * Documented deviation: this broker implements only 1.x semantics
 * (`A2A_COMPATIBILITY_PROFILE.unsupportedA2A03Compat`), so a missing/empty
 * header is served with 1.0 semantics instead of the spec's 0.3 fallback —
 * rejecting every header-less request would break existing 1.0-era clients
 * for no safety gain. An explicit version we cannot honor (e.g. `0.3`, `2.0`)
 * is rejected fail-closed rather than silently served with the wrong
 * semantics.
 */

export const A2A_VERSION_HEADER = "a2a-version";

export const SUPPORTED_A2A_VERSIONS = ["1.0"] as const;

export type A2AVersionNegotiation =
  | { ok: true; version: (typeof SUPPORTED_A2A_VERSIONS)[number]; requested: string | null }
  | { ok: false; requested: string; message: string };

export function negotiateA2AVersion(headerValue: string | string[] | undefined): A2AVersionNegotiation {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const requested = typeof raw === "string" ? raw.trim() : "";
  if (requested === "") {
    return { ok: true, version: "1.0", requested: null };
  }
  // Accept exact supported versions plus a bare major ("1") for tolerant
  // clients; everything else is an explicit mismatch.
  if (requested === "1" || (SUPPORTED_A2A_VERSIONS as readonly string[]).includes(requested)) {
    return { ok: true, version: "1.0", requested };
  }
  return {
    ok: false,
    requested,
    message: `unsupported A2A-Version "${requested}"; supported: ${SUPPORTED_A2A_VERSIONS.join(", ")}`,
  };
}
