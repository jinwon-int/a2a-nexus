/**
 * TEST-ONLY statement-boundary fault seam for worker-mode V1 SQLite targets.
 *
 * Five of the seven inline Phase 2 targets inject faults by wrapping their own
 * `DatabaseSync` in a `Proxy` and firing at a statement boundary inside the
 * adapter's transaction. Each wrote its own wrapper against its own fault-point
 * vocabulary. In worker mode the connection lives in the worker, so the wrapper
 * has to live there too — and one worker serves every harness.
 *
 * This generalises the five wrappers into one mechanism with no harness
 * knowledge in it. A target computes, on the main thread, which SQL a fault
 * point matches and at which phase it fires, ships that plan over the
 * conformance control channel, and this seam executes it mechanically. The
 * meaning of a fault point stays with the harness that owns it.
 *
 * The three phases reproduce every position the inline targets needed:
 *   - `before-prepare` fires instead of preparing the matched statement, so
 *     nothing is written (the `before_mutation` family).
 *   - `after-run` prepares and really runs the matched statement, then fires,
 *     so the row exists and the adapter still has to roll back. Delegating
 *     first is essential: firing before `run` would be `before-prepare`
 *     wearing another name.
 *   - `before-exec` fires instead of executing a matched bare statement, which
 *     is how a fault lands immediately before `COMMIT`.
 *
 * A fired fault throws. The adapter rolls its own transaction back and the
 * worker runtime reports a closed failure for that ticket; the target then maps
 * it to the operation-preserving unavailable result its harness expects, which
 * is exactly what the inline targets do.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { SharedStateSqliteConformanceFaultPlanV1 } from "./shared-state-sqlite-conformance-control-v1.js";

/** The sentinel a fired fault throws. Never produced by the adapter itself. */
export const SHARED_STATE_SQLITE_CONFORMANCE_FAULT_MESSAGE_V1 =
  "test-only-injected-conformance-fault";

export interface SharedStateSqliteConformanceFaultStateV1 {
  armed: SharedStateSqliteConformanceFaultPlanV1 | null;
  fired: boolean;
  firedAt: string[];
}

export function createSharedStateSqliteConformanceFaultStateV1(): SharedStateSqliteConformanceFaultStateV1 {
  return { armed: null, fired: false, firedAt: [] };
}

/**
 * Wraps a connection so armed plans fire at their declared phase. The returned
 * handle is what the adapter must be constructed over; the raw connection stays
 * available to the caller for out-of-band observation, which must not be
 * subject to injected faults.
 */
export function createSharedStateSqliteConformanceFaultHandleV1(
  db: DatabaseSync,
  state: SharedStateSqliteConformanceFaultStateV1,
): DatabaseSync {
  const fire = (plan: SharedStateSqliteConformanceFaultPlanV1): never => {
    // A non-repeating plan disarms on fire. Section 2.5 needs the opposite: a
    // point that keeps firing until it is explicitly replaced.
    if (!plan.repeating) state.armed = null;
    state.fired = true;
    state.firedAt.push(plan.point);
    throw new Error(SHARED_STATE_SQLITE_CONFORMANCE_FAULT_MESSAGE_V1);
  };

  return new Proxy(db, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver) as unknown;

      if (property === "prepare") {
        return (sql: string): unknown => {
          const plan = state.armed;
          const matches = plan !== null && sql.includes(plan.sqlFragment);

          if (matches && plan.phase === "before-prepare") fire(plan);

          const statement = target.prepare(sql);
          if (!matches || plan.phase !== "after-run") return statement;

          return new Proxy(statement, {
            get(stmt, stmtProperty, stmtReceiver): unknown {
              const stmtValue = Reflect.get(
                stmt,
                stmtProperty,
                stmtReceiver,
              ) as unknown;
              if (stmtProperty !== "run") {
                return typeof stmtValue === "function"
                  ? stmtValue.bind(stmt)
                  : stmtValue;
              }
              return (...args: unknown[]): unknown => {
                // Delegate first so the row is really written.
                (stmt.run as (...input: unknown[]) => unknown)(...args);
                return fire(plan);
              };
            },
          }) as StatementSync;
        };
      }

      if (property === "exec") {
        return (sql: string): unknown => {
          const plan = state.armed;
          if (
            plan !== null
            && plan.phase === "before-exec"
            && sql.includes(plan.sqlFragment)
          ) {
            fire(plan);
          }
          return target.exec(sql);
        };
      }

      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DatabaseSync;
}
