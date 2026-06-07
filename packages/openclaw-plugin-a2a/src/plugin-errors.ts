/**
 * Minimal error helpers for A2A gateway handlers.
 * Kept intentionally small — no core errorShape graph duplication.
 */

export const A2AErrorCodes = {
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL: "INTERNAL",
} as const;

export type A2AErrorCode = (typeof A2AErrorCodes)[keyof typeof A2AErrorCodes];

export function a2aError(
  code: A2AErrorCode,
  message: string,
): { code: A2AErrorCode; message: string } {
  return { code, message };
}

/**
 * Presence-safe labels for sessionKey state — never returns the raw value.
 *
 * Use this whenever an error message, log, or diagnostic needs to reference
 * a sessionKey's presence state without exposing the key itself.
 *
 * @returns "<missing>"  when value is undefined or null
 * @returns "<empty>"    when value is an empty/whitespace-only string
 * @returns "<present>"  when a non-empty string is provided
 */
export function safeSessionKeyLabel(
  value: unknown,
): "<missing>" | "<empty>" | "<present>" {
  if (value === undefined || value === null) return "<missing>";
  if (typeof value === "string" && value.trim() === "") return "<empty>";
  return "<present>";
}
