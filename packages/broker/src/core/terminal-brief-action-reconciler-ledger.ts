/**
 * Broker-side source-only action reconciler / ledger planner.
 *
 * Wraps the Terminal Brief auto-closeout dry-run runner with idempotency
 * storage, replay/reconcile behavior, a noop adapter, and blocked/error
 * state modeling.
 *
 * This module is source-only. It never performs live GitHub actions,
 * provider sends, terminal ACK/replay, DB mutation, restart/deploy,
 * release/publish, or secret movement.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  DryRunRunner  ──►  ActionReconcilerLedgerPlanner           │
 * │                      ├── IdempotencyStorage  (interface)    │
 * │                      ├── NoopLedgerAdapter   (memory impl)  │
 * │                      ├── ReconcileEngine     (diff logic)   │
 * │                      └── ReconcilerResult    (output)       │
 * └─────────────────────────────────────────────────────────────┘
 */

import { createHash } from "node:crypto";

import {
  buildAutoCloseoutDryRunRunner,
  renderAutoCloseoutDryRunRunnerMarkdown,
  type TerminalBriefAutoCloseoutDryRunRunnerInput,
  type TerminalBriefAutoCloseoutDryRunRunnerOptions,
  type TerminalBriefAutoCloseoutDryRunRunnerPacket,
} from "./terminal-brief-auto-closeout-dryrun-runner.js";

// ---------------------------------------------------------------------------
// Ledger row / record types
// ---------------------------------------------------------------------------

/** State of an individual ledger row. */
export type ActionLedgerRowState =
  | "recorded"     // action was stored but not yet reconciled against a new plan
  | "reconciled"   // action matches between stored state and current plan
  | "blocked"      // action cannot proceed due to policy or evidence blockers
  | "errored"      // storage/planning error occurred for this row
  | "skipped";     // action was idempotency-skipped (duplicate key suppressed)

/** High-level reconciler state machine. */
export type ReconcilerLedgerState =
  | "idle"          // no reconciliation has been performed
  | "reconciling"   // reconciliation is in progress
  | "reconciled"    // reconciliation completed successfully
  | "blocked"       // reconciliation blocked (policy or evidence)
  | "errored";      // reconciliation encountered an error

/** A single stored ledger record tracking one planned action. */
export interface ActionLedgerRecord {
  /** Unique ledger row id. */
  id: string;
  /** Run id from the dry-run runner. */
  runId: string;
  /** Parent round identifier. */
  parentRoundId: string;
  /** Action kind (matches AutoCloseoutActionKind). */
  actionKind: string;
  /** Human-readable action label. */
  actionLabel: string;
  /** Idempotency key derived from action + plan + evidence. */
  idempotencyKey: string;
  /** Current row state. */
  rowState: ActionLedgerRowState;
  /** Whether the action requires operator approval. */
  requiresApproval: boolean;
  /** Whether execution was permitted at store time. */
  executePermitted: boolean;
  /** Detail / reason text. */
  detail: string;
  /** ISO timestamp when this row was stored. */
  storedAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
  /** Optional error message if rowState is errored. */
  errorMessage?: string;
  /** Optional block reason if rowState is blocked. */
  blockReason?: string;
}

// ---------------------------------------------------------------------------
// Idempotency storage interface
// ---------------------------------------------------------------------------

/**
 * Idempotent storage for reconciled action ledger rows.
 *
 * This is the broker-side interface. Implementations can be in-memory
 * (NoopLedgerAdapter), SQLite, file-backed, or remote. The reconciler
 * calls these methods during its reconcile step — never during live
 * action execution.
 */
export interface ActionLedgerStorage {
  /**
   * Store a new ledger row. If a row with the same idempotencyKey already
   * exists, return the existing row without mutation (idempotent store).
   */
  store(row: ActionLedgerRecord): ActionLedgerRecord;

  /**
   * Return true if a row with the given idempotencyKey already exists.
   */
  has(idempotencyKey: string): boolean;

  /**
   * Retrieve a row by its id.
   */
  getById(id: string): ActionLedgerRecord | undefined;

