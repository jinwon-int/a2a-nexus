// Parent round registry (#2339 PR-1a, spec docs/specs/cross-broker-parent-round §1+2).
//
// A broker-side record of which parent rounds exist, who minted them, and which
// child task ids anchor them. Later PRs judge cross-broker projections against
// this record instead of trusting payload claims (PR-1b adds the mint API and
// handoff-receiver registration, PR-1c wires the parent checks). This PR only
// holds and persists the state: nothing reads it for a decision yet, so broker
// behaviour is unchanged.
//
// Persistence follows the other snapshot-only sidecars (wave plans,
// cross-broker projections): no hot table, canonical-blob persistence, carried
// across SQLite hot-table restarts by store.ts.

/** `local-origin`: this broker started the round. `foreign-handoff`: a handoff envelope named it here. */
export type ParentRoundKind = "local-origin" | "foreign-handoff";

export interface ParentRoundMintedBy {
  requesterId: string;
  role: string;
}

/** Persisted (and returned) shape: anchors as a sorted array. */
export interface ParentRoundRegistryEntry {
  parentRoundId: string;
  /** Broker that minted the round (contract meaning of `originBrokerId`). */
  originBrokerId: string;
  /** Broker that renders the operator-facing aggregate for the round. */
  parentBrokerId: string;
  initiatingBrokerId: string;
  teamScope?: string;
  /** Broker the round's children were handed off to, when known. */
  handoffBrokerId?: string;
  parentRoundTotal?: number;
  kind: ParentRoundKind;
  mintedAt: string;
  mintedBy: ParentRoundMintedBy;
  /** Child/origin task ids a projection must match to be accepted (PR-1c). */
  anchors: string[];
}

export type ParentRoundMintInput = Omit<ParentRoundRegistryEntry, "mintedAt" | "anchors"> & {
  mintedAt?: string;
  anchors?: readonly string[];
};

export type ParentRoundMintResult =
  | { status: "minted"; entry: ParentRoundRegistryEntry }
  /** Same id and same round metadata: the existing entry, unchanged. */
  | { status: "replayed"; entry: ParentRoundRegistryEntry }
  /** Same id, different round metadata: refused, existing entry unchanged. */
  | { status: "conflict"; entry: ParentRoundRegistryEntry };

export type ParentRoundAnchorResult =
  | { status: "added" | "present"; entry: ParentRoundRegistryEntry }
  | { status: "unknown_round" }
  | { status: "anchor_limit"; entry: ParentRoundRegistryEntry };

export class ParentRoundRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParentRoundRegistryError";
  }
}

/** Bounds a round's anchor set so one round cannot grow the snapshot without limit. */
export const MAX_PARENT_ROUND_ANCHORS = 1024;
const MAX_ID_CHARS = 200;

interface InternalEntry extends Omit<ParentRoundRegistryEntry, "anchors"> {
  anchors: Set<string>;
}

export class ParentRoundRegistry {
  private readonly entries = new Map<string, InternalEntry>();

  get size(): number {
    return this.entries.size;
  }

  has(parentRoundId: string): boolean {
    return this.entries.has(parentRoundId);
  }

  get(parentRoundId: string): ParentRoundRegistryEntry | undefined {
    const entry = this.entries.get(parentRoundId);
    return entry ? toPublic(entry) : undefined;
  }

  list(): ParentRoundRegistryEntry[] {
    return [...this.entries.values()].map(toPublic).sort(compareEntries);
  }

  /**
   * Register a round. Idempotent on the round metadata: the minting time,
   * minting requester, and anchors are bookkeeping and do not make a retry
   * conflict. Throws ParentRoundRegistryError on malformed input.
   */
  mint(input: ParentRoundMintInput, now: () => Date = () => new Date()): ParentRoundMintResult {
    const candidate = normalizeEntry({
      ...input,
      mintedAt: input.mintedAt ?? now().toISOString(),
      anchors: [...(input.anchors ?? [])],
    });
    const existing = this.entries.get(candidate.parentRoundId);
    if (existing) {
      return {
        status: sameRoundMetadata(existing, candidate) ? "replayed" : "conflict",
        entry: toPublic(existing),
      };
    }
    const entry: InternalEntry = { ...candidate, anchors: new Set(candidate.anchors) };
    this.entries.set(entry.parentRoundId, entry);
    return { status: "minted", entry: toPublic(entry) };
  }

  addAnchor(parentRoundId: string, anchor: string): ParentRoundAnchorResult {
    const entry = this.entries.get(parentRoundId);
    if (!entry) return { status: "unknown_round" };
    const normalized = requireId(anchor, "anchor");
    if (entry.anchors.has(normalized)) return { status: "present", entry: toPublic(entry) };
    if (entry.anchors.size >= MAX_PARENT_ROUND_ANCHORS) return { status: "anchor_limit", entry: toPublic(entry) };
    entry.anchors.add(normalized);
    return { status: "added", entry: toPublic(entry) };
  }

