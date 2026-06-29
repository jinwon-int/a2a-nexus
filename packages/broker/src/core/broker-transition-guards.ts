// Precondition guards for InMemoryA2ABroker mutations, extracted from the broker
// god-class into pure free functions. Each throws BrokerError when a mutation's
// precondition is unmet and is otherwise side-effect free. The two ownership
// guards consult the broker's own identity, which is passed in explicitly
// (brokerId/teamId) rather than read off `this`, so all four are unit-testable
// in isolation and follow the existing broker-*.ts free-function convention.
import { BrokerError } from "./broker-error.js";
import type { ProposalStatus, TaskRecord, TaskStatus } from "./types.js";
import { normalizeOwnershipString } from "./broker-task-request-normalizers.js";

/** Reject a proposal state transition whose current status is not in `allowed`. */
export function assertTransition(
  current: ProposalStatus,
  allowed: ProposalStatus[],
  action: string,
): void {
  if (!allowed.includes(current)) {
    throw new BrokerError(
      "invalid_transition",
      `cannot ${action} proposal while status is ${current}`,
    );
  }
}

/** Reject a task state transition whose current status is not in `allowed`. */
export function assertTaskStatus(
  current: TaskStatus,
  allowed: TaskStatus[],
  action: string,
): void {
  if (!allowed.includes(current)) {
    throw new BrokerError(
      "invalid_transition",
      `cannot ${action} task while status is ${current}`,
    );
  }
}

/**
 * Reject an action on a task owned by a different broker-of-record or team than
 * the operating broker (`brokerId`/`teamId`).
 */
export function assertTaskOwnership(
  task: TaskRecord,
  action: string,
  brokerId: string | undefined,
  teamId: string | undefined,
): void {
  const taskBroker = normalizeOwnershipString(task.brokerOfRecord);
  if (taskBroker && brokerId !== taskBroker) {
    throw new BrokerError(
      "policy_denied",
      `${action} requires broker-of-record ${taskBroker}`,
    );
  }

  const taskTeam = normalizeOwnershipString(task.teamId);
  if (taskTeam && teamId !== taskTeam) {
    throw new BrokerError(
      "policy_denied",
      `${action} requires teamId ${taskTeam}`,
    );
  }
}

/** Reject a task creation that sets a brokerOfRecord other than the operating broker. */
export function assertTaskCreationOwnership(
  brokerOfRecord: string | undefined,
  brokerId: string | undefined,
): void {
  if (brokerOfRecord && brokerId && brokerId !== brokerOfRecord) {
    throw new BrokerError(
      "policy_denied",
      `create cannot set brokerOfRecord ${brokerOfRecord} on broker ${brokerId}`,
    );
  }
}