  /**
   * Retrieve a row by its idempotencyKey.
   */
  getByIdempotencyKey(idempotencyKey: string): ActionLedgerRecord | undefined;

  /**
   * Retrieve all rows for a given runId.
   */
  getByRunId(runId: string): ActionLedgerRecord[];

  /**
   * Update an existing row's state.
   */
  update(id: string, patch: Partial<ActionLedgerRecord>): ActionLedgerRecord | undefined;

  /**
   * Remove a row by id. Returns true if removed.
   */
  remove(id: string): boolean;

  /**
   * List all rows across all runs.
   */
  list(): ActionLedgerRecord[];

  /**
   * Count rows by state.
   */
  countByState(): Record<ActionLedgerRowState, number>;

  /**
   * Clear all records (for testing / reset).
   */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Noop (in-memory) ledger adapter
// ---------------------------------------------------------------------------

/**
 * In-memory implementation of ActionLedgerStorage.
 * Safe for testing and source-only dry-run contexts.
 * Never persists across process restarts.
 */
export class NoopLedgerAdapter implements ActionLedgerStorage {
  private rows: Map<string, ActionLedgerRecord> = new Map();
  private idKeyIndex: Map<string, string> = new Map();

  store(row: ActionLedgerRecord): ActionLedgerRecord {
    // Idempotency check: if a row with this key exists, return it unchanged
    const existingId = this.idKeyIndex.get(row.idempotencyKey);
    if (existingId !== undefined) {
      const existing = this.rows.get(existingId);
      if (existing) return existing;
    }
    this.rows.set(row.id, row);
    this.idKeyIndex.set(row.idempotencyKey, row.id);
    return row;
  }

  has(idempotencyKey: string): boolean {
    return this.idKeyIndex.has(idempotencyKey);
  }

  getById(id: string): ActionLedgerRecord | undefined {
    return this.rows.get(id);
  }

  getByIdempotencyKey(idempotencyKey: string): ActionLedgerRecord | undefined {
    const id = this.idKeyIndex.get(idempotencyKey);
    if (id === undefined) return undefined;
    return this.rows.get(id);
  }

  getByRunId(runId: string): ActionLedgerRecord[] {
    const result: ActionLedgerRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.runId === runId) result.push(row);
    }
    return result.sort((a, b) => a.storedAt.localeCompare(b.storedAt));
  }

  update(id: string, patch: Partial<ActionLedgerRecord>): ActionLedgerRecord | undefined {
    const existing = this.rows.get(id);
    if (!existing) return undefined;
    const updated: ActionLedgerRecord = { ...existing, ...patch, id: existing.id };
    // Protect immutables
    this.rows.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    const row = this.rows.get(id);
    if (!row) return false;
    this.idKeyIndex.delete(row.idempotencyKey);
    this.rows.delete(id);
    return true;
  }

  list(): ActionLedgerRecord[] {
    return [...this.rows.values()].sort((a, b) => a.storedAt.localeCompare(b.storedAt));
  }

  countByState(): Record<ActionLedgerRowState, number> {
    const counts: Record<ActionLedgerRowState, number> = {
      recorded: 0,
      reconciled: 0,
      blocked: 0,
      errored: 0,
      skipped: 0,
    };
    for (const row of this.rows.values()) {
      counts[row.rowState] = (counts[row.rowState] ?? 0) + 1;
    }
    return counts;
  }

  clear(): void {
    this.rows.clear();
    this.idKeyIndex.clear();
  }
}

// ---------------------------------------------------------------------------
// Reconcile result types
// ---------------------------------------------------------------------------

/** Individual diff entry between stored and planned actions. */
export interface ReconcileDiffEntry {
  /** Diff classification. */
  kind: "new" | "matching" | "stale" | "missing" | "state_changed";
  /** Stored row id (present when kind is matching, stale, or state_changed). */
  storedId?: string;
  /** Stored idempotency key. */
  idempotencyKey: string;
  /** Action kind. */
  actionKind: string;
  /** Action label. */
  actionLabel: string;
  /** Stored row state (present when stored row exists). */
  storedRowState?: ActionLedgerRowState;
  /** Current planned state (present when action is in the plan). */
  plannedRowState?: ActionLedgerRowState;
  /** Description of the diff. */
  detail: string;
}

