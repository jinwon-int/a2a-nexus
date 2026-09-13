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

/**
 * #2129: `stop_grace_period` is a Docker Compose concept — it is not passed
 * into the container, so this process cannot read Compose's actual configured
 * value. This is only a hint used to decide whether the drain-duration log
 * line below should read as a WARN (elapsed drain time approaching or past
 * the budget operators configured in `docker-compose.yml`). Keep it in sync
 * with that file's `stop_grace_period` for the `a2a-broker` service by hand,
 * or override per-deployment with `A2A_STOP_GRACE_PERIOD_HINT_MS` — neither
 * changes Compose's own kill timer, which is the actual enforcement point.
 */
const DEFAULT_STOP_GRACE_PERIOD_HINT_MS = 60_000;

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

  // #2129: see DEFAULT_STOP_GRACE_PERIOD_HINT_MS above — this is an
  // operator-supplied hint, not something read from Docker.
  const stopGracePeriodHintMs = Math.max(
    0,
    Math.floor(Number(process.env.A2A_STOP_GRACE_PERIOD_HINT_MS ?? DEFAULT_STOP_GRACE_PERIOD_HINT_MS))
      || DEFAULT_STOP_GRACE_PERIOD_HINT_MS,
  );

  const closeServer = (signal: NodeJS.Signals | "uncaughtException") => {
    // #2129: T1 2026-09-12 — a container that could not finish draining
    // before the Compose kill timer fired was SIGKILLed mid-release, leaving
    // the shared-state serving fence's owner_token set and every subsequent
    // container fail closed with `ownership_conflict`. Logging how long the
    // drain actually took (ending when the fence is released in
    // closeWorkerPersistence) makes a grace-period breach observable from the
    // broker's own logs instead of only inferable after the fact from
    // `docker events`/`docker inspect`.
    const drainStartedAtMs = Date.now();
    console.log(`[a2a-broker] ${signal}: stopping stale reaper and closing server`);
    runtime.stopStaleReaper();
    runtime.stopPoller();
    runtime.server.close(() => {
      void runtime.closeWorkerPersistence()
        .catch((error) => {
          console.error("[a2a-broker] worker-thread persistence shutdown failed:", error);
          process.exitCode = 1;
        })
        .finally(() => {
          const elapsedMs = Date.now() - drainStartedAtMs;
          const line = `[a2a-broker] drain completed in ${elapsedMs}ms (stop_grace_period budget: ${stopGracePeriodHintMs}ms)`;
          // Warn once the drain has used most of the configured budget: by
          // the time it fully exceeds the budget, Compose may already have
          // sent SIGKILL and this line might never flush, so the warning
          // threshold is deliberately set below 100% of the budget.
          if (stopGracePeriodHintMs > 0 && elapsedMs >= stopGracePeriodHintMs * 0.8) {
            console.warn(line);
          } else {
            console.log(line);
          }
          process.exit();
        });
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
