/**
 * a2a-policy-referee — declarative worker-class policy engine (#1601 P1,
 * spin-off candidate #1480). Extracted from packages/broker/core/broker-policy
 * with its contract unchanged; the broker consumes this package, and the same
 * import boundary is what a future standalone repo extraction would use.
 */
export {
  BROKER_POLICY_DEFAULT_ACTIONS,
  BROKER_POLICY_MODES,
  BROKER_POLICY_SCHEMA,
  BROKER_POLICY_WORKER_CLASSES,
  deriveTaskWorkerClass,
  evaluateTaskPolicy,
  loadBrokerPolicyFile,
  validateBrokerPolicyDocument,
} from "./broker-policy.js";
export type {
  BrokerPolicyDecision,
  BrokerPolicyDocument,
  BrokerPolicyEvaluationInput,
  BrokerPolicyMode,
  BrokerPolicyRule,
} from "./broker-policy.js";
export {
  POLICY_REFEREE_DECISION_SCHEMA,
  POLICY_REFEREE_ERROR_SCHEMA,
  POLICY_REFEREE_EXIT,
  POLICY_REFEREE_MAX_TASKS_TODAY,
  POLICY_REFEREE_TASK_SCHEMA,
  POLICY_REFEREE_WORKER_SCHEMA,
  PolicyRefereeInputError,
  evaluatePolicyRefereeCli,
  parsePolicyRefereePolicyDocument,
  parsePolicyRefereeTaskEnvelope,
  parsePolicyRefereeWorkerEnvelope,
  projectPolicyRefereeDecision,
} from "./cli-contract.js";
export type {
  PolicyRefereeDecisionEnvelope,
  PolicyRefereeErrorCode,
  PolicyRefereeEvaluationResult,
  PolicyRefereeImplementationReadiness,
  PolicyRefereeInputKind,
  PolicyRefereeReasonCode,
  PolicyRefereeTaskEnvelope,
  PolicyRefereeWorkerEnvelope,
} from "./cli-contract.js";