/** The overall difference summary. */
export interface ReconcileDiffSummary {
  /** Number of new actions not yet in the ledger. */
  newActions: number;
  /** Number of actions that match between stored and planned. */
  matchingActions: number;
  /** Number of stored actions no longer in the plan (stale). */
  staleActions: number;
  /** Number of planned actions with no matching stored row (missing). */
  missingActions: number;
  /** Number of actions where state differs. */
  stateChangedActions: number;
  /** Total planned actions. */
  totalPlanned: number;
  /** Total stored rows for this run. */
  totalStored: number;
  /** Timestamp. */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Reconciler result / planner output
// ---------------------------------------------------------------------------

export interface ReconcilerLedgerPlannerResult {
  kind: "a2a-broker.terminal-brief-action-reconciler-ledger-planner.result";
  version: 1;
  generatedAt: string;
  runId: string;
  reconcilerState: ReconcilerLedgerState;
  sourceOnlyNoLive: true;
  /** Embedded dry-run runner packet. */
  dryRunPacket: TerminalBriefAutoCloseoutDryRunRunnerPacket;
  /** Ledger rows that were stored or updated during this reconciliation. */
  ledgerRows: ActionLedgerRecord[];
  /** Reconciliation diff (only present when previous state exists). */
  diff: {
    entries: ReconcileDiffEntry[];
    summary: ReconcileDiffSummary;
    previousRunId?: string;
  };
  /** Blockers at the reconciler level. */
  blockers: string[];
  /** Warnings at the reconciler level. */
  warnings: string[];
  /** Rendered markdown for evidence output. */
  markdown: string;
  /** Safety gates — all forced to safe defaults. */
  safety: {
    reconciliationOnly: boolean;
    storeOnly: boolean;
    noLiveExecution: boolean;
    idempotencyGuarded: boolean;
  };
  /** Integration contract — source-only slice. */
  integrationContract: {
    storesActionLedgerRows: boolean;
    reconcilesAgainstStoredState: boolean;
    executesGitHubComment: false;
    executesGitHubClose: false;
    executesProviderSend: false;
    executesTerminalAck: false;
    executesDbMutation: false;
    executesRestartDeploy: false;
    executesReleasePublish: false;
    executesSecretMovement: false;
  };
}

// ---------------------------------------------------------------------------
// Reconciler planner input
// ---------------------------------------------------------------------------

export interface ReconcilerLedgerPlannerInput {
  /** Dry-run runner input (planner + runner options). */
  dryRunInput: TerminalBriefAutoCloseoutDryRunRunnerInput;
  /** Runner-level options. */
  dryRunOptions?: TerminalBriefAutoCloseoutDryRunRunnerOptions;
  /** Pre-existing ledger storage (noop adapter used if omitted). */
  storage?: ActionLedgerStorage;
  /** Previous run id for cross-run reconciliation (optional). */
  previousRunId?: string;
  /** Allow overriding the reconciler state for testing. */
  forceState?: ReconcilerLedgerState;
}

export interface ReconcilerLedgerPlannerOptions {
  now?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a source-only action reconciler / ledger planner result.
 *
 * Steps:
 * 1. Build the dry-run runner packet (forces policyMode=draft, all safe).
 * 2. Compute ledger rows from the dry-run actions (idempotency-keyed).
 * 3. Store rows via the storage adapter (idempotent store — duplicates
 *    return existing rows unchanged).
 * 4. Reconcile stored rows against the current planned actions.
 * 5. Produce a typed result with ledger, diff, blockers, and evidence
 *    markdown.
 */
export function buildReconcilerLedgerPlanner(
  input: ReconcilerLedgerPlannerInput,
  options: ReconcilerLedgerPlannerOptions = {},
): ReconcilerLedgerPlannerResult {
  const now = options.now ?? new Date().toISOString();
  const storage = input.storage ?? new NoopLedgerAdapter();
  const forceState = input.forceState;

  // Step 1: Build the dry-run runner packet
  const packet = buildAutoCloseoutDryRunRunner(input.dryRunInput, input.dryRunOptions);
  const runId = packet.runId ?? "reconciler-" + now.replace(/[:.]/g, "-");
  const parentRoundId = packet.plan.parentRoundId ?? "unknown";

  // Step 2: Compute ledger rows from the dry-run actions
  const ledgerRows: ActionLedgerRecord[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Determine reconciler state
  let reconcilerState: ReconcilerLedgerState;
  if (forceState) {
    reconcilerState = forceState;
  } else if (packet.state === "plan_invalid") {
    reconcilerState = "errored";
    blockers.push("dry-run runner produced plan_invalid state: " + (packet.blockers[0] ?? "unknown error"));
  } else if (packet.state === "plan_blocked") {
    reconcilerState = "blocked";
    blockers.push(...packet.blockers.map((b) => "dry-run runner blocked: " + b));
  } else if (packet.state === "plan_waiting") {
    reconcilerState = "blocked";
    blockers.push("dry-run runner waiting: " + (packet.blockers[0] ?? "insufficient evidence"));
  } else {
    reconcilerState = "idle";
  }

  // When forceState is set, skip store/reconcile logic and return a minimal result
  if (forceState) {
    const minimalMarkdown = renderReconcilerLedgerPlannerMarkdown({
      kind: "a2a-broker.terminal-brief-action-reconciler-ledger-planner.result" as const,
      version: 1,
      generatedAt: now,
      runId,
      reconcilerState,
      sourceOnlyNoLive: true,
      dryRunPacket: packet,
      ledgerRows: [],
      diff: {
        entries: [],
        summary: {
          newActions: 0,
          matchingActions: 0,
          staleActions: 0,
          missingActions: 0,
          stateChangedActions: 0,
          totalPlanned: packet.actions.length,
          totalStored: 0,
          generatedAt: now,
        },
        previousRunId: input.previousRunId,
      },
      blockers,
      warnings,
      markdown: "",
      safety: {
        reconciliationOnly: true,
        storeOnly: false,
        noLiveExecution: true,
        idempotencyGuarded: true,
      },
      integrationContract: {
        storesActionLedgerRows: false,
        reconcilesAgainstStoredState: false,
        executesGitHubComment: false,
        executesGitHubClose: false,
        executesProviderSend: false,
        executesTerminalAck: false,
        executesDbMutation: false,
        executesRestartDeploy: false,
        executesReleasePublish: false,
        executesSecretMovement: false,
      },
    });
    return {
      kind: "a2a-broker.terminal-brief-action-reconciler-ledger-planner.result",
      version: 1,
      generatedAt: now,
      runId,
      reconcilerState,
      sourceOnlyNoLive: true,
      dryRunPacket: packet,
      ledgerRows: [],
      diff: {
        entries: [],
        summary: {
          newActions: 0,
          matchingActions: 0,
          staleActions: 0,
          missingActions: 0,
          stateChangedActions: 0,
          totalPlanned: packet.actions.length,
          totalStored: 0,
          generatedAt: now,
        },
        previousRunId: input.previousRunId,
      },
      blockers,
      warnings,
      markdown: minimalMarkdown,
      safety: {
        reconciliationOnly: true,
        storeOnly: false,
        noLiveExecution: true,
        idempotencyGuarded: true,
      },
      integrationContract: {
        storesActionLedgerRows: false,
        reconcilesAgainstStoredState: false,
        executesGitHubComment: false,
        executesGitHubClose: false,
        executesProviderSend: false,
        executesTerminalAck: false,
        executesDbMutation: false,
        executesRestartDeploy: false,
        executesReleasePublish: false,
        executesSecretMovement: false,
      },
    };
  }

  // Only store/reconcile when the plan is ready
  if (reconcilerState === "idle") {
    reconcilerState = "reconciling";

    // Build ledger rows from actions
    for (const action of packet.actions) {
      const actionIdempotencyKey = buildActionIdempotencyKey(
        runId,
        action.kind,
        action.label,
        packet.idempotencyKey,
      );

      // Idempotency check
      if (storage.has(actionIdempotencyKey)) {
        const existing = storage.getByIdempotencyKey(actionIdempotencyKey);
        if (existing) {
          // Skip — existing row returned unchanged
          ledgerRows.push(existing);
          warnings.push(
            "idempotency skip: action '" + action.label + "' "
            + "(key=" + actionIdempotencyKey.slice(0, 32) + "…) already stored at "
            + existing.storedAt,
          );
          continue;
        }
      }

      const row: ActionLedgerRecord = {
        id: buildLedgerRowId(actionIdempotencyKey, now),
        runId,
        parentRoundId,
        actionKind: action.kind,
        actionLabel: action.label,
        idempotencyKey: actionIdempotencyKey,
        rowState: packet.state === "plan_blocked" || packet.state === "plan_waiting"
          ? "blocked"
          : "recorded",
        requiresApproval: action.requiresApproval,
        executePermitted: action.executePermitted,
        detail: action.detail,
        storedAt: now,
        updatedAt: now,
        blockReason: packet.state === "plan_blocked" || packet.state === "plan_waiting"
          ? "dry-run runner produced non-ready state: " + packet.state
          : undefined,
      };

      const stored = storage.store(row);
      ledgerRows.push(stored);
    }

    // Determine final reconciler state (diff computed below)
    reconcilerState = "reconciled";
  }

  // Render markdown
  const markdown = renderReconcilerLedgerPlannerMarkdown({
    kind: "a2a-broker.terminal-brief-action-reconciler-ledger-planner.result" as const,
    version: 1,
    generatedAt: now,
    runId,
    reconcilerState,
    sourceOnlyNoLive: true,
    dryRunPacket: packet,
    ledgerRows,
    diff: {
      entries: [],
      summary: {
        newActions: 0,
        matchingActions: 0,
        staleActions: 0,
        missingActions: 0,
        stateChangedActions: 0,
        totalPlanned: 0,
        totalStored: 0,
        generatedAt: now,
      },
      previousRunId: input.previousRunId,
    },
    blockers,
    warnings,
    markdown: "",
    safety: {
      reconciliationOnly: true,
      storeOnly: true,
      noLiveExecution: true,
      idempotencyGuarded: true,
    },
    integrationContract: {
      storesActionLedgerRows: true,
      reconcilesAgainstStoredState: true,
      executesGitHubComment: false,
      executesGitHubClose: false,
      executesProviderSend: false,
      executesTerminalAck: false,
      executesDbMutation: false,
      executesRestartDeploy: false,
      executesReleasePublish: false,
      executesSecretMovement: false,
    },
  });

  const storedRows = storage.getByRunId(runId);
  const diff = reconcileActions(storedRows, packet.actions, runId, now, packet.idempotencyKey);

  return {
    kind: "a2a-broker.terminal-brief-action-reconciler-ledger-planner.result",
    version: 1,
    generatedAt: now,
    runId,
    reconcilerState,
    sourceOnlyNoLive: true,
    dryRunPacket: packet,
    ledgerRows,
    diff: {
      entries: diff.entries,
      summary: diff.summary,
      previousRunId: input.previousRunId,
    },
    blockers,
    warnings,
    markdown,
    safety: {
      reconciliationOnly: true,
      storeOnly: true,
      noLiveExecution: true,
      idempotencyGuarded: true,
    },
    integrationContract: {
      storesActionLedgerRows: true,
      reconcilesAgainstStoredState: true,
      executesGitHubComment: false,
      executesGitHubClose: false,
      executesProviderSend: false,
      executesTerminalAck: false,
      executesDbMutation: false,
      executesRestartDeploy: false,
      executesReleasePublish: false,
      executesSecretMovement: false,
    },
  };
}

/**
 * Render a human-readable markdown summary of the reconciler ledger planner
 * result, including ledger rows, diff, and safety boundary.
 */
export function renderReconcilerLedgerPlannerMarkdown(
  result: ReconcilerLedgerPlannerResult,
): string {
  const stateLabel = titleForReconcilerState(result.reconcilerState);

  const lines: string[] = [
    stateLabel,
    "Run ID: " + result.runId,
    "Parent round: " + (result.dryRunPacket.plan.parentRoundId ?? "unknown"),
    "Reconciler state: " + result.reconcilerState + " sourceOnlyNoLive=" + result.sourceOnlyNoLive,
    "",
  ];

  // Ledger rows
  lines.push("Ledger rows (" + result.ledgerRows.length + "):");
  for (const row of result.ledgerRows) {
    const execStatus = row.executePermitted ? "execute_permitted" : "execute_blocked";
    lines.push(
      "- [" + row.rowState + "] " + row.actionLabel
      + " (" + row.actionKind + ") " + execStatus
      + " reqApproval=" + row.requiresApproval,
    );
    if (row.blockReason) lines.push("  block: " + row.blockReason);
    if (row.errorMessage) lines.push("  error: " + row.errorMessage);
  }
  lines.push("");

  // Diff summary
  if (result.diff.entries.length > 0) {
    lines.push("Reconciliation diff:");
    lines.push("- new: " + result.diff.summary.newActions);
    lines.push("- matching: " + result.diff.summary.matchingActions);
    lines.push("- stale: " + result.diff.summary.staleActions);
    lines.push("- missing: " + result.diff.summary.missingActions);
    lines.push("- state_changed: " + result.diff.summary.stateChangedActions);
    lines.push("");

    if (result.diff.previousRunId) {
      lines.push("Cross-run reconciliation from: " + result.diff.previousRunId);
      lines.push("");
    }

    for (const entry of result.diff.entries) {
      lines.push("- [" + entry.kind + "] " + entry.actionLabel + " (" + entry.actionKind + ")");
      lines.push("  " + entry.detail);
    }
    lines.push("");
  }

  // Blockers
  if (result.blockers.length > 0) {
    lines.push("Blockers:");
    for (const blocker of result.blockers) lines.push("- " + blocker);
    lines.push("");
  }

  // Warnings
  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) lines.push("- " + warning);
    lines.push("");
  }

