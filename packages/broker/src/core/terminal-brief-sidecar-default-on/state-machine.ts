export interface TerminalBriefSidecarDefaultOnStageDescriptor {
  id: string;
  module: string;
}

export const TERMINAL_BRIEF_SIDECAR_DEFAULT_ON_STAGES: TerminalBriefSidecarDefaultOnStageDescriptor[] = [
  { id: "approval-evidence-ingestor", module: "./approval-evidence-ingestor.js" },
  { id: "approval-request", module: "./approval-request.js" },
  { id: "candidate-final-gate", module: "./candidate-final-gate.js" },
  { id: "enablement-gate", module: "./enablement-gate.js" },
  { id: "execution-approval-evidence-ingestor", module: "./execution-approval-evidence-ingestor.js" },
  { id: "execution-approval-request", module: "./execution-approval-request.js" },
  { id: "execution-rollback-envelope", module: "./execution-rollback-envelope.js" },
  { id: "execution-window-approval-evidence-ingestor", module: "./execution-window-approval-evidence-ingestor.js" },
  { id: "execution-window-request-draft", module: "./execution-window-request-draft.js" },
  { id: "final-live-execution", module: "./final-live-execution.js" },
  { id: "final-runtime-mutation-executor-gate", module: "./final-runtime-mutation-executor-gate.js" },
  { id: "live-executor", module: "./live-executor.js" },
  { id: "runtime-execution-approval-evidence-ingestor", module: "./runtime-execution-approval-evidence-ingestor.js" },
  { id: "runtime-execution-final-gate", module: "./runtime-execution-final-gate.js" },
  { id: "runtime-execution-request-draft", module: "./runtime-execution-request-draft.js" },
  { id: "runtime-executor-gate", module: "./runtime-executor-gate.js" },
  { id: "runtime-mutation-plan", module: "./runtime-mutation-plan.js" },
];

export const TERMINAL_BRIEF_SIDECAR_DEFAULT_ON_STAGE_COUNT = TERMINAL_BRIEF_SIDECAR_DEFAULT_ON_STAGES.length;
