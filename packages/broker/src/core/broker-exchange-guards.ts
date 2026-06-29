// Authorization guard for A2A exchange messages, extracted from the
// InMemoryA2ABroker god-class into a pure free function. It validates that the
// message actor is permitted to post (and, where applicable, to change
// assignment or set a decision) on the given exchange, throwing BrokerError on
// rejection. It reads only its arguments, so it is unit-testable in isolation
// and follows the existing broker-*.ts free-function convention.
import { BrokerError } from "./broker-error.js";
import type { A2AExchangeMessageRequest, A2AExchangeState } from "./types.js";

/**
 * Reject an exchange message whose actor is not the requester, target, hub, or
 * operator — or who attempts an assignment/decision change without privilege.
 */
export function assertExchangeMessageActor(
  exchange: A2AExchangeState,
  request: A2AExchangeMessageRequest,
): void {
  const actor = request.actor;
  const isPrivileged = actor.role === "hub" || actor.role === "operator";
  const isRequester = actor.id === exchange.requester.id;
  const isTarget = actor.id === exchange.target.id;

  if (!isPrivileged && !isRequester && !isTarget) {
    throw new BrokerError(
      "policy_denied",
      "exchange messages require the requester, target, hub, or operator actor",
    );
  }

  if (isRequester && exchange.requester.role && actor.role && exchange.requester.role !== actor.role) {
    throw new BrokerError("policy_denied", "requester actor role must match the exchange requester role");
  }

  if (isTarget && exchange.target.role && actor.role && exchange.target.role !== actor.role) {
    throw new BrokerError("policy_denied", "target actor role must match the exchange target role");
  }

  if ((request.targetNodeId || request.assignedWorkerId) && !isPrivileged) {
    throw new BrokerError("policy_denied", "only hub or operator actors may change assignment fields");
  }

  if (request.decision && !isPrivileged && !isTarget) {
    throw new BrokerError("policy_denied", "only the target, hub, or operator actor may set a decision");
  }
}