  // Safety boundary
  lines.push("Safety boundary:");
  lines.push("- reconciliationOnly=" + result.safety.reconciliationOnly);
  lines.push("- storeOnly=" + result.safety.storeOnly);
  lines.push("- noLiveExecution=" + result.safety.noLiveExecution);
  lines.push("- idempotencyGuarded=" + result.safety.idempotencyGuarded);
  lines.push("");

  // Integration contract
  lines.push("Integration contract:");
  lines.push("- storesActionLedgerRows=" + result.integrationContract.storesActionLedgerRows);
  lines.push("- reconcilesAgainstStoredState=" + result.integrationContract.reconcilesAgainstStoredState);
  lines.push("- executesGitHubComment=" + result.integrationContract.executesGitHubComment);
  lines.push("- executesGitHubClose=" + result.integrationContract.executesGitHubClose);
  lines.push("- executesProviderSend=" + result.integrationContract.executesProviderSend);
  lines.push("- executesTerminalAck=" + result.integrationContract.executesTerminalAck);
  lines.push("- executesDbMutation=" + result.integrationContract.executesDbMutation);
  lines.push("- executesRestartDeploy=" + result.integrationContract.executesRestartDeploy);
  lines.push("- executesReleasePublish=" + result.integrationContract.executesReleasePublish);
  lines.push("- executesSecretMovement=" + result.integrationContract.executesSecretMovement);
  lines.push("");

