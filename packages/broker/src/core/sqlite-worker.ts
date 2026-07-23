/**
 * Worker thread entry point for SqliteBrokerStateStore.
 * Launched by SqliteWorkerThread via eval to avoid path-resolution
 * issues across compiled/tsx runners.
 *
 * Receives { dbFile, options } via workerData.
 * @module
 */

import { parentPort, workerData } from "node:worker_threads";
import { SqliteBrokerStateStore } from "./store.js";
import type { BrokerSnapshot, BrokerStateSaveHints, SqliteBrokerLoadSource } from "./store.js";
import type { ProjectedReviewLineageObservation } from "../review-lifecycle/observation.js";
import type {
  AuthorizedReviewLineageSourceAdmissionV1,
} from "./review-lineage-observation-store.js";

type WorkerRequest = { id: number; method: string; args: unknown[] };
type InitOptions = {
  loadSource?: SqliteBrokerLoadSource;
  maxBytes?: number;
  maxHotRuntimeNonTerminalTasks?: number;
  maxHotRuntimeTerminalTasks?: number;
  maxHotRuntimeAuditEvents?: number;
  maxHotRuntimeHeartbeatAuditEvents?: number;
  maxHotRuntimeTerminalOutboxEvents?: number;
};

const { dbFile, options }: { dbFile: string; options?: InitOptions } = workerData;

const store = new SqliteBrokerStateStore(dbFile, {
  loadSource: options?.loadSource,
  maxBytes: options?.maxBytes,
  maxHotRuntimeNonTerminalTasks: options?.maxHotRuntimeNonTerminalTasks,
  maxHotRuntimeTerminalTasks: options?.maxHotRuntimeTerminalTasks,
  maxHotRuntimeAuditEvents: options?.maxHotRuntimeAuditEvents,
  maxHotRuntimeHeartbeatAuditEvents: options?.maxHotRuntimeHeartbeatAuditEvents,
  maxHotRuntimeTerminalOutboxEvents: options?.maxHotRuntimeTerminalOutboxEvents,
});

if (!parentPort) {
  throw new Error("sqlite-worker must run as a worker thread");
}

parentPort.on("message", (req: WorkerRequest) => {
  if (req.method === "__close__") {
    process.exit(0);
  }

  try {
    let result: unknown;
    switch (req.method) {
      case "load":
        result = store.load();
        break;
      case "save": {
        const { snapshot, hints } = req.args[0] as { snapshot: BrokerSnapshot; hints: BrokerStateSaveHints };
        result = store.save(snapshot, hints);
        break;
      }
      case "saveHotEntities": {
        const { hints } = req.args[0] as { hints: BrokerStateSaveHints };
        result = store.saveHotEntities(hints);
        break;
      }
      case "applyReviewLineageObservation": {
        const { command } = req.args[0] as {
          command: ProjectedReviewLineageObservation;
        };
        result = store.applyReviewLineageObservation(command);
        break;
      }
      case "applyAuthorizedReviewLineageSource": {
        const { admission } = req.args[0] as {
          admission: AuthorizedReviewLineageSourceAdmissionV1;
        };
        result = store.applyAuthorizedReviewLineageSource(admission);
        break;
      }
      case "readHotRuntimeSnapshot":
        result = store.readHotRuntimeSnapshot();
        break;
      case "readHotTerminalOutbox":
        result = store.readHotTerminalOutbox((req.args[0] as { limit?: number }) ?? {});
        break;
      case "readHotTableLoadMetrics":
        result = store.readHotTableLoadMetrics();
        break;
      case "readHotEntityDiagnostics":
        result = store.readHotEntityDiagnostics();
        break;
      case "getPersistenceInfo":
        result = store.getPersistenceInfo();
        break;
      default:
        parentPort!.postMessage({ id: req.id, ok: false, error: `unknown_method:${req.method}` });
        return;
    }
    parentPort!.postMessage({ id: req.id, ok: true, value: result });
  } catch (error: unknown) {
    parentPort!.postMessage({
      id: req.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
