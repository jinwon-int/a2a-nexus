/**
 * Child-process helper for the serving-fence startup test.
 *
 * Acquires the fence at the path in BROKER_SHARED_STATE_FILE, prints
 * "acquired", and waits for stdin to close before releasing. It is not a
 * test file.
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
  process.stdin.resume();
  process.stdin.on("end", () => {
    runtime.server.close();
    void runtime.closeWorkerPersistence().finally(() => process.exit(0));
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${message}\n`);
  process.exit(1);
}
