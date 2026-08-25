/**
 * Embedded default A2A agent (opt-in).
 *
 * A2A clients — including the official TCK and any single-agent peer — send a
 * message and expect the receiving agent to produce a Task; they have no way
 * to pre-register a broker worker. By default this broker is a multi-worker
 * router and rejects a worker-less SendMessage. When the default-agent mode
 * is enabled (A2A_DEFAULT_AGENT_MODE), the broker registers a single built-in
 * worker and drives its tasks to completion in-process, so the broker also
 * behaves as a conformant standalone agent.
 *
 * Production routing is unchanged: the mode is off by default, and an
 * explicit metadata.targetNodeId always wins over the default agent.
 */
import { createBuiltinWorkerHandler, type BuiltinWorkerHandlerKind } from "../worker.js";
import type { InMemoryA2ABroker } from "../core/broker.js";
import type { TaskRecord, TaskResult } from "../core/types.js";

export const DEFAULT_AGENT_NODE_ID = "default-agent";

export interface DefaultAgentHandle {
  nodeId: string;
  stop: () => void;
}

export interface StartDefaultAgentOptions {
  nodeId?: string;
  handlerKind?: BuiltinWorkerHandlerKind;
  displayName?: string;
}

/**
 * Register the embedded agent worker and drive its queued tasks to terminal
 * in-process. Returns a handle whose stop() unsubscribes the drive loop.
 */
export function startDefaultAgent(
  broker: InMemoryA2ABroker,
  options: StartDefaultAgentOptions = {},
): DefaultAgentHandle {
  const nodeId = options.nodeId ?? DEFAULT_AGENT_NODE_ID;
  const handler = createBuiltinWorkerHandler(options.handlerKind ?? "echo");

  broker.registerWorker({
    nodeId,
    role: "analyst",
    displayName: options.displayName ?? "A2A Default Agent",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["default-agent"],
      environments: ["research"],
    },
  });

  // Guard against re-entrant drives: broker mutations inside the loop emit
  // more state events, so a task already being processed must not be picked
  // up twice.
  const inFlight = new Set<string>();
  let stopped = false;

  const drive = (): void => {
    if (stopped) return;
    const queued = broker.listTasks({ assignedWorkerId: nodeId, status: "queued" });
    // Resumed tasks (checkpoint cleared by a follow-up message) stay in
    // "running" — pick them up too so the agent finishes them. Tasks still
    // holding a checkpoint (awaiting operator input) are never driven.
    const resumed = broker
      .listTasks({ assignedWorkerId: nodeId, status: "running" })
      .filter((task) => !task.checkpoint);
    for (const task of [...queued, ...resumed]) {
      if (inFlight.has(task.id)) continue;
      inFlight.add(task.id);
      void processTask(task).finally(() => inFlight.delete(task.id));
    }
  };

  const processTask = async (task: TaskRecord): Promise<void> => {
    try {
      const current0 = broker.getTask(task.id) ?? task;
      if (current0.status === "queued") broker.claimTask(task.id, nodeId);
      if ((broker.getTask(task.id) ?? current0).status === "claimed") broker.startTask(task.id, nodeId);
      const current = broker.getTask(task.id) ?? task;
      const outcome = await handler(current);
      // Human-interrupt semantics: a task that gained a checkpoint while the
      // handler ran waits for operator input instead of completing. The
      // resume path clears the checkpoint and re-triggers the drive.
      const latest = broker.getTask(task.id);
      if (latest?.checkpoint) return;
      const result: TaskResult | undefined =
        outcome && typeof outcome === "object" && "result" in outcome
          ? (outcome.result as TaskResult)
          : (outcome as TaskResult | undefined);
      broker.completeTask(task.id, nodeId, result ?? { summary: `handled ${task.intent}` });
    } catch (error) {
      // The agent must never throw into the broker's state-change emit path.
      // A failed drive leaves the task for the stale reaper / next attempt — but
      // log it so the stall is diagnosable instead of a silent hang until the
      // reaper collects it minutes later (BUG-11).
      console.error(`[a2a-default-agent] drive failed for task ${task.id}:`, (error as Error)?.message ?? error);
    }
  };

  const unsubscribe = broker.subscribeToState(drive);
  // Pick up anything already queued at startup (e.g. restored snapshot).
  drive();

  return {
    nodeId,
    stop: () => {
      stopped = true;
      unsubscribe();
    },
  };
}
