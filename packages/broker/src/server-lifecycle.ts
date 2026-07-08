import type { Server } from "node:http";

/**
 * Default keepAliveTimeout for the HTTP server (62s). Chosen to exceed the default
 * 30s worker heartbeat interval so that heartbeat TCP connections survive between
 * heartbeats and can be reused. Node.js defaults to 5000ms, which forces every
 * heartbeat to create a new TCP connection.
 */
export const DEFAULT_KEEPALIVE_TIMEOUT_MS = 62000;

/**
 * Margin applied to headersTimeout above keepAliveTimeout. Node.js requires
 * headersTimeout > keepAliveTimeout or server.listen() throws an error.
 */
export const HEADERS_TIMEOUT_MARGIN_MS = 10000;

// Grace period after server.close() before force-closing lingering (e.g. SSE)
// connections so a graceful shutdown cannot hang indefinitely.
const SHUTDOWN_FORCE_CLOSE_MS = 5_000;

interface BrokerLifecycleRuntime {
  server: Server;
  /** Enter drain mode before close (#1405); optional for older runtime shapes. */
  beginDrain?: () => void;
  stopStaleReaper: () => void;
  stopPoller: () => void;
  closeWorkerPersistence: () => Promise<void>;
  config: {
    host: string;
    port: number;
    serviceName: string;
    publicBaseUrl: string;
    staleReaperEnabled: boolean;
    staleReaperIntervalSec: number;
    staleReaperOlderThanSec: number;
    maxRequeueAttempts: number;
  };
}

/** @internal Factory-injected lifecycle wrapper used by server.ts to keep startBrokerServer's public surface stable. */
export function startBrokerServerWithFactory<Options, Runtime extends BrokerLifecycleRuntime>(
  createBrokerServer: (options?: Options) => Runtime,
  options?: Options,
): Runtime {
  const runtime = createBrokerServer(options);
  runtime.server.listen(runtime.config.port, runtime.config.host, () => {
    console.log(`${runtime.config.serviceName} listening on ${runtime.config.publicBaseUrl}`);
    if (runtime.config.staleReaperEnabled) {
      const cap =
        runtime.config.maxRequeueAttempts === 0
          ? "unlimited"
          : `${runtime.config.maxRequeueAttempts}`;
      console.log(
        `[a2a-broker] stale reaper enabled: interval=${runtime.config.staleReaperIntervalSec}s olderThan=${runtime.config.staleReaperOlderThanSec}s maxRequeueAttempts=${cap}`,
      );
    }
  });

  // Graceful drain window before close (#1405). While draining, the handler
  // refuses new poll/claim work (503 broker_draining + Retry-After) and marks
  // every response `Connection: close`, so in-flight worker submissions finish
  // instead of landing on a socket that is about to be severed. 0 (default)
  // preserves today's immediate-close behavior; the redeploy runbook
  // recommends 5000.
  const shutdownDrainMs = Math.max(0, Math.floor(Number(process.env.A2A_SHUTDOWN_DRAIN_MS ?? 0)) || 0);

  const closeServer = (signal: NodeJS.Signals | "uncaughtException") => {
    console.log(`[a2a-broker] ${signal}: stopping stale reaper and closing server`);
    runtime.stopStaleReaper();
    runtime.stopPoller();
    runtime.server.close(() => {
      runtime.closeWorkerPersistence()
        .catch((error) => {
          console.error("[a2a-broker] worker-thread persistence shutdown failed:", error);
          process.exitCode = 1;
        })
        .finally(() => process.exit());
    });
    // server.close() only fires its callback once every connection ends, but
    // SSE streams are kept alive by heartbeats and never end on their own.
    // Close idle connections immediately and force-close any still-open ones
    // after a grace period so shutdown cannot hang until SIGKILL.
    runtime.server.closeIdleConnections?.();
    setTimeout(() => {
      runtime.server.closeAllConnections?.();
    }, SHUTDOWN_FORCE_CLOSE_MS).unref?.();
  };

  const gracefulShutdown = (signal: NodeJS.Signals | "uncaughtException") => {
    if (shutdownDrainMs > 0 && runtime.beginDrain) {
      console.log(`[a2a-broker] received ${signal}, draining for ${shutdownDrainMs}ms before close`);
      runtime.beginDrain();
      setTimeout(() => closeServer(signal), shutdownDrainMs).unref?.();
      return;
    }
    console.log(`[a2a-broker] received ${signal}`);
    closeServer(signal);
  };
  process.once("SIGINT", gracefulShutdown);
  process.once("SIGTERM", gracefulShutdown);
  process.on("unhandledRejection", (reason) => {
    console.error(JSON.stringify({
      level: "error",
      component: "a2a-broker",
      event: "unhandledRejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    }));
  });
  process.once("uncaughtException", (error) => {
    console.error(JSON.stringify({
      level: "fatal",
      component: "a2a-broker",
      event: "uncaughtException",
      message: error.message,
      stack: error.stack,
    }));
    process.exitCode = 1;
    gracefulShutdown("uncaughtException");
  });

  return runtime;
}
