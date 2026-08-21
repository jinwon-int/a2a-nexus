import type { AgentCardSignature } from "a2a-attestation";

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
 * A2A 1.0 protocol binding declaration. Each entry advertises one transport
 * the agent serves and the URL where it is reachable. The broker speaks only
 * JSON-RPC 2.0 (see A2A_COMPATIBILITY_PROFILE.unsupportedTransports), so it
 * declares a single JSONRPC interface.
 */
export interface AgentInterface {
  protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON";
  url: string;
  /**
   * The A2A protocol version this interface exposes (#1912 D7).
   *
   * v1.0 moved the protocol version onto the interface, where the proto marks
   * it REQUIRED (`string protocol_version = 4` in a2a.proto v1.0.1). The
   * mechanism it enables is one agent serving 0.3 and 1.0 on different URLs —
   * a client picks an entry from `supportedInterfaces` and reads the version
   * from the entry it picked, not from the card.
   *
   * The card-level {@link AgentCard.protocolVersion} is retained alongside it
   * as a documented deviation (see docs/protocol-compatibility.md); drift-watch
   * pins the two to the same value so they cannot disagree.
   */
  protocolVersion: string;
  /**
   * Opaque routing identifier for multi-agent endpoints (`tenant = 3` in the
   * proto). When an interface sets it, clients MUST echo the value in the
   * `tenant` field of every request to that interface.
   *
   * The broker serves a single agent and does no tenant routing, so it never
   * sets this — which is the correct spec-compliant state, not a gap. It is
   * typed so a card from another implementation round-trips intact, and so
   * D9 has the shape it needs. **It is not an authorization boundary**: the
   * value is client-supplied and opaque, and authorization must be performed
   * on every request independently of it.
   */
  tenant?: string;
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
  /** A2A 1.0 transport bindings the agent serves (CARD-PROTO / BIND-FIELD). */
  supportedInterfaces: AgentInterface[];
  /**
   * A2A 1.0 signed card envelope (#1912 F2). Present only when the broker is
   * booted with AGENT_CARD_SIGNING_KEY_FILE; the default card is served
   * unsigned with this key **absent**, not present-and-undefined — the
   * signing payload is JCS over the card sans `signatures`, so a serialized
   * null would change the canonical bytes.
   *
   * This is not a placeholder field: the broker genuinely serves it, and
   * typing it is what lets the compiler catch regressions in the signed card
   * structure. It is deliberately `signatures[]` (the spec's top-level array),
   * not the v0.3-era `signature`/`signedExtensions` scalars, which the broker
   * has never emitted.
   */
  signatures?: AgentCardSignature[];
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
  const jsonRpcUrl = `${baseUrl}/a2a/jsonrpc`;
  // One source for both the card-level field and every interface entry, so the
  // deviation stays a duplicate rather than becoming a contradiction (#1912 D7).
  const protocolVersion = options.protocolVersion ?? "1.0";
  return {
    name: options.serviceName,
    description:
      options.description ??
      "Broker-first A2A coordination service for delegated tasks, proposal review, and auditable worker execution.",
    url: jsonRpcUrl,
    version: options.version ?? "0.1.0",
    protocolVersion,
    provider: options.provider,
    capabilities: {
      streaming: options.supportsStreaming ?? false,
      pushNotifications: options.supportsPushNotifications ?? false,
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    supportedInterfaces: [{ protocolBinding: "JSONRPC", url: jsonRpcUrl, protocolVersion }],
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
      {
        id: "conversation",
        name: "Conversation",
        description:
          "Broker-mediated conversations (a2a.conversation-envelope.v1): inbox poll/consume, task result projection, and cross-broker relay with idempotent ordering. Served on the broker conversation surface (/conversations) and the peer relay — not as A2A JSON-RPC methods.",
        tags: ["conversation", "inbox", "relay", "cross-broker"],
      },
    ],
  };
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
