/**
 * Child-process helper for the serving-fence startup test.
 *
 * Acquires the fence, prints "acquired", and releases on SIGTERM or after
 * a hard 8s deadman. It is not a test file.
 */

import { createBrokerServer } from "./server.js";
import { createInMemoryStateStore } from "./server-test-helpers.js";

const sharedStateFile = process.env.BROKER_SHARED_STATE_FILE;
if (!sharedStateFile) {
  process.stderr.write("missing BROKER_SHARED_STATE_FILE\n");
  process.exit(2);
}

try {
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: createInMemoryStateStore(),
    sharedStateFile,
  });
  process.stdout.write("acquired\n");
  const shutdown = (code: number): void => {
    try {
      runtime.server.close();
    } catch {
      // Best-effort: the deadman still exits.
    }
    void runtime.closeWorkerPersistence().finally(() => process.exit(code));
    setTimeout(() => process.exit(code), 2_000).unref();
  };
  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(0));
  setTimeout(() => shutdown(2), 8_000);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${message}\n`);
  process.exit(1);
}