  snapshot(): ParentRoundRegistryEntry[] {
    return this.list();
  }

  /**
   * Replace the registry with persisted entries. Malformed entries are skipped
   * so one bad record cannot keep the broker from starting (#1504, the same
   * rule as the other snapshot collections). The first entry for an id wins.
   */
  restore(records: readonly unknown[]): void {
    this.entries.clear();
    for (const record of records) {
      let entry: ParentRoundRegistryEntry;
      try {
        entry = normalizeEntry(record as ParentRoundRegistryEntry);
      } catch {
        continue;
      }
      if (this.entries.has(entry.parentRoundId)) continue;
      this.entries.set(entry.parentRoundId, { ...entry, anchors: new Set(entry.anchors) });
    }
  }
}

function sameRoundMetadata(a: InternalEntry, b: ParentRoundRegistryEntry): boolean {
  return a.originBrokerId === b.originBrokerId
    && a.parentBrokerId === b.parentBrokerId
    && a.initiatingBrokerId === b.initiatingBrokerId
    && a.teamScope === b.teamScope
    && a.handoffBrokerId === b.handoffBrokerId
    && a.parentRoundTotal === b.parentRoundTotal
    && a.kind === b.kind;
}

function normalizeEntry(input: ParentRoundRegistryEntry): ParentRoundRegistryEntry {
  if (typeof input !== "object" || input === null) {
    throw new ParentRoundRegistryError("parent round entry must be an object");
  }
  if (input.kind !== "local-origin" && input.kind !== "foreign-handoff") {
    throw new ParentRoundRegistryError("parent round kind must be local-origin or foreign-handoff");
  }
  const mintedAt = typeof input.mintedAt === "string" ? Date.parse(input.mintedAt) : Number.NaN;
  if (!Number.isFinite(mintedAt)) throw new ParentRoundRegistryError("parent round mintedAt must be an ISO timestamp");
  if (typeof input.mintedBy !== "object" || input.mintedBy === null) {
    throw new ParentRoundRegistryError("parent round mintedBy is required");
  }
  const total = input.parentRoundTotal;
  if (total !== undefined && !(typeof total === "number" && Number.isSafeInteger(total) && total > 0)) {
    throw new ParentRoundRegistryError("parentRoundTotal must be a positive integer");
  }
  if (!Array.isArray(input.anchors)) throw new ParentRoundRegistryError("parent round anchors must be an array");
  const anchors = [...new Set(input.anchors.map((anchor) => requireId(anchor, "anchor")))].sort();
  if (anchors.length > MAX_PARENT_ROUND_ANCHORS) {
    throw new ParentRoundRegistryError(`parent round anchors exceed ${MAX_PARENT_ROUND_ANCHORS}`);
  }
  const teamScope = optionalId(input.teamScope, "teamScope");
  const handoffBrokerId = optionalId(input.handoffBrokerId, "handoffBrokerId");
  return {
    parentRoundId: requireId(input.parentRoundId, "parentRoundId"),
    originBrokerId: requireId(input.originBrokerId, "originBrokerId"),
    parentBrokerId: requireId(input.parentBrokerId, "parentBrokerId"),
    initiatingBrokerId: requireId(input.initiatingBrokerId, "initiatingBrokerId"),
    ...(teamScope ? { teamScope } : {}),
    ...(handoffBrokerId ? { handoffBrokerId } : {}),
    ...(total !== undefined ? { parentRoundTotal: total } : {}),
    kind: input.kind,
    mintedAt: new Date(mintedAt).toISOString(),
    mintedBy: {
      requesterId: requireId(input.mintedBy.requesterId, "mintedBy.requesterId"),
      role: requireId(input.mintedBy.role, "mintedBy.role"),
    },
    anchors,
  };
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ParentRoundRegistryError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ID_CHARS) {
    throw new ParentRoundRegistryError(`${field} must be 1-${MAX_ID_CHARS} characters`);
  }
  return trimmed;
}

function optionalId(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireId(value, field);
}

function toPublic(entry: InternalEntry): ParentRoundRegistryEntry {
  return {
    parentRoundId: entry.parentRoundId,
    originBrokerId: entry.originBrokerId,
    parentBrokerId: entry.parentBrokerId,
    initiatingBrokerId: entry.initiatingBrokerId,
    ...(entry.teamScope ? { teamScope: entry.teamScope } : {}),
    ...(entry.handoffBrokerId ? { handoffBrokerId: entry.handoffBrokerId } : {}),
    ...(entry.parentRoundTotal !== undefined ? { parentRoundTotal: entry.parentRoundTotal } : {}),
    kind: entry.kind,
    mintedAt: entry.mintedAt,
    mintedBy: { ...entry.mintedBy },
    anchors: [...entry.anchors].sort(),
  };
}

function compareEntries(a: ParentRoundRegistryEntry, b: ParentRoundRegistryEntry): number {
  return a.parentRoundId < b.parentRoundId ? -1 : a.parentRoundId > b.parentRoundId ? 1 : 0;
}
