export interface AgentProvider {
  organization: string;
  url?: string;
}

export interface AgentCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
}

/**
 * A2A 1.0 AgentCard (public discovery shape).
 *
 * **Naming guard:** `AgentCard.capabilities` carries A2A protocol-level flags
 * (`streaming`, `pushNotifications`). This is deliberately distinct from
 * {@link WorkerCapabilities} (`canAnalyze`, `canBackfill`, …) which describe
 * broker-internal worker runtime abilities. The two capability types MUST NOT
 * be merged into a single shape; they serve different consumers (public A2A
 * clients vs. internal broker scheduler).
 */
/**
 * Trust-signature envelope for a signed AgentCard (JWS or similar).
 *
 * **Current status: deferred.** The broker does not yet sign or verify
 * AgentCards. This field is a type-level placeholder for future
 * implementation (see docs/agent-card-trust-model.md). When populated,
 * consumers SHOULD verify the signature before trusting card content.
 */
export interface AgentCardSignature {
  /** JWS compact serialization or equivalent signature payload. */
  payload: string;
  /** Key identifier used for signing (kid claim or equivalent). */
  keyId?: string;
  /** Signature algorithm (e.g. ES256, EdDSA). */
  algorithm?: string;
  /** Unix timestamp when the signature was created. */
  createdAt?: number;
  /** Unix timestamp when the signature expires. */
  expiresAt?: number;
}

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  protocolVersion: string;
  provider?: AgentProvider;
  /** A2A protocol-level capabilities. Not to be confused with worker runtime
   * {@link WorkerCapabilities}. */
  capabilities: AgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  /**
   * Optional trust signature over the card content.
   *
   * Deferred: not yet populated by the broker. See
   * docs/agent-card-trust-model.md for the trust model and signing roadmap.
   */
  signature?: AgentCardSignature;
  /**
   * A2A extension URIs that this card's signature covers, in addition to
   * the core card fields. An empty array means the signature covers only
   * the core AgentCard shape. When absent (`undefined`), the card is
   * unsigned.
   */
  signedExtensions?: string[];
}

export interface CreateBrokerAgentCardOptions {
  serviceName: string;
  publicBaseUrl: string;
  version?: string;
  protocolVersion?: string;
  description?: string;
  provider?: AgentProvider;
  supportsStreaming?: boolean;
  supportsPushNotifications?: boolean;
}

export function createBrokerAgentCard(options: CreateBrokerAgentCardOptions): AgentCard {
  const baseUrl = trimTrailingSlash(options.publicBaseUrl);
  return {
    name: options.serviceName,
    description:
      options.description ??
      "Broker-first A2A coordination service for delegated tasks, proposal review, and auditable worker execution.",
    url: `${baseUrl}/a2a/jsonrpc`,
    version: options.version ?? "0.1.0",
    protocolVersion: options.protocolVersion ?? "1.0",
    provider: options.provider,
    capabilities: {
      streaming: options.supportsStreaming ?? false,
      pushNotifications: options.supportsPushNotifications ?? false,
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "analyze",
        name: "Analyze",
        description: "Dispatch research and analysis tasks to registered workers.",
        tags: ["analysis", "research"],
      },
      {
        id: "backfill",
        name: "Backfill",
        description: "Coordinate replay and backfill jobs across broker-managed workers.",
        tags: ["backfill", "history"],
      },
      {
        id: "propose_patch",
        name: "Propose patch",
        description: "Submit a patch proposal for remote review and approval.",
        tags: ["proposal", "patch", "approval"],
      },
      {
        id: "validate_change",
        name: "Validate change",
        description: "Route validation work and record verdicts in the broker pipeline.",
        tags: ["validation", "review"],
      },
      {
        id: "apply_local_change",
        name: "Apply local change",
        description: "Coordinate target-side apply after approval while preserving local workspace ownership.",
        tags: ["apply", "workspace", "policy"],
      },
    ],
  };
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