  // Embedded dry-run runner markdown
  lines.push("---");
  lines.push("Embedded dry-run runner packet:");
  lines.push(renderAutoCloseoutDryRunRunnerMarkdown(result.dryRunPacket)
    .split("\n").map((l) => "  " + l).join("\n"));

  // Final safety footer
  lines.push("");
  lines.push("Safety: source-only reconciler ledger planner. Stores action rows"
    + " to an in-memory or provided storage adapter. Does not execute GitHub"
    + " comment/close, provider send, terminal ACK/replay, DB mutation,"
    + " restart/deploy, release/publish, or secret movement. Idempotency-gated.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Reconcile logic
// ---------------------------------------------------------------------------

/**
 * Reconcile stored ledger rows against current planned actions.
 * Returns diff entries and a summary.
 */
export function reconcileActions(
  storedRows: ActionLedgerRecord[],
  plannedActions: ReadonlyArray<{ kind: string; label: string; requiresApproval: boolean; executePermitted: boolean; detail: string }>,
  runId: string,
  now: string,
  planIdempotencyKey: string,
): { entries: ReconcileDiffEntry[]; summary: ReconcileDiffSummary } {
  const entries: ReconcileDiffEntry[] = [];
  const plannedKeyed = new Map<string, typeof plannedActions[number]>();

  // Index planned actions by their action-level idempotency key
  for (const action of plannedActions) {
    const key = buildActionIdempotencyKey(runId, action.kind, action.label, planIdempotencyKey);
    plannedKeyed.set(key, action);
  }

  // Index stored rows by idempotency key
  const storedKeyed = new Map<string, ActionLedgerRecord>();
  for (const row of storedRows) {
    storedKeyed.set(row.idempotencyKey, row);
  }

  let newActions = 0;
  let matchingActions = 0;
  let staleActions = 0;
  let missingActions = 0;
  let stateChangedActions = 0;

  // 1. Check each planned action against stored state
  for (const [key, action] of plannedKeyed) {
    const stored = storedKeyed.get(key);
    if (!stored) {
      // Planned action not yet in ledger — missing
      missingActions++;
      entries.push({
        kind: "missing",
        idempotencyKey: key,
        actionKind: action.kind,
        actionLabel: action.label,
        plannedRowState: "recorded",
        detail: "planned action not found in ledger; will be stored on reconcile",
      });
    } else if (stored.rowState === "recorded" || stored.rowState === "reconciled") {
      matchingActions++;
      entries.push({
        kind: "matching",
        storedId: stored.id,
        idempotencyKey: key,
        actionKind: action.kind,
        actionLabel: action.label,
        storedRowState: stored.rowState,
        plannedRowState: "recorded",
        detail: "action matches between stored ledger and current plan",
      });
    } else if (stored.rowState === "blocked") {
      // State changed from blocked in stored to recorded in plan
      stateChangedActions++;
      entries.push({
        kind: "state_changed",
        storedId: stored.id,
        idempotencyKey: key,
        actionKind: action.kind,
        actionLabel: action.label,
        storedRowState: "blocked",
        plannedRowState: "recorded",
        detail: "stored as blocked but now in plan as recorded",
      });
    } else {
      // Other state transitions
      stateChangedActions++;
      entries.push({
        kind: "state_changed",
        storedId: stored.id,
        idempotencyKey: key,
        actionKind: action.kind,
        actionLabel: action.label,
        storedRowState: stored.rowState,
        plannedRowState: "recorded",
        detail: "state changed from " + stored.rowState + " to recorded",
      });
    }
  }

  // 2. Check for stale stored rows (not in current plan)
  for (const [key, stored] of storedKeyed) {
    if (!plannedKeyed.has(key)) {
      staleActions++;
      entries.push({
        kind: "stale",
        storedId: stored.id,
        idempotencyKey: key,
        actionKind: stored.actionKind,
        actionLabel: stored.actionLabel,
        storedRowState: stored.rowState,
        detail: "stored action no longer appears in current plan",
      });
    }
  }

  // 3. Count new actions
  for (const [key] of plannedKeyed) {
    if (!storedKeyed.has(key)) {
      newActions++;
    }
  }

  return {
    entries: entries.sort((a, b) => a.actionLabel.localeCompare(b.actionLabel)),
    summary: {
      newActions,
      matchingActions,
      staleActions,
      missingActions,
      stateChangedActions,
      totalPlanned: plannedKeyed.size,
      totalStored: storedKeyed.size,
      generatedAt: now,
    },
  };
}

/**
 * Build a reconciler diff that counts blocked actions alongside the normal
 * diff entries (new, matching, stale, missing, state_changed).
 *
 * This is the canonical diff function used by the reconciler planner.
 */
export function reconcileActionLedger(
  storedRows: ActionLedgerRecord[],
  plannedActions: ReadonlyArray<{
    kind: string;
    label: string;
    requiresApproval: boolean;
    executePermitted: boolean;
    detail: string;
  }>,
  runId: string,
  now: string,
  planIdempotencyKey: string,
): { entries: ReconcileDiffEntry[]; summary: ReconcileDiffSummary & { blockedActions: number } } {
  const base = reconcileActions(storedRows, plannedActions, runId, now, planIdempotencyKey);

  let blockedActions = 0;
  for (const entry of base.entries) {
    if (entry.storedRowState === "blocked" || entry.plannedRowState === "blocked") {
      blockedActions++;
    }
  }

  const entryList: ReconcileDiffEntry[] = [];
  const seenKinds = new Set<string>();

  // Walk planned actions and classify
  const plannedKeyed = new Map<string, typeof plannedActions[number]>();
  for (const action of plannedActions) {
    const key = buildActionIdempotencyKey(runId, action.kind, action.label, planIdempotencyKey);
    plannedKeyed.set(key, action);
  }

  const storedKeyed = new Map<string, ActionLedgerRecord>();
  for (const row of storedRows) {
    storedKeyed.set(row.idempotencyKey, row);
  }

  for (const [key, action] of plannedKeyed) {
    const stored = storedKeyed.get(key);
    if (stored && stored.rowState === "blocked") {
      entryList.push({
        kind: "state_changed",
        storedId: stored.id,
        idempotencyKey: key,
        actionKind: action.kind,
        actionLabel: action.label,
        storedRowState: "blocked",
        plannedRowState: "recorded",
        detail: "action was blocked in stored ledger but is now planned",
      });
      seenKinds.add("state_changed");
    } else if (!stored) {
      if (!seenKinds.has("new")) {
        entryList.push({
          kind: "new",
          idempotencyKey: key,
          actionKind: action.kind,
          actionLabel: action.label,
          plannedRowState: "recorded",
          detail: "new action not previously stored in ledger",
        });
        seenKinds.add("new");
      }
    } else {
      if (!seenKinds.has("matching")) {
        entryList.push({
          kind: "matching",
          storedId: stored.id,
          idempotencyKey: key,
          actionKind: action.kind,
          actionLabel: action.label,
          storedRowState: stored.rowState,
          plannedRowState: "recorded",
          detail: "action matches between stored ledger and current plan",
        });
        seenKinds.add("matching");
      }
    }
  }

  // Stale check
  for (const [key, stored] of storedKeyed) {
    if (!plannedKeyed.has(key)) {
      entryList.push({
        kind: "stale",
        storedId: stored.id,
        idempotencyKey: key,
        actionKind: stored.actionKind,
        actionLabel: stored.actionLabel,
        storedRowState: stored.rowState,
        detail: "stored action no longer appears in current plan",
      });
    }
  }

  return {
    entries: entryList,
    summary: {
      ...base.summary,
      blockedActions,
    },
  };
}

// ---------------------------------------------------------------------------
// Idempotency helpers
// ---------------------------------------------------------------------------

function buildActionIdempotencyKey(
  runId: string,
  actionKind: string,
  actionLabel: string,
  planIdempotencyKey: string,
): string {
  const stable = JSON.stringify({
    runId,
    actionKind,
    actionLabel,
    planIdempotencyKey,
  });
  return "action-ledger:" + createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

function buildLedgerRowId(idempotencyKey: string, now: string): string {
  const suffix = createHash("sha256").update(now + idempotencyKey).digest("hex").slice(0, 12);
  return "row-" + suffix;
}

function titleForReconcilerState(state: ReconcilerLedgerState): string {
  switch (state) {
    case "idle":
      return "Idle: action reconciler ledger planner — idle (no reconciliation performed)";
    case "reconciling":
      return "Reconciling: action reconciler ledger planner — reconciliation in progress";
    case "reconciled":
      return "Reconciled: action reconciler ledger planner — reconciled";
    case "blocked":
      return "Blocked: action reconciler ledger planner — blocked";
    case "errored":
      return "Error: action reconciler ledger planner — error";
  }
}
