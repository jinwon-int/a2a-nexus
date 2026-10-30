/**
 * Canonical requester roles accepted by the broker request-security boundary.
 * Dispatch clients consume this same runtime tuple so local validation cannot
 * drift from the broker header contract.
 */
// The tuple is the accepted role *namespace* for the request-security
// boundary. It is not an authorization grant: per-credential authority comes
// from each signing key's `roles` declaration (HTTP-signature registry) and
// from per-operation allowlists (e.g. hub/operator for dialectic advance).
// 2026-08-29: added publisher/reviewer/orchestrator for the fleet
// skills-intake pipeline and the documented dispatch examples (#2011 rollout).
export const A2A_REQUESTER_ROLES = Object.freeze(
  /** @type {const} */ ([
    "hub",
    "live-trader",
    "researcher",
    "analyst",
    "operator",
    "publisher",
    "reviewer",
    "orchestrator",
  ]),
);
