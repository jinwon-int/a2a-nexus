/**
 * Canonical requester roles accepted by the broker request-security boundary.
 * Dispatch clients consume this same runtime tuple so local validation cannot
 * drift from the broker header contract.
 */
export const A2A_REQUESTER_ROLES = Object.freeze(
  /** @type {const} */ ([
    "hub",
    "live-trader",
    "researcher",
    "analyst",
    "operator",
  ]),
);
